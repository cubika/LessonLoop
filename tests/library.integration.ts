import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { dispatch } from "../src/core/server.js";
import { Effects } from "../src/core/effects.js";
import { identity, digest, methodSchema } from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
const row = (kind: string, value: any) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value,
});
class Engine extends HindsightEngine {
  calls = 0;
  beforeReturn?: () => Promise<void>;
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async checkObservations(
    input: Parameters<HindsightEngine["checkObservations"]>[0],
  ) {
    this.calls++;
    await this.beforeReturn?.();
    return {
      result: {
        conditions: input.conditions.map((c) => ({
          key: c.key,
          result: "true" as const,
          excerpt: "Observed version 2",
        })),
        completed_steps: [],
      },
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  }
}
async function setup(store: ProductStore) {
  const scope = randomUUID(),
    owner = { id: randomUUID(), channel: "user" as const, scopes: [scope] },
    host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
    engine = new Engine(),
    core = new CoreService(store, engine);
  await core.configure(owner, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: true,
    review: true,
    notifications: false,
  });
  const source = digest(scope),
    e = experienceSchema.parse({
      ...identity(scope),
      conclusion: "Extensions survive the observed pipeline",
      level: "L1",
      purpose: "fact",
      applicability: "conditional",
      conditions: [{ text: "Observed version 2" }],
      exceptions: [],
      topics: ["pipeline"],
      entities: ["extension"],
      basis: "observed",
      assessment: "supported",
      evidence: [
        {
          excerpt: "Observed version 2",
          role: "tool",
          relation: "supports",
          fingerprint: source,
        },
      ],
      derivedFrom: [],
      sourceFingerprints: [source],
      state: "active",
    });
  const methods = ["a", "b", "c"].map((title) =>
    methodSchema.parse({
      ...identity(scope),
      title,
      goal: "Preserve extensions",
      topics: ["pipeline"],
      applicability: "general",
      conditions: [],
      exceptions: [],
      state: "active",
      steps: [
        { stepId: "s1", instruction: "Check output", supportIndexes: [0] },
      ],
      completionChecks: [{ text: "Output checked" }],
      stopConditions: [],
      supportRefs: [{ kind: "experience", id: e.id, revision: 1 }],
      change: {
        kind: "create",
        summary: "Fixture",
        caseRefs: [],
        predecessors: [],
      },
    }),
  );
  await store.transaction(async (tx) => {
    await tx.put(
      row("source", {
        id: source,
        scopeId: scope,
        revision: 1,
        blocked: false,
      }),
      null,
    );
    await tx.put(row("experience", e), null);
    for (const [kind, item] of [
      ["experience", e] as const,
      ...methods.map((m) => ["method", m] as const),
    ]) {
      if (kind === "method") await tx.put(row(kind, item), null);
      await tx.put(
        row("projection", {
          id: item.id,
          scopeId: scope,
          revision: 1,
          objectKind: kind,
          objectRevision: 1,
          confirmed: true,
        }),
        null,
      );
    }
  });
  return { scope, owner, host, engine, core, e, methods };
}
test("Method library pagination binds filters, pins persist, and users cannot forge host observations", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const f = await setup(store),
      m = f.methods[2]!;
    await f.core.pinMethod(f.owner, { id: m.id, pinned: true });
    const first = (await f.core.browseMethods(f.owner, {
      topic: "pipeline",
      limit: 1,
    })) as any;
    assert.equal(first.items[0].id, m.id);
    assert.equal(first.total, 3);
    const next = (await f.core.browseMethods(f.owner, {
      topic: "pipeline",
      limit: 2,
      cursor: first.nextCursor,
    })) as any;
    assert.equal(next.items.length, 2);
    assert.ok(next.items.every((v: any) => v.id !== m.id));
    await assert.rejects(
      f.core.browseMethods(f.owner, {
        query: "changed",
        limit: 2,
        cursor: first.nextCursor,
      }),
      /invalid_cursor/,
    );
    assert.equal(
      ((await f.core.browseMethods({ ...f.owner, scopes: [] }, {})) as any[])
        .length,
      0,
    );
    const task = await f.core.startTask(f.host, f.scope);
    const prepared = await f.core.prepare(f.owner, {
      taskRef: task.taskRef,
      methodId: m.id,
      revision: m.revision,
    });
    assert.ok(prepared.methodUseRef);
    assert.equal((await f.core.listTasks(f.owner))[0]?.taskRef, task.taskRef);
    await f.core.recordHostObservation(f.host, {
      taskRef: task.taskRef,
      eventId: "actual",
      text: "Observed version 2",
    });
    const assessed = await f.core.reassessTask(f.owner, {
      taskRef: task.taskRef,
      methodId: m.id,
      revision: m.revision,
      methodUseRef: prepared.methodUseRef,
    });
    assert.equal((assessed as any).status, "assessed");
    await assert.rejects(
      dispatch(f.core, f.owner, "recordTaskObservation", [], "fake"),
      /trusted_host_required/,
    );
    await assert.rejects(
      f.core.observe(f.owner, {
        taskRef: task.taskRef,
        eventId: "fake",
        text: "not host evidence",
        values: {},
        completedStepIds: [],
        conditionResults: {},
      }),
      /task_identity_mismatch/,
    );
    const rating = {
      taskRef: task.taskRef,
      methodUseRef: prepared.methodUseRef,
      rating: "helpful",
      text: "The diagnostic step helped",
    };
    assert.equal(
      (await f.core.rateMethodUse(f.owner, rating, "rating-1")).results[0]
        ?.status,
      "accepted",
    );
    assert.equal(
      (await f.core.rateMethodUse(f.owner, rating, "rating-1")).results[0]
        ?.status,
      "duplicate",
    );
    await assert.rejects(
      f.core.rateMethodUse(
        f.owner,
        { ...rating, rating: "incorrect" },
        "rating-1",
      ),
      /event_conflict/,
    );
    const effects = new Effects(store);
    await effects.clear(f.scope);
    assert.equal(
      (await f.core.rateMethodUse(f.owner, rating, "rating-1")).results[0]
        ?.status,
      "ignored",
    );
    assert.equal(
      ((await f.core.inspect(f.owner, "method", m.id)) as any).revision,
      1,
    );
  } finally {
    await store.close();
  }
});
test("Targeted recall uses stored host evidence, caches checks and rejects stale or foreign context", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const f = await setup(store),
      task = await f.core.startTask(f.host, f.scope);
    const input = { query: "extension", target: { id: f.e.id, revision: 1 } };
    assert.equal(
      (await f.core.recallRequest(f.owner, input)).results[0]?.usage,
      "lead",
    );
    await f.core.recordHostObservation(f.host, {
      taskRef: task.taskRef,
      eventId: "read",
      text: "Observed version 2",
    });
    const request = {
      ...input,
      contextEvidence: { taskRef: task.taskRef, observationIds: ["read"] },
    };
    assert.equal(
      (await f.core.recallRequest(f.owner, request)).results[0]?.usage,
      "guidance",
    );
    assert.equal(
      (await f.core.recallRequest(f.owner, request)).results[0]?.usage,
      "guidance",
    );
    assert.equal(f.engine.calls, 1);
    await assert.rejects(
      f.core.recallRequest(
        { ...f.host, id: "other", channel: "agent" },
        request,
      ),
      /task_unavailable/,
    );
    await assert.rejects(
      f.core.recallRequest(f.owner, {
        ...request,
        target: { id: f.e.id, revision: 2 },
      }),
      /target_changed/,
    );
    await f.core.recordHostObservation(f.host, {
      taskRef: task.taskRef,
      eventId: "later",
      text: "Later observation",
    });
    f.engine.beforeReturn = () =>
      f.core
        .recordHostObservation(f.host, {
          taskRef: task.taskRef,
          eventId: "race",
          text: "Context changed",
        })
        .then(() => undefined);
    await assert.rejects(
      f.core.recallRequest(f.owner, request),
      /context_changed_during_assessment/,
    );
  } finally {
    await store.close();
  }
});
