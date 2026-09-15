import { z } from "zod";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import { taskFixtures } from "../fixtures/tasks.js";
import type { TaskFixture } from "../fixtures/tasks.js";
import type { ModelClient } from "./model-client.js";
import { HindsightEngine } from "../../src/adapters/hindsight/engine.js";
import { CoreService } from "../../src/core/service.js";

export const profileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    tasks: z.array(z.string()).min(1).max(20),
    repeats: z.number().int().min(1).max(5),
    officialBaseline: z.enum(["native_sdk", "official_agent_hooks"]),
    model: z.string().min(1),
    python: z.string().min(1),
    contextTokens: z.number().int().min(128).max(8000),
    learningTimeoutSeconds: z.number().int().min(30).max(1800),
    pollMilliseconds: z.number().int().min(100).max(10000),
    official: z
      .object({
        retainMission: z.string().min(1),
        reflectMission: z.string().min(1),
        knowledgeQuery: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type EvaluationProfile = z.infer<typeof profileSchema>;
export const groups = ["none", "official", "product"] as const;
export type EvaluationGroup = (typeof groups)[number];
export class EvaluationBlocked extends Error {}
export function validateProfile(
  input: unknown,
  fixtures: TaskFixture[] = taskFixtures,
) {
  const profile = profileSchema.parse(input);
  if (new Set(profile.tasks).size !== profile.tasks.length)
    throw new Error("duplicate_profile_task");
  if (profile.officialBaseline !== "native_sdk")
    throw new EvaluationBlocked(
      "official_agent_hooks_not_supported_by_this_runner",
    );
  for (const id of profile.tasks) {
    const task = fixtures.find((f) => f.id === id);
    if (!task) throw new Error("unknown_task:" + id);
    for (const name of Object.keys(task.setup)) {
      const parts = name.replaceAll(String.fromCharCode(92), "/").split("/");
      if (path.isAbsolute(name) || parts.includes("..") || name.includes(":"))
        throw new Error("unsafe_fixture_path");
    }
    if (
      !(task.targetFile in task.setup) ||
      (task.generatedFile && !(task.generatedFile in task.setup))
    )
      throw new Error("missing_fixture_target");
  }
  return profile;
}
const encoder = encodingForModel("gpt-4o");
export function boundedContext(text: string, budget: number) {
  const tokens = encoder.encode(text);
  if (tokens.length <= budget)
    return {
      text,
      originalTokens: tokens.length,
      deliveredTokens: tokens.length,
      truncated: false,
    };
  throw new EvaluationBlocked(
    "context_too_large:" + tokens.length + ":" + budget,
  );
}
export function isolatedIdentity(
  runId: string,
  task: string,
  repeat: number,
  group: EvaluationGroup,
) {
  const identity = "eval-" + runId + "-" + repeat + "-" + group + "-" + task;
  return {
    scopeId: identity,
    bankId: identity + "-native",
    directory: [task, String(repeat), group],
  };
}
export async function until<T>(
  read: () => Promise<T>,
  finished: (value: T) => boolean,
  timeoutMs: number,
  pollMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (finished(value)) return value;
    if (Date.now() >= deadline) throw new Error("learning_deadline_exceeded");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
export interface ContextEvidence {
  context: string;
  stages: unknown[];
  identity: Record<string, unknown>;
  nativeUsage: { status: string; records: unknown[] };
}
type NativeEngine = Pick<
  HindsightEngine,
  "client" | "operation" | "hasPendingOperations"
>;
export async function officialContext(
  engine: NativeEngine,
  bank: string,
  fixture: TaskFixture,
  profile: EvaluationProfile,
  stages: unknown[] = [],
): Promise<ContextEvidence> {
  const usage: unknown[] = [];
  await engine.client.createBank(bank, {
    retainMission: profile.official.retainMission,
    reflectMission: profile.official.reflectMission,
    retainExtractionMode: "concise",
    enableObservations: true,
    signal: AbortSignal.timeout(30000),
  });
  stages.push({
    stage: "configured",
    extraction: "concise",
    observations: true,
  });
  for (const [index, history] of fixture.history.entries()) {
    const result = await engine.client.retain(bank, history, {
      documentId: "history-" + index,
      context:
        "Authored historical task record; attribution must be preserved.",
      async: false,
      signal: AbortSignal.timeout(profile.learningTimeoutSeconds * 1000),
    });
    stages.push({ stage: "retain", index, result });
    if (!result.success || result.async)
      throw new Error("official_retain_not_confirmed");
    usage.push({ stage: "retain", usage: result.usage ?? null });
  }
  await until(
    () => engine.hasPendingOperations(bank),
    (pending) => !pending,
    profile.learningTimeoutSeconds * 1000,
    profile.pollMilliseconds,
  );
  const modelId = "knowledge-" + randomUUID();
  const model = await engine.client.createMentalModel(
    bank,
    "Working knowledge",
    profile.official.knowledgeQuery,
    {
      id: modelId,
      maxTokens: profile.contextTokens,
      signal: AbortSignal.timeout(30000),
    },
  );
  stages.push({ stage: "knowledge_submitted", result: model });
  const completed = await until(
    () => engine.operation(bank, model.operation_id),
    (result) => !["pending", "processing"].includes(result.status),
    profile.learningTimeoutSeconds * 1000,
    profile.pollMilliseconds,
  );
  stages.push({ stage: "knowledge_operation", result: completed });
  if (completed.status !== "completed")
    throw new Error("official_knowledge_failed:" + completed.status);
  const knowledge = await engine.client.getMentalModel(
    bank,
    model.mental_model_id ?? modelId,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!knowledge.content?.trim()) throw new Error("official_knowledge_empty");
  stages.push({ stage: "knowledge", result: knowledge });
  const reflected = await engine.client.reflect(bank, fixture.request, {
    budget: "mid",
    includeFacts: true,
    includeToolCalls: true,
    excludeMentalModels: false,
    signal: AbortSignal.timeout(profile.learningTimeoutSeconds * 1000),
  });
  if (!reflected.text.trim()) throw new Error("official_reflect_empty");
  stages.push({ stage: "reflect", result: reflected });
  usage.push({ stage: "reflect", usage: reflected.usage ?? null });
  return {
    context: reflected.text,
    stages,
    identity: {
      bank,
      modelId,
      baseline: "official_hindsight_native_sdk",
      officialAgentHooksValidated: false,
    },
    nativeUsage: {
      status: "partial_knowledge_and_consolidation_not_aggregated",
      records: usage,
    },
  };
}
export async function productContext(
  core: CoreService,
  scope: string,
  fixture: TaskFixture,
  profile: EvaluationProfile,
  stages: unknown[] = [],
): Promise<ContextEvidence> {
  const host = {
      id: scope + "-host",
      channel: "host" as const,
      scopes: [scope],
    },
    user = { ...host, channel: "user" as const };
  await core.configure(user, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const receipt = await core.submitMaterial(
    host,
    {
      scopeId: scope,
      segments: fixture.history.map((text) => ({
        text,
        role: "external" as const,
      })),
    },
    "historical-material",
  );
  stages.push({ stage: "submit", receipt });
  const job = await until(
    async () => {
      await core.tick([scope]);
      return core.getJob(host, receipt.jobId);
    },
    (value) => ["completed", "failed", "canceled"].includes(value.status),
    profile.learningTimeoutSeconds * 1000,
    profile.pollMilliseconds,
  );
  stages.push({ stage: "learning", job });
  if (job.status !== "completed")
    throw new Error("product_learning_failed:" + job.status);
  const publication: {
    stage: string;
    status: string;
    attempts: number;
    pending: number;
    job?: unknown;
  } = { stage: "publication", status: "waiting", attempts: 0, pending: 0 };
  stages.push(publication);
  let publishedJob = job;
  try {
    await until(
      async () => {
        publication.attempts++;
        await core.syncProjections([scope]);
        publishedJob = await core.getJob(host, receipt.jobId);
        publication.job = publishedJob;
        const products = publishedJob.results.filter(
          (result) => result.kind !== "work_case",
        );
        if (!products.length) {
          publication.status = "no_memory_output";
          return true;
        }
        if (publishedJob.receipt.replacement.status === "effective") {
          publication.status = "effective";
          return true;
        }
        publication.pending = await core.store.transaction(async (tx) => {
          const projections = new Map(
            (
              await tx.list<{
                id: string;
                confirmed: boolean;
                objectRevision: number;
              }>("projection", [scope])
            ).map((projection) => [projection.id, projection]),
          );
          let pending = 0;
          for (const kind of ["method", "experience"] as const)
            for (const object of await tx.list<{
              id: string;
              state: string;
              revision: number;
            }>(kind, [scope])) {
              const projection = projections.get(object.id);
              if (
                object.state === "active" &&
                (!projection?.confirmed ||
                  projection.objectRevision !== object.revision)
              )
                pending++;
            }
          return pending;
        });
        if (publication.pending > 0) return false;
        if (publishedJob.receipt.replacement.status === "pending") return false;
        publication.status = products.some((result) => result.effective)
          ? "partially_effective"
          : "ineligible_output";
        return true;
      },
      (ready) => ready,
      profile.learningTimeoutSeconds * 1000,
      profile.pollMilliseconds,
    );
  } catch (error) {
    publication.status = "failed";
    throw new Error(
      "product_publication_failed:" +
        (error instanceof Error ? error.message : "unknown"),
    );
  }
  const search = await core.search(host, fixture.request),
    task = await core.startTask(host, scope);
  const method = search.results[0]?.method;
  const prepared = method
    ? await core.prepare(host, {
        methodId: method.id,
        revision: method.revision,
        taskRef: task.taskRef,
        requestId: "evaluation",
      })
    : null;
  const methodAvailable =
    prepared &&
    typeof prepared.status === "string" &&
    prepared.status === "guidance";
  const recalled = methodAvailable
    ? null
    : await core.recall(host, fixture.request);
  stages.push({ stage: "retrieval", search, prepared, recalled });
  return {
    context: JSON.stringify(
      methodAvailable
        ? { preparedMethod: prepared }
        : { experiences: recalled },
    ),
    stages,
    identity: {
      scope,
      taskRef: task.taskRef,
      product: "actual_core_and_hindsight",
      retrieval: methodAvailable ? "method" : "experience_fallback",
    },
    nativeUsage: {
      status: publishedJob.usage.status,
      records: [{ jobId: receipt.jobId, usage: publishedJob.usage }],
    },
  };
}
export interface ArmResult {
  task: string;
  repeat: number;
  group: EvaluationGroup;
  status: "completed" | "failed" | "blocked";
  passed: boolean;
  taskUsage: ModelClient["usage"];
  error?: string;
}
export function pairedReport(arms: ArmResult[]) {
  const pairs = [...new Set(arms.map((a) => a.task + ":" + a.repeat))].map(
    (key) => {
      const rows = arms.filter((a) => a.task + ":" + a.repeat === key),
        byGroup = Object.fromEntries(rows.map((a) => [a.group, a]));
      const complete = groups.every(
        (group) => byGroup[group]?.status === "completed",
      );
      return {
        key,
        complete,
        outcomes: Object.fromEntries(
          groups.map((group) => [group, byGroup[group]?.passed ?? null]),
        ),
        productMinusNone: complete
          ? Number(byGroup.product!.passed) - Number(byGroup.none!.passed)
          : null,
        productMinusOfficial: complete
          ? Number(byGroup.product!.passed) - Number(byGroup.official!.passed)
          : null,
      };
    },
  );
  return {
    pairs,
    completedPairs: pairs.filter((p) => p.complete).length,
    excludedPairs: pairs.filter((p) => !p.complete).length,
    releaseGate: "not_evaluated",
    causalBenefit: "not_established_by_authored_development_probes",
  };
}
