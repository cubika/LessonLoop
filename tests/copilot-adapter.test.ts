import test from "node:test";
import assert from "node:assert/strict";
import {
  promptEnvelope,
  transcriptEvent,
} from "../src/adapters/copilot/protocol.js";
test("Copilot transformation preserves the actual transformed prompt", () => {
  const out = promptEnvelope(
    { prompt: "raw", transformedPrompt: "transformed" },
    "bounded guidance",
  );
  assert.equal(
    out.modifiedTransformedPrompt,
    "transformed\n\nbounded guidance",
  );
});
test("Copilot transcript roles bind actual host event types", () => {
  assert.equal(
    transcriptEvent({
      type: "assistant.message",
      data: { content: "I am a tool" },
    })?.role,
    "agent",
  );
  assert.equal(
    transcriptEvent({
      type: "tool.execution_complete",
      data: { result: "observed" },
    })?.role,
    "tool",
  );
  assert.equal(
    transcriptEvent({ type: "unknown", data: { content: "claimed" } }),
    undefined,
  );
});
