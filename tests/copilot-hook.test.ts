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

async function fixture(t: test.TestContext) {
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
  let expansion = false;
  const rpc = async (operation: string, input: any, key: string) => {
    calls.push({ operation, input, key });
    if (fail === operation) {
      fail = undefined;
      throw new Error("temporary_failure");
    }
    if (operation === "settings.get") return [settings];
    if (operation === "startTask") {
      if (!bindings.has(input.eventId))
        bindings.set(input.eventId, "task-" + bindings.size);
      return { taskRef: bindings.get(input.eventId) };
    }
    if (operation === "getGuidance") {
      const playbook = { kind: "playbook", id: input.query, revision: 1 };
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
                  playbookUseRef: "use-" + input.query,
                  steps: [{ instruction: "Read the source and verify" }],
                }),
          },
        ],
        experiences: [],
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
    fail: (operation: string) => {
      fail = operation;
    },
    lose: (operation: string) => {
      lose = operation;
    },
    expand: () => {
      expansion = true;
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
    ["cursor", "prompts", "taskRef", "tools"],
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
        c.operation === "recordTaskObservation" &&
        c.input[0].kind === "delivery",
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
  f.settings.learning = true;
  await f.hook("agentStop", 4);
  assert.equal(f.sources().length, 0, "disabled content is not backfilled");
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
  await writeFile(join(f.config.stateRoot, digest([f.root, "session"]) + ".json"), JSON.stringify({tasks: []}));
  await assert.rejects(f.hook("agentStop", 203), /host_session_restart_required/);
});
