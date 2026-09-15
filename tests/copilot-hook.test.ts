import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook, type Config } from "../src/adapters/copilot/hook.js";
import { readTranscript } from "../src/adapters/copilot/transcript.js";
import { hostTaskBoundary } from "../src/core/host-tasks.js";
import { digest } from "../src/domain/schema.js";
import type { CoreService } from "../src/core/service.js";

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
  const playbook = { kind: "playbook", id: "playbook", revision: 1 };
  let rows = new Map<string, any>();
  // Exercise the actual core boundary logic; each transaction commits together.
  const core = {
    store: {
      transaction: async (fn: any) => {
        const next = structuredClone(rows);
        const result = await fn({
          get: async (kind: string, id: string) =>
            kind === "settings" ? settings : next.get(kind + id),
          list: async (kind: string) =>
            [...next]
              .filter(([key]) => key.startsWith(kind))
              .map(([, value]) => value),
          put: async (entry: any) => {
            next.set(entry.kind + entry.id, structuredClone(entry.value));
          },
        });
        rows = next;
        return result;
      },
    },
  } as unknown as CoreService;
  const principal = { id: "host", channel: "host" as const, scopes: ["scope"] };
  const taskRows = () =>
    [...rows]
      .filter(([, value]) => value.hostSession)
      .map(([, value]) => value);
  let fail: string | undefined;
  const receipts = new Map<string, any>();
  const payloads = new Map<string, string>();
  const rpc = async (operation: string, input: any, key: string) => {
    const receiptKey = operation + key;
    if (receipts.has(receiptKey)) {
      assert.equal(
        digest(input),
        payloads.get(receiptKey),
        "same idempotency key must preserve its payload",
      );
      return receipts.get(receiptKey);
    }
    calls.push({ operation, input, key });
    if (fail === operation || fail === operation + ":" + input.action) {
      fail = undefined;
      throw new Error("temporary_failure");
    }
    if (operation === "settings.get") return [settings];
    if (operation === "hostTaskBoundary")
      return hostTaskBoundary(core, principal, input);
    if (operation === "searchPlaybooks")
      return { results: [{ playbook: playbook }] };
    if (operation === "preparePlaybook")
      return {
        status: "guidance",
        playbook: playbook,
        feedbackRevision: 2,
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
    if (operation === "updateTaskFeedback")
      return { accepted: true, revision: 3 };
    if (["submitSource", "recordHostObservation"].includes(operation)) {
      receipts.set(receiptKey, { accepted: true });
      payloads.set(receiptKey, digest(input));
    }
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
    taskRows,
    failOnce: (operation: string) => {
      fail = operation;
    },
  };
}

test("Copilot transcript capture preserves roles, strips injected playbooks and confirms delivery from host receipts", async (t) => {
  const f = await fixture(t);
  const prompt = "Check the generated client";
  const output = await f.hook("userPromptTransformed", 1, { prompt });
  assert.equal(
    f.calls.some(
      (c) =>
        c.operation === "updateTaskFeedback" && c.input.field === "delivered",
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
        'Inspecting. <lessonloop-playbook task="claimed">injected</lessonloop-playbook>',
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
  const inputSources = f.calls
    .filter((c) => c.operation === "submitSource")
    .flatMap((c) => c.input.segments);
  assert.deepEqual(
    inputSources.map((s) => s.role),
    ["user", "agent", "tool", "agent"],
  );
  assert.equal(inputSources.filter((s) => s.text === prompt).length, 1);
  assert.equal(
    inputSources.some((s) => s.text.includes("injected")),
    false,
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "recordHostObservation").length,
    1,
  );
  const effects = f.calls
    .filter((c) => c.operation === "updateTaskFeedback")
    .flatMap((c) => c.input);
  assert.equal(effects.filter((e) => e.field === "delivered").length, 1);
  assert.equal(effects.filter((e) => e.field === "usage").length, 0);
  assert.equal(
    effects.some((e) => e.field === "taskOutcome"),
    false,
  );
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
  const prepares = f.calls.filter((c) => c.operation === "preparePlaybook");
  assert.equal(prepares[1]?.input.playbookUseRef, undefined);
  assert.equal(prepares[1]?.input.completedStepIds, undefined);
  assert.equal(prepares[1]?.input.taskRef, prepares[0]?.input.taskRef);
  assert.deepEqual(
    await f.hook("userPromptTransformed", 1, { prompt: "Investigate" }),
    {},
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "preparePlaybook").length,
    2,
  );
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 5, {
    prompt: "/lessonloop continue verify it",
  });
  assert.equal(f.taskRows().length, 1);
  await f.hook("agentStop", 6);
  await f.hook("userPromptTransformed", 7, { prompt: "A different task" });
  await f.hook("userPromptTransformed", 8, {
    prompt: "/lessonloop new Another task",
  });
  assert.equal(f.taskRows().length, 3);
  const taskKeys = f.taskRows().map((t) => t.id);
  assert.equal(new Set(taskKeys).size, 3);
});

