import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { Effects } from "../src/core/effects.js";
import { Reviews } from "../src/core/reviews.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
test("Periodic reviews merge offline intervals, preserve unknowns, respect mute, and clear contributions", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const scope = randomUUID(),
      host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
      p = { ...host, channel: "user" as const };
    const core = new CoreService(
        store,
        new HindsightEngine("http://127.0.0.1:19888", "unused"),
      ),
      effects = new Effects(store),
      reviews = new Reviews(store);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: false,
      recommendation: false,
      review: true,
      notifications: true,
    });
    const otherTask = await core.startTask(host, scope);
    const reference = { kind: "playbook", id: randomUUID(), revision: 1 };
    await store.transaction(async (tx) => {
      const id = randomUUID();
      await tx.put(
        {
          kind: "playbook_use",
          id,
          scopeId: scope,
          revision: 1,
          value: {
            id,
            revision: 1,
            scopeId: scope,
            taskRef: otherTask.taskRef,
            callerId: host.id,
            playbook: reference,
            playbookUseRef: "use-1",
            stepIds: ["s1"],
            returnedAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
        null,
      );
    });
    const now = Date.now();
    await store.transaction(async (tx) => {
      const schedule = await tx.get<any>("review_schedule", scope);
      await tx.put(
        {
          kind: "review_schedule",
          id: scope,
          scopeId: scope,
          revision: schedule.revision + 1,
          value: {
            ...schedule,
            revision: schedule.revision + 1,
            through: new Date(now - 15 * 86400000).toISOString(),
          },
        },
        schedule.revision,
      );
    });
    const task = await core.startTask(host, scope);
    await effects.record(host, [
      {
        eventId: "unknown-end",
        taskRef: task.taskRef,
        scopeId: scope,
        kind: "task_ended",
        text: "Ended with no observed outcome",
        occurredAt: new Date(now).toISOString(),
      },
    ]);
    const result = await reviews.maintain([scope], now + 1000);
    assert.equal(result.created.length, 1);
    assert.equal(
      (await reviews.maintain([scope], now + 2000)).created.length,
      0,
    );
    const all = await reviews.list(p);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.mergedPeriods, 2);
    assert.equal(all[0]!.summary.tasks, 2);
    assert.equal(all[0]!.summary.unknownOutcome, 2);
    assert.equal(all[0]!.summary.succeeded, 0);
    const mismatch = await effects.record(host, [
      {
        eventId: "wrong-use",
        taskRef: task.taskRef,
        scopeId: scope,
        kind: "delivery",
        playbook: reference,
        playbookUseRef: "use-1",
        stepId: "s1",
        text: "Wrong task use",
        occurredAt: new Date().toISOString(),
      },
    ]);
    assert.equal(mismatch.results[0]!.status, "rejected");
    await store.transaction(async (tx) => {
      const t = await tx.get<any>("task", otherTask.taskRef);
      await tx.put(
        {
          kind: "task",
          id: t.id,
          scopeId: scope,
          revision: t.revision + 1,
          value: {
            ...t,
            revision: t.revision + 1,
            ended: true,
            endedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
          },
        },
        t.revision,
      );
    });
    const late = await effects.record(host, [
      {
        eventId: "late",
        taskRef: otherTask.taskRef,
        scopeId: scope,
        kind: "outcome",
        outcome: "succeeded",
        text: "Old buffered result",
        occurredAt: new Date(Date.now() - 26 * 3600000).toISOString(),
      },
    ]);
    assert.equal(late.results[0]!.status, "rejected");
    const notes = await reviews.notifications(p);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.text.includes("Ended"), false);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 1,
      learning: false,
      recommendation: false,
      review: true,
      notifications: false,
    });
    assert.equal((await reviews.notifications(p)).length, 0);
    assert.equal((await reviews.list(p)).length, 1);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 2,
      learning: false,
      recommendation: false,
      review: true,
      notifications: true,
    });
    await reviews.dismiss(p, notes[0]!.id);
    assert.equal((await reviews.notifications(p)).length, 0);
    await effects.clear(scope);
    assert.equal((await reviews.list(p)).length, 0);
    assert.equal((await reviews.notifications(p)).length, 0);
    const empty = await reviews.maintain([scope], Date.now() + 8 * 86400000);
    assert.equal(empty.created.length, 0);
    await assert.rejects(
      reviews.configure(
        { ...p, channel: "agent" },
        { scopeId: scope, expectedRevision: 3, days: 1 },
      ),
      /user_operation_required/,
    );
  } finally {
    await store.close();
  }
});

