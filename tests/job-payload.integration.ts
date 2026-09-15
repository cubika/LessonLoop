import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CoreService } from "../src/core/service.js";
import { ProductStore } from "../src/store/postgres.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("isolated test database required");
const draft = {
  workView: null,
  experiences: [],
  playbook: null,
  splitPlaybooks: null,
  decisions: [],
};

class Engine extends HindsightEngine {
  requests: unknown[][] = [];
  fail = new Set(["compose", "assess"]);
  composeComplete = false;
  assessComplete = false;
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override forJob() {
    return this;
  }
  override async findModelOperation() {
    return undefined;
  }
  override async createModel(
    scope: string,
    id: string,
    query: string,
    tags: string[],
    schema: Record<string, unknown>,
  ) {
    this.requests.push(structuredClone([scope, id, query, tags, schema]));
    const stage = id.startsWith("assess-") ? "assess" : "compose";
    if (this.fail.delete(stage)) throw new Error("submission_response_lost");
    return { operation_id: stage + "-operation", mental_model_id: id };
  }
  override async operation(_scope: string, id: string): Promise<any> {
    return {
      status: (
        id === "compose-operation" ? this.composeComplete : this.assessComplete
      )
        ? "completed"
        : "pending",
    };
  }
  override async model(_scope: string, id: string): Promise<any> {
    return {
      reflect_response: {
        structured_output: id.startsWith("assess-")
          ? {
              acceptedExperienceIndexes: [],
              playbookSupported: false,
              substantiveChange: false,
              supportedEvidenceChange: false,
              acceptedPlaybookIndexes: [],
              splitCoherent: false,
              reasons: [],
            }
          : draft,
      },
    };
  }
  override async eraseRegisteredBank() {
    return { erased: true, remaining: {} };
  }
  override async deleteAllProjectionRevisions() {
    return { erased: true, deleted: 0 };
  }
  override async drainRegisteredBank() {
    return { drained: true, remaining: 0 };
  }
}

async function setup(store: ProductStore, engine: Engine) {
  const scope = randomUUID(),
    p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
  const core = new CoreService(store, engine);
  await core.configure(p, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const receipt = await core.submitSource(
    p,
    {
      scopeId: scope,
      segments: [
        { role: "user", text: "A durable observation for payload replay" },
      ],
      context: { z: "last", a: "first" },
    },
    randomUUID(),
  );
  await store.transaction(async (tx) => {
    const job = (await tx.get<any>("job", receipt.jobId))!;
    await tx.put(
      {
        kind: "job",
        id: job.id,
        scopeId: scope,
        revision: job.revision + 1,
        value: { ...job, revision: job.revision + 1, stage: "compose" },
      },
      job.revision,
    );
  });
  return { scope, p, receipt, core };
}

test("Generation and assessment replay exact requests after PostgreSQL round trips without stored prompts", async () => {
  let store = new ProductStore(url!);
  await store.open();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const engine = new Engine();
    const f = await setup(store, engine);
    await f.core.tick([f.scope]);
    const raw = (
      await db.query(
        "SELECT value FROM lessonloop.objects WHERE kind='job' AND id=$1",
        [f.receipt.jobId],
      )
    ).rows[0].value;
    assert.equal(raw.status, "uncertain");
    assert.ok(raw.payload.inputSources.length);
    assert.equal(raw.modelQuery, undefined);
    assert.equal(raw.payload.modelQuery, undefined);
    assert.equal(raw.payload.assessmentQuery, undefined);
    assert.equal(
      JSON.stringify(raw).split("A durable observation for payload replay")
        .length - 1,
      1,
    );
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    let core = new CoreService(store, engine);
    await core.tick([f.scope]);
    assert.deepEqual(engine.requests[1], engine.requests[0]);
    engine.composeComplete = true;
    await core.tick([f.scope]);
    const firstAssessment = engine.requests.at(-1);
    assert.ok(String(firstAssessment![1]).startsWith("assess-"));
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    core = new CoreService(store, engine);
    await core.tick([f.scope]);
    assert.deepEqual(engine.requests.at(-1), firstAssessment);
    engine.assessComplete = true;
    await core.tick([f.scope]);
    const done = (
      await db.query(
        "SELECT value FROM lessonloop.objects WHERE kind='job' AND id=$1",
        [f.receipt.jobId],
      )
    ).rows[0].value;
    assert.equal(done.status, "completed");
    assert.equal(done.payload, undefined);
    assert.equal(done.candidate, undefined);
  } finally {
    await store.close();
    await db.end();
  }
});

test("Old in-flight jobs replay their original prompt and migrate on write", async () => {
  const store = new ProductStore(url!);
  await store.open();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const engine = new Engine();
    engine.fail.clear();
    const f = await setup(store, engine);
    const query = 'Legacy prompt {"z":1,"a":2}';
    await db.query(
      "UPDATE lessonloop.objects SET value=value || $2::jsonb WHERE kind='job' AND id=$1",
      [
        f.receipt.jobId,
        JSON.stringify({
          modelId: "job-" + f.receipt.jobId,
          modelQuery: query,
          status: "uncertain",
        }),
      ],
    );
    await f.core.tick([f.scope]);
    assert.equal(engine.requests[0]![2], query);
    const raw = (
      await db.query(
        "SELECT value FROM lessonloop.objects WHERE kind='job' AND id=$1",
        [f.receipt.jobId],
      )
    ).rows[0].value;
    assert.equal(raw.modelQuery, undefined);
    assert.equal(raw.payload.modelQuery, query);
    await f.core.cancelJob(f.p, f.receipt.jobId);
    await f.core.tick([f.scope]);
    const done = (
      await db.query(
        "SELECT value FROM lessonloop.objects WHERE kind='job' AND id=$1",
        [f.receipt.jobId],
      )
    ).rows[0].value;
    assert.equal(done.status, "canceled");
    assert.equal(done.payload, undefined);
  } finally {
    await store.close();
    await db.end();
  }
});

test("Prompt drift fails without resubmission and source erasure clears frozen data", async () => {
  const store = new ProductStore(url!);
  await store.open();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const engine = new Engine();
    const f = await setup(store, engine);
    await f.core.tick([f.scope]);
    await db.query(
      "UPDATE lessonloop.objects SET value=jsonb_set(value,'{payload,modelQueryHash}','\"changed\"') WHERE kind='job' AND id=$1",
      [f.receipt.jobId],
    );
    await f.core.tick([f.scope]);
    assert.equal(engine.requests.length, 1);
    assert.equal(
      (await f.core.getJob(f.p, f.receipt.jobId)).error,
      "job_prompt_changed",
    );
    const g = await setup(store, new Engine());
    await g.core.tick([g.scope]);
    await g.core.controlSource(g.p, {
      id: g.receipt.sources[0]!.id,
      expectedRevision: 1,
      action: "erase",
    });
    await g.core.tick([g.scope]);
    await g.core.processSourceCleanups([g.scope]);
    const raw = (
      await db.query(
        "SELECT value FROM lessonloop.objects WHERE kind='job' AND id=$1",
        [g.receipt.jobId],
      )
    ).rows[0].value;
    assert.equal(raw.payload, undefined);
    assert.ok(
      !JSON.stringify(raw).includes("A durable observation for payload replay"),
    );
  } finally {
    await store.close();
    await db.end();
  }
});