test("session end retries after interruption and late transcript inputSource stays with the closed task", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "First task" });
  f.failOnce("hostTaskBoundary:end");
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
      c.operation === "submitSource" &&
      c.input.segments[0].text === "Late final answer",
  );
  assert.equal(late?.input.context.taskRef, f.taskRows()[0].id);
  assert.equal(
    f.calls.some(
      (c) =>
        c.operation === "updateTaskFeedback" && c.input.field === "taskOutcome",
    ),
    false,
  );
  assert.ok(f.taskRows()[0].ended);
});

test("an interrupted preparation retries the same prompt instead of caching an empty result", async (t) => {
  const f = await fixture(t);
  f.failOnce("preparePlaybook");
  await assert.rejects(
    f.hook("userPromptTransformed", 1, { prompt: "Read input" }),
    /temporary_failure/,
  );
  const result = await f.hook("userPromptTransformed", 1, {
    prompt: "Read input",
  });
  assert.match(String(result.modifiedTransformedPrompt), /lessonloop-playbook/);
  assert.equal(f.taskRows().length, 1);
  assert.equal(f.calls.filter((c) => c.operation === "submitSource").length, 1);
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
  assert.equal(
    f.calls.some((c) => c.operation === "updateTaskFeedback"),
    false,
  );
});

test("LessonLoop MCP responses are excluded from independent tool evidence", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "tool.execution_start", {
      toolCallId: "own",
      toolName: "lessonloop-preparePlaybook",
      arguments: {},
    }),
  );
  await f.hook("postToolUse", 3, {
    toolName: "lessonloop-preparePlaybook",
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
        c.operation === "submitSource" &&
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
  assert.equal(f.taskRows().length, 1);
  const effects = f.calls
    .filter((c) => c.operation === "updateTaskFeedback")
    .flatMap((c) => c.input);
  assert.equal(
    effects.some((e) => e.field === "delivered"),
    false,
  );
  assert.equal(
    effects.some((e) => e.field === "taskOutcome"),
    false,
  );
});

