import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook, type Config } from "../src/adapters/copilot/hook.js";
import { readTranscript } from "../src/adapters/copilot/transcript.js";

async function fixture(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lessonloop-copilot-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl");
  const epoch = Date.now() - 60000;
  const time = (n: number) => new Date(epoch + n * 1000).toISOString();
  const start = {
    type: "session.start",
    data: { sessionId: "session", context: { cwd: root } },
  };
  await writeFile(path, JSON.stringify(start) + "\n");
  const calls: Array<{ operation: string; input: any; key: string }> = [];
  const settings = {
    scopeId: "scope",
    learning: true,
    recommendation: true,
    review: true,
  };
  const method = { kind: "method", id: "method", revision: 1 };
  let tasks = 0;
  let fail: string | undefined;
  const rpc = async (operation: string, input: any, key: string) => {
    calls.push({ operation, input, key });
    if (fail === operation) {
      fail = undefined;
      throw new Error("temporary_failure");
    }
    if (operation === "settings.get") return [settings];
    if (operation === "startTask") return { taskRef: `task-${++tasks}` };
    if (operation === "searchMethods") return { results: [{ method }] };
    if (operation === "prepareMethod")
      return {
        status: "guidance",
        method,
        methodUseRef: "use-" + input.taskRef,
        conditions: [{ text: "Read the input schema" }],
        steps: [
          {
            stepId: "inspect",
            choices: [
              { when: { text: "Generated" }, next: "source" },
              { when: { text: "Manual" }, next: "stop" },
            ],
          },
          { stepId: "source", instruction: "Edit the source and regenerate" },
        ],
      };
    if (operation === "recordTaskObservation")
      return {
        results: input.map((e: any) => ({
          eventId: e.eventId,
          status: "accepted",
        })),
      };
    return { accepted: true };
  };
  const config: Config = {
    baseUrl: "http://127.0.0.1:1",
    token: "test",
    scopeId: "scope",
    allowedRoots: [root],
    stateRoot: join(root, "state"),
  };
  const event = (n: number, extra: Record<string, unknown> = {}) => ({
    sessionId: "session",
    cwd: root,
    transcriptPath: path,
    timestamp: time(n),
    ...extra,
  });
  const record = (n: number, type: string, data: object, extra = {}) => ({
    id: `event-${n}`,
    type,
    timestamp: time(n),
    data,
    ...extra,
  });
  const append = (...values: object[]) =>
    appendFile(path, values.map((v) => JSON.stringify(v)).join("\n") + "\n");
  const hook = (type: string, n: number, extra: Record<string, unknown> = {}) =>
    handleHook(config, event(n, extra), type, rpc);
  return {
    root,
    path,
    calls,
    settings,
    event,
    record,
    append,
    hook,
    config,
    time,
    failOnce: (operation: string) => {
      fail = operation;
    },
  };
}

