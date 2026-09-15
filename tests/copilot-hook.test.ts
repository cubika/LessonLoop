import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook, type Config } from "../src/adapters/copilot/hook.js";
import { readTranscript } from "../src/adapters/copilot/transcript.js";
import { digest } from "../src/domain/schema.js";

async function fixture(
  t: test.TestContext,
  guidance?: { playbooks: object[]; experiences: object[] },
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lessonloop-session-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl");
  await writeFile(
    path,
    JSON.stringify({
      type: "session.start",
      data: { sessionId: "session", context: { cwd: root } },
    }) + "\n",
  );
  const epoch = Date.now() - 60000;
  const time = (n: number) => new Date(epoch + n * 1000).toISOString();
  const settings = {
    scopeId: "scope",
    learning: true,
    recommendation: true,
    review: true,
  };
  const config: Config = {
    baseUrl: "http://127.0.0.1:1",
    token: "test",
    scopeId: "scope",
    allowedRoots: [root],
    stateRoot: join(root, "state"),
  };
  const calls: Array<{ operation: string; input: any; key: string }> = [];
  const bindings = new Map<string, string>();
  const received = new Map<string, any>();
  let fail: string | undefined, lose: string | undefined;
  let failMessage = "temporary_failure";
  let expansion = false;
  let feedbackSnapshot: object | undefined;
  const rpc = async (operation: string, input: any, key: string) => {
    calls.push({ operation, input, key });
    if (fail === operation) {
      fail = undefined;
      throw new Error(failMessage);
    }
    if (operation === "settings.get") return [settings];
    if (operation === "getTaskFeedback")
      return (
        feedbackSnapshot ?? { revision: 1, outcomeGeneration: 0, feedback: [] }
      );
    if (operation === "startTask") {
      if (!bindings.has(input.eventId))
        bindings.set(input.eventId, "task-" + bindings.size);
      return { taskRef: bindings.get(input.eventId) };
    }
    if (operation === "getGuidance") {
      const playbook = {
        kind: "playbook",
        id: "playbook-" + digest(input.query),
        revision: 1,
      };
      return {
        taskRef: input.taskRef,
        scopeId: "scope",
        playbooks: [
          {
            playbook,
            status: expansion ? "requires_expansion" : "guidance",
            ...(expansion
              ? {}
              : {
                  feedbackRevision: 1,
                  steps: [{ instruction: "Read the source and verify" }],
                }),
          },
        ],
        experiences: [],
        ...guidance,
      };
    }
    const id = operation + key;
    if (received.has(id))
      assert.deepEqual(
        received.get(id),
        input,
        "retries must preserve source payload",
      );
    else received.set(id, structuredClone(input));
    if (lose === operation) {
      lose = undefined;
      throw new Error("response_lost");
    }
    return operation === "recordTaskObservation"
      ? {
          results: input.map((e: any) => ({
            eventId: e.eventId,
            status: "accepted",
          })),
        }
      : { accepted: true };
  };
  const event = (n: number, extra = {}) => ({
    sessionId: "session",
    cwd: root,
    transcriptPath: path,
    timestamp: time(n),
    ...extra,
  });
  const record = (n: number, type: string, data: object, extra = {}) => ({
    id: "e-" + n,
    type,
    timestamp: time(n),
    data,
    ...extra,
  });
  const append = (...records: object[]) =>
    appendFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const hook = (type: string, n: number, extra = {}) =>
    handleHook(config, event(n, extra), type, rpc);
  const sources = () =>
    [...received]
      .filter(([key]) => key.startsWith("submitSource"))
      .flatMap(([, v]) => v.segments);
  return {
    root,
    path,
    config,
    settings,
    time,
    calls,
    bindings,
    event,
    record,
    append,
    hook,
    sources,
    received,
    fail: (operation: string, message = "temporary_failure") => {
      fail = operation;
      failMessage = message;
    },
    lose: (operation: string) => {
      lose = operation;
    },
    expand: () => {
      expansion = true;
    },
    feedback: (value: object) => {
      feedbackSnapshot = value;
    },
  };
}

