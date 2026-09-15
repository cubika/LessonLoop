import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";
import { identity, playbookSchema } from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
import { dispatch } from "../src/core/server.js";
import { Effects } from "../src/core/effects.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
test("Source withdrawal suppresses affected input without canceling unrelated jobs", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scope = randomUUID(),
      p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const a = await core.submitSource(
      p,
      { scopeId: scope, segments: [{ text: "source A", role: "user" }] },
      "a",
    );
    const b = await core.submitSource(
      p,
      { scopeId: scope, segments: [{ text: "source B", role: "user" }] },
      "b",
    );
    const sources = await core.listSources(p);
    const source = sources.find((s) => s.id === a.sources[0]!.id)!;
    const receipt = await core.controlSource(p, {
      id: source.id,
      expectedRevision: 1,
      action: "withdraw",
    });
    assert.equal(receipt.previousUse, "suppressed");
    assert.equal((await core.getJob(p, a.jobId)).status, "canceled");
    assert.equal((await core.getJob(p, b.jobId)).status, "queued");
    const cleanup = (await core.inspect(
      p,
      "source_cleanup",
      receipt.cleanupId,
    )) as unknown as { status: string; copyManifest: { documents: unknown[] } };
    assert.equal(cleanup.status, "suppressed");
    assert.equal(cleanup.copyManifest.documents.length, 1);
    await core.submitSource(
      p,
      { scopeId: scope, segments: [{ text: "source C", role: "user" }] },
      "c",
    );
  } finally {
    await store.close();
  }
});