test("Copilot transcript capture preserves roles, strips injected methods and confirms delivery from host receipts", async (t) => {
  const f = await fixture(t);
  const prompt = "Check the generated client";
  const output = await f.hook("userPromptTransformed", 1, { prompt });
  assert.equal(
    f.calls.some(
      (c) =>
        c.operation === "recordTaskObservation" &&
        c.input[0].kind === "delivery",
    ),
    false,
  );
  await f.append(
    f.record(2, "hook.end", {
      hookType: "userPromptTransformed",
      success: true,
      output,
    }),
    f.record(3, "user.message", { content: prompt }),
    f.record(4, "assistant.message", {
      content:
        'Inspecting. <lessonloop-method task="claimed">injected</lessonloop-method>',
    }),
    f.record(5, "tool.execution_start", {
      toolCallId: "call",
      toolName: "view",
      arguments: { path: "schema.json" },
    }),
    f.record(
      6,
      "hook.start",
      { hookType: "postToolUse", input: { timestamp: f.time(6) } },
      { parentId: "event-5" },
    ),
  );
  await f.hook("postToolUse", 6, {
    toolName: "view",
    toolArgs: { path: "schema.json" },
    toolResult: {
      resultType: "success",
      textResultForLlm: "Schema has source field.",
    },
  });
  await f.append(
    f.record(7, "tool.execution_complete", {
      toolCallId: "call",
      success: true,
      result: { content: "Schema has source field." },
    }),
    f.record(8, "assistant.message", {
      content: "The source field exists. Task succeeded.",
    }),
  );
  await f.hook("agentStop", 9);
  await f.hook("sessionEnd", 10, { reason: "complete" });
  const materials = f.calls
    .filter((c) => c.operation === "submitMaterial")
    .flatMap((c) => c.input.segments);
  assert.deepEqual(
    materials.map((s) => s.role),
    ["user", "agent", "tool", "agent"],
  );
  assert.equal(materials.filter((s) => s.text === prompt).length, 1);
  assert.equal(
    materials.some((s) => s.text.includes("injected")),
    false,
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "recordHostObservation").length,
    1,
  );
  const effects = f.calls
    .filter((c) => c.operation === "recordTaskObservation")
    .flatMap((c) => c.input);
  assert.equal(effects.filter((e) => e.kind === "delivery").length, 1);
  assert.equal(effects.filter((e) => e.kind === "usage").length, 0);
  assert.equal(effects.find((e) => e.kind === "outcome")?.outcome, "unknown");
  assert.equal(
    effects.some((e) => e.outcome === "succeeded"),
    false,
  );
});

test("active clarification and explicit continuation reuse the task; completed turns isolate tasks", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, {
    prompt: "Investigate",
  });
  await f.hook("userPromptTransformed", 3, {
    prompt: "The source is schema.json",
  });
  const prepares = f.calls.filter((c) => c.operation === "prepareMethod");
  assert.equal(prepares[1]?.input.methodUseRef, undefined);
  assert.equal(prepares[1]?.input.completedStepIds, undefined);
  assert.equal(prepares[1]?.input.taskRef, prepares[0]?.input.taskRef);
  assert.deepEqual(
    await f.hook("userPromptTransformed", 1, { prompt: "Investigate" }),
    {},
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "prepareMethod").length,
    2,
  );
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 5, {
    prompt: "/lessonloop continue verify it",
  });
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 1);
  await f.hook("agentStop", 6);
  await f.hook("userPromptTransformed", 7, { prompt: "A different task" });
  await f.hook("userPromptTransformed", 8, {
    prompt: "/lessonloop new Another task",
  });
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 3);
  const taskKeys = f.calls
    .filter((c) => c.operation === "startTask")
    .map((c) => c.input.eventId);
  assert.equal(new Set(taskKeys).size, 3);
});

test("session end retries after interruption and late transcript material stays with the closed task", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "First task" });
  f.failOnce("observeTask");
  await assert.rejects(
    f.hook("sessionEnd", 3, { reason: "timeout" }),
    /temporary_failure/,
  );
  await f.hook("sessionEnd", 3, { reason: "timeout" });
  await f.hook("userPromptTransformed", 6, { prompt: "Second task" });
  await f.append(
    f.record(2, "assistant.message", { content: "Late final answer" }),
  );
  await f.hook("agentStop", 7);
  const late = f.calls.find(
    (c) =>
      c.operation === "submitMaterial" &&
      c.input.segments[0].text === "Late final answer",
  );
  assert.equal(late?.input.context.taskRef, "task-1");
  const outcomes = f.calls.filter(
    (c) =>
      c.operation === "recordTaskObservation" && c.input[0].kind === "outcome",
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.input[0].outcome, "failed");
});

test("an interrupted preparation retries the same prompt instead of caching an empty result", async (t) => {
  const f = await fixture(t);
  f.failOnce("prepareMethod");
  await assert.rejects(
    f.hook("userPromptTransformed", 1, { prompt: "Read input" }),
    /temporary_failure/,
  );
  const result = await f.hook("userPromptTransformed", 1, {
    prompt: "Read input",
  });
  assert.match(String(result.modifiedTransformedPrompt), /lessonloop-method/);
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 1);
  assert.equal(
    f.calls.filter((c) => c.operation === "submitMaterial").length,
    1,
  );
});

