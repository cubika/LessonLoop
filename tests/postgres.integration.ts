import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore, Conflict } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { Effects } from "../src/core/effects.js";
import { identity, methodSchema } from "../src/domain/schema.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "LESSONLOOP_TEST_DATABASE_URL is required for actual PostgreSQL tests",
  );
test("PostgreSQL migration, singleton, durable idempotency, CAS and source-role binding", async () => {
  let store = new ProductStore(url);
  await store.open(true);
  const contender = new ProductStore(url);
  await assert.rejects(contender.open(), /another_core/);
  await contender.close();
  const scope = randomUUID();
  const p = { id: "owner", channel: "user" as const, scopes: [scope] };
  const engine = new HindsightEngine(
    "http://127.0.0.1:19888",
    "integration-unused",
  );
  let core = new CoreService(store, engine);
  await core.configure(p, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  await assert.rejects(
    core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: false,
      recommendation: false,
      review: false,
      notifications: false,
    }),
    Conflict,
  );
  const agent = { ...p, id: `agent-${scope}`, channel: "agent" as const };
  const material = {
    scopeId: scope,
    segments: [
      {
        text: "A real input retained for the store integration test.",
        role: "tool",
      },
    ],
  };
  const accepted = await core.submitMaterial(agent, material, "event-1");
  assert.equal(accepted.accepted, true);
  const stored = (await core.inspect(
    agent,
    "material",
    accepted.materialId,
  )) as unknown as { segments: Array<{ role: string }> };
  assert.equal(stored.segments[0]!.role, "agent");
  await assert.rejects(
    core.submitMaterial(
      agent,
      { ...material, segments: [{ text: "changed", role: "tool" }] },
      "event-1",
    ),
    /idempotency_conflict/,
  );
  await store.close();
  store = new ProductStore(url);
  await store.open();
  core = new CoreService(store, engine);
  const duplicate = await core.submitMaterial(agent, material, "event-1");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.jobId, accepted.jobId);
  await core.cancelJob(agent, accepted.jobId);
  assert.equal((await core.getJob(agent, accepted.jobId)).status, "canceled");
  await assert.rejects(
    core.inspect({ ...p, scopes: [] }, "material", accepted.materialId),
    /not_found/,
  );
  const task = await core.startTask(p, scope);
  const obs = {
    taskRef: task.taskRef,
    eventId: "obs",
    text: "Observed file type",
    values: { kind: "manual" },
  };
  assert.equal((await core.observe(p, obs)).duplicate, false);
  await store.transaction(async (tx) => {
    const saved = await tx.get<any>("task", task.taskRef);
    await tx.put(
      {
        kind: "task",
        id: saved.id,
        scopeId: scope,
        revision: saved.revision + 1,
        value: {
          ...saved,
          revision: saved.revision + 1,
          observations: saved.observations.map((o: any) => ({
            ...o,
            completedStepIds: ["legacy"],
            conditionResults: { old: true },
          })),
        },
      },
      saved.revision,
    );
  });
  assert.equal((await core.observe(p, obs)).duplicate, true);
  await assert.rejects(core.observe(p, { ...obs, completedStepIds: [] }));
  await assert.rejects(
    core.observe(agent, obs),
    /trusted_observation_required/,
  );
  const effects = new Effects(store);
  const configured = (await core.getSettings(p))[0]!;
  await core.configure(p, {
    scopeId: scope,
    expectedRevision: configured.revision,
    learning: true,
    recommendation: false,
    review: true,
    notifications: false,
  });
  const host = { ...p, channel: "host" as const };
  const effectTask = await core.startTask(host, scope);
  await assert.rejects(
    core.prepare(
      { ...agent, taskOwnerId: "wrong-host" },
      { methodId: "missing", revision: 1, taskRef: effectTask.taskRef },
    ),
    /task_unavailable/,
  );
  assert.equal(
    (
      await core.prepare(
        { ...agent, taskOwnerId: host.id },
        { methodId: "missing", revision: 1, taskRef: effectTask.taskRef },
      )
    ).status,
    "target_unavailable",
  );
  const event = {
    eventId: "effect-start",
    taskRef: effectTask.taskRef,
    scopeId: scope,
    kind: "task_started",
    occurredAt: new Date().toISOString(),
    text: "Task started",
  };
  assert.equal(
    (await effects.record(host, [event])).results[0]?.status,
    "accepted",
  );
  assert.equal(
    (await effects.record(host, [event])).results[0]?.status,
    "duplicate",
  );
  assert.equal((await effects.summary([scope])).unknownOutcome, 1);
  assert.equal((await effects.summary([scope])).succeeded, 0);
  assert.equal("successRate" in (await effects.summary([scope])), false);
  await effects.clear(scope);
  assert.equal((await effects.summary([scope])).tasks, 0);
  assert.equal(
    (await effects.record(host, [event])).results[0]?.status,
    "ignored",
  );
  const method = methodSchema.parse({
    ...identity(scope),
    title: "Test method",
    goal: "Test control barrier",
    topics: [],
    applicability: "general",
    conditions: [],
    exceptions: [],
    state: "active",
    steps: [
      {
        stepId: "s1",
        instruction: "Original instruction",
        supportIndexes: [0],
      },
    ],
    completionChecks: [{ text: "Check result" }],
    stopConditions: [],
    supportRefs: [{ kind: "experience", id: "synthetic-support", revision: 1 }],
    change: {
      kind: "create",
      summary: "test fixture",
      caseRefs: [],
      predecessors: [],
    },
  });
  await store.transaction((tx) =>
    tx.put(
      {
        kind: "method",
        id: method.id,
        scopeId: scope,
        revision: 1,
        value: method,
      },
      null,
    ),
  );
  await core.revise(p, method.id, 1, {
    goal: "Changed goal requiring reassessment",
  });
  await core.setState(p, "method", method.id, 2, "disabled");
  await assert.rejects(
    core.setState(p, "method", method.id, 3, "active"),
    /reassessment_required/,
  );
  await store.close();
});
test("Trusted task materials aggregate without source duplication or cross-task mixing", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const scope = randomUUID(),
      host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
      owner = { ...host, channel: "user" as const };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(owner, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const task = await core.startTask(host, scope),
      other = await core.startTask(host, scope);
    const input = (taskRef: string, text: string) => ({
      scopeId: scope,
      context: { taskRef },
      segments: [{ text, role: "tool" }],
    });
    const first = await core.submitMaterial(
      host,
      input(task.taskRef, "actual A"),
      "a",
    );
    const forged = await core.submitMaterial(
      { ...host, channel: "agent" },
      input(task.taskRef, "agent assertion"),
      "forged",
    );
    await core.submitMaterial(
      host,
      input(other.taskRef, "other task"),
      "other",
    );
    const next = await core.submitMaterial(
      host,
      input(task.taskRef, "actual B"),
      "b",
    );
    const job = await core.getJob(host, next.jobId);
    assert.equal(job.kind, "synthesis");
    assert.deepEqual(job.materialIds, [first.materialId, next.materialId]);
    assert.equal(job.materialIds.includes(forged.materialId), false);
    const duplicate = await core.submitMaterial(
      host,
      input(task.taskRef, "actual B"),
      "b",
    );
    assert.equal(duplicate.jobId, next.jobId);
    await assert.rejects(
      core.submitMaterial(
        { ...host, id: "other-host" },
        input(task.taskRef, "wrong owner"),
        "wrong",
      ),
      /task_identity_mismatch/,
    );
    const otherScope = randomUUID();
    await assert.rejects(
      core.submitMaterial(
        { ...host, scopes: [scope, otherScope] },
        { ...input(task.taskRef, "wrong scope"), scopeId: otherScope },
        "wrong-scope",
      ),
      /task_identity_mismatch/,
    );
    const raw = {
      taskRef: task.taskRef,
      eventId: "missing-time",
      text: "Actual observation",
    };
    assert.equal(
      (await core.recordHostObservation(host, raw)).duplicate,
      false,
    );
    assert.equal((await core.recordHostObservation(host, raw)).duplicate, true);
    const all = await store.transaction((tx) =>
      tx.list<any>("material", [scope]),
    );
    assert.equal(
      all.find((m) => m.id === first.materialId).sourceFamily,
      all.find((m) => m.id === next.materialId).sourceFamily,
    );
    assert.equal(
      all.find((m) => m.id === forged.materialId).sourceFamily,
      undefined,
    );
  } finally {
    await store.close();
  }
});
