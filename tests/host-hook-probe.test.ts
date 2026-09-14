import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findViewTool, HOOK_SCRIPT, modelMarkers } from "../probes/copilot/host-hook-probe.js";

test("generated hook is valid JavaScript before a host session starts", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: HOOK_SCRIPT, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test("generated prompt hooks emit valid JSON and preserve transformed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lessonloop-hook-script-"));
  try {
    const trace = join(directory, "trace.jsonl");
    for (const event of ["userPromptSubmitted", "userPromptTransformed"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", HOOK_SCRIPT, "hook.mjs", event], {
        input: JSON.stringify({ prompt: "P0_HOST_PROTOCOL_SYNTHETIC_ONLY", transformedPrompt: "original model-facing input" }),
        env: { P0_TRACE: trace, P0_CASE: "context" },
        encoding: "utf8", windowsHide: true, timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      if (event === "userPromptSubmitted") assert.equal(output.modifiedPrompt, "P0_HOST_PROTOCOL_SYNTHETIC_ONLY\nP0_SUBMITTED_MODEL_CONTEXT");
      else assert.equal(output.modifiedTransformedPrompt, "original model-facing input\nP0_TRANSFORMED_MODEL_CONTEXT");
    }
    const records = (await readFile(trace, "utf8")).trim().split("\n");
    assert.equal(records.length, 2);
    for (const record of records) assert.equal((JSON.parse(record) as { hasOriginalPrompt: boolean }).hasOriginalPrompt, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("synthetic tool response permits only the advertised read tool and fixed fixture", () => {
  const tool = findViewTool({ tools: [{ type: "function", function: { name: "view", parameters: { properties: { path: { type: "string" } } } } }] }, "fixed-fixture");
  assert.deepEqual(tool, { name: "view", args: { path: "fixed-fixture" } });
  assert.equal(findViewTool({ tools: [{ function: { name: "powershell", parameters: { properties: { command: {} } } } }] }, "fixture"), null);
  assert.equal(findViewTool({ tools: [{ function: { name: "view", parameters: { properties: { unknown: {} } } } }] }, "fixture"), null);
});

test("hook markers are checked only in model messages", () => {
  const markers = modelMarkers({ messages: [{ role: "user", content: "P0_HOST_PROTOCOL_SYNTHETIC_ONLY P0_TRANSFORMED_MODEL_CONTEXT" }], ignoredMetadata: "P0_SUBMITTED_MODEL_CONTEXT" });
  assert.deepEqual(markers, { originalTask: true, submittedOutput: false, transformedOutput: true, fixtureResult: false });
});
