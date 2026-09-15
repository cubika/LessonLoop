import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore, Transaction } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { Effects } from "../src/core/effects.js";
import { dispatch } from "../src/core/server.js";
import { handleHook } from "../src/adapters/copilot/hook.js";
import { mkdtemp, realpath, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
test("host boundaries commit task and effects together, survive retries and enforce ownership", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scopeId = randomUUID();
    const host = {
      id: randomUUID(),
      channel: "host" as const,
      scopes: [scopeId],
    };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(
      { ...host, channel: "user" },
      {
        scopeId,
        expectedRevision: 0,
        learning: true,
        recommendation: false,
        review: true,
        notifications: false,
      },
    );
    const time = (n: number) =>
      new Date(Date.now() - 60000 + n * 1000).toISOString();
    const epoch = time(0);
    const at = (n: number) =>
      new Date(Date.parse(epoch) + n * 1000).toISOString();
    const input = (action: string, n: number, extra = {}) => ({
      scopeId,
      sessionKey: "session",
      action,
      occurredAt: at(n),
      ...extra,
    });
    const rpc = (value: unknown, p = host) =>
      dispatch(
        core,
        p,
        "hostTaskBoundary",
        value,
        "host-boundary",
      ) as Promise<any>;
    const first = await rpc(input("prompt", 1, { promptKey: "first" }));
    assert.equal(
      (await rpc(input("prompt", 1, { promptKey: "first" }))).taskRef,
      first.taskRef,
    );
    await assert.rejects(
      dispatch(
        core,
        { ...host, channel: "agent" },
        "hostTaskBoundary",
        input("end", 2),
        "x",
      ),
      /trusted_host_required/,
    );
    await assert.rejects(
      rpc({ ...input("read", 2), scopeId: "other" }),
      /not_found/,
    );
    assert.deepEqual(
      (await rpc(input("read", 2), { ...host, id: randomUUID() })).tasks,
      [],
    );

    // Fail after effect writes but before the task row update. PostgreSQL must
    // roll back the end event; a retry produces exactly one task closure.
    const put = Transaction.prototype.put;
    Transaction.prototype.put = async function (entry, expected) {
      if (
        entry.kind === "task" &&
        entry.id === first.taskRef &&
        entry.value.ended
      )
        throw new Error("injected_storage_failure");
      return put.call(this, entry, expected);
    };
    try {
      await assert.rejects(
        rpc(input("end", 3, { reason: "timeout" })),
        /injected_storage_failure/,
      );
    } finally {
      Transaction.prototype.put = put;
    }
    assert.equal((await rpc(input("read", 3))).tasks[0].endedAt, undefined);
    let events = (await new Effects(store).cases([scopeId])).flatMap(
      (c) => c.events,
    );
    assert.equal(
      events.some((e) => e.kind === "outcome" || e.kind === "task_ended"),
      false,
    );
    await rpc(input("end", 3, { reason: "timeout" }));
    await rpc(input("end", 3, { reason: "timeout" }));
    events = (await new Effects(store).cases([scopeId])).flatMap(
      (c) => c.events,
    );
    assert.equal(events.filter((e) => e.kind === "outcome").length, 0);
    assert.equal(events.filter((e) => e.kind === "task_ended").length, 1);
    const second = await rpc(
      input("prompt", 4, { promptKey: "second", boundary: "continue" }),
    );
    assert.notEqual(second.taskRef, first.taskRef);
    await rpc(input("stop", 5));
    assert.equal(
      (
        await rpc(
          input("prompt", 6, {
            promptKey: "clarification",
            boundary: "continue",
          }),
        )
      ).taskRef,
      second.taskRef,
    );
    assert.equal((await rpc(input("read", 2))).taskRef, first.taskRef);
    await rpc(input("stop", 7));
    const third = await rpc(input("prompt", 8, { promptKey: "third" }));
    assert.notEqual(third.taskRef, second.taskRef);
    assert.equal(
      (await rpc(input("prompt", 4, { promptKey: "second" }))).taskRef,
      second.taskRef,
    );
    assert.equal((await rpc(input("read", 9))).tasks.length, 3);

    const root = await realpath(
      await mkdtemp(join(tmpdir(), "lessonloop-host-db-")),
    );
    try {
      const path = join(root, "events.jsonl");
      await writeFile(
        path,
        JSON.stringify({
          type: "session.start",
          data: { sessionId: "capture", context: { cwd: root } },
        }) + "\n",
      );
      const config = {
        baseUrl: "http://127.0.0.1:1",
        token: "unused",
        scopeId,
        allowedRoots: [root],
        stateRoot: join(root, "state"),
      };
      const hook = (type: string, n: number, extra = {}) =>
        handleHook(
          config,
          {
            sessionId: "capture",
            cwd: root,
            transcriptPath: path,
            timestamp: at(n),
            ...extra,
          },
          type,
          (operation, value, key) =>
            dispatch(core, host, operation, value, key),
        );
      await hook("userPromptTransformed", 10, {
        prompt: "Inspect generated source",
      });
      await appendFile(
        path,
        JSON.stringify({
          id: "start",
          type: "tool.execution_start",
          timestamp: at(11),
          data: { toolCallId: "view-1", toolName: "view" },
        }) + "\n",
      );
      await hook("postToolUse", 12, {
        toolCallId: "view-1",
        toolName: "view",
        toolResult: { content: "source verified", success: true },
      });
      await appendFile(
        path,
        JSON.stringify({
          id: "complete",
          type: "tool.execution_complete",
          timestamp: at(13),
          data: {
            toolCallId: "view-1",
            result: { content: "source verified" },
            success: true,
          },
        }) + "\n",
      );
      await hook("agentStop", 14);
      await hook("sessionEnd", 15, { reason: "complete" });
      const stored = await store.transaction((tx) =>
        tx.list<any>("task", [scopeId]),
      );
      const captured = stored.find((task) => task.hostStartedAt === at(10));
      assert.equal(captured.rawObservations.length, 1);
      assert.equal(captured.rawObservations[0].occurredAt, at(12));
      assert.equal(captured.ended, true);
      const sources = await store.transaction((tx) =>
        tx.list<any>("source", [scopeId]),
      );
      assert.equal(
        sources.filter((s) => s.taskRef === captured.id && s.segment).length,
        2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await store.close();
  }
});