test("one session retains its binding across stops, resumes and topic changes", async (t) => {
  const f = await fixture(t);
  const first = await f.hook("userPromptTransformed", 1, {
    prompt: "generated client",
  });
  await f.hook("agentStop", 2);
  await f.hook("sessionEnd", 3, { reason: "timeout" });
  await f.hook("userPromptTransformed", 4, { prompt: "database migration" });
  await f.hook("userPromptTransformed", 5, {
    prompt: "/lessonloop new is plain text now",
  });
  assert.equal(f.bindings.size, 1);
  assert.equal(f.calls.filter((c) => c.operation === "getGuidance").length, 3);
  assert.ok(String(first.modifiedTransformedPrompt).includes("task-0"));
  assert.equal(
    f.calls.some((c) =>
      ["observeTask", "recordHostObservation", "hostTaskBoundary"].includes(
        c.operation,
      ),
    ),
    false,
  );
  assert.equal(
    f.calls.some(
      (c) =>
        c.operation === "recordTaskObservation" &&
        ["task_ended", "outcome"].includes(c.input[0].kind),
    ),
    false,
  );
  const file = (await readdir(f.config.stateRoot)).find((n) =>
    n.endsWith(".json"),
  )!;
  assert.deepEqual(
    Object.keys(
      JSON.parse(await readFile(join(f.config.stateRoot, file), "utf8")),
    ).sort(),
    [
      "cursor",
      "outcomeCursor",
      "outcomeGaps",
      "outcomeGeneration",
      "outcomeTools",
      "prompts",
      "taskRef",
      "tools",
    ],
  );
});

test("empty guidance leaves the prompt unchanged, preserves capture and deduplicates only the same callback", async (t) => {
  const guidance = { playbooks: [] as object[], experiences: [] as object[] };
  const f = await fixture(t, guidance);
  await f.append(f.record(1, "user.message", { content: "Inspect" }));
  const event = {
    prompt: "Inspect",
    transformedPrompt: "Host context: Inspect",
  };
  const output = await f.hook("userPromptTransformed", 2, event);
  assert.deepEqual(output, {});
  assert.deepEqual(await f.hook("userPromptTransformed", 2, event), {});
  assert.equal(f.calls.filter((c) => c.operation === "getGuidance").length, 1);
  assert.equal(f.sources().length, 1);
  await f.append(
    f.record(3, "hook.end", {
      hookType: "userPromptTransformed",
      success: true,
      output,
    }),
    f.record(4, "assistant.message", { content: "Observed the project" }),
  );
  await f.hook("agentStop", 5);
  assert.deepEqual(
    f.sources().map((s) => s.text),
    ["Inspect", "Observed the project"],
  );
  assert.equal(
    f.calls.some((c) => c.operation === "updateTaskFeedback"),
    false,
  );
  assert.deepEqual(await f.hook("userPromptTransformed", 6, event), {});
  assert.equal(f.calls.filter((c) => c.operation === "getGuidance").length, 2);
  guidance.playbooks.push({
    playbook: { kind: "playbook", id: "available", revision: 1 },
    status: "guidance",
    feedbackRevision: 1,
    steps: [{ instruction: "Read the source and verify" }],
  });
  const next = await f.hook("userPromptTransformed", 7, event);
  assert.match(
    String(next.modifiedTransformedPrompt),
    /Read the source and verify/,
  );
  assert.equal(f.calls.filter((c) => c.operation === "getGuidance").length, 3);
  assert.equal(f.bindings.size, 1);
  assert.ok(
    f.calls
      .filter((c) => c.operation === "getGuidance")
      .every((c) => c.input.taskRef === "task-0"),
  );
});

test("experience-only guidance is still injected without playbook delivery feedback", async (t) => {
  const experience = {
    experience: { kind: "experience", id: "observed", revision: 1 },
    level: "lead",
    summary: "Verify the generated client against its source",
  };
  const f = await fixture(t, { playbooks: [], experiences: [experience] });
  const output = await f.hook("userPromptTransformed", 1, {
    prompt: "Inspect",
    transformedPrompt: "Host context: Inspect",
  });
  assert.ok(
    String(output.modifiedTransformedPrompt).startsWith(
      "Host context: Inspect",
    ),
  );
  assert.ok(
    String(output.modifiedTransformedPrompt).includes(
      JSON.stringify(experience),
    ),
  );
  await f.append(
    f.record(2, "hook.end", {
      hookType: "userPromptTransformed",
      success: true,
      output,
    }),
  );
  await f.hook("agentStop", 3);
  assert.equal(
    f.calls.some((c) => c.operation === "updateTaskFeedback"),
    false,
  );
});