test("transcript identity, partial lines and byte limits are explicit collection boundaries", async (t) => {
  const f = await fixture(t);
  const first = await readTranscript(f.event(1), f.root);
  assert.equal(first.gaps.length, 0);
  await appendFile(
    f.path,
    JSON.stringify(f.record(2, "assistant.message", { content: "partial" })),
  );
  const partial = await readTranscript(f.event(3), f.root, first.cursor);
  assert.equal(partial.records.length, 0);
  await appendFile(f.path, "\n");
  const complete = await readTranscript(f.event(3), f.root, partial.cursor);
  assert.equal(complete.records[0]?.data.content, "partial");
  const bounded = await readTranscript(f.event(3), f.root, undefined, 150);
  assert.ok(bounded.gaps.includes("transcript_truncated"));
  const wrong = await readTranscript(
    { ...f.event(3), sessionId: "another" },
    f.root,
  );
  assert.deepEqual(wrong.gaps, ["transcript_identity_mismatch"]);
  await writeFile(f.path, "not-json\n");
  await f.hook("userPromptTransformed", 1, { prompt: "Read" });
  await f.hook("agentStop", 2);
  assert.ok(
    f.calls.some(
      (c) =>
        c.operation === "recordTaskObservation" &&
        c.input[0].kind === "collection_gap",
    ),
  );
});

test("LessonLoop MCP responses are excluded from independent tool evidence", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "tool.execution_start", {
      toolCallId: "own",
      toolName: "lessonloop-prepareMethod",
      arguments: {},
    }),
  );
  await f.hook("postToolUse", 3, {
    toolName: "lessonloop-prepareMethod",
    toolCallId: "own",
    toolResult: { textResultForLlm: "Derived guidance" },
  });
  await f.append(
    f.record(4, "tool.execution_complete", {
      toolCallId: "own",
      success: true,
      result: { content: "Derived guidance" },
    }),
  );
  await f.hook("agentStop", 5);
  assert.equal(
    f.calls.filter((c) => c.operation === "recordHostObservation").length,
    0,
  );
  assert.equal(
    f.calls.some(
      (c) =>
        c.operation === "submitMaterial" &&
        JSON.stringify(c.input).includes("Derived guidance"),
    ),
    false,
  );
});

test("unacknowledged injection is never counted as delivery, and completed prompt replay never reopens a task", async (t) => {
  const f = await fixture(t);
  const output = await f.hook("userPromptTransformed", 1, {
    prompt: "Inspect",
  });
  await f.append(
    f.record(2, "hook.end", {
      hookType: "userPromptTransformed",
      success: false,
      output,
    }),
  );
  await f.hook("sessionEnd", 3, { reason: "abort" });
  assert.deepEqual(
    await f.hook("userPromptTransformed", 1, { prompt: "Inspect" }),
    {},
  );
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 1);
  const effects = f.calls
    .filter((c) => c.operation === "recordTaskObservation")
    .flatMap((c) => c.input);
  assert.equal(
    effects.some((e) => e.kind === "delivery"),
    false,
  );
  assert.equal(effects.find((e) => e.kind === "outcome")?.outcome, "abandoned");
});

test("disabled learning does not ingest transcript material and disallowed workspaces make no API call", async (t) => {
  const f = await fixture(t);
  f.settings.learning = false;
  f.settings.recommendation = false;
  f.settings.review = false;
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "assistant.message", { content: "Unretained final" }),
  );
  await f.hook("agentStop", 3);
  assert.equal(
    f.calls.some((c) =>
      ["submitMaterial", "recordTaskObservation", "searchMethods"].includes(
        c.operation,
      ),
    ),
    false,
  );
  let called = false;
  assert.deepEqual(
    await handleHook(
      { ...f.config, allowedRoots: [] },
      f.event(4),
      "agentStop",
      async () => {
        called = true;
        return [];
      },
    ),
    {},
  );
  assert.equal(called, false);
});

