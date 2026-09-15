import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
test("New task snapshots replace one case while older candidates cannot overwrite later evidence", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const scope = randomUUID(),
      host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
      owner = { ...host, channel: "user" as const };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(owner, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const task = await core.startTask(host, scope);
    const submit = (text: string, key: string) =>
      core.submitSource(
        host,
        {
          scopeId: scope,
          context: { taskRef: task.taskRef },
          segments: [{ text, role: "tool" }],
        },
        key,
      );
    const first = await submit("Attempt A failed", "a"),
      second = await submit("Attempt B succeeded", "b"),
      third = await submit("Verification C passed", "c");
    const stage = async (jobId: string) =>
      store.transaction(async (tx) => {
        const job = await tx.get<any>("job", jobId);
        const inputSources = [];
        for (const id of job.sourceIds)
          inputSources.push(await tx.get<any>("source", id));
        const source = inputSources.flatMap((m) => [m.segment]);
        const candidate = {
          workView: {
            topic: "fixture",
            goal: "Complete real task",
            context: {},
            attempts: source.map((s: any, i: number) => ({
              stepId: "a" + i,
              action: "Recorded action",
              observation: s.text,
              outcome: s.text.includes("failed") ? "failed" : "succeeded",
              evidenceIndexes: [i],
            })),
            result: {
              status: source.length > 1 ? "succeeded" : "failed",
              summary: source.at(-1).text,
              evidenceIndexes: [source.length - 1],
            },
            evidence: source.map((s: any, i: number) => ({
              sourceIndex: i,
              excerpt: s.text,
              relation: "supports",
            })),
            unresolved: [],
            coverage: [],
          },
          experiences: [],
          playbook: null,
          decisions: [],
        };
        await tx.put(
          {
            kind: "job",
            id: job.id,
            scopeId: scope,
            revision: job.revision + 1,
            value: {
              ...job,
              revision: job.revision + 1,
              stage: "publish",
              status: "running",
              candidate,
              verdict: {
                acceptedExperienceIndexes: [],
                playbookSupported: false,
                reasons: [],
              },
            },
          },
          job.revision,
        );
      });
    await stage(second.jobId);
    await store.transaction(async (tx) => {
      for (const id of [first.jobId, third.jobId]) {
        const j = await tx.get<any>("job", id);
        await tx.put(
          {
            kind: "job",
            id,
            scopeId: scope,
            revision: j.revision + 1,
            value: { ...j, revision: j.revision + 1, status: "failed" },
          },
          j.revision,
        );
      }
    });
    await core.tick([scope]);
    let cases = await core.browse(host, "work_view");
    assert.equal(cases.length, 1);
    const caseId = cases[0]!.id;
    assert.equal((cases[0]!.evidence as unknown[]).length, 2);
    await stage(third.jobId);
    await core.tick([scope]);
    cases = await core.browse(host, "work_view");
    assert.equal(cases[0]!.id, caseId);
    assert.equal((cases[0]!.evidence as unknown[]).length, 3);
    assert.equal((cases[0]!.attempts as unknown[]).length, 3);
    assert.equal(cases[0]!.taskRef, task.taskRef);
    await stage(first.jobId);
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", first.jobId);
      await tx.put(
        {
          kind: "job",
          id: j.id,
          scopeId: scope,
          revision: j.revision + 1,
          value: {
            ...j,
            revision: j.revision + 1,
            candidate: { ...j.candidate, workView: null },
          },
        },
        j.revision,
      );
    });
    await core.tick([scope]);
    cases = await core.browse(host, "work_view");
    assert.equal(cases.length, 1);
    assert.equal((cases[0]!.evidence as unknown[]).length, 3);
    assert.equal((cases[0]!.result as any).summary, "Verification C passed");
    assert.equal((await core.getJob(host, first.jobId)).status, "completed");
    const sourceFor = (await core.listSources(owner)).find(
      (s) => s.id === first.sources[0]!.id,
    )!;
    const supplemented = await core.submitSource(
      owner,
      {
        scopeId: scope,
        sourceFor: { id: sourceFor.id, revision: sourceFor.revision },
        segments: [{ text: "User confirmed the output", role: "user" }],
      },
      "user-supplement",
    );
    const nextSupplement = await core.submitSource(
      owner,
      {
        scopeId: scope,
        sourceFor: { id: sourceFor.id, revision: sourceFor.revision },
        segments: [{ text: "User confirmed again", role: "user" }],
      },
      "second-user-supplement",
    );
    // Both were accepted against the same source revision and internal view.
    await stage(nextSupplement.jobId);
    await stage(supplemented.jobId);
    const staged = await store.transaction((tx) =>
      tx.get<any>("job", supplemented.jobId),
    );
    const stagedSources = await store.transaction(async (tx) =>
      Promise.all(
        staged.sourceIds.map((id: string) => tx.get<any>("source", id)),
      ),
    );
    await (core as any).publish(
      staged,
      stagedSources,
      staged.candidate,
      staged.verdict,
    );
    let supplementCase = (await core.browse(host, "work_view"))[0]!;
    assert.equal(supplementCase.taskRef, task.taskRef);
    assert.equal((supplementCase.evidence as unknown[]).length, 4);
    assert.equal((supplementCase.attempts as unknown[]).length, 4);
    await core.tick([scope]);
    assert.equal(
      (await core.getJob(host, nextSupplement.jobId)).status,
      "completed",
    );
    supplementCase = (await core.browse(host, "work_view"))[0]!;
    assert.equal((supplementCase.evidence as unknown[]).length, 5);
    assert.equal((supplementCase.attempts as unknown[]).length, 5);
    // A manual source has no taskRef; its own ordering still prevents late rollback.
    const manual = await core.submitSource(
      owner,
      {
        scopeId: scope,
        segments: [{ role: "user", text: "Manual initial observation" }],
      },
      "manual",
    );
    const manualSource = (await core.listSources(owner)).find(
      (s) => s.id === manual.sources[0]!.id,
    )!;
    const manualAppend = (text: string, key: string) =>
      core.submitSource(
        owner,
        {
          scopeId: scope,
          sourceFor: { id: manualSource.id, revision: 1 },
          segments: [{ role: "user", text }],
        },
        key,
      );
    const earlier = await manualAppend(
      "Manual earlier failed",
      "manual-earlier",
    );
    const later = await manualAppend("Manual later succeeded", "manual-later");
    await stage(later.jobId);
    const publishJob = async (id: string) => {
      const j = await store.transaction((tx) => tx.get<any>("job", id));
      const ms = await store.transaction((tx) =>
        Promise.all(
          j.sourceIds.map((mid: string) => tx.get<any>("source", mid)),
        ),
      );
      await (core as any).publish(j, ms, j.candidate, j.verdict);
    };
    await publishJob(later.jobId);
    await stage(earlier.jobId);
    await publishJob(earlier.jobId);
    await stage(manual.jobId);
    await publishJob(manual.jobId);
    assert.equal(
      (await core.browse(host, "work_view")).filter((c) =>
        (c.evidence as any[]).some((e) => e.fingerprint === manualSource.id),
      ).length,
      1,
    );
    const manualCase = (await core.browse(host, "work_view")).find((c) =>
      (c.evidence as any[]).some((e) => e.fingerprint === manualSource.id),
    )!;
    assert.equal((manualCase.result as any).summary, "Manual later succeeded");
    assert.equal((manualCase.attempts as any[]).length, 3);
    await store.transaction((tx) =>
      tx.remove(
        "work_view",
        String(manualCase.id),
        Number(manualCase.revision),
      ),
    );
    const emptyLater = await manualAppend("No reusable result", "manual-empty");
    await stage(emptyLater.jobId);
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", emptyLater.jobId);
      await tx.put(
        {
          kind: "job",
          id: j.id,
          scopeId: scope,
          revision: j.revision + 1,
          value: {
            ...j,
            revision: j.revision + 1,
            candidate: { ...j.candidate, workView: null },
          },
        },
        j.revision,
      );
    });
    await publishJob(emptyLater.jobId);
    await stage(later.jobId);
    await publishJob(later.jobId);
    assert.equal(
      (await core.browse(host, "work_view")).some((c) =>
        (c.evidence as any[]).some((e) => e.fingerprint === manualSource.id),
      ),
      false,
    );
    const fourth = await submit("New D observation", "d");
    await stage(fourth.jobId);
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", fourth.jobId);
      j.candidate.workView.attempts = [];
      await tx.put(
        {
          kind: "job",
          id: j.id,
          scopeId: scope,
          revision: j.revision + 1,
          value: { ...j, revision: j.revision + 1 },
        },
        j.revision,
      );
    });
    await core.tick([scope]);
    assert.equal((await core.getJob(host, fourth.jobId)).status, "failed");
    assert.equal(
      (await core.getJob(host, fourth.jobId)).error,
      "task_case_observation_omitted",
    );
    const source = (await core.listSources(owner)).find(
      (s) => s.id === first.sources[0]!.id,
    )!;
    await core.controlSource(owner, {
      id: source.id,
      expectedRevision: source.revision,
      action: "withdraw",
    });
    const afterWithdrawal = await submit("Post-withdrawal E observation", "e");
    await stage(afterWithdrawal.jobId);
    await core.tick([scope]);
    const updated = await core.browse(host, "work_view");
    assert.ok(
      (updated[0]!.evidence as Array<{ excerpt: string }>).some(
        (e) => e.excerpt === "User confirmed the output",
      ),
    );
    assert.equal(updated[0]!.id, caseId);
    assert.equal(
      (updated[0]!.evidence as Array<{ excerpt: string }>).some(
        (e) => e.excerpt === "Attempt A failed",
      ),
      false,
    );
    // A failed attempt with revoked inputs must not be retryable.
    await assert.rejects(
      core.retryJob(owner, fourth.jobId, "revoked-retry"),
      /source_reassessment_required/,
    );
    await core.cancelJob(owner, afterWithdrawal.jobId);
    const fresh = await submit("Retry-only F observation", "f");
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", fresh.jobId);
      await tx.put(
        {
          kind: "job",
          id: j.id,
          scopeId: scope,
          revision: j.revision + 1,
          value: { ...j, revision: j.revision + 1, status: "failed" },
        },
        j.revision,
      );
    });
    const retry = await core.retryJob(owner, fresh.jobId, "retry-1");
    assert.ok(retry.jobId);
    await assert.rejects(
      core.retryJob(owner, fresh.jobId, "retry-2"),
      /retry_already_running/,
    );
  } finally {
    await store.close();
  }
});