test("transcript is the sole material source, preserving roles and excluding injected and product output", async (t) => {
  const f = await fixture(t);
  const output = await f.hook("userPromptTransformed", 1, {
    prompt: "Inspect",
  });
  assert.equal(f.sources().length, 0);
  await f.hook("postToolUse", 2, {
    toolName: "view",
    toolResult: { content: "uncollected callback" },
  });
  await f.append(
    f.record(1, "user.message", { content: "Inspect" }),
    f.record(2, "hook.end", {
      hookType: "userPromptTransformed",
      success: true,
      output,
    }),
    f.record(3, "tool.execution_start", {
      toolCallId: "read",
      toolName: "view",
    }),
    f.record(4, "tool.execution_complete", {
      toolCallId: "read",
      success: true,
      result: { content: "Observed schema" },
    }),
    f.record(5, "tool.execution_start", {
      toolCallId: "derived",
      toolName: "lessonloop-getGuidance",
    }),
    f.record(6, "tool.execution_complete", {
      toolCallId: "derived",
      success: true,
      result: { content: "derived guidance" },
    }),
    f.record(
      7,
      "assistant.message",
      { content: "Child material" },
      { agentId: "child" },
    ),
    f.record(8, "assistant.message", {
      content:
        "Final answer <lessonloop-playbook>injected</lessonloop-playbook>",
    }),
  );
  await f.hook("agentStop", 9);
  await f.hook("sessionEnd", 10, { finalMessage: "Final answer" });
  assert.deepEqual(
    f.sources().map((s) => s.role),
    ["user", "tool", "agent"],
  );
  assert.equal(f.sources()[2].text, "Final answer");
  assert.ok(
    f.calls.some(
      (c) =>
        c.operation === "updateTaskFeedback" && c.input.field === "delivered",
    ),
  );
});

test("lost source receipts and failed stops recover on the next callback without new task state", async (t) => {
  const f = await fixture(t);
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  await f.append(
    f.record(2, "user.message", { content: "Inspect" }),
    f.record(3, "assistant.message", { content: "Result" }),
  );
  f.lose("submitSource");
  await assert.rejects(f.hook("agentStop", 4), /response_lost/);
  await f.hook("userPromptTransformed", 5, { prompt: "Continue" });
  assert.equal(f.bindings.size, 1);
  assert.equal(f.sources().length, 2);
  f.fail("getGuidance");
  await assert.rejects(
    f.hook("userPromptTransformed", 6, { prompt: "Check" }),
    /temporary_failure/,
  );
  assert.ok(
    (await f.hook("userPromptTransformed", 6, { prompt: "Check" }))
      .modifiedTransformedPrompt,
  );
  assert.deepEqual(
    await f.hook("userPromptTransformed", 6, { prompt: "Check" }),
    {},
  );
});

test("authorization and learning switches precede capture; expanded guidance uses getGuidance", async (t) => {
  const f = await fixture(t);
  f.config.allowedRoots = [];
  await f.hook("userPromptTransformed", 1, { prompt: "Inspect" });
  assert.equal(f.calls.length, 0);
  f.config.allowedRoots = [f.root];
  f.settings.learning = false;
  await f.append(f.record(2, "user.message", { content: "Private" }));
  f.expand();
  const output = await f.hook("userPromptTransformed", 3, {
    prompt: "Large guidance",
  });
  assert.equal(f.sources().length, 0);
  assert.match(String(output.modifiedTransformedPrompt), /getGuidance/);
  assert.match(String(output.modifiedTransformedPrompt), /requires_expansion/);
  f.settings.learning = true;
  await f.hook("agentStop", 4);
  assert.equal(f.sources().length, 0, "disabled content is not backfilled");
});

const expandedGuidance = () => ({
  result: {
    taskRef: "task-0",
    scopeId: "scope",
    playbooks: [
      {
        playbook: { kind: "playbook", id: "Large guidance", revision: 3 },
        status: "guidance",
        feedbackRevision: 2,
        steps: [{ instruction: "Read the source and verify" }],
      },
    ],
    experiences: [],
  },
});
const deliveries = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls.filter(
    (c) =>
      c.operation === "updateTaskFeedback" && c.input.field === "delivered",
  );

test("MCP expansion confirms delivery only after a successful tool receipt and never becomes source material", async (t) => {
  const f = await fixture(t);
  f.expand();
  const output = await f.hook("userPromptTransformed", 1, {
    prompt: "Large guidance",
  });
  await f.append(
    f.record(2, "hook.end", {
      hookType: "userPromptTransformed",
      success: true,
      output,
    }),
    f.record(3, "tool.execution_start", {
      toolCallId: "expand",
      toolName: "lessonloop-getGuidance",
    }),
  );
  await f.hook("agentStop", 4);
  assert.equal(deliveries(f).length, 0);
  await f.append(
    f.record(5, "tool.execution_complete", {
      toolCallId: "expand",
      success: true,
      result: { content: JSON.stringify(expandedGuidance()) },
    }),
  );
  await f.hook("agentStop", 6);
  await f.hook("sessionEnd", 7);
  assert.deepEqual(
    deliveries(f).map((c) => c.input),
    [
      {
        taskRef: "task-0",
        field: "delivered",
        playbookId: "Large guidance",
        revision: 3,
        expectedRevision: 2,
      },
    ],
  );
  assert.equal(f.sources().length, 0);
});