test("session closure records outcomes without an observation assessment", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.hook("postToolUse", 2, {
    toolName: "view",
    toolCallId: "real-read",
    toolResult: { resultType: "success", textResultForLlm: "Source exists" },
  });
  await f.hook("sessionEnd", 3, { reason: "complete" });
  assert.ok(
    f.calls.some(
      (c) => c.operation === "observeTask" && c.input.ended === true,
    ),
  );
  assert.equal(
    f.calls.some((c) => c.operation === "reassessTask"),
    false,
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "prepareMethod").length,
    1,
  );
});

test("the first prompt receives full guidance and tool observations never trigger branch unlocking", async (t) => {
  const f = await fixture(t);
  const result = await f.hook("userPromptTransformed", 1, {
    prompt: "Inspect generated output",
  });
  const text = String(result.modifiedTransformedPrompt);
  assert.ok(text.includes("Edit the source and regenerate"));
  assert.ok(text.includes("Read the input schema"));
  assert.ok(text.includes("current observations"));
  assert.equal(text.includes("reassessTask"), false);
  assert.equal(text.includes("completedStepIds"), false);
  await f.hook("postToolUse", 2, {
    toolName: "view",
    toolCallId: "read",
    toolResult: { content: "Generated file confirmed" },
  });
  await f.hook("agentStop", 3);
  assert.equal(
    f.calls.filter((c) => c.operation === "prepareMethod").length,
    1,
  );
  assert.equal(
    f.calls.some((c) => c.operation === "reassessTask"),
    false,
  );
  await f.hook("userPromptTransformed", 4, {
    prompt: "/lessonloop continue apply the change",
  });
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 1);
  await f.hook("sessionEnd", 5, { reason: "complete" });
  await f.hook("userPromptTransformed", 6, {
    prompt: "/lessonloop continue check a new result",
  });
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 2);
});

test("oversized automatic guidance exposes a bounded explicit retrieval without claiming delivery", async (t) => {
  const f = await fixture(t);
  const result = await handleHook(
    f.config,
    f.event(1, { prompt: "Inspect" }),
    "userPromptTransformed",
    async (operation, input) => {
      if (operation === "settings.get") return [f.settings];
      if (operation === "startTask") return { taskRef: "large-task" };
      if (operation === "searchMethods")
        return {
          results: [
            { method: { kind: "method", id: "large-method", revision: 1 } },
          ],
        };
      if (operation === "prepareMethod")
        return { status: "requires_expansion" };
      if (operation === "recordTaskObservation")
        return {
          results: input.map((e: any) => ({
            eventId: e.eventId,
            status: "accepted",
          })),
        };
      return { accepted: true };
    },
  );
  const text = String(result.modifiedTransformedPrompt);
  assert.ok(text.includes("large-task") && text.includes("large-method"));
  assert.ok(text.includes("viewMode=expanded"));
  assert.equal(text.includes("methodUseRef"), false);
});

test("Copilot sessionStart following the first prompt does not close the newly bound task", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.hook("sessionStart", 2, { source: "new" });
  await f.hook("userPromptTransformed", 3, { prompt: "More detail" });
  assert.equal(
    f.calls.some((c) => c.operation === "observeTask" && c.input.ended),
    false,
  );
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 1);
  assert.equal(
    f.calls.filter((c) => c.operation === "prepareMethod").at(-1)?.input
      .methodUseRef,
    undefined,
  );
});

test("a method MCP response is not execution evidence and does not change the task boundary", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "tool.execution_start", {
      toolCallId: "prepare",
      toolName: "lessonloop-prepareMethod",
    }),
    f.record(3, "tool.execution_complete", {
      toolCallId: "prepare",
      success: true,
      result: {
        content: JSON.stringify({
          result: {
            status: "guidance",
            method: { kind: "method", id: "method", revision: 1 },
            methodUseRef: "use-1",
            steps: [],
          },
        }),
      },
    }),
  );
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 5, { prompt: "Another task" });
  assert.equal(f.calls.filter((c) => c.operation === "startTask").length, 2);
  assert.equal(
    f.calls.filter((c) => c.operation === "recordHostObservation").length,
    0,
  );
});
