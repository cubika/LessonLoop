import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { identity, refSchema, type Source } from "../src/domain/schema.js";
import { learningQuery } from "../src/core/learning.js";
import { workViewSchema } from "../src/core/work-view.js";

test("Only Source, Experience and Playbook have domain references", () => {
  for (const kind of ["source", "experience", "playbook"])
    assert.ok(refSchema.safeParse({ kind, id: "id", revision: 1 }).success);
  for (const kind of [
    "material",
    "method",
    "work_case",
    "effect_case",
    "work_view",
  ])
    assert.equal(
      refSchema.safeParse({ kind, id: "id", revision: 1 }).success,
      false,
    );
});
test("Native ingestion retains every source in original order and uses its sole identity", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        async: true,
        operation_id: body.operation_id,
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sources: Source[] = ["second-by-hash", "first-by-hash"].map(
    (id, ordinal) => ({
      ...identity("scope"),
      id,
      segment: { text: "Original " + ordinal, role: "tool" },
      sourceIdentity: "submission",
      sourceFamily: "family",
      workKey: "work",
      taskSequence: 1,
      ordinal,
      blocked: false,
      erased: false,
      excluded: false,
    }),
  );
  try {
    await new HindsightEngine("http://127.0.0.1:" + address.port, "test")
      .forJob("job")
      .retain(sources, "operation");
    assert.deepEqual(
      requests[0].contents.map((c: any) => [c.document_id, c.content]),
      sources.map((s) => [s.id, s.segment!.text]),
    );
    const query = learningQuery(sources, []);
    assert.ok(query.indexOf("Original 0") < query.indexOf("Original 1"));
    assert.ok(query.includes('"sourceIndex":0'));
    assert.ok(query.includes('"sourceIndex":1'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