test("explicit MCP guidance confirms delivery with learning and automatic recommendations disabled", async (t) => {
  const f = await fixture(t);
  f.settings.learning = false;
  f.settings.recommendation = false;
  await f.append(
    f.record(1, "tool.execution_start", {
      toolCallId: "explicit",
      toolName: "lessonloop-getGuidance",
    }),
    f.record(2, "tool.execution_complete", {
      toolCallId: "explicit",
      success: true,
      result: { textResultForLlm: JSON.stringify(expandedGuidance()) },
    }),
  );
  await f.hook("agentStop", 3);
  assert.equal(deliveries(f).length, 1);
  assert.equal(f.sources().length, 0);
});

test("MCP delivery ignores failed, incomplete, foreign and disabled receipts", async (t) => {
  const invalid: Array<{
    name: string;
    change?: (body: any) => void;
    completion?: Record<string, unknown>;
    toolName?: string;
    review?: boolean;
    extra?: Record<string, unknown>;
  }> = [
    { name: "failed tool", completion: { success: false } },
    {
      name: "MCP result error",
      completion: {
        result: { content: JSON.stringify(expandedGuidance()), isError: true },
      },
    },
    {
      name: "truncated model content with a complete UI copy",
      completion: {
        result: {
          content: "truncated",
          detailedContent: JSON.stringify(expandedGuidance()),
          textResultForLlm: JSON.stringify(expandedGuidance()),
        },
      },
    },
    { name: "malformed JSON", completion: { result: { content: "invalid" } } },
    { name: "null body", completion: { result: { content: "null" } } },
    {
      name: "MCP error",
      change: (body) => {
        body.isError = true;
      },
    },
    {
      name: "RPC error",
      change: (body) => {
        body.error = "unavailable";
      },
    },
    {
      name: "other task",
      change: (body) => {
        body.result.taskRef = "other";
      },
    },
    {
      name: "other scope",
      change: (body) => {
        body.result.scopeId = "other";
      },
    },
    {
      name: "requires expansion",
      change: (body) => {
        body.result.playbooks[0].status = "requires_expansion";
      },
    },
    {
      name: "too large",
      change: (body) => {
        body.result.playbooks[0].status = "too_large";
      },
    },
    {
      name: "missing feedback revision",
      change: (body) => {
        delete body.result.playbooks[0].feedbackRevision;
      },
    },
    {
      name: "invalid feedback revision",
      change: (body) => {
        body.result.playbooks[0].feedbackRevision = 0;
      },
    },
    {
      name: "invalid target revision",
      change: (body) => {
        body.result.playbooks[0].playbook.revision = 0;
      },
    },
    {
      name: "experience target",
      change: (body) => {
        body.result.playbooks[0].playbook.kind = "experience";
      },
    },
    { name: "unrelated product tool", toolName: "lessonloop-submitSource" },
    { name: "lookalike tool", toolName: "other-lessonloop-getGuidance" },
    { name: "review disabled", review: false },
    { name: "child agent", extra: { agentId: "child" } },
  ];
  for (const scenario of invalid)
    await t.test(scenario.name, async (t) => {
      const f = await fixture(t);
      f.settings.review = scenario.review ?? true;
      const body = expandedGuidance();
      scenario.change?.(body);
      await f.append(
        f.record(
          1,
          "tool.execution_start",
          {
            toolCallId: "expand",
            toolName: scenario.toolName ?? "lessonloop-getGuidance",
          },
          scenario.extra,
        ),
        f.record(
          2,
          "tool.execution_complete",
          {
            toolCallId: "expand",
            success: true,
            result: { content: JSON.stringify(body) },
            ...scenario.completion,
          },
          scenario.extra,
        ),
      );
      await f.hook("agentStop", 3);
      assert.equal(deliveries(f).length, 0);
      assert.equal(f.sources().length, 0);
      f.settings.review = true;
      await f.hook("agentStop", 4);
      assert.equal(
        deliveries(f).length,
        0,
        "ignored receipts are not backfilled",
      );
    });
});

