import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, modelUsage } from "../src/core/usage.js";
test("Usage aggregates unique native operations and reports missing costs as unknown", () => {
  assert.equal(aggregateUsage(["missing"]).input_tokens, null);
  const records = { a: { input_tokens: 10, output_tokens: 2, complete: true } };
  assert.equal(aggregateUsage(["a", "a"], records).input_tokens, 10);
  assert.equal(aggregateUsage(["a"], records).status, "measured");
  assert.equal(aggregateUsage(["a", "b"], records).status, "partial");
  assert.deepEqual(aggregateUsage(["a", "b"], records).unknownOperationIds, [
    "b",
  ]);
  assert.equal(
    modelUsage({
      reflect_response: {
        trace: { usage: { input_tokens: 5, output_tokens: 2 } },
      },
    })?.complete,
    false,
  );
});