test("disabled learning does not ingest transcript inputSource and disallowed workspaces make no API call", async (t) => {
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
      ["submitSource", "updateTaskFeedback", "searchPlaybooks"].includes(
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

test("session closure leaves the result unknown and preserves raw evidence", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.hook("postToolUse", 2, {
    toolName: "view",
    toolCallId: "real-read",
    toolResult: { resultType: "success", textResultForLlm: "Source exists" },
  });
  await f.hook("sessionEnd", 3, { reason: "complete" });
  assert.ok(f.taskRows().some((t) => t.ended));
  assert.equal(
    f.calls.some((c) => c.operation === "reassessTask"),
    false,
  );
  assert.equal(
    f.calls.filter((c) => c.operation === "preparePlaybook").length,
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
  const guidance = JSON.parse(
    text.split("<lessonloop-playbook")[1]!.split("\n")[1]!,
  );
  assert.equal(guidance.taskRef, f.taskRows()[0].id);
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
    f.calls.filter((c) => c.operation === "preparePlaybook").length,
    1,
  );
  assert.equal(
    f.calls.some((c) => c.operation === "reassessTask"),
    false,
  );
  await f.hook("userPromptTransformed", 4, {
    prompt: "/lessonloop continue apply the change",
  });
  assert.equal(f.taskRows().length, 1);
  await f.hook("sessionEnd", 5, { reason: "complete" });
  await f.hook("userPromptTransformed", 6, {
    prompt: "/lessonloop continue check a new result",
  });
  assert.equal(f.taskRows().length, 2);
});

test("oversized automatic guidance exposes a bounded explicit retrieval without claiming delivery", async (t) => {
  const f = await fixture(t);
  const result = await handleHook(
    f.config,
    f.event(1, { prompt: "Inspect" }),
    "userPromptTransformed",
    async (operation, input) => {
      if (operation === "settings.get") return [f.settings];
      if (operation === "hostTaskBoundary")
        return { tasks: [{ taskRef: "large-task", startedAt: f.time(1) }] };
      if (operation === "searchPlaybooks")
        return {
          results: [
            {
              playbook: { kind: "playbook", id: "large-playbook", revision: 1 },
            },
          ],
        };
      if (operation === "preparePlaybook")
        return { status: "requires_expansion" };
      if (operation === "updateTaskFeedback")
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
  assert.ok(text.includes("large-task") && text.includes("large-playbook"));
  assert.ok(text.includes("viewMode=expanded"));
  assert.ok(text.includes("getGuidance") && text.includes("target: playbook"));
  assert.equal(text.includes("playbookUseRef"), false);
});

test("Copilot sessionStart following the first prompt does not close the newly bound task", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.hook("sessionStart", 2, { source: "new" });
  await f.hook("userPromptTransformed", 3, { prompt: "More detail" });
  assert.equal(
    f.taskRows().some((t) => t.ended),
    false,
  );
  assert.equal(f.taskRows().length, 1);
  assert.equal(
    f.calls.filter((c) => c.operation === "preparePlaybook").at(-1)?.input
      .playbookUseRef,
    undefined,
  );
});

test("a guidance MCP response is not execution evidence and does not change the task boundary", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "tool.execution_start", {
      toolCallId: "prepare",
      toolName: "lessonloop-getGuidance",
    }),
    f.record(3, "tool.execution_complete", {
      toolCallId: "prepare",
      success: true,
      result: {
        content: JSON.stringify({
          result: {
            status: "guidance",
            playbook: { kind: "playbook", id: "playbook", revision: 1 },
            feedbackRevision: 2,
            steps: [],
          },
        }),
      },
    }),
  );
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 5, { prompt: "Another task" });
  assert.equal(f.taskRows().length, 2);
  assert.equal(
    f.calls.filter((c) => c.operation === "recordHostObservation").length,
    0,
  );
});

test("official streaming preserves UTF-8 chunk boundaries and retries only a complete final line", async (t) => {
  const f = await fixture(t);
  const content = "汉字🙂".repeat(10000);
  await f.append(f.record(1, "assistant.message", { content }));
  const first = await readTranscript(f.event(2), f.root);
  assert.equal(first.records.at(-1)?.data.content, content);
  assert.equal(first.cursor?.offset, (await readFile(f.path)).length);
  const partial = JSON.stringify(
    f.record(3, "assistant.message", { content: "继续🙂" }),
  );
  await appendFile(f.path, partial);
  const pending = await readTranscript(f.event(4), f.root, first.cursor);
  assert.equal(pending.records.length, 0);
  assert.deepEqual(pending.cursor, first.cursor);
  await appendFile(f.path, "\n");
  const complete = await readTranscript(f.event(5), f.root, pending.cursor);
  assert.equal(complete.records[0]?.data.content, "继续🙂");
  const bounded = await readTranscript(f.event(6), f.root, undefined, 70000);
  assert.ok(bounded.gaps.includes("transcript_truncated"));
  assert.equal(bounded.records.at(-1)?.data.content, "继续🙂");
  assert.equal(bounded.cursor?.offset, (await readFile(f.path)).length);
});