test("MCP delivery retries transport failures with the same receipt and respects feedback conflicts", async (t) => {
  for (const error of [
    "response_lost",
    "revision_conflict",
    "feedback_unavailable",
    "review_disabled",
  ]) {
    await t.test(error, async (t) => {
      const f = await fixture(t);
      await f.append(
        f.record(1, "tool.execution_start", {
          toolCallId: "expand",
          toolName: "lessonloop-getGuidance",
        }),
        f.record(2, "tool.execution_complete", {
          toolCallId: "expand",
          success: true,
          result: { content: JSON.stringify(expandedGuidance()) },
        }),
        f.record(3, "assistant.message", {
          content: "Continue collecting observations",
        }),
      );
      if (error === "response_lost") {
        f.lose("updateTaskFeedback");
        await assert.rejects(f.hook("agentStop", 3), /response_lost/);
      } else {
        f.fail("updateTaskFeedback", error);
        await f.hook("agentStop", 3);
      }
      await f.hook("sessionEnd", 4);
      const updates = deliveries(f);
      assert.equal(updates.length, error === "response_lost" ? 2 : 1);
      if (error === "response_lost") assert.deepEqual(updates[0], updates[1]);
      assert.deepEqual(
        f.sources().map((source) => source.text),
        ["Continue collecting observations"],
      );
    });
  }
});

test("streaming preserves UTF-8 and incomplete lines, reports identity mismatches and truncation", async (t) => {
  const f = await fixture(t);
  const content = "汉字🙂".repeat(10000);
  await f.append(f.record(1, "assistant.message", { content }));
  const first = await readTranscript(f.event(2), f.root);
  assert.equal(first.records.at(-1)?.data.content, content);
  const next = JSON.stringify(
    f.record(3, "assistant.message", { content: "继续🙂" }),
  );
  await appendFile(f.path, next);
  const partial = await readTranscript(f.event(4), f.root, first.cursor);
  assert.deepEqual(partial.cursor, first.cursor);
  await appendFile(f.path, "\n");
  const complete = await readTranscript(f.event(5), f.root, partial.cursor);
  assert.equal(complete.records[0]?.data.content, "继续🙂");
  const bounded = await readTranscript(f.event(6), f.root, undefined, 70000);
  assert.ok(bounded.gaps.includes("transcript_truncated"));
  assert.equal(bounded.cursor?.offset, (await readFile(f.path)).length);
  assert.deepEqual(
    (await readTranscript(f.event(6, { sessionId: "wrong" }), f.root)).gaps,
    ["transcript_identity_mismatch"],
  );
});

test("long sessions have no adapter event-count cutoff and old task state is rejected", async (t) => {
  const f = await fixture(t);
  await f.append(
    ...Array.from({ length: 200 }, (_, n) =>
      f.record(n + 1, "assistant.message", { content: "Observation " + n }),
    ),
  );
  await f.hook("agentStop", 201);
  assert.equal(f.sources().length, 200);
  const file = (await readdir(f.config.stateRoot)).find((n) =>
    n.endsWith(".json"),
  )!;
  await writeFile(
    join(f.config.stateRoot, file),
    JSON.stringify({ captures: {}, tools: {} }),
  );
  await assert.rejects(
    f.hook("userPromptTransformed", 202, { prompt: "Resume" }),
    /host_session_restart_required/,
  );
  await rm(join(f.config.stateRoot, file));
  await writeFile(
    join(f.config.stateRoot, digest([f.root, "session"]) + ".json"),
    JSON.stringify({ tasks: [] }),
  );
  await assert.rejects(
    f.hook("agentStop", 203),
    /host_session_restart_required/,
  );
});

const outcomeCalls = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls.filter((c) => c.operation === "submitTaskOutcome");
const savedOutcomeState = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const file = (await readdir(f.config.stateRoot)).find((n) =>
    n.endsWith(".json"),
  )!;
  const raw = await readFile(join(f.config.stateRoot, file), "utf8");
  return { raw, state: JSON.parse(raw) };
};

