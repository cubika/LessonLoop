import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService, type Principal } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { handleHook } from "../src/adapters/copilot/hook.js";
import { Effects, type TaskFeedback } from "../src/core/effects.js";
import { TaskOutcomes } from "../src/core/task-outcomes.js";
import { dispatch } from "../src/core/server.js";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("isolated database required");
type Input = Parameters<HindsightEngine["assessTaskOutcome"]>[0];
type Response = Awaited<ReturnType<HindsightEngine["assessTaskOutcome"]>>;
const observed: Input["observations"] = [
  {
    id: "goal",
    role: "user",
    text: "Fix checkout totals and run the checkout tests.",
  },
  { id: "check", role: "tool", text: "Checkout tests: 12 passed, 0 failed." },
];
const answer = (
  status: TaskFeedback["taskOutcome"] = "succeeded",
  id = "check",
  excerpt = observed[1]!.text,
): Response => ({
  result: {
    taskOutcome: status,
    text: "Checkout verification recorded.",
    evidence: [{ id, excerpt }],
  },
  usage: { input_tokens: 100, output_tokens: 20 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: test.TestContext, review = true) {
  let store = new ProductStore(url!);
  await store.open(true);
  t.after(() => store.close());
  const scopeId = randomUUID();
  const host: Principal = {
    id: randomUUID(),
    channel: "host",
    scopes: [scopeId],
  };
  const user: Principal = { ...host, channel: "user" };
  const engine = new HindsightEngine("http://127.0.0.1:19888", "unused");
  const calls: Input[] = [];
  let respond = async (_input: Input): Promise<Response> => answer();
  engine.assessTaskOutcome = async (input) => {
    calls.push(input);
    return respond(input);
  };
  let core = new CoreService(store, engine);
  const settings = {
    learning: false,
    recommendation: false,
    review,
    notifications: false,
  };
  const configure = async (change: Partial<typeof settings>) => {
    Object.assign(settings, change);
    const current = await store.transaction((tx) =>
      tx.get<{ revision: number }>("settings", scopeId),
    );
    await core.configure(user, {
      scopeId,
      expectedRevision: current?.revision ?? 0,
      ...settings,
    });
  };
  await configure({});
  const binding = "copilot-session:" + randomUUID();
  const { taskRef } = await core.startTask(host, scopeId, binding);
  const read = async () => {
    const row = await store.transaction((tx) =>
      tx.get<TaskFeedback>("task_feedback", taskRef),
    );
    assert.ok(row);
    return row;
  };
  const payload = async (extra = {}) => ({
    taskRef,
    generation: (await read()).outcomeGeneration ?? 0,
    checkpoint: { path: "transcript", offset: 100 },
    observations: observed,
    gaps: [],
    trigger: "agentStop",
    ...extra,
  });
  return {
    scopeId,
    host,
    user,
    engine,
    calls,
    taskRef,
    configure,
    read,
    payload,
    get store() {
      return store;
    },
    get core() {
      return core;
    },
    model: (fn: typeof respond) => {
      respond = fn;
    },
    capture: async (extra = {}, caller = host) =>
      new TaskOutcomes(store).capture(caller, await payload(extra)),
    tick: () => new TaskOutcomes(store).tick(engine, [scopeId]),
    start: () => core.startTask(host, scopeId, binding),
    restart: async () => {
      await store.close();
      store = new ProductStore(url!);
      await store.open();
      core = new CoreService(store, engine);
    },
    correct: async (
      status: TaskFeedback["taskOutcome"],
      caller = user,
      revision?: number,
    ) =>
      new Effects(store).update(caller, {
        taskRef,
        field: "taskOutcome",
        taskOutcome: status,
        text: "User checked the result.",
        expectedRevision: revision ?? (await read()).revision,
      }),
    retryNow: async () =>
      store.transaction(async (tx) => {
        const state = await tx.get<{
          id: string;
          scopeId: string;
          revision: number;
          attempts: number;
        }>("task_outcome", taskRef);
        assert.ok(state);
        const next = { ...state, revision: state.revision + 1, retryAt: 0 };
        await tx.put(
          {
            kind: "task_outcome",
            id: state.id,
            scopeId,
            revision: next.revision,
            value: next,
          },
          state.revision,
        );
      }),
  };
}

test("real hook dispatch persists an AI session outcome with review alone and no playbook", async (t) => {
  const f = await fixture(t);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lessonloop-outcome-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl"),
    sessionId = randomUUID();
  const stamp = (n: number) =>
    new Date(Date.now() - 10000 + n * 1000).toISOString();
  await writeFile(
    path,
    JSON.stringify({
      type: "session.start",
      data: { sessionId, context: { cwd: root } },
    }) + "\n",
  );
  const config = {
    baseUrl: "http://127.0.0.1:1",
    token: "unused",
    scopeId: f.scopeId,
    allowedRoots: [root],
    stateRoot: join(root, "state"),
  };
  const rpc = (operation: string, input: unknown, key: string) =>
    dispatch(f.core, f.host, operation, input, key);
  await handleHook(
    config,
    {
      cwd: root,
      sessionId,
      transcriptPath: path,
      timestamp: stamp(1),
      prompt: observed[0]!.text,
    },
    "userPromptTransformed",
    rpc,
  );
  const records = [
    { id: "u1", type: "user.message", data: { content: observed[0]!.text } },
    {
      id: "t1",
      type: "tool.execution_start",
      data: { toolCallId: "check", toolName: "powershell" },
    },
    {
      id: "t2",
      type: "tool.execution_complete",
      data: {
        toolCallId: "check",
        success: true,
        result: { content: observed[1]!.text },
      },
    },
  ].map((record, i) => ({ ...record, timestamp: stamp(i + 2) }));
  await appendFile(
    path,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  f.model(async (input) => {
    const check = input.observations.find((o) => o.role === "tool")!;
    return answer("succeeded", check.id, observed[1]!.text);
  });
  await handleHook(
    config,
    {
      cwd: root,
      sessionId,
      transcriptPath: path,
      timestamp: stamp(6),
      stopReason: "end_turn",
    },
    "agentStop",
    rpc,
  );
  await f.core.tick([f.scopeId]);
  const rows = await new Effects(f.store).cases([f.scopeId]);
  const completed = rows.find((row) => row.outcomeSource === "ai")!;
  assert.ok(completed);
  assert.equal(completed.taskOutcome, "succeeded");
  assert.equal(completed.outcomeScope, "session");
  assert.deepEqual(completed.feedback, []);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    await f.store.transaction((tx) => tx.list("source", [f.scopeId])),
    [],
  );
});

test("all statuses persist with provenance; user corrections survive restart and retain CAS and permissions", async (t) => {
  const f = await fixture(t);
  for (const [index, status] of (
    ["succeeded", "failed", "abandoned", "unknown"] as const
  ).entries()) {
    const text =
      status === "abandoned"
        ? "I abandon this checkout task."
        : observed[1]!.text;
    const observations = [
      ...observed,
      {
        id: "result-" + index,
        role: status === "abandoned" ? ("user" as const) : ("tool" as const),
        text,
      },
    ];
    f.model(async () => answer(status, "result-" + index, text));
    await f.capture({
      observations,
      checkpoint: { path: "transcript", offset: 100 + index },
    });
    await f.tick();
    assert.equal((await f.read()).taskOutcome, status);
    assert.equal((await f.read()).outcomeSource, "ai");
  }
  const oldRevision = (await f.read()).revision;
  await f.correct("succeeded");
  await assert.rejects(
    f.correct("failed", f.user, oldRevision),
    /revision_conflict/,
  );
  await assert.rejects(f.correct("failed", f.host), /feedback_user_confirmed/);
  await assert.rejects(f.capture({}, f.user), /feedback_writer_denied/);
  await assert.rejects(
    f.capture({}, { ...f.host, id: randomUUID() }),
    /feedback_unavailable/,
  );
  await assert.rejects(
    f.correct("failed", { ...f.user, scopes: [] }),
    /feedback_unavailable/,
  );
  await assert.rejects(
    f.correct("failed", { ...f.host, channel: "agent" }),
    /feedback_writer_denied/,
  );
  const corrected = await f.read();
  await f.restart();
  assert.deepEqual(await f.read(), corrected);
  await f.capture({ checkpoint: { path: "transcript", offset: 500 } });
  await f.tick();
  assert.deepEqual(await f.read(), corrected);
});

test("in-flight assessment cannot overwrite a user correction or a newer prompt", async (t) => {
  const f = await fixture(t);
  for (const action of ["resume", "correct"] as const) {
    const entered = deferred<void>(),
      pending = deferred<Response>();
    f.model(async () => {
      entered.resolve();
      return pending.promise;
    });
    await f.capture({
      checkpoint: {
        path: "transcript",
        offset: action === "resume" ? 100 : 300,
      },
    });
    const running = f.tick();
    await entered.promise;
    if (action === "resume")
      await f.capture({
        trigger: "userPromptTransformed",
        checkpoint: { path: "transcript", offset: 200 },
        observations: [
          {
            id: "follow-up",
            role: "user",
            text: "Also fix shipping; that remains unfinished.",
          },
        ],
      });
    else await f.correct("failed");
    pending.resolve(answer());
    await running;
    assert.equal(
      (await f.read()).taskOutcome,
      action === "resume" ? "unknown" : "failed",
    );
    assert.equal(
      (await f.read()).outcomeSource,
      action === "resume" ? undefined : "user",
    );
  }
});

test("model failures and forged evidence stop after three attempts without marking the task failed", async (t) => {
  const f = await fixture(t);
  const responses = [
    async (): Promise<Response> => {
      throw new Error("model_unavailable");
    },
    async () => answer("succeeded", "check", "invented result"),
    async () => answer("succeeded", "missing", observed[1]!.text),
  ];
  for (const [index, response] of responses.entries()) {
    f.model(response);
    const before = f.calls.length;
    await f.capture({
      observations: [
        ...observed,
        {
          id: "attempt-" + index,
          role: "host",
          text: "Assessment requested " + index,
        },
      ],
      checkpoint: { path: "transcript", offset: 100 + index },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await f.retryNow();
      await f.tick();
    }
    await f.retryNow();
    await f.tick();
    assert.equal(f.calls.length - before, 3);
    assert.equal((await f.read()).taskOutcome, "unknown");
    assert.equal((await f.read()).outcomeAssessment, "unavailable");
    assert.equal((await f.read()).outcomeEvidence, undefined);
  }
});

test("clear and review generations reject old captures; disable preserves completed results and erasure clears them", async (t) => {
  const f = await fixture(t);
  const original = await f.payload();
  await f.capture();
  await f.tick();
  const completed = await f.read();
  await f.configure({ review: false });
  assert.equal((await f.read()).taskOutcome, completed.taskOutcome);
  assert.deepEqual((await f.read()).outcomeEvidence, completed.outcomeEvidence);
  await f.configure({ review: true });
  await assert.rejects(
    new TaskOutcomes(f.store).capture(f.host, original),
    /outcome_generation_changed/,
  );
  await f.store.transaction((tx) =>
    TaskOutcomes.invalidate(tx, f.scopeId, f.taskRef),
  );
  assert.equal((await f.read()).taskOutcome, "unknown");
  assert.equal((await f.read()).outcomeEvidence, undefined);
  const beforeClear = await f.payload();
  await new Effects(f.store).clear(f.scopeId);
  await f.start();
  assert.equal((await f.read()).cleared, true);
  await assert.rejects(
    new TaskOutcomes(f.store).capture(f.host, beforeClear),
    /feedback_unavailable/,
  );
  await f.store.transaction(async (tx) => {
    const task = await tx.get<{
      id: string;
      scopeId: string;
      createdAt: string;
    }>("task", f.taskRef);
    assert.ok(task);
    await new Effects(f.store).register(tx, task);
  });
  await assert.rejects(
    new TaskOutcomes(f.store).capture(f.host, beforeClear),
    /outcome_generation_changed/,
  );
  await f.capture({ gaps: ["outcome_generation_changed"] });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "unknown");
});

test("transient gaps recover, checkpoints advance on duplicate capture, and permanent gaps stay unknown", async (t) => {
  const f = await fixture(t);
  await f.capture({
    observations: [observed[0]!],
    gaps: ["transcript_unavailable"],
    checkpoint: { path: "unavailable", offset: 0 },
  });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "unknown");
  assert.equal(f.calls.length, 0, "a known collection gap needs no model call");
  await f.capture();
  await f.configure({ notifications: true });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "succeeded");
  const before = await f.read();
  const calls = f.calls.length;
  await f.capture({ checkpoint: { path: "transcript", offset: 200 } });
  await f.capture({
    checkpoint: { path: "transcript", offset: 150 },
    observations: [{ id: "old", role: "user", text: "Stale prompt" }],
  });
  await f.tick();
  assert.deepEqual(await f.read(), before);
  assert.equal(f.calls.length, calls);
  await f.capture({
    checkpoint: { path: "transcript", offset: 300 },
    gaps: ["outcome_input_budget"],
  });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "unknown");
  assert.equal(f.calls.length, calls, "permanent gaps skip model work");
  await f.capture({
    checkpoint: { path: "transcript", offset: 400 },
    observations: [
      { id: "latest", role: "tool", text: "Another successful check" },
    ],
  });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "unknown");
});

