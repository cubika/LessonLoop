import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";
import { identity } from "../src/domain/schema.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw Error("isolated test database required");
test("Old storage is explicitly rejected without modifying its version", async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const store = new ProductStore(url);
  try {
    for (const version of [1, 2]) {
      await db.query("UPDATE lessonloop.schema_version SET version=$1", [
        version,
      ]);
      await assert.rejects(store.open(), /incompatible_product_schema/);
      assert.equal(
        (await db.query("SELECT version FROM lessonloop.schema_version"))
          .rows[0].version,
        version,
      );
    }
  } finally {
    await db.query("UPDATE lessonloop.schema_version SET version=3");
    await store.close();
    await db.end();
  }
});
class Engine extends HindsightEngine {
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async eraseRegisteredBank() {
    return { erased: true, remaining: {} };
  }
  override async deleteAllProjectionRevisions() {
    return { erased: true, deleted: 0 };
  }
}
test("Erasure clears cached source metadata and shared context without deleting sibling text", async () => {
  const store = new ProductStore(url);
  await store.open();
  const scopeId = randomUUID(),
    p = { id: randomUUID(), channel: "user" as const, scopes: [scopeId] };
  const core = new CoreService(store, new Engine());
  try {
    await core.configure(p, {
      scopeId,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const receipt = await core.submitSource(
      p,
      {
        scopeId,
        context: { note: "shared-private-context" },
        segments: [
          {
            role: "user",
            text: "erase-me",
            author: "private-author",
            locator: "private-location",
          },
          { role: "user", text: "keep-me" },
        ],
      },
      "two",
    );
    const erasedId = receipt.sources[0]!.id,
      keptId = receipt.sources[1]!.id;
    await core.cancelJob(p, receipt.jobId);
    const siblingJob = {
      ...identity(scopeId),
      sourceIds: [keptId],
      sourceRefs: [keptId],
      status: "completed",
      stage: "done",
      payload: { modelQuery: "shared-private-context" },
    };
    const siblingBank = {
      ...identity(scopeId),
      sourceRefs: [keptId],
      jobId: siblingJob.id,
      kind: "learning_job",
      state: "active",
    };
    await store.transaction(async (tx) => {
      await tx.put(
        {
          kind: "job",
          id: siblingJob.id,
          scopeId,
          revision: 1,
          value: siblingJob,
        },
        null,
      );
      await tx.put(
        {
          kind: "engine_bank",
          id: siblingBank.id,
          scopeId,
          revision: 1,
          value: siblingBank,
        },
        null,
      );
    });
    const view = {
      ...identity(scopeId),
      sequence: 1,
      topic: "work",
      goal: "goal",
      context: {},
      attempts: [],
      result: { status: "unknown", summary: "pending", evidenceIndexes: [] },
      evidence: [
        {
          fingerprint: erasedId,
          excerpt: "erase-me",
          role: "user",
          relation: "supports",
          author: "private-author",
          locator: "private-location",
        },
      ],
      unresolved: [],
      coverage: [],
    };
    await store.transaction((tx) =>
      tx.put(
        { kind: "work_view", id: view.id, scopeId, revision: 1, value: view },
        null,
      ),
    );
    await core.controlSource(p, {
      id: erasedId,
      expectedRevision: 1,
      action: "erase",
    });
    await core.processSourceCleanups([scopeId]);
    const erased = (await core.inspect(p, "source", erasedId)) as any,
      kept = (await core.inspect(p, "source", keptId)) as any;
    assert.equal(erased.segment, undefined);
    assert.equal(erased.erased, true);
    assert.equal(kept.segment.text, "keep-me");
    assert.equal(kept.blocked, false);
    assert.equal(kept.context, undefined);
    assert.equal(
      ((await core.inspect(p, "engine_bank", siblingBank.id)) as any).state,
      "erased",
    );
    assert.equal(
      JSON.stringify(await core.inspect(p, "job", siblingJob.id)).includes(
        "shared-private-context",
      ),
      false,
    );
    const cached = (await core.inspect(p, "work_view", view.id)) as any;
    assert.equal(cached.evidence[0].author, undefined);
    assert.equal(cached.evidence[0].locator, undefined);
  } finally {
    await store.close();
  }
});
