import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { Effects } from "../src/core/effects.js";
import { Reviews } from "../src/core/reviews.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw Error("isolated database required");

test("Direct feedback survives restart, accepts independent corrections and rejects stale or cleared writes", async () => {
  let store = new ProductStore(url);
  await store.open();
  try {
    const scope = randomUUID(),
      host = { id: randomUUID(), channel: "host", scopes: [scope] },
      user = { ...host, channel: "user" };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(user as any, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      review: true,
      recommendation: false,
      notifications: false,
    });
    const task = await core.startTask(host as any, scope),
      playbook = { kind: "playbook" as const, id: randomUUID(), revision: 3 };
    let effects = new Effects(store);
    const register = () =>
      store.transaction(async (tx) =>
        effects.register(
          tx,
          (await tx.get<any>("task", task.taskRef))!,
          playbook,
        ),
      );
    await register();
    const read = async () => (await effects.cases([scope]))[0]!;
    assert.deepEqual((await read()).feedback, [
      {
        playbookId: playbook.id,
        revision: 3,
        delivered: null,
        userRating: null,
        ratingText: "",
      },
    ]);
    await core.observe(host as any, {
      taskRef: task.taskRef,
      eventId: "end",
      text: "Ended",
      values: {},
      ended: true,
    });
    assert.equal((await read()).taskOutcome, "unknown");
    const rate = {
      taskRef: task.taskRef,
      field: "userRating",
      playbookId: playbook.id,
      revision: 3,
      expectedRevision: (await read()).revision,
      rating: "helpful",
      text: "Useful",
    };
    const receipt = await effects.update(user, rate);
    assert.deepEqual(await effects.update(user, rate), receipt);
    await effects.update(host, {
      taskRef: task.taskRef,
      field: "taskOutcome",
      expectedRevision: receipt.revision,
      taskOutcome: "failed",
      text: "Check failed",
    });
    await effects.update(user, {
      ...rate,
      expectedRevision: (await read()).revision,
      rating: "incorrect",
    });
    await assert.rejects(effects.update(user, rate), /revision_conflict/);
    await assert.rejects(
      effects.update(host, {
        ...rate,
        expectedRevision: (await read()).revision,
      }),
      /feedback_writer_denied/,
    );
    await assert.rejects(
      effects.update(
        { ...host, id: "other" },
        {
          taskRef: task.taskRef,
          field: "taskOutcome",
          taskOutcome: "succeeded",
          expectedRevision: 1,
        },
      ),
      /feedback_unavailable/,
    );
    await effects.update(host, {
      taskRef: task.taskRef,
      field: "delivered",
      playbookId: playbook.id,
      revision: 3,
      expectedRevision: (await read()).revision,
    });
    const before = await read();
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    effects = new Effects(store);
    assert.deepEqual(await read(), before);
    assert.equal((await effects.summary([scope])).failed, 1);
    assert.equal((await effects.summary([scope])).helpful, 0);
    const reviews = new Reviews(store);
    const issue = await reviews.recordIssue(user as any, {
      scopeId: scope,
      problemKey: "problem",
      expectedRevision: 0,
      category: "incorrect_guidance",
      status: "confirmed",
      severity: "serious",
      evidence: [{ caseId: task.taskRef, revision: before.revision }],
    });
    await effects.update(user, { ...rate, expectedRevision: before.revision });
    const corrected = (await reviews.issues(user as any))[0]!;
    assert.equal(corrected.status, "suspected");
    assert.equal(corrected.evidence[0]!.revision, (await read()).revision);
    await reviews.recordIssue(user as any, {
      scopeId: scope,
      id: corrected.id,
      expectedRevision: corrected.revision,
      category: corrected.category,
      status: "resolved",
      severity: "normal",
      evidence: corrected.evidence,
    });
    assert.equal(
      (await reviews.issues(user as any)).some(
        (i) => i.id === issue.id && i.status === "confirmed",
      ),
      false,
    );
    await effects.clear(scope);
    await assert.rejects(effects.update(user, rate), /feedback_unavailable/);
    assert.deepEqual(await effects.cases([scope]), []);
    await register();
    await assert.rejects(effects.update(user, rate), /revision_conflict/);
    assert.equal((await read()).taskOutcome, "unknown");
    assert.equal((await read()).feedback[0]!.userRating, null);
    await store.transaction(async (tx) => {
      const row = await tx.get<any>("task_feedback", task.taskRef);
      await tx.put(
        {
          kind: "task_feedback",
          id: row.id,
          scopeId: scope,
          revision: row.revision + 1,
          value: {
            ...row,
            revision: row.revision + 1,
            createdAt: "2000-01-01T00:00:00.000Z",
          },
        },
        row.revision,
      );
    });
    await effects.maintain([scope]);
    assert.deepEqual(await effects.cases([scope]), []);
  } finally {
    await store.close();
  }
});
