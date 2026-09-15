import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { Effects } from "../src/core/effects.js";
import { dispatch } from "../src/core/server.js";
import { byteSize } from "../src/domain/schema.js";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
test("session binding survives idle expiry; long capture retains all sources with bounded learning and replaceable summaries", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scopeId = randomUUID();
    const host = {
      id: randomUUID(),
      channel: "host" as const,
      scopes: [scopeId],
    };
    const owner = { ...host, channel: "user" as const };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(owner, {
      scopeId,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: true,
      notifications: false,
    });
    const eventId = "copilot-session:fixture";
    const first = await core.startTask(host, scopeId, eventId);
    assert.equal(
      (await core.startTask(host, scopeId, eventId)).taskRef,
      first.taskRef,
    );
    assert.notEqual(
      (await core.startTask({ ...host, id: randomUUID() }, scopeId, eventId))
        .taskRef,
      first.taskRef,
    );
    await assert.rejects(
      dispatch(core, host, "hostTaskBoundary", {}, "retired"),
      /unknown_operation/,
    );
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    await store.transaction(async (tx) => {
      const task = await tx.get<any>("task", first.taskRef);
      await tx.put(
        {
          kind: "task",
          id: task.id,
          scopeId,
          revision: task.revision + 1,
          value: {
            ...task,
            revision: task.revision + 1,
            createdAt: old,
            updatedAt: old,
          },
        },
        task.revision,
      );
    });
    await assert.rejects(
      core.guidanceTask(host, { taskRef: first.taskRef }, "expired"),
      /task_unavailable/,
    );
    await core.startTask(host, scopeId, eventId);
    assert.equal(
      (await core.guidanceTask(host, { taskRef: first.taskRef }, "resumed"))
        .taskRef,
      first.taskRef,
    );
    assert.ok(
      (await core.listTasks(owner)).some((t) => t.taskRef === first.taskRef),
    );
    assert.equal(
      (
        await core.prepare(host, {
          taskRef: first.taskRef,
          playbookId: "missing",
          revision: 1,
        })
      ).status,
      "target_unavailable",
    );
    const submit = (text: string, key: string) =>
      core.submitSource(
        host,
        {
          scopeId,
          context: { taskRef: first.taskRef },
          segments: [{ text, role: "tool" }],
        },
        key,
      );
    let latest: Awaited<ReturnType<typeof submit>>;
    for (let i = 0; i < 200; i++)
      latest = await submit("Observed result " + i, "record-" + i);
    const sources = () =>
      store.transaction((tx) => tx.list<any>("source", [scopeId]));
    const job = (id: string) =>
      store.transaction((tx) => tx.get<any>("job", id));
    assert.equal((await sources()).length, 200);
    assert.ok((await job(latest!.jobId)).sourceIds.length <= 192);
    const firstSource = (await sources()).find((s) => s.taskSequence === 1);
    const supplement = await core.submitSource(
      owner,
      {
        scopeId,
        sourceFor: { id: firstSource.id, revision: 1 },
        segments: [{ text: "User supplement", role: "user" }],
      },
      "supplement",
    );
    assert.ok((await job(supplement.jobId)).sourceIds.length <= 192);
    for (let i = 0; i < 8; i++)
      latest = await submit("Large " + i + "x".repeat(20000), "large-" + i);
    const all = await sources();
    assert.equal(all.length, 209);
    assert.equal(new Set(all.map((s) => s.sourceFamily)).size, 1);
    assert.equal(new Set(all.map((s) => s.workKey)).size, 1);
    const latestJob = await job(latest!.jobId);
    const window = all.filter((s) => latestJob.sourceIds.includes(s.id));
    assert.ok(byteSize(window) <= 131072);
    assert.ok(window.length < 192);

    const publish = async (
      receipt: typeof latest,
      count: number,
      topic: string,
    ) => {
      const j = await job(receipt.jobId);
      await store.transaction((tx) =>
        tx.put(
          {
            kind: "job",
            id: j.id,
            scopeId,
            revision: j.revision + 1,
            value: { ...j, revision: j.revision + 1, status: "running" },
          },
          j.revision,
        ),
      );
      const input = await store.transaction(async (tx) =>
        Promise.all(j.sourceIds.map((id: string) => tx.get<any>("source", id))),
      );
      const selected = input.slice(-count);
      const candidate = {
        workView: {
          topic,
          goal: "Review recent session material",
          context: {},
          attempts: selected.map((s: any, i: number) => ({
            stepId: "s" + i,
            action: "Observed",
            observation: s.segment.text.slice(0, 100),
            outcome: "unknown",
            evidenceIndexes: [i],
          })),
          result: { status: "unknown", summary: topic, evidenceIndexes: [0] },
          evidence: selected.map((s: any) => ({
            sourceIndex: input.indexOf(s),
            excerpt: s.segment.text.slice(0, 100),
            relation: "supports",
          })),
          unresolved: [],
          coverage: [],
        },
        experiences: [],
        playbook: null,
        decisions: [],
      };
      const verdict = {
        acceptedExperienceIndexes: [],
        playbookSupported: false,
        reasons: [],
      };
      await (core as any).publish(j, input, candidate, verdict);
    };
    await publish(supplement, 16, "Earlier topic");
    let view = (await core.browse(host, "work_view"))[0]!;
    assert.equal((view.evidence as unknown[]).length, 16);
    const viewId = view.id;
    await publish(latest!, 1, "Current topic");
    view = (await core.browse(host, "work_view"))[0]!;
    assert.equal(view.id, viewId);
    assert.equal(view.topic, "Current topic");
    assert.equal((view.evidence as unknown[]).length, 1);
    await publish(supplement, 16, "Old replay");
    assert.equal(
      (await core.browse(host, "work_view"))[0]!.topic,
      "Current topic",
    );
    assert.equal((await sources()).length, 209);
    const events = (await new Effects(store).cases([scopeId]))
      .flatMap((c) => c.events)
      .filter((e) => e.taskRef === first.taskRef);
    assert.equal(events.filter((e) => e.kind === "task_started").length, 1);
    assert.equal(
      events.some((e) => e.kind === "task_ended" || e.kind === "outcome"),
      false,
    );
  } finally {
    await store.close();
  }
});