test("queued snapshots are rechecked before dispatch and source invalidation blocks an in-flight result", async (t) => {
  const f = await fixture(t);
  await f.capture();
  const other = await f.core.startTask(
    f.host,
    f.scopeId,
    "copilot-session:" + randomUUID(),
  );
  await new TaskOutcomes(f.store).capture(f.host, {
    ...(await f.payload()),
    taskRef: other.taskRef,
  });
  const entered = deferred<void>(),
    pending = deferred<Response>();
  f.model(async () => {
    entered.resolve();
    return pending.promise;
  });
  const running = f.tick();
  await entered.promise;
  await f.store.transaction((tx) => TaskOutcomes.invalidate(tx, f.scopeId));
  pending.resolve(answer());
  await running;
  assert.equal(f.calls.length, 1);
  assert.equal((await f.read()).taskOutcome, "unknown");
});

test("enabling review in an existing session creates missing feedback without reviving cleared data", async (t) => {
  const f = await fixture(t, false);
  assert.equal(
    await f.store.transaction((tx) => tx.get("task_feedback", f.taskRef)),
    undefined,
  );
  await f.configure({ review: true });
  assert.equal((await f.start()).taskRef, f.taskRef);
  assert.equal((await f.read()).taskOutcome, "unknown");
  await f.capture();
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "succeeded");
  await new Effects(f.store).clear(f.scopeId);
  await f.start();
  assert.equal((await f.read()).cleared, true);
});

