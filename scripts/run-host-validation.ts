import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse } from "jsonc-parser";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { apiServer } from "../src/core/server.js";
import { Effects } from "../src/core/effects.js";
const root = resolve(".local-validation");
const report = JSON.parse(
  await readFile(join(root, "results/p0-playbook-path.json"), "utf8"),
);
const secret = JSON.parse(
  await readFile(join(root, "data/development-secret.json"), "utf8"),
);
const folder = join(root, `host-validation-${Date.now()}`);
await mkdir(folder, { recursive: true });
const workspace = join(folder, "workspace");
await mkdir(workspace, { recursive: true });
const prompt =
  "Read fixture.txt once. Diagnose the generated client field that disappears after regeneration using the complete method supplied by the LessonLoop hook. Choose the relevant branch from the file contents and explain the remaining check. Do not request step unlocking or report completion. Read taskRef from the lessonloop-playbook tag and the playbook id/revision from its JSON in this prompt; those references are not in fixture.txt. Call lessonloop-getGuidance once with input {taskRef, target: {kind: 'playbook', id, revision}} using those supplied references to check explicit retrieval. Stop after these two tools. If the hook context is absent or a tool returns an error, report the limitation. Do not guess identifiers, inspect other files, retry tools, edit files, or claim task success.";
const plugin = join(folder, "plugin");
await mkdir(join(plugin, "com.github.copilot/hooks"), { recursive: true });
const token = randomBytes(32).toString("hex");
const agentToken = randomBytes(32).toString("hex");
const principal = {
  id: "host-validation",
  channel: "host" as const,
  scopes: [report.scope],
};
const store = new ProductStore(
  process.env.LESSONLOOP_TEST_DATABASE_URL ??
    `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const settings = (await core.getSettings(principal))[0]!;
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  classification: "real_copilot_product_hook",
  scope: report.scope,
  status: "failed",
  diagnostics: [],
};
const server = apiServer(core, [
  { token, principal },
  {
    token: agentToken,
    principal: {
      ...principal,
      id: "host-validation-agent",
      channel: "agent",
      taskOwnerId: principal.id,
    },
  },
]);
try {
  await core.configure(
    { ...principal, channel: "user" },
    {
      scopeId: report.scope,
      expectedRevision: settings.revision,
      learning: true,
      recommendation: true,
      review: true,
      notifications: false,
    },
  );
  let available = await core.search(principal, prompt);
  for (let attempt = 0; !available.results.length && attempt < 12; attempt++) {
    await core.syncProjections([report.scope]);
    available = await core.search(principal, prompt);
  }
  if (!available.results.length)
    throw new Error("no_eligible_playbook_for_host_validation");
  result.preflightPlaybook = available.results[0]!.playbook;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(19433, "127.0.0.1", done);
  });
  const config = join(folder, "host-config.json");
  await writeFile(
    config,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:19433",
      token,
      scopeId: report.scope,
      allowedRoots: [workspace],
      stateRoot: join(folder, "state"),
    }),
  );
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "lessonloop-validation",
      version: "0.0.1",
      description: "Local product playbook integration validation",
    }),
  );
  const events = [
    "sessionStart",
    "userPromptTransformed",
    "postToolUse",
    "agentStop",
    "sessionEnd",
  ];
  await writeFile(
    join(plugin, "com.github.copilot/hooks/hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: Object.fromEntries(
        events.map((e) => [
          e,
          [
            {
              type: "command",
              exec: process.execPath,
              args: [resolve("dist/adapters/copilot/hook.js"), e],
              cwd: workspace,
              timeoutSec: 60,
              env: { LESSONLOOP_HOST_CONFIG: config },
            },
          ],
        ]),
      ),
    }),
  );
  await writeFile(
    join(workspace, "fixture.txt"),
    "The pipeline copies schema.json to client.json. Generated edits are overwritten.",
  );
  const mcpConfig = join(folder, "mcp-config.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        lessonloop: {
          type: "stdio",
          command: process.execPath,
          args: [resolve("dist/adapters/copilot/mcp.js")],
          env: {
            LESSONLOOP_AGENT_CONFIG_JSON: JSON.stringify({
              baseUrl: "http://127.0.0.1:19433",
              token: agentToken,
            }),
          },
          tools: ["getGuidance"],
        },
      },
    }),
  );
  const isolatedHome = join(folder, "copilot-home");
  await mkdir(isolatedHome, { recursive: true });
  const accountConfig = parse(
    await readFile(
      join(process.env.USERPROFILE!, ".copilot/config.json"),
      "utf8",
    ),
  );
  await writeFile(
    join(isolatedHome, "config.json"),
    JSON.stringify({
      lastLoggedInUser: accountConfig.lastLoggedInUser,
      loggedInUsers: accountConfig.loggedInUsers,
      trustedFolders: [workspace],
    }),
  );
  const executable = process.env.LESSONLOOP_COPILOT_SCRIPT
    ? process.execPath
    : (process.env.LESSONLOOP_COPILOT_EXECUTABLE ??
      join(process.env.LOCALAPPDATA!, "Microsoft/WinGet/Links/copilot.exe"));
  const call = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((done) =>
    execFile(
      executable,
      [
        ...(process.env.LESSONLOOP_COPILOT_SCRIPT
          ? [resolve(process.env.LESSONLOOP_COPILOT_SCRIPT)]
          : []),
        "--no-auto-update",
        "--no-custom-instructions",
        "--no-remote",
        "--no-remote-export",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--available-tools=view,lessonloop",
        "--allow-tool=read",
        "--allow-tool=lessonloop",
        "--additional-mcp-config",
        `@${mcpConfig}`,
        "--model=gpt-5.5",
        "--output-format=json",
        "--stream=off",
        "--plugin-dir",
        plugin,
        "--log-dir",
        join(folder, "logs"),
        "-p",
        prompt,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          COPILOT_HOME: isolatedHome,
          COPILOT_CACHE_HOME: join(folder, "cache"),
        },
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        done({
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
        }),
    ),
  );
  result.exitCode = call.exitCode;
  const outputEvents = call.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  result.output = outputEvents
    .filter((e) => ["assistant.message", "result"].includes(e.type))
    .map((e) => ({ type: e.type, text: e.data?.content ?? e.result ?? "" }));
  result.error = call.stderr;
  result.requiresAuthentication =
    /No authentication information|not authenticated|login/i.test(call.stderr);
  const directories = await readdir(join(isolatedHome, "session-state"), {
    withFileTypes: true,
  }).catch(() => []);
  const traces = [];
  const runtimeTools: Array<{ name: string; success?: boolean }> = [];
  const guidanceReceipts: Array<{
    taskRef: string;
    playbooks: Array<{ playbook: { id: string; revision: number } }>;
  }> = [];
  const toolNames = new Map<string, string>();
  const finalTexts: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const lines = (
      await readFile(
        join(isolatedHome, "session-state", directory.name, "events.jsonl"),
        "utf8",
      ).catch(() => {
        (result.diagnostics as string[]).push("host_transcript_unavailable");
        return "";
      })
    ).split("\n");
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (
          e.type === "assistant.message" &&
          !e.data.toolRequests?.length &&
          typeof e.data.content === "string" &&
          e.data.content.trim()
        )
          finalTexts.push(e.data.content.trim());
        if (e.type === "tool.execution_start")
          toolNames.set(e.data.toolCallId, e.data.toolName);
        if (e.type === "tool.execution_complete")
          runtimeTools.push({
            name: toolNames.get(e.data.toolCallId) ?? "unknown",
            success: e.data.success,
          });
        if (
          e.type === "tool.execution_complete" &&
          toolNames.get(e.data.toolCallId) === "lessonloop-getGuidance" &&
          e.data.success
        ) {
          const response = JSON.parse(e.data.result.content);
          if (
            response.result?.taskRef &&
            Array.isArray(response.result.playbooks)
          )
            guidanceReceipts.push(response.result);
        }
        if (e.type === "hook.end")
          traces.push({
            hook: e.data.hookType,
            success: e.data.success,
            injected: JSON.stringify(e.data.output ?? {}).includes(
              "<lessonloop-playbook",
            ),
          });
      } catch {}
    }
  }
  result.hooks = traces;
  result.tools = runtimeTools;
  result.observedPlaybook = traces.some(
    (e) => e.hook === "userPromptTransformed" && e.success && e.injected,
  );
  const stateTasks = [];
  for (const name of await readdir(join(folder, "state")).catch(() => []))
    if (name.endsWith(".json"))
      stateTasks.push(
        ...Object.keys(
          JSON.parse(await readFile(join(folder, "state", name), "utf8"))
            .captures,
        ).map((taskRef) => ({ taskRef })),
      );
  const taskRefs = new Set(stateTasks.map((t) => t.taskRef));
  const evidence = await store.transaction(async (tx) => {
    const inputSources = (await tx.list<any>("source", [report.scope])).filter(
      (m) => taskRefs.has(m.taskRef),
    );
    return {
      roles: [...new Set(inputSources.map((m) => m.segment?.role))],
      finalAgentCaptured:
        finalTexts.length > 0 &&
        inputSources.some(
          (m) =>
            m.segment?.role === "agent" && m.segment.text === finalTexts.at(-1),
        ),
    };
  });
  const cases = (await new Effects(store).cases([report.scope])).filter((c) =>
    taskRefs.has(c.taskRef),
  );
  result.evidence = {
    ...evidence,
    feedback: cases,
    outcomes: cases.map((c) => c.taskOutcome),
    sameSessionUserClarification: "adapter_replay_test_only",
    causalBenefit: "not_inferred",
  };
  result.status =
    call.exitCode === 0 &&
    result.observedPlaybook &&
    evidence.finalAgentCaptured &&
    evidence.roles.includes("user") &&
    evidence.roles.includes("tool") &&
    traces.some((e) => e.hook === "agentStop" && e.success) &&
    effectEvents.some((e) => e.kind === "delivery") &&
    effectEvents.some((e) => e.kind === "task_ended") &&
    !effectEvents.some((e) => e.kind === "outcome")
      ? "host_loop_observed"
      : "failed";
} catch (error) {
  result.validationError =
    error instanceof Error ? error.message : "validation_failed";
  result.status = "failed";
} finally {
  // Persist the original failure before cleanup, even if a local service stalls.
  await writeFile(
    join(root, "results/host-product-validation.json"),
    JSON.stringify(result, null, 2),
  );
  const watchdog = setTimeout(() => {
    process.stderr.write(
      "Host validation cleanup exceeded 15 seconds; closing the validation process.\n",
    );
    process.exit(1);
  }, 15000);
  watchdog.unref();
  try {
    const currentSettings = (await core.getSettings(principal)).find(
      (s) => s.scopeId === report.scope,
    );
    if (currentSettings)
      await core.configure(
        { ...principal, channel: "user" },
        {
          scopeId: report.scope,
          expectedRevision: currentSettings.revision,
          learning: settings.learning,
          recommendation: settings.recommendation,
          review: settings.review,
          notifications: settings.notifications,
        },
      );
    result.settingsRestored = true;
  } catch (error) {
    result.cleanupError =
      error instanceof Error ? error.message : "settings_restore_failed";
    result.status = "failed";
  }
  try {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    await store.close();
  } catch (error) {
    result.cleanupError =
      error instanceof Error ? error.message : "cleanup_failed";
    result.status = "failed";
  } finally {
    clearTimeout(watchdog);
  }
  await writeFile(
    join(root, "results/host-product-validation.json"),
    JSON.stringify(result, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: result.status,
    exitCode: result.exitCode,
    observedPlaybook: result.observedPlaybook,
  }),
);

process.exitCode = result.status === "host_loop_observed" ? 0 : 1;
