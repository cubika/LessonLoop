import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/method-engine.js";
import { digest, identity } from "../src/domain/schema.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
class IdleEngine extends HindsightEngine {
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override forJob() {
    return this;
  }
  override async stageEvidence() {
    throw new Error("pause at native boundary");
  }
}
test("Automatic cross-case review requires independent families and freezes a deduplicated source set", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const scope = randomUUID(),
      p = { id: randomUUID(), channel: "user" as const, scopes: [scope] },
      core = new CoreService(store, new IdleEngine());
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const topic = "regeneration";
    await store.transaction((tx) =>
      tx.put(
        {
          kind: "learning_topic",
          id: digest([scope, topic]),
          revision: 1,
          scopeId: scope,
          value: {
            id: digest([scope, topic]),
            revision: 1,
            scopeId: scope,
            name: topic,
          },
        },
        null,
      ),
    );
    const add = async (key: string, family: string) => {
      const receipt = await core.submitMaterial(
        p,
        {
          scopeId: scope,
          segments: [{ text: "Observed " + key, role: "user" }],
        },
        key,
      );
      const source = (await core.listSources(p)).find(
        (s) => s.materialId === receipt.materialId,
      )!;
      await store.transaction(async (tx) => {
        const job = await tx.get<any>("job", receipt.jobId);
        await tx.put(
          {
            kind: "job",
            id: job.id,
            revision: job.revision + 1,
            scopeId: scope,
            value: {
              ...job,
              revision: job.revision + 1,
              status: "completed",
              stage: "done",
            },
          },
          job.revision,
        );
        const c = {
          ...identity(scope),
          sourceFamily: family,
          topic,
          goal: "Preserve generated edits",
          context: {},
          attempts: [],
          result: {
            status: "unknown",
            summary: "Observed",
            evidenceIndexes: [0],
          },
          evidence: [
            {
              excerpt: "Observed " + key,
              role: "user",
              relation: "supports",
              fingerprint: source.id,
            },
          ],
          unresolved: [],
          coverage: [],
          methodUses: [],
        };
        await tx.put(
          {
            kind: "work_case",
            id: c.id,
            revision: 1,
            scopeId: scope,
            value: c,
          },
          null,
        );
      });
      return receipt;
    };
    // Use real bank names for material identities, while preventing actual model calls in tick.
    core.engine.forJob = (id: string) => {
      const e = Object.create(core.engine) as HindsightEngine;
      e.bank = () => "lessonloop-job-" + id;
      return e;
    };
    const a = await add("a", "family-a"),
      b = await add("b", "family-a");
    await core.tick([scope]);
    assert.equal(
      (await store.transaction((tx) => tx.list<any>("job", [scope]))).filter(
        (j) => j.synthesisTopicId,
      ).length,
      0,
    );
    const c = await add("c", "family-c");
    await core.tick([scope]);
    let jobs = (
      await store.transaction((tx) => tx.list<any>("job", [scope]))
    ).filter((j) => j.synthesisTopicId);
    assert.equal(jobs.length, 1);
    assert.deepEqual(
      new Set(jobs[0].materialIds),
      new Set([a.materialId, b.materialId, c.materialId]),
    );
    assert.equal(jobs[0].inputCaseRefs.length, 3);
    assert.equal(jobs[0].decisions[0].families, 2);
    await store.transaction(async (tx) => {
      const j = jobs[0];
      await tx.put(
        {
          kind: "job",
          id: j.id,
          revision: j.revision + 1,
          scopeId: scope,
          value: {
            ...j,
            revision: j.revision + 1,
            status: "completed",
            stage: "done",
          },
        },
        j.revision,
      );
    });
    await core.tick([scope]);
    jobs = (
      await store.transaction((tx) => tx.list<any>("job", [scope]))
    ).filter((j) => j.synthesisTopicId);
    assert.equal(jobs.length, 1);
    const d = await add("d", "family-d");
    await core.tick([scope]);
    jobs = (
      await store.transaction((tx) => tx.list<any>("job", [scope]))
    ).filter((j) => j.synthesisTopicId);
    assert.equal(jobs.length, 2);
    assert.equal(
      jobs.some((j) => j.materialIds.includes(d.materialId)),
      true,
    );
  } finally {
    await store.close();
  }
});
