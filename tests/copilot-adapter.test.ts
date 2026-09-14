import test from "node:test";
import assert from "node:assert/strict";
import {
  eventTime,
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

test("Copilot event timestamps preserve ISO identity on replay", () => {
  const iso = "2026-09-15T00:00:00.000Z";
  assert.equal(eventTime(iso), iso);
  assert.equal(eventTime(Date.parse(iso)), iso);
  assert.equal(eventTime("invalid"), undefined);
  assert.equal(eventTime(undefined), undefined);
});