test("Serious issue notifications require user-confirmed retained evidence and deduplicate across tasks", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const scope = randomUUID(),
      host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
      p = { ...host, channel: "user" as const },
      core = new CoreService(
        store,
        new HindsightEngine("http://127.0.0.1:19888", "unused"),
      ),
      effects = new Effects(store),
      reviews = new Reviews(store);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: false,
      recommendation: false,
      review: true,
      notifications: true,
    });
    await core.startTask(host, scope);
    await core.startTask(host, scope);
    const cases = await effects.cases([scope]);
    const exported = await reviews.exportCases(p, {
      caseIds: [cases[0]!.id],
      includeObservations: false,
      redact: [scope],
    });
    assert.equal(exported.caseCount, 1);
    assert.equal(exported.content.includes(scope), false);
    assert.equal(
      JSON.parse(exported.content).cases[0].coverage.initialWorkspace,
      "unavailable",
    );
    await assert.rejects(
      reviews.exportCases(
        { ...p, channel: "agent" },
        { caseIds: [cases[0]!.id] },
      ),
      /user_operation_required/,
    );
    const evidence = cases.map((c) => ({
      caseId: c.id,
      eventId: c.events[0]!.eventId,
    }));
    const input = {
      scopeId: scope,
      problemKey: "same issue",
      expectedRevision: 0,
      category: "wrong_branch",
      status: "suspected",
      severity: "normal",
      evidence: [evidence[0]],
    };
    const initial = await reviews.recordIssue(p, input);
    assert.equal((await reviews.notifications(p)).length, 0);
    await assert.rejects(
      reviews.recordIssue(
        { ...p, channel: "agent" },
        {
          ...input,
          expectedRevision: initial.revision,
          status: "confirmed",
          severity: "serious",
        },
      ),
      /user_operation_required/,
    );
    const confirmed = await reviews.recordIssue(p, {
      ...input,
      expectedRevision: initial.revision,
      status: "confirmed",
      severity: "serious",
      evidence,
    });
    const notification = (await reviews.notifications(p))[0]!;
    assert.equal((await reviews.notifications(p)).length, 1);
    assert.equal(notification.text.includes("same issue"), false);
    assert.equal((await reviews.issues(p))[0]!.affectedTasks, 2);
    await reviews.recordIssue(p, {
      ...input,
      expectedRevision: confirmed.revision,
      status: "confirmed",
      severity: "serious",
      evidence,
    });
    assert.equal((await reviews.notifications(p)).length, 1);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 1,
      learning: false,
      recommendation: false,
      review: true,
      notifications: false,
    });
    assert.equal((await reviews.notifications(p)).length, 0);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 2,
      learning: false,
      recommendation: false,
      review: true,
      notifications: true,
    });
    await store.transaction(async (tx) => {
      const task = await tx.get<any>("effect_task", evidence[0]!.caseId);
      await tx.remove("effect_task", task.id, task.revision);
    });
    const weakened = (await reviews.issues(p))[0]!;
    assert.equal(weakened.status, "suspected");
    assert.equal(weakened.confirmation, "needs_verification");
    assert.equal((await reviews.notifications(p)).length, 0);
    await reviews.dismiss(p, notification.id);
    assert.equal((await reviews.notifications(p)).length, 0);
    await effects.clear(scope);
    assert.equal((await reviews.issues(p)).length, 0);
    await assert.rejects(
      reviews.recordIssue(p, input),
      /issue_evidence_unavailable/,
    );
  } finally {
    await store.close();
  }
});