test("review captures session evidence independently of learning and queues only hook triggers", async (t) => {
  const f = await fixture(t);
  f.settings.learning = false;
  await f.hook("userPromptTransformed", 1, {
    prompt: "Implement and test the change",
  });
  await f.append(
    f.record(2, "user.message", { content: "Implement and test the change" }),
    f.record(3, "assistant.message", { content: "Implemented it; tests pass" }),
  );
  await f.hook("agentStop", 4, { stopReason: "end_turn" });
  const requests = outcomeCalls(f);
  assert.deepEqual(
    requests.map((c) => c.input.trigger),
    ["userPromptTransformed", "agentStop"],
  );
  assert.equal(requests[0]!.input.observations[0].role, "user");
  assert.equal(
    requests[0]!.input.observations[0].text,
    "Implement and test the change",
  );
  assert.equal(requests[0]!.input.observations[0].occurredAt, f.time(1));
  assert.deepEqual(
    requests[1]!.input.observations.map((o: any) => o.role),
    ["user", "agent", "host"],
  );
  assert.deepEqual(JSON.parse(requests[1]!.input.observations.at(-1).text), {
    event: "agentStop",
    stopReason: "end_turn",
  });
  assert.deepEqual(
    requests[1]!.input.observations.map((o: any) => o.occurredAt),
    [f.time(2), f.time(3), f.time(4)],
  );
  assert.ok(requests.every((c) => !("taskOutcome" in c.input)));
  assert.equal(f.sources().length, 0);
  assert.ok(
    requests[1]!.input.checkpoint.offset > requests[0]!.input.checkpoint.offset,
  );
});

