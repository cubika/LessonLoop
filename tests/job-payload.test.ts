import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { canonical, digest, type Source } from "../src/domain/schema.js";
import { jobQuery, type JobPayload } from "../src/core/job-prompts.js";

const source: Source = {
  id: "a".repeat(64),
  revision: 1,
  scopeId: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  segment: {
    text: "A unique source observation",
    role: "tool",
    author: "runner",
    locator: "build.log",
  },
  context: { environment: "test" },
  sourceIdentity: "fixture",
  sourceFamily: "fixture",
  workKey: "fixture",
  taskSequence: 1,
  ordinal: 0,
  blocked: false,
  erased: false,
  excluded: false,
};
const draft = {
  workView: null,
  experiences: [],
  playbook: null,
  splitPlaybooks: null,
  decisions: [],
};

test("Retain sends source text once while preserving provenance", async () => {
  const engine = new HindsightEngine("http://127.0.0.1:19888", "unused").forJob(
    randomUUID(),
  );
  const original = globalThis.fetch;
  const operationId = randomUUID();
  let content: any;
  globalThis.fetch = async (_url, init) => {
    content = JSON.parse(String(init!.body)).contents[0];
    return new Response(
      JSON.stringify({ success: true, async: true, operation_id: operationId }),
      { status: 200 },
    );
  };
  try {
    await engine.retain([source], operationId);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(content.content, source.segment!.text);
  const context = JSON.parse(content.context);
  assert.equal(context.text, undefined);
  assert.equal(context.role, "tool");
  assert.equal(context.author, "runner");
  assert.equal(context.locator, "build.log");
  assert.equal(context.fingerprint, source.id);
});

test("Frozen inputs regenerate identical generation, assessment and repair requests", () => {
  const payload: JobPayload = {
    inputSources: [source],
    comparisonPlaybooks: [],
    retainedSupport: [],
    candidate: draft,
  };
  const job = { payload };
  for (const stage of ["compose", "assess"] as const) {
    const query = jobQuery(job, stage);
    const hash = stage === "compose" ? "modelQueryHash" : "assessmentQueryHash";
    const stored = {
      status: "uncertain",
      payload: { ...payload, [hash]: digest(query) },
    };
    const roundTrip = JSON.parse(canonical(stored));
    assert.equal(jobQuery(roundTrip, stage), query);
    assert.equal("modelQuery" in stored.payload, false);
    assert.equal("assessmentQuery" in stored.payload, false);
    assert.equal(
      JSON.stringify(stored).split(source.segment!.text).length - 1,
      1,
    );
    assert.throws(
      () =>
        jobQuery(
          { payload: { ...roundTrip.payload, [hash]: "changed" } },
          stage,
        ),
      /job_prompt_changed/,
    );
  }
  const repair = {
    payload: {
      ...payload,
      repairReasons: ["Preserve the original supported path"],
    },
  };
  const query = jobQuery(repair, "compose");
  assert.ok(query.includes("REJECTED PROPOSAL (not evidence)"));
  assert.equal(jobQuery(JSON.parse(canonical(repair)), "compose"), query);
  assert.throws(
    () => jobQuery({ payload: {} }, "compose"),
    /job_prompt_inputs_missing/,
  );
});
