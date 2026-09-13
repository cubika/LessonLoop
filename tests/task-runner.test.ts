import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelClient, parseJsonResponse } from "../spikes/p0/model-client.js";
import { runTask } from "../spikes/p0/task-runner.js";
import { taskFixtures } from "../spikes/p0/task-fixtures.js";

class ScriptedProtocol extends ModelClient {
  constructor(private actions: string[]) { super("http://127.0.0.1:1/v1", "test-double", undefined); }
  override async complete() { return this.actions.shift() ?? JSON.stringify({ tool: "finish" }); }
}
test("task oracle detects generated-output-only edits after regeneration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lessonloop-task-oracle-"));
  try {
    const result = await runTask(new ScriptedProtocol([
      JSON.stringify({ tool: "write_json", path: "generated/orders-client.json", value: { fields: ["orderId", "customerId"] } }),
      JSON.stringify({ tool: "run_check" }),
    ]), taskFixtures[0]!, directory, async () => "");
    assert.equal(result.passed, false); assert.equal(result.failedChecks, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("task oracle accepts source edit and actual check without judging model prose", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lessonloop-task-oracle-"));
  try {
    const result = await runTask(new ScriptedProtocol([
      JSON.stringify({ tool: "write_json", path: "inputs/order-contract.json", value: { fields: ["orderId", "customerId"] } }),
      JSON.stringify({ tool: "run_check" }),
    ]), taskFixtures[0]!, directory, async () => "");
    assert.equal(result.passed, true); assert.equal(result.checks, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("runner denies paths outside the task allowlist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lessonloop-task-oracle-"));
  try {
    const result = await runTask(new ScriptedProtocol([JSON.stringify({ tool: "write_json", path: "../not-allowed.json", value: { invalid: true } })]), taskFixtures[0]!, directory, async () => "");
    assert.equal(result.toolLog[0]?.tool, "invalid_action"); assert.equal(result.passed, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("model JSON decoding handles a fence without removing JSON whitespace literals", () => {
  assert.deepEqual(parseJsonResponse(["```json", JSON.stringify({ value: "sample" }), "```"].join(String.fromCharCode(10))), { value: "sample" });
});