test("outcome capture retries missed deltas and callback evidence without blocking learning or guidance", async (t) => {
  const f = await fixture(t);
  f.fail("submitTaskOutcome");
  const prompt = await f.hook("userPromptTransformed", 1, {
    prompt: "Original full goal",
  });
  assert.ok(prompt.modifiedTransformedPrompt);
  const afterFailure = await savedOutcomeState(f);
  assert.ok(!afterFailure.raw.includes("Original full goal"));
  assert.deepEqual(afterFailure.state.outcomePendingPrompts, [
    { hash: digest("Original full goal"), occurredAt: f.time(1) },
  ]);
  assert.ok(
    afterFailure.state.outcomePending.every((o: any) => o.role === "host"),
  );
  await f.append(
    f.record(2, "assistant.message", { content: "Partial implementation" }),
  );
  f.lose("submitTaskOutcome");
  await f.hook("sessionEnd", 3, { reason: "abort" });
  assert.deepEqual(
    f.sources().map((s) => s.text),
    ["Partial implementation"],
  );
  await f.append(f.record(4, "user.message", { content: "Resume and finish" }));
  await f.hook("userPromptTransformed", 5, { prompt: "Resume and finish" });
  const retry = outcomeCalls(f).at(-1)!.input;
  assert.equal(retry.trigger, "userPromptTransformed");
  assert.ok(
    retry.observations.every((o: any) => o.text !== "Original full goal"),
  );
  assert.ok(retry.gaps.includes("outcome_prompt_unavailable"));
  assert.ok(
    retry.observations.some((o: any) => o.text === "Partial implementation"),
  );
  assert.equal(
    retry.observations.find((o: any) => o.role === "host").occurredAt,
    f.time(3),
  );
  assert.ok(
    retry.observations.some(
      (o: any) => o.role === "host" && JSON.parse(o.text).reason === "abort",
    ),
  );
  assert.ok(
    retry.observations.findIndex(
      (o: any) => o.text === "Partial implementation",
    ) < retry.observations.findIndex((o: any) => o.role === "host"),
    "terminal callback stays after earlier transcript evidence when replayed",
  );
  assert.equal(
    retry.observations.filter((o: any) => o.text === "Resume and finish")
      .length,
    1,
  );
  assert.deepEqual(
    f.sources().map((s) => s.text),
    ["Partial implementation", "Resume and finish"],
  );
  const saved = JSON.parse(
    await readFile(
      join(
        f.config.stateRoot,
        (await readdir(f.config.stateRoot)).find((n) => n.endsWith(".json"))!,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(saved.outcomeCursor, saved.cursor);
  assert.equal(saved.outcomePending, undefined);
  assert.deepEqual(saved.outcomePendingPrompts, [
    { hash: digest("Original full goal"), occurredAt: f.time(1) },
  ]);
});

test("missed prompt hashes recover from transcript or a repeated callback without local plaintext", async (t) => {
  for (const recovery of ["transcript", "callback"]) {
    const f = await fixture(t);
    const original = `Private original goal for ${recovery}`;
    f.settings.learning = false;
    f.fail("submitTaskOutcome");
    await f.hook("userPromptTransformed", 1, { prompt: original });
    assert.ok(!(await savedOutcomeState(f)).raw.includes(original));
    await f.hook("agentStop", 2, { stopReason: "end_turn" });
    assert.ok(
      outcomeCalls(f).at(-1)!.input.gaps.includes("outcome_prompt_unavailable"),
    );
    if (recovery === "transcript") {
      await f.append(
        f.record(1, "user.message", { content: original }),
        f.record(3, "assistant.message", {
          content: "Result waiting for verification",
        }),
      );
      await f.hook("agentStop", 4);
    } else {
      await f.hook("userPromptTransformed", 4, { prompt: original });
    }
    const recovered = outcomeCalls(f).at(-1)!.input;
    assert.deepEqual(recovered.gaps, []);
    assert.ok(
      recovered.observations.some(
        (o: any) => o.role === "user" && o.text === original,
      ),
    );
    const saved = await savedOutcomeState(f);
    assert.equal(saved.state.outcomePendingPrompts, undefined);
    assert.ok(!saved.raw.includes(original));
    assert.equal(f.sources().length, 0);
  }
});

test("a second failed capture retains recovered prompt hashes until delivery succeeds", async (t) => {
  const f = await fixture(t);
  f.fail("submitTaskOutcome");
  await f.hook("userPromptTransformed", 1, { prompt: "Private retry goal" });
  await f.append(
    f.record(1, "user.message", { content: "Private retry goal" }),
  );
  f.fail("submitTaskOutcome");
  await f.hook("agentStop", 2);
  const failed = await savedOutcomeState(f);
  assert.ok(!failed.raw.includes("Private retry goal"));
  assert.equal(
    failed.state.outcomePendingPrompts[0].hash,
    digest("Private retry goal"),
  );
  await f.hook("agentStop", 3);
  assert.deepEqual(outcomeCalls(f).at(-1)!.input.gaps, []);
  assert.equal(
    (await savedOutcomeState(f)).state.outcomePendingPrompts,
    undefined,
  );
});

test("outcome captures terminal host reasons as evidence and keeps intermediate errors distinct", async (t) => {
  const f = await fixture(t);
  await f.append(
    f.record(1, "tool.execution_start", {
      toolCallId: "check",
      toolName: "shell",
    }),
    f.record(2, "tool.execution_complete", {
      toolCallId: "check",
      success: false,
      error: "temporary test failure",
    }),
    f.record(3, "hook.end", {
      hookType: "agentStop",
      success: false,
      error: "hook failed",
    }),
    f.record(4, "assistant.message", {
      content: "Retried and all checks pass",
    }),
    f.record(5, "tool.execution_start", {
      toolCallId: "product",
      toolName: "lessonloop-submitSource",
    }),
    f.record(6, "tool.execution_complete", {
      toolCallId: "product",
      success: false,
      error: "product failed",
    }),
  );
  await f.hook("agentStop", 7);
  const initial = outcomeCalls(f).at(-1)!.input.observations;
  assert.deepEqual(
    initial.map((o: any) => o.role),
    ["tool", "agent"],
  );
  assert.equal(JSON.parse(initial[0].text).result.success, false);
  assert.ok(
    initial.every(
      (o: any) =>
        !o.text.includes("hook failed") && !o.text.includes("product failed"),
    ),
  );
  for (const [index, reason] of [
    "error",
    "abort",
    "timeout",
    "user_exit",
    "complete",
  ].entries()) {
    await f.hook("sessionEnd", index + 8, { reason });
    const input = outcomeCalls(f).at(-1)!.input;
    assert.deepEqual(
      input.observations.map((o: any) => ({
        role: o.role,
        ...JSON.parse(o.text),
      })),
      [{ role: "host", event: "sessionEnd", reason }],
    );
    assert.equal(input.taskOutcome, undefined);
  }
});

test("disabled or truncated review capture reports missing coverage instead of backfilling", async (t) => {
  const f = await fixture(t);
  f.settings.review = false;
  await f.append(
    f.record(1, "user.message", { content: "Private disabled goal" }),
  );
  await f.hook("userPromptTransformed", 2, { prompt: "Private disabled goal" });
  assert.equal(outcomeCalls(f).length, 0);
  f.settings.review = true;
  await f.append(
    ...Array.from({ length: 220 }, (_, n) =>
      f.record(n + 3, "assistant.message", { content: "Observation " + n }),
    ),
  );
  await f.hook("agentStop", 225);
  const input = outcomeCalls(f).at(-1)!.input;
  assert.equal(input.observations.length, 192);
  assert.ok(input.gaps.includes("outcome_review_disabled"));
  assert.ok(input.gaps.includes("outcome_input_budget"));
  assert.equal(input.observations[0].text, "Observation 0");
  assert.equal(input.observations.at(-1).text, "Observation 219");
  assert.ok(
    input.observations.every(
      (o: any) => !o.text.includes("Private disabled goal"),
    ),
  );
});

test("delivery refreshes its revision after independent outcome or user feedback updates", async (t) => {
  const f = await fixture(t);
  f.feedback({
    revision: 9,
    feedback: [{ playbookId: "Large guidance", revision: 3, delivered: null }],
  });
  await f.append(
    f.record(1, "tool.execution_start", {
      toolCallId: "guidance",
      toolName: "lessonloop-getGuidance",
    }),
    f.record(2, "tool.execution_complete", {
      toolCallId: "guidance",
      success: true,
      result: { content: JSON.stringify(expandedGuidance()) },
    }),
  );
  f.fail("updateTaskFeedback", "revision_conflict");
  await f.hook("agentStop", 3);
  assert.deepEqual(
    deliveries(f).map((c) => c.input.expectedRevision),
    [2, 9],
  );
  assert.ok(deliveries(f).every((c) => c.input.field === "delivered"));
});

test("temporary transcript absence clears after a complete retry", async (t) => {
  const f = await fixture(t);
  const head = await readFile(f.path);
  await rm(f.path);
  await f.hook("userPromptTransformed", 1, {
    prompt: "Inspect the full session",
  });
  const missing = outcomeCalls(f).at(-1)!.input;
  assert.equal(missing.checkpoint.path, "unavailable");
  assert.ok(missing.gaps.includes("transcript_unavailable"));
  await writeFile(f.path, head);
  await f.append(
    f.record(2, "user.message", { content: "Inspect the full session" }),
    f.record(3, "assistant.message", { content: "Inspection completed" }),
  );
  await f.hook("agentStop", 4);
  const recovered = outcomeCalls(f).at(-1)!.input;
  assert.notEqual(recovered.checkpoint.path, "unavailable");
  assert.deepEqual(recovered.gaps, []);
  assert.deepEqual(
    recovered.observations.map((o: any) => o.role),
    ["user", "agent"],
  );
});

test("new feedback generation skips cleared transcript and pending callback evidence", async (t) => {
  const f = await fixture(t);
  f.fail("submitTaskOutcome");
  await f.hook("userPromptTransformed", 1, { prompt: "Cleared original goal" });
  assert.ok(
    !(await savedOutcomeState(f)).raw.includes("Cleared original goal"),
  );
  await f.append(
    f.record(2, "user.message", { content: "Cleared original goal" }),
    f.record(3, "assistant.message", { content: "Cleared result" }),
  );
  f.feedback({ revision: 8, outcomeGeneration: 1, feedback: [] });
  await f.hook("userPromptTransformed", 4, {
    prompt: "Fresh goal after clear",
  });
  const fresh = outcomeCalls(f).at(-1)!.input;
  assert.equal(fresh.generation, 1);
  assert.deepEqual(
    fresh.observations.map((o: any) => o.text),
    ["Fresh goal after clear"],
  );
  assert.ok(fresh.gaps.includes("outcome_generation_changed"));
  assert.ok(!fresh.gaps.includes("outcome_prompt_unavailable"));
  assert.equal(
    (await savedOutcomeState(f)).state.outcomePendingPrompts,
    undefined,
  );
  assert.deepEqual(
    f.sources().map((s) => s.text),
    ["Cleared original goal", "Cleared result"],
  );
});

test("generation read failure preserves learning and retries outcome capture later", async (t) => {
  const f = await fixture(t);
  await f.append(f.record(1, "user.message", { content: "Review goal" }));
  f.fail("getTaskFeedback");
  const output = await f.hook("userPromptTransformed", 2, {
    prompt: "Review goal",
  });
  assert.ok(output.modifiedTransformedPrompt);
  assert.equal(outcomeCalls(f).length, 0);
  assert.equal(f.sources().length, 1);
  await f.hook("agentStop", 3);
  const recovered = outcomeCalls(f).at(-1)!.input;
  assert.equal(recovered.generation, 0);
  assert.ok(recovered.observations.some((o: any) => o.text === "Review goal"));
});

test("delivery cannot replay into re-registered feedback after a clear", async (t) => {
  const f = await fixture(t);
  f.feedback({
    revision: 9,
    minimumRevision: 8,
    outcomeGeneration: 1,
    feedback: [{ playbookId: "Large guidance", revision: 3, delivered: null }],
  });
  await f.append(
    f.record(1, "tool.execution_start", {
      toolCallId: "old-guidance",
      toolName: "lessonloop-getGuidance",
    }),
    f.record(2, "tool.execution_complete", {
      toolCallId: "old-guidance",
      success: true,
      result: { content: JSON.stringify(expandedGuidance()) },
    }),
  );
  f.fail("updateTaskFeedback", "revision_conflict");
  await f.hook("agentStop", 3);
  assert.deepEqual(
    deliveries(f).map((c) => c.input.expectedRevision),
    [2],
  );
});
