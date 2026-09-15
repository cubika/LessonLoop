import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  boundedContext,
  EvaluationBlocked,
  isolatedIdentity,
  officialContext,
  pairedReport,
  productContext,
  until,
  validateProfile,
  type ArmResult,
} from "../evals/lib/product-evaluation.js";
import { taskFixtures } from "../evals/fixtures/tasks.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { CoreService } from "../src/core/service.js";

const raw = JSON.parse(
  await readFile(
    new URL("../evals/profiles/development.json", import.meta.url),
    "utf8",
  ),
);
test("Evaluation profiles reject unsupported official hooks, duplicate tasks and unsafe fixture files", () => {
  assert.equal(validateProfile(raw).tasks.length, 2);
  assert.throws(
    () => validateProfile({ ...raw, officialBaseline: "official_agent_hooks" }),
    EvaluationBlocked,
  );
  assert.throws(
    () => validateProfile({ ...raw, tasks: [raw.tasks[0], raw.tasks[0]] }),
    /duplicate_profile_task/,
  );
  const fixture = { ...taskFixtures[0]!, setup: { "../outside.json": {} } };
  assert.throws(
    () => validateProfile({ ...raw, tasks: [fixture.id] }, [fixture]),
    /unsafe_fixture_path/,
  );
});
test("Each arm receives separate scopes and directories and the same bounded context budget", () => {
  const identities = ["none", "official", "product"].map((group) =>
    isolatedIdentity("run", "task", 0, group as ArmResult["group"]),
  );
  assert.equal(new Set(identities.map((identity) => identity.scopeId)).size, 3);
  assert.equal(
    new Set(identities.map((identity) => identity.directory.join("/"))).size,
    3,
  );
  assert.throws(
    () => boundedContext("保留条件与例外。".repeat(300), 128),
    /context_too_large/,
  );
  const context = boundedContext("保留条件与例外。", 128);
  assert.equal(context.truncated, false);
  assert.equal(context.text, "保留条件与例外。");
});
test("Paired comparisons preserve task failures and exclude incomplete infrastructure runs", () => {
  const usage = {
    requests: 1,
    promptTokens: 10,
    completionTokens: 2,
    milliseconds: 3,
  };
  const arms: ArmResult[] = [
    {
      task: "a",
      repeat: 0,
      group: "none",
      status: "completed",
      passed: false,
      taskUsage: usage,
    },
    {
      task: "a",
      repeat: 0,
      group: "official",
      status: "completed",
      passed: true,
      taskUsage: usage,
    },
    {
      task: "a",
      repeat: 0,
      group: "product",
      status: "completed",
      passed: true,
      taskUsage: usage,
    },
    {
      task: "b",
      repeat: 0,
      group: "none",
      status: "completed",
      passed: false,
      taskUsage: usage,
    },
    {
      task: "b",
      repeat: 0,
      group: "official",
      status: "failed",
      passed: false,
      taskUsage: usage,
    },
  ];
  const result = pairedReport(arms);
  assert.equal(result.pairs[0]!.productMinusNone, 1);
  assert.equal(result.pairs[0]!.productMinusOfficial, 0);
  assert.equal(result.pairs[1]!.productMinusNone, null);
  assert.equal(result.excludedPairs, 1);
  assert.equal(result.releaseGate, "not_evaluated");
});
test("Official SDK baseline performs extraction, knowledge creation and contextual reflection", async () => {
  const calls: string[] = [];
  const engine = {
    client: {
      createBank: async (_bank: string, options: Record<string, unknown>) => {
        calls.push("configure");
        assert.equal(options.retainExtractionMode, "concise");
        assert.equal(options.enableObservations, true);
      },
      retain: async () => {
        calls.push("retain");
        return {
          success: true,
          async: false,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      createMentalModel: async () => {
        calls.push("knowledge");
        return { operation_id: "op", mental_model_id: "model" };
      },
      getMentalModel: async () => ({
        content: "Supported mechanism and exception",
      }),
      reflect: async (
        _bank: string,
        _query: string,
        options: Record<string, unknown>,
      ) => {
        calls.push("reflect");
        assert.equal(options.excludeMentalModels, false);
        assert.equal(options.includeFacts, true);
        return {
          text: "Check whether the file is generated before editing.",
          usage: { input_tokens: 1 },
        };
      },
    },
    hasPendingOperations: async () => false,
    operation: async () => ({ status: "completed" }),
  } as unknown as HindsightEngine;
  const result = await officialContext(
    engine,
    "isolated",
    taskFixtures[0]!,
    validateProfile(raw),
  );
  assert.deepEqual(calls, [
    "configure",
    "retain",
    "retain",
    "knowledge",
    "reflect",
  ]);
  assert.ok(result.context.includes("generated"));
  assert.equal(result.identity.officialAgentHooksValidated, false);
  assert.match(result.nativeUsage.status, /not_aggregated/);
  engine.client.retain = async () => ({
    success: false,
    async: false,
    bank_id: "isolated",
    items_count: 0,
  });
  await assert.rejects(
    officialContext(engine, "isolated", taskFixtures[0]!, validateProfile(raw)),
    /official_retain_not_confirmed/,
  );
});
test("A learning timeout fails instead of accepting a pending operation", async () => {
  await assert.rejects(
    until(
      async () => "pending",
      (value) => value === "completed",
      0,
      0,
    ),
    /learning_deadline_exceeded/,
  );
});
test("Official operation polling retains the isolated native bank namespace", () => {
  const engine = new HindsightEngine(
    "http://127.0.0.1:19888",
    "fixture",
    "eval-native-bank",
  );
  assert.equal(engine.bank("eval-native-bank"), "eval-native-bank");
  assert.equal(engine.bank("unrelated-scope-argument"), "eval-native-bank");
});
test("Product evaluation injects one prepared method or falls back to direct experiences", async () => {
  let recallCalls = 0,
    available = true;
  const core = {
    configure: async () => ({}),
    submitMaterial: async () => ({ jobId: "job" }),
    tick: async () => {},
    getJob: async () => ({
      status: "completed",
      usage: { status: "reported" },
      results: [],
      receipt: { replacement: { status: "not_effective" } },
    }),
    syncProjections: async () => {},
    store: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ list: async () => [] }),
    },
    search: async () => ({
      results: available ? [{ method: { id: "method", revision: 1 } }] : [],
    }),
    startTask: async () => ({ taskRef: "task" }),
    prepare: async () => ({
      status: "guidance",
      conditions: [{ text: "version" }],
      steps: [{ stepId: "inspect" }],
    }),
    recall: async () => {
      recallCalls++;
      return [{ usage: "lead" }];
    },
  } as unknown as CoreService;
  const method = await productContext(
    core,
    "scope",
    taskFixtures[0]!,
    validateProfile(raw),
  );
  assert.equal(recallCalls, 0);
  assert.deepEqual(Object.keys(JSON.parse(method.context)), ["preparedMethod"]);
  available = false;
  const fallback = await productContext(
    core,
    "scope2",
    taskFixtures[0]!,
    validateProfile(raw),
  );
  assert.equal(recallCalls, 1);
  assert.deepEqual(Object.keys(JSON.parse(fallback.context)), ["experiences"]);
});
test("Product evaluation waits for every publication batch before searching and records the receipt", async () => {
  let ticks = 0,
    syncs = 0;
  const stages: unknown[] = [];
  const core = {
    configure: async () => ({}),
    submitMaterial: async () => ({ jobId: "job" }),
    tick: async () => {
      ticks++;
    },
    getJob: async () => ({
      status: "completed",
      usage: { status: "reported" },
      results: [
        { kind: "method", id: "method", revision: 1, effective: syncs >= 3 },
      ],
      receipt: {
        replacement: { status: syncs >= 3 ? "effective" : "not_effective" },
      },
    }),
    syncProjections: async () => {
      syncs++;
    },
    store: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          list: async (kind: string) =>
            kind === "projection"
              ? []
              : kind === "method"
                ? [{ id: "method", state: "active", revision: 1 }]
                : [],
        }),
    },
    search: async () => {
      assert.equal(syncs, 3);
      return { results: [{ method: { id: "method", revision: 1 } }] };
    },
    startTask: async () => ({ taskRef: "task" }),
    prepare: async () => ({ status: "guidance" }),
  } as unknown as CoreService;
  await productContext(
    core,
    "scope",
    taskFixtures[0]!,
    { ...validateProfile(raw), pollMilliseconds: 0 },
    stages,
  );
  assert.equal(
    ticks,
    1,
    "Publication waiting must not start another learning tick",
  );
  const publication = stages.find(
    (stage) => (stage as { stage: string }).stage === "publication",
  ) as { status: string; attempts: number };
  assert.equal(publication.status, "effective");
  assert.equal(publication.attempts, 3);
});
test("An unconfirmed active product times out with publication evidence instead of becoming empty recall", async () => {
  let searches = 0;
  const stages: unknown[] = [];
  const core = {
    configure: async () => ({}),
    submitMaterial: async () => ({ jobId: "job" }),
    tick: async () => {},
    getJob: async () => ({
      status: "completed",
      usage: { status: "reported" },
      results: [
        { kind: "method", id: "method", revision: 1, effective: false },
      ],
      receipt: { replacement: { status: "not_effective" } },
    }),
    syncProjections: async () => {},
    store: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          list: async (kind: string) =>
            kind === "method"
              ? [{ id: "method", state: "active", revision: 1 }]
              : [],
        }),
    },
    search: async () => {
      searches++;
      return { results: [] };
    },
  } as unknown as CoreService;
  await assert.rejects(
    productContext(
      core,
      "scope",
      taskFixtures[0]!,
      {
        ...validateProfile(raw),
        learningTimeoutSeconds: 0,
        pollMilliseconds: 0,
      },
      stages,
    ),
    /product_publication_failed:learning_deadline_exceeded/,
  );
  assert.equal(searches, 0);
  const publication = stages.find(
    (stage) => (stage as { stage: string }).stage === "publication",
  ) as { status: string; pending: number; job: unknown };
  assert.equal(publication.status, "failed");
  assert.equal(publication.pending, 1);
  assert.ok(publication.job);
});
