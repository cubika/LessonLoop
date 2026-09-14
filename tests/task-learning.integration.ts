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
      core.submitMaterial(
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
        const materials = [];
        for (const id of job.materialIds)
          materials.push(await tx.get<any>("material", id));
        const source = materials.flatMap((m) => m.segments);
        const candidate = {
          workCase: {
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
          method: null,
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
                methodSupported: false,
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
    let cases = await core.browse(host, "work_case");
    assert.equal(cases.length, 1);
    const caseId = cases[0]!.id;
    assert.equal((cases[0]!.evidence as unknown[]).length, 2);
    await stage(third.jobId);
    await core.tick([scope]);
    cases = await core.browse(host, "work_case");
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
            candidate: { ...j.candidate, workCase: null },
          },
        },
        j.revision,
      );
    });
    await core.tick([scope]);
    cases = await core.browse(host, "work_case");
    assert.equal(cases.length, 1);
    assert.equal((cases[0]!.evidence as unknown[]).length, 3);
    assert.equal((cases[0]!.result as any).summary, "Verification C passed");
    assert.equal((await core.getJob(host, first.jobId)).status, "completed");
    const fourth = await submit("New D observation", "d");
    await stage(fourth.jobId);
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", fourth.jobId);
      j.candidate.workCase.attempts = [];
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
      (s) => s.materialId === first.materialId,
    )!;
    await core.controlSource(owner, {
      id: source.id,
      expectedRevision: source.revision,
      action: "withdraw",
    });
    const afterWithdrawal = await submit("Post-withdrawal E observation", "e");
    await stage(afterWithdrawal.jobId);
    await core.tick([scope]);
    const updated = await core.browse(host, "work_case");
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
