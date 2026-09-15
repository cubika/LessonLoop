import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, sdk } from "@vectorize-io/hindsight-client";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { taskFixtures } from "../evals/fixtures/tasks.js";
import { runTask } from "../evals/lib/task-runner.js";
import { CopilotModelClient } from "../evals/lib/copilot-model.js";
import {
  boundedContext,
  EvaluationBlocked,
  groups,
  isolatedIdentity,
  officialContext,
  pairedReport,
  productContext,
  validateProfile,
  type ArmResult,
  type ContextEvidence,
} from "../evals/lib/product-evaluation.js";

const args = process.argv.slice(2);
const help = args.includes("--help");
const value = (flag: string, fallback?: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const next = args[index + 1];
  if (!next || next.startsWith("--"))
    throw new Error("Missing value for " + flag);
  return next;
};
async function main() {
  if (help) {
    console.log(
      [
        "Usage: node --import tsx scripts/run-product-evaluation.ts [--profile evals/profiles/development.json] [--validate] [--check-provider]",
        "Run: add --core-config path/to/core-config.json [--python path/to/private/python.exe] [--out output-directory]",
        "--validate checks the profile and fixture paths without opening a database or calling a model.",
        "--check-provider imports the pinned Python provider; authentication is checked by the first real call.",
        "A run needs the installed Hindsight 0.9.2 Python runtime, existing Copilot CLI login, a running Hindsight engine and an initialized ProductStore database. Stop the product Core process first: this runner requires its single-writer lock.",
        "The config contains databaseUrl, engineUrl and engineToken. Credentials are read locally and omitted from reports. The model uses the official GitHub Copilot provider and the existing login; no model API endpoint is created.",
        "COPILOT_CLI_PATH may select the installed CLI. On Windows it defaults to the Microsoft/WinGet/Links/copilot.exe link, matching the local engine launcher. Cached SDK runtimes are not selected automatically.",
        "The official arm uses native SDK extraction, observations, a mental model and reflection. Official Agent hook profiles are blocked; this script does not stand in for their acceptance.",
        "Every run uses fresh scopes, native banks and workspace directories. Data is retained for inspection. Reports include authored-task outcomes, failures, partial native costs and paired differences; releaseGate is always not_evaluated.",
        "Context exceeding the shared budget blocks that arm; necessary method conditions and exceptions are never truncated. Product context prefers a prepared method and uses direct experience recall only as a fallback.",
        "Exit 0: experiment completed (check individual task outcomes); exit 1: failed; exit 2: required capability unavailable.",
      ].join("\n"),
    );
    return;
  }
  const allowed = new Set([
    "--profile",
    "--validate",
    "--check-provider",
    "--core-config",
    "--python",
    "--out",
  ]);
  for (const arg of args.filter((a) => a.startsWith("--")))
    if (!allowed.has(arg)) throw new Error("Unknown option " + arg);
  const profilePath = resolve(
    value("--profile", "evals/profiles/development.json")!,
  );
  const profile = validateProfile(
    JSON.parse(await readFile(profilePath, "utf8")),
  );
  const python = resolve(value("--python", profile.python)!);
  if (args.includes("--check-provider"))
    await new CopilotModelClient(python, profile.model).validate();
  if (args.includes("--validate")) {
    console.log(
      JSON.stringify(
        {
          status: "valid",
          profile: profile.id,
          groups,
          tasks: profile.tasks.length,
          repeats: profile.repeats,
          officialBaseline: profile.officialBaseline,
          releaseGate: "not_evaluated",
          authentication: "checked_on_run",
        },
        null,
        2,
      ),
    );
    return;
  }
  await new CopilotModelClient(python, profile.model).validate();
  const configPath = value("--core-config", process.env.LESSONLOOP_CONFIG);
  if (!configPath)
    throw new EvaluationBlocked("core_config_required_use_--core-config");
  const config = JSON.parse(await readFile(resolve(configPath), "utf8")) as {
    databaseUrl: string;
    engineUrl: string;
    engineToken: string;
  };
  if (!config.databaseUrl || !config.engineUrl || !config.engineToken)
    throw new EvaluationBlocked(
      "core_config_requires_databaseUrl_engineUrl_engineToken",
    );
  const runId = randomUUID(),
    root = resolve(
      value("--out", ".local-validation/product-evaluations")!,
      runId,
    );
  await mkdir(root, { recursive: true });
  const store = new ProductStore(config.databaseUrl),
    engine = new HindsightEngine(config.engineUrl, config.engineToken),
    core = new CoreService(store, engine);
  const arms: ArmResult[] = [];
  const report: Record<string, unknown> = {
    runId,
    profile,
    profilePath,
    startedAt: new Date().toISOString(),
    classification: "authored_development_three_arm_native_sdk",
    officialAgentHooksValidated: false,
    productHostHooksValidated: false,
    taskModel: { provider: "github-copilot", model: profile.model },
    engineModel: "server_configured_not_independently_pinned",
    arms,
    releaseGate: "not_evaluated",
  };
  const save = async () =>
    writeFile(
      join(root, "report.json"),
      JSON.stringify({ ...report, comparison: pairedReport(arms) }, null, 2),
    );
  try {
    await store.open();
    report.engineVersion = await engine.health();
    for (const [taskIndex, taskId] of profile.tasks.entries())
      for (let repeat = 0; repeat < profile.repeats; repeat++) {
        const fixture = taskFixtures.find((task) => task.id === taskId)!;
        const offset = (taskIndex + repeat) % groups.length;
        const order = [...groups.slice(offset), ...groups.slice(0, offset)];
        for (const group of order) {
          const identity = isolatedIdentity(runId, taskId, repeat, group),
            directory = join(root, ...identity.directory);
          await mkdir(directory, { recursive: true });
          const model = new CopilotModelClient(python, profile.model),
            stages: unknown[] = [];
          const arm: ArmResult = {
            task: taskId,
            repeat,
            group,
            status: "failed",
            passed: false,
            taskUsage: model.usage,
          };
          const detail: Record<string, unknown> = {
            ...identity,
            stages,
            context: null,
            fixture: { id: fixture.id, family: fixture.family, authored: true },
            startedAt: new Date().toISOString(),
          };
          console.log(
            JSON.stringify({ task: taskId, repeat, group, stage: "starting" }),
          );
          try {
            let evidence: ContextEvidence = {
              context: "",
              stages,
              identity: { group: "none" },
              nativeUsage: { status: "not_applicable", records: [] },
            };
            if (group === "official") {
              const native = new HindsightEngine(
                config.engineUrl,
                config.engineToken,
                identity.bankId,
              );
              evidence = await officialContext(
                native,
                identity.bankId,
                fixture,
                profile,
                stages,
              );
              const operations = await sdk.listOperations({
                client: createClient({
                  baseUrl: config.engineUrl,
                  headers: { Authorization: "Bearer " + config.engineToken },
                }),
                path: { bank_id: identity.bankId },
                query: { limit: 100, offset: 0 },
                signal: AbortSignal.timeout(10000),
                throwOnError: true,
              });
              stages.push({
                stage: "native_operation_audit",
                result: operations.data,
              });
              if (operations.data.total > 100)
                throw new Error("official_operation_audit_budget");
              if (
                operations.data.operations.some((operation) =>
                  ["failed", "cancelled"].includes(operation.status),
                )
              )
                throw new Error("official_background_operation_failed");
            } else if (group === "product")
              evidence = await productContext(
                core,
                identity.scopeId,
                fixture,
                profile,
                stages,
              );
            detail.learning = evidence.identity;
            detail.nativeUsage = evidence.nativeUsage;
            detail.originalContext = evidence.context;
            const context = boundedContext(
              evidence.context,
              profile.contextTokens,
            );
            detail.context = context;
            await writeFile(
              join(directory, "evidence.json"),
              JSON.stringify(detail, null, 2),
            );
            const task = await runTask(
              model,
              fixture,
              join(directory, "workspace"),
              async () => context.text,
            );
            detail.result = task;
            arm.status = "completed";
            arm.passed = task.passed;
          } catch (error) {
            arm.status =
              error instanceof EvaluationBlocked ? "blocked" : "failed";
            arm.error =
              error instanceof Error ? error.message : "evaluation_failed";
            detail.nativeUsage ??= {
              status: "incomplete_stage_failure",
              records: [],
            };
          } finally {
            detail.finishedAt = new Date().toISOString();
            detail.taskUsage = {
              ...model.usage,
              status: model.unknownUsageCalls ? "partial" : "reported",
              unknownUsageCalls: model.unknownUsageCalls,
            };
            detail.outcome = arm;
            await writeFile(
              join(directory, "evidence.json"),
              JSON.stringify(detail, null, 2),
            );
            arms.push(arm);
            await save();
            console.log(
              JSON.stringify({
                task: taskId,
                repeat,
                group,
                status: arm.status,
                passed: arm.passed,
              }),
            );
          }
        }
      }
    report.status = arms.some((arm) => arm.status === "failed")
      ? "failed"
      : arms.some((arm) => arm.status === "blocked")
        ? "blocked"
        : "completed";
    process.exitCode =
      report.status === "completed" ? 0 : report.status === "blocked" ? 2 : 1;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : "evaluation_failed";
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    await store.close();
  }
  console.log(
    JSON.stringify({
      report: join(root, "report.json"),
      status: report.status,
      releaseGate: "not_evaluated",
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "evaluation_failed");
  process.exitCode = error instanceof EvaluationBlocked ? 2 : 1;
});