test("recovered transcript evidence keeps event chronology and budgets skip model calls", async (t) => {
  const f = await fixture(t);
  await f.capture({
    observations: [
      { ...observed[0]!, occurredAt: "2026-09-15T00:00:00Z" },
      {
        id: "cancel",
        role: "user",
        text: "Drop this task.",
        occurredAt: "2026-09-15T00:00:03Z",
      },
    ],
  });
  await f.capture({
    checkpoint: { path: "transcript", offset: 200 },
    observations: [{ ...observed[1]!, occurredAt: "2026-09-15T00:00:02Z" }],
  });
  f.model(async (input) => {
    assert.deepEqual(
      input.observations.map((o) => o.id),
      ["goal", "check", "cancel"],
    );
    return answer("abandoned", "cancel", "Drop this task.");
  });
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "abandoned");
  await f.capture({
    checkpoint: { path: "transcript", offset: 300 },
    observations: Array.from({ length: 192 }, (_, i) => ({
      id: "many-" + i,
      role: "tool",
      text: "Observed " + i,
    })),
  });
  const state = await f.store.transaction((tx) =>
    tx.get<any>("task_outcome", f.taskRef),
  );
  assert.equal(state.observations.length, 192);
  assert.ok(state.gaps.includes("outcome_input_budget"));
  await f.tick();
  assert.equal((await f.read()).taskOutcome, "unknown");
  assert.equal(f.calls.length, 1);
});