test("hook checkpoints contain collection receipts without a second task lifecycle", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.hook("agentStop", 2);
  const name = (await readdir(f.config.stateRoot)).find((n) =>
    n.endsWith(".json"),
  )!;
  const saved = JSON.parse(
    await readFile(join(f.config.stateRoot, name), "utf8"),
  );
  assert.equal(saved.tasks, undefined);
  assert.equal(Object.keys(saved.captures).length, 1);
  const capture = Object.values(saved.captures)[0] as any;
  for (const field of ["startedAt", "endedAt", "stopped"])
    assert.equal(capture[field], undefined);
  assert.ok(capture.prompts[0].done);
  assert.equal(f.taskRows()[0].stopped, true);
});

test("a failed stop receipt is retried before the next prompt and stale stops do not undo continuation", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "First" });
  f.failOnce("hostTaskBoundary:stop");
  await assert.rejects(f.hook("agentStop", 2), /temporary_failure/);
  await f.hook("userPromptTransformed", 3, { prompt: "Second" });
  assert.equal(f.taskRows().length, 2);
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 5, {
    prompt: "/lessonloop continue More",
  });
  await f.hook("agentStop", 4);
  await f.hook("userPromptTransformed", 6, { prompt: "Clarification" });
  assert.equal(f.taskRows().length, 2);
  f.failOnce("hostTaskBoundary:end");
  await assert.rejects(f.hook("sessionEnd", 7), /temporary_failure/);
  await f.hook("userPromptTransformed", 8, {
    prompt: "/lessonloop continue After end",
  });
  assert.equal(f.taskRows().length, 3);
});

test("legacy sessions require a new session without replaying materials into new tasks", async (t) => {
  const f = await fixture(t);
  await f.hook("sessionStart", 0);
  await writeFile(
    join(f.config.stateRoot, digest([f.root, "session"]) + ".json"),
    JSON.stringify({ tasks: [{ taskRef: "legacy" }] }),
  );
  await assert.rejects(
    f.hook("userPromptTransformed", 1, { prompt: "Inspect" }),
    /host_session_restart_required/,
  );
  assert.equal(f.taskRows().length, 0);
});

test("boundary receipt survives a failed initial read and rejects a previously unseen late prompt", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "First" });
  f.failOnce("hostTaskBoundary:read");
  await assert.rejects(f.hook("agentStop", 4), /temporary_failure/);
  await f.hook("userPromptTransformed", 3, { prompt: "Late clarification" });
  assert.equal(f.taskRows().length, 1);
  assert.equal(f.taskRows()[0].stopped, true);
  const interrupted = JSON.parse(await readFile(join(f.config.stateRoot, digest([f.root, "session", "scope"]) + ".json"), "utf8"));
  assert.equal(interrupted.pendingBoundary, undefined);
  assert.ok(Object.values(interrupted.captures).some((c: any) => c.collectionGap));
  await f.hook("userPromptTransformed", 5, { prompt: "Next task" });
  assert.equal(f.taskRows().length, 2);
});

test("a failed preparation still preserves the prompt receipt for later transcript collection", async (t) => {
  const f = await fixture(t);
  f.failOnce("preparePlaybook");
  await assert.rejects(
    f.hook("userPromptTransformed", 1, { prompt: "Inspect" }),
    /temporary_failure/,
  );
  await f.append(f.record(1, "user.message", { content: "Inspect" }));
  await f.hook("agentStop", 2);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.operation === "submitSource" && c.input.segments[0].role === "user",
    ).length,
    1,
  );
});