class CleanupEngine extends HindsightEngine {
  pending = false;
  projectionFailure = false;
  erased: string[] = [];
  constructor() {
    super("http://127.0.0.1:19888", "test-unused");
  }
  override forJob(jobId: string) {
    const child = Object.create(this) as CleanupEngine;
    child.bank = () => `lessonloop-job-${jobId}`;
    return child;
  }
  override async drainRegisteredBank() {
    return { drained: !this.pending, remaining: this.pending ? 1 : 0 };
  }
  override async eraseRegisteredBank(bank: string) {
    this.erased.push(bank);
    return { erased: true, remaining: {} };
  }
  override async deleteAllProjectionRevisions() {
    if (this.projectionFailure)
      throw new Error("simulated lost cleanup acknowledgement");
    return { erased: true, deleted: 1 };
  }
}
const put = (
  kind: string,
  value: { id: string; revision: number; scopeId: string },
  expected: number | null = null,
) => ({
  entry: {
    kind,
    id: value.id,
    scopeId: value.scopeId,
    revision: value.revision,
    value: value as unknown as Record<string, unknown>,
  },
  expected,
});
test("Erasure resumes after native and projection failures, scrubs transient and task copies, and rejects replay", async () => {
  let store = new ProductStore(url!);
  await store.open(true);
  const scope = randomUUID(),
    host = { id: randomUUID(), channel: "host" as const, scopes: [scope] };
  const owner = { ...host, channel: "user" as const };
  const engine = new CleanupEngine();
  let core = new CoreService(store, engine);
  try {
    await core.configure(owner, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const task = await core.startTask(host, scope);
    const sensitive = "Source A unique fixture content";
    await core.recordHostObservation(host, {
      taskRef: task.taskRef,
      eventId: "tool-a",
      text: sensitive,
      occurredAt: new Date().toISOString(),
    });
    const input = {
      scopeId: scope,
      context: { taskRef: task.taskRef },
      segments: [{ text: sensitive, role: "tool" }],
    };
    const accepted = await core.submitSource(host, input, "a");
    const source = (await core.listSources(owner))[0]!;
    const experience = experienceSchema.parse({
      ...identity(scope),
      conclusion: sensitive,
      level: "L1",
      purpose: "fact",
      applicability: "general",
      conditions: [],
      exceptions: [],
      topics: [],
      entities: [],
      basis: "observed",
      assessment: "supported",
      evidence: [
        {
          excerpt: sensitive,
          role: "tool",
          relation: "supports",
          fingerprint: source.id,
        },
      ],
      derivedFrom: [],
      sourceFingerprints: [source.id],
      state: "active",
    });
    const playbook = playbookSchema.parse({
      ...identity(scope),
      title: sensitive,
      goal: "Use evidence",
      topics: [],
      applicability: "general",
      conditions: [],
      exceptions: [],
      state: "active",
      steps: [{ stepId: "s1", instruction: sensitive, supportIndexes: [0] }],
      completionChecks: [{ text: "Verify result" }],
      stopConditions: [],
      supportRefs: [{ kind: "experience", id: experience.id, revision: 1 }],
      change: {
        kind: "create",
        summary: "Fixture",
        predecessors: [],
      },
    });
    const currentPlaybook = {
      ...playbook,
      revision: 2,
      title: "Independent playbook B",
      steps: [{ stepId: "s1", instruction: "Use B", supportIndexes: [0] }],
      supportRefs: [
        { kind: "experience" as const, id: "independent-b", revision: 1 },
      ],
    };
    await store.transaction(async (tx) => {
      for (const [kind, value] of [
        ["experience", experience],
        ["playbook", playbook],
      ] as const) {
        const row = put(kind, value);
        await tx.put(row.entry, null);
      }
      await tx.put(put("playbook", currentPlaybook).entry, 1);
      const feedback = {
        ...identity(scope),
        id: task.taskRef,
        taskOutcome: "unknown",
        outcomeText: "",
        feedback: [
          {
            playbookId: playbook.id,
            revision: 1,
            delivered: true,
            userRating: "incorrect",
            ratingText: sensitive,
          },
        ],
      };
      await tx.put(put("task_feedback", feedback).entry, null);
      // Deleting the experience first must not discard the source-to-history binding.
      const job = await tx.get<any>("job", accepted.jobId);
      await tx.put(
        put("job", {
          ...job,
          revision: job.revision + 1,
          stage: "extract",
          status: "running",
          operationId: randomUUID(),
        }).entry,
        job.revision,
      );
    });
    // The independent replacement is confirmed before A is erased. Pending
    // replacements retain every possibly stored old source until confirmation.
    await core.syncProjections([scope]);
    await core.remove(owner, "experience", experience.id, 1);
    const receipt = (await dispatch(
      core,
      owner,
      "controlSource",
      { id: source.id, expectedRevision: 1, action: "forget" },
      "",
    )) as { cleanupId: string };
    engine.pending = true;
    await core.tick([scope]);
    assert.equal(
      (await core.getJob(owner, accepted.jobId)).status,
      "uncertain",
    );
    await assert.rejects(
      core.submitSource(
        host,
        { scopeId: scope, segments: [{ text: "other", role: "tool" }] },
        "blocked",
      ),
      /source_cleanup_in_progress/,
    );
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    core = new CoreService(store, engine);
    engine.pending = false;
    engine.projectionFailure = true;
    await core.tick([scope]);
    await core.tick([scope]);
    assert.equal(
      ((await core.inspect(owner, "source_cleanup", receipt.cleanupId)) as any)
        .lastError,
      "projection_erasure_unconfirmed",
    );
    engine.projectionFailure = false;
    await core.tick([scope]);
    assert.equal(
      ((await core.inspect(owner, "source_cleanup", receipt.cleanupId)) as any)
        .status,
      "completed",
    );
    assert.deepEqual(
      (
        await store.transaction((tx) => tx.list<any>("task_feedback", [scope]))
      ).flatMap((t) => t.feedback),
      [],
    );
    assert.equal((await core.listSources(owner))[0]!.erased, true);
    const feedback = (await new Effects(store).cases([scope]))[0]!;
    await core.configure(owner, {scopeId:scope,expectedRevision:1,learning:true,recommendation:false,review:true,notifications:false});
    await assert.rejects(
      new Effects(store).update(host, {
        taskRef: task.taskRef,
        field: "taskOutcome",
        taskOutcome: "succeeded",
        text: sensitive,
        expectedRevision: feedback.revision,
      }),
      /observation_erased/,
    );
    assert.equal(
      ((await core.inspect(owner, "playbook", playbook.id)) as any).title,
      "Independent playbook B",
    );
    for (const [kind, id] of [
      ["source", accepted.sources[0]!.id],
      ["task", task.taskRef],
    ])
      assert.equal(
        JSON.stringify(await core.inspect(owner, kind!, id!)).includes(
          sensitive,
        ),
        false,
      );
    await assert.rejects(
      core.recordHostObservation(host, {
        taskRef: task.taskRef,
        eventId: "late-a",
        text: sensitive,
        occurredAt: new Date().toISOString(),
      }),
      /observation_erased/,
    );
    await assert.rejects(
      core.submitSource(host, input, "a"),
      /source_erased_from_task/,
    );
    await core.submitSource(
      host,
      {
        scopeId: scope,
        segments: [
          { text: "Unrelated inputSource remains accepted", role: "tool" },
        ],
      },
      "after",
    );
    await assert.rejects(
      dispatch(
        core,
        { ...owner, channel: "agent" },
        "controlSource",
        { id: source.id, expectedRevision: 3, action: "erase" },
        "",
      ),
      /user_operation_required/,
    );
  } finally {
    await store.close();
  }
});
