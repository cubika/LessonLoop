import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { canonical, digest, type Source } from "../src/domain/schema.js";
import { jobQuery, type PromptJob } from "../src/core/job-prompts.js";
import {
  packJobPayload,
  unpackJobPayload,
  clearJobPayload,
} from "../src/store/job-payload.js";

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

test("Old extraction retries preserve their original request format", async () => {
  const engine = new HindsightEngine("http://127.0.0.1:19888", "unused").forJob(
    randomUUID(),
  );
  const original = globalThis.fetch;
  const operationId = randomUUID();
  let context = "";
  globalThis.fetch = async (_url, init) => {
    context = JSON.parse(String(init!.body)).contents[0].context;
    return new Response(
      JSON.stringify({ success: true, async: true, operation_id: operationId }),
      { status: 200 },
    );
  };
  try {
    await engine.retain([source], operationId, 0);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(
    context,
    JSON.stringify({
      ...source.segment,
      fingerprint: source.id,
      context: source.context,
    }),
  );
});

test("Frozen inputs regenerate identical generation, assessment and repair requests", () => {
  const job: PromptJob = {
    promptVersion: 1,
    inputSources: [source],
    comparisonPlaybooks: [],
    retainedSupport: [],
    candidate: draft,
  };
  for (const stage of ["compose", "assess"] as const) {
    const query = jobQuery(job, stage);
    const hash = stage === "compose" ? "modelQueryHash" : "assessmentQueryHash";
    const stored = packJobPayload({
      ...job,
      status: "uncertain",
      [hash]: digest(query),
    });
    const roundTrip = unpackJobPayload(JSON.parse(canonical(stored)));
    assert.equal(jobQuery(roundTrip, stage), query);
    assert.equal(stored.modelQuery, undefined);
    assert.equal(stored.assessmentQuery, undefined);
    assert.equal(
      JSON.stringify(stored).split(source.segment!.text).length - 1,
      1,
    );
    assert.throws(
      () => jobQuery({ ...roundTrip, [hash]: "changed" }, stage),
      /job_prompt_changed/,
    );
  }
  const repair = {
    ...job,
    repairReasons: ["Preserve the original supported path"],
  };
  const query = jobQuery(repair, "compose");
  assert.ok(query.includes("REJECTED PROPOSAL (not evidence)"));
  assert.equal(jobQuery(JSON.parse(canonical(repair)), "compose"), query);
  assert.throws(
    () => jobQuery({ ...job, promptVersion: 999 }, "compose"),
    /job_prompt_version_unsupported/,
  );
});

test("Legacy requests remain exact and every terminal status clears the payload", () => {
  const legacy = {
    status: "uncertain",
    modelQuery: 'Original {"z":1,"a":2}',
    assessmentQuery: "Original assessment",
    candidate: draft,
    retainedSupport: [],
    verificationTarget: { id: "target", revision: 3 },
    verificationControl: { reason: "Recheck" },
  };
  const stored = packJobPayload(legacy);
  const read = unpackJobPayload(JSON.parse(canonical(stored)));
  assert.equal(jobQuery(read, "compose"), legacy.modelQuery);
  assert.equal(jobQuery(read, "assess"), legacy.assessmentQuery);
  for (const status of ["completed", "failed", "canceled"]) {
    const terminal = packJobPayload({ ...stored, status });
    assert.deepEqual(terminal, {
      status,
      verificationRef: { kind: "experience", id: "target", revision: 3 },
    });
  }
  assert.deepEqual(clearJobPayload(read), {
    status: "uncertain",
    verificationRef: { kind: "experience", id: "target", revision: 3 },
  });
});
