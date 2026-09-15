import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";
import {
  identity,
  playbookSchema,
  type Playbook,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
import type { PlaybookWrite } from "../src/store/playbook-content.js";
import { splitPlaybook } from "../src/store/playbook-content.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL!;

const entry = (kind: string, value: any) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value,
});
class Engine extends HindsightEngine {
  supported = true;
  failAfterWrite = false;
  failRead = false;
  submissions: Parameters<HindsightEngine["createModel"]>[] = [];
  operations = new Map<string, string>();
  failSubmission: "before" | "after" | undefined;
  nativeStatus: Awaited<ReturnType<HindsightEngine["operation"]>>["status"] =
    "completed";
  invalidOutput = false;
  metrics = { reads: 0 };
  get reads() {
    return this.metrics.reads;
  }
  override forJob(jobId: string) {
    const child = Object.create(this) as Engine;
    child.bank = () => "lessonloop-job-" + jobId;
    return child;
  }
  override async configure() {}
  override async drainRegisteredBank() {
    return { drained: true, remaining: 0 };
  }
  override async eraseRegisteredBank() {
    return { erased: true, remaining: {} };
  }
  override async deleteAllProjectionRevisions() {
    return { erased: true, deleted: 0 };
  }
  override async retainSupport() {}
  override async index(_scope: string, ref: { id: string }) {
    return ref.id;
  }
  override async findModelOperation(_scope: string, modelId: string) {
    return this.operations.get(modelId);
  }
  override async cancelModelSubmission(_scope: string, modelId: string) {
    return {
      submission_canceled: true,
      operation_id: this.operations.get(modelId) ?? null,
    };
  }
  override async createModel(
    ...request: Parameters<HindsightEngine["createModel"]>
  ) {
    this.submissions.push(structuredClone(request));
    if (this.failSubmission === "before")
      throw new Error("submission not accepted");
    this.operations.set(request[1], "review-op");
    if (this.failSubmission === "after")
      throw new Error("submission reply lost");
    return { operation_id: "review-op", mental_model_id: "review-model" };
  }
  override async operation() {
    return { status: this.nativeStatus, operation_id: "review-op" };
  }
  override async model(): Promise<any> {
    this.metrics.reads++;
    if (this.invalidOutput)
      return { reflect_response: { structured_output: {} } };
    return {
      reflect_response: {
        structured_output: {
          acceptedExperienceIndexes: [],
          playbookSupported: this.supported,
          reasons: ["Synthetic verdict"],
        },
      },
    };
  }
  override async writePlaybookContent(write: PlaybookWrite) {
    await super.writePlaybookContent(write);
    if (this.failAfterWrite) throw new Error("lost reply after native write");
  }
  override async readPlaybookContent(scope: string, id: string, hash: string) {
    if (this.failRead) throw new Error("native offline");
    return super.readPlaybookContent(scope, id, hash);
  }
}
async function fixture() {
  const store = new ProductStore(url);
  await store.open(true);
  const scope = randomUUID(),
    owner = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
  const engine = new Engine("http://127.0.0.1:19888", "unused"),
    core = new CoreService(store, engine);
  await core.configure(owner, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: true,
    review: false,
    notifications: false,
  });
  const accepted = await core.submitSource(
    owner,
    {
      scopeId: scope,
      segments: [
        { role: "user", text: "Editing the template survives regeneration." },
      ],
    },
    randomUUID(),
  );
  const source = (await core.listSources(owner))[0]!;
  const exp = experienceSchema.parse({
    ...identity(scope),
    conclusion: "Edit the template",
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
        role: "tool",
        relation: "supports",
        excerpt: "Editing the template survives regeneration.",
        fingerprint: source.id,
      },
    ],
    derivedFrom: [],
    sourceFingerprints: [source.id],
    state: "active",
  });
  const playbook = playbookSchema.parse({
    ...identity(scope),
    title: "Template playbook",
    goal: "Preserve changes",
    topics: [],
    applicability: "general",
    conditions: [],
    exceptions: [],
    state: "active",
    steps: [
      { stepId: "s1", instruction: "Edit the template", supportIndexes: [0] },
    ],
    completionChecks: [{ text: "Regenerate" }],
    stopConditions: [],
    supportRefs: [{ kind: "experience", id: exp.id, revision: 1 }],
    change: {
      kind: "create",
      summary: "Fixture",
      predecessors: [],
    },
  });
  await store.transaction(async (tx) => {
    for (const [kind, value] of [
      ["experience", exp],
      ["playbook", playbook],
    ] as const) {
      await tx.put(entry(kind, value), null);
      await tx.put(
        entry("projection", {
          ...identity(scope),
          id: value.id,
          objectKind: kind,
          objectRevision: 1,
          text: "Template",
          confirmed: true,
        }),
        null,
      );
    }
    const job = await tx.get<any>("job", accepted.jobId);
    await tx.put(
      entry("job", {
        ...job,
        revision: job.revision + 1,
        status: "completed",
        stage: "done",
      }),
      job.revision,
    );
  });
  await core.syncProjections([scope]);
  return { store, scope, owner, engine, core, playbook, exp, source };
}
test("Reviewed updates preserve the current body until accepted; product persistence contains metadata only", async () => {
  const f = await fixture();
  let closed = false;
  try {
    const task = await f.core.startTask(f.owner, f.scope);
    const first = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Rejected change",
    });
    assert.equal(first.previousUse, "unchanged");
    assert.equal(
      (
        await f.core.prepare(f.owner, {
          playbookId: f.playbook.id,
          revision: 1,
          taskRef: task.taskRef,
        })
      ).status,
      "guidance",
    );
    f.engine.supported = false;
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await (f.core as any).advanceRevisionReviews([f.scope]);
    assert.equal(
      ((await f.core.inspect(f.owner, "playbook", f.playbook.id)) as Playbook)
        .title,
      f.playbook.title,
    );
    assert.equal(
      (
        (await f.core.inspect(
          f.owner,
          "revision_review",
          first.reviewId,
        )) as any
      ).candidate,
      undefined,
    );
    f.engine.supported = true;
    const second = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Checked change",
    });
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await (f.core as any).advanceRevisionReviews([f.scope]);
    f.engine.failAfterWrite = true;
    await f.core.syncProjections([f.scope]);
    assert.notEqual(
      (
        await f.core.prepare(f.owner, {
          playbookId: f.playbook.id,
          revision: 2,
          taskRef: task.taskRef,
        })
      ).status,
      "guidance",
    );
    await f.store.close();
    closed = true;
    const recovered = new ProductStore(url);
    await recovered.open();
    const core = new CoreService(recovered, f.engine);
    try {
      f.engine.failAfterWrite = false;
      await core.syncProjections([f.scope]);
      const record = await recovered.transaction((tx) =>
        tx.get<any>("playbook", f.playbook.id, true),
      );
      assert.equal(record.steps, undefined);
      assert.equal(record.title, undefined);
      assert.equal(record.goal, undefined);
      assert.equal(
        await recovered.transaction((tx) =>
          tx.get("playbook_write", f.playbook.id),
        ),
        undefined,
      );
      assert.equal(
        ((await core.inspect(f.owner, "playbook", f.playbook.id)) as Playbook)
          .title,
        "Checked change",
      );
      assert.equal(
        (
          (await core.inspect(
            f.owner,
            "revision_review",
            second.reviewId,
          )) as any
        ).candidate,
        undefined,
      );
      assert.equal(
        (
          await core.prepare(f.owner, {
            playbookId: f.playbook.id,
            revision: 2,
            taskRef: task.taskRef,
          })
        ).status,
        "guidance",
      );
      f.engine.failRead = true;
      await core.setState(f.owner, "playbook", f.playbook.id, 2, "disabled");
      await core.remove(f.owner, "playbook", f.playbook.id, 3);
      await core.syncProjections([f.scope]);
      assert.equal(
        await recovered.transaction((tx) =>
          tx.get("playbook_write", f.playbook.id),
        ),
        undefined,
      );
    } finally {
      await recovered.close();
    }
  } finally {
    if (!closed) await f.store.close();
  }
});
test("New control invalidates a pending review; unreadable playbooks do not break other metadata operations", async () => {
  const f = await fixture();
  try {
    const review = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Late update",
    });
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await f.core.setState(f.owner, "playbook", f.playbook.id, 1, "disabled");
    await (f.core as any).advanceRevisionReviews([f.scope]);
    assert.equal(
      (
        (await f.core.inspect(
          f.owner,
          "revision_review",
          review.reviewId,
        )) as any
      ).status,
      "failed",
    );
    assert.equal(
      ((await f.core.inspect(f.owner, "playbook", f.playbook.id)) as Playbook)
        .title,
      f.playbook.title,
    );
    f.engine.failRead = true;
    assert.deepEqual(await f.core.browse(f.owner, "playbook"), []);
    await f.core.syncProjections([f.scope]);
    await f.core.controlSource(f.owner, {
      id: f.source.id,
      expectedRevision: 1,
      action: "withdraw",
    });
  } finally {
    await f.store.close();
  }
});
test("Unknown successful writes retain every possibly stored source until deletion is confirmed", async () => {
  const f = await fixture();
  try {
    const sourceB = `source-b-${f.scope}`,
      sourceC = `source-c-${f.scope}`;
    const b = {
      ...f.exp,
      ...identity(f.scope),
      sourceFingerprints: [sourceB],
      evidence: [{ ...f.exp.evidence[0]!, fingerprint: sourceB }],
    };
    const c = {
      ...f.exp,
      ...identity(f.scope),
      sourceFingerprints: [sourceC],
      evidence: [{ ...f.exp.evidence[0]!, fingerprint: sourceC }],
    };
    const v2 = {
      ...f.playbook,
      revision: 2,
      title: "Source B playbook",
      supportRefs: [{ kind: "experience" as const, id: b.id, revision: 1 }],
    };
    await f.store.transaction(async (tx) => {
      await tx.put(entry("experience", b), null);
      await tx.put(entry("experience", c), null);
      await tx.put(
        entry("source", {
          id: sourceB,
          scopeId: f.scope,
          revision: 1,
          materialId: "none",
          sourceIdentity: "b",
          blocked: false,
          erased: false,
          excluded: false,
        }),
        null,
      );
      await tx.put(entry("playbook", v2), 1);
    });
    f.engine.failAfterWrite = true;
    await f.core.syncProjections([f.scope]);
    const v3 = {
      ...v2,
      revision: 3,
      title: "Source C playbook",
      supportRefs: [{ kind: "experience" as const, id: c.id, revision: 1 }],
    };
    await f.store.transaction((tx) => tx.put(entry("playbook", v3), 2));
    const pending = await f.store.transaction((tx) =>
      tx.get<PlaybookWrite>("playbook_write", f.playbook.id),
    );
    assert.deepEqual(
      new Set(pending!.previousSupport!.map((r) => r.id)),
      new Set([f.exp.id, b.id]),
    );
    const receipt = await f.core.controlSource(f.owner, {
      id: sourceB,
      expectedRevision: 1,
      action: "erase",
    });
    await f.core.processSourceCleanups([f.scope]);
    assert.equal(
      (
        (await f.core.inspect(
          f.owner,
          "source_cleanup",
          receipt.cleanupId,
        )) as any
      ).status,
      "pending",
    );
    f.engine.failAfterWrite = false;
    await f.core.processSourceCleanups([f.scope]);
    assert.equal(
      (
        (await f.core.inspect(
          f.owner,
          "source_cleanup",
          receipt.cleanupId,
        )) as any
      ).status,
      "completed",
    );
    await assert.rejects(
      f.engine.readPlaybookContent(
        f.scope,
        f.playbook.id,
        splitPlaybook(v2).record.contentHash,
      ),
      /unavailable/,
    );
    assert.equal(
      await f.store.transaction((tx) =>
        tx.get("playbook_write", f.playbook.id),
      ),
      undefined,
    );
  } finally {
    await f.store.close();
  }
});

for (const failure of ["before", "after"] as const) {
  test(
    "Revision review recovers a submission failure " +
      failure +
      " acceptance with frozen input",
    async () => {
      const f = await fixture();
      try {
        const accepted = await f.core.revise(f.owner, f.playbook.id, 1, {
          title: "Reviewed title",
        });
        f.engine.failSubmission = failure;
        await (f.core as any).advanceRevisionReviews([f.scope]);
        let review = await f.store.transaction((tx) =>
          tx.get<any>("revision_review", accepted.reviewId),
        );
        assert.equal(review.status, "uncertain");
        assert.ok(
          review.modelQuery.includes(
            "Editing the template survives regeneration.",
          ),
        );
        assert.deepEqual(review.sourceRefs, [f.source.id]);
        assert.equal(review.operationId, undefined);
        const frozen = f.engine.submissions[0]!;
        // Current support may change while the native request is being recovered.
        await f.store.transaction(async (tx) => {
          const old = await tx.get<any>("experience", f.exp.id);
          await tx.put(
            entry("experience", {
              ...old,
              revision: old.revision + 1,
              conclusion: "Changed after submission",
            }),
            old.revision,
          );
        });
        f.engine.failSubmission = undefined;
        f.engine.nativeStatus = "pending";
        const restarted = new CoreService(f.store, f.engine);
        await (restarted as any).advanceRevisionReviews([f.scope]);
        review = await f.store.transaction((tx) =>
          tx.get<any>("revision_review", accepted.reviewId),
        );
        assert.equal(review.operationId, "review-op");
        assert.equal(f.engine.submissions.length, failure === "before" ? 2 : 1);
        for (const request of f.engine.submissions)
          assert.deepEqual(request, frozen);
        assert.equal(f.engine.reads, 0);
        f.engine.nativeStatus = "cancelled";
        await (restarted as any).advanceRevisionReviews([f.scope]);
        review = await f.store.transaction((tx) =>
          tx.get<any>("revision_review", accepted.reviewId),
        );
        assert.equal(review.status, "failed");
        assert.equal(review.reason, "native_assessment_failed");
        assert.equal(review.modelQuery, undefined);
        assert.equal(review.candidate, undefined);
        assert.equal(f.engine.reads, 0);
      } finally {
        await f.store.close();
      }
    },
  );
}

test("Revision review persists a recovered ID, survives result-read failure, and then publishes", async () => {
  const f = await fixture();
  try {
    const accepted = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Recovered title",
    });
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await f.store.transaction(async (tx) => {
      const old = await tx.get<any>("revision_review", accepted.reviewId);
      const next = { ...old, revision: old.revision + 1 };
      delete next.operationId;
      await tx.put(entry("revision_review", next), old.revision);
    });
    const model = f.engine.model.bind(f.engine);
    f.engine.model = async () => {
      throw new Error("result unavailable");
    };
    await (f.core as any).advanceRevisionReviews([f.scope]);
    let review = await f.store.transaction((tx) =>
      tx.get<any>("revision_review", accepted.reviewId),
    );
    assert.equal(review.status, "uncertain");
    assert.equal(review.operationId, "review-op");
    f.engine.model = model;
    await (f.core as any).advanceRevisionReviews([f.scope]);
    review = await f.store.transaction((tx) =>
      tx.get<any>("revision_review", accepted.reviewId),
    );
    assert.equal(review.status, "completed");
    assert.equal(review.modelQuery, undefined);
    assert.equal(f.engine.submissions.length, 1);
    assert.equal(
      ((await f.core.inspect(f.owner, "playbook", f.playbook.id)) as Playbook)
        .title,
      "Recovered title",
    );
  } finally {
    await f.store.close();
  }
});

for (const hasOperation of [false, true]) {
  test(
    "Legacy revision review without frozen request " +
      (hasOperation ? "recovers its operation" : "closes before failing"),
    async () => {
      const f = await fixture();
      try {
        const accepted = await f.core.revise(f.owner, f.playbook.id, 1, {
          title: "Legacy title",
        });
        await f.store.transaction(async (tx) => {
          const old = await tx.get<any>("revision_review", accepted.reviewId);
          await tx.put(
            entry("revision_review", {
              ...old,
              revision: old.revision + 1,
              status: "running",
            }),
            old.revision,
          );
          if (hasOperation) f.engine.operations.set(old.modelId, "legacy-op");
        });
        await (f.core as any).advanceRevisionReviews([f.scope]);
        const review = await f.store.transaction((tx) =>
          tx.get<any>("revision_review", accepted.reviewId),
        );
        assert.equal(review.status, hasOperation ? "completed" : "failed");
        if (!hasOperation)
          assert.equal(review.reason, "native_request_unavailable");
        assert.equal(f.engine.submissions.length, 0);
        assert.equal(review.candidate, undefined);
      } finally {
        await f.store.close();
      }
    },
  );
}

test("A queued revision invalidated before submission needs no native operation", async () => {
  const f = await fixture();
  try {
    const accepted = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Obsolete",
    });
    await f.core.setState(f.owner, "playbook", f.playbook.id, 1, "disabled");
    let closes = 0;
    f.engine.cancelModelSubmission = async () => {
      closes++;
      throw new Error("native offline");
    };
    await (f.core as any).advanceRevisionReviews([f.scope]);
    const review = await f.store.transaction((tx) =>
      tx.get<any>("revision_review", accepted.reviewId),
    );
    assert.equal(review.status, "failed");
    assert.equal(review.reason, "target_changed");
    assert.equal(closes, 0);
    assert.equal(f.engine.submissions.length, 0);
  } finally {
    await f.store.close();
  }
});

test("Malformed revision verdict fails without replacing the published playbook", async () => {
  const f = await fixture();
  try {
    const accepted = await f.core.revise(f.owner, f.playbook.id, 1, {
      title: "Malformed verdict",
    });
    f.engine.invalidOutput = true;
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await (f.core as any).advanceRevisionReviews([f.scope]);
    const review = await f.store.transaction((tx) =>
      tx.get<any>("revision_review", accepted.reviewId),
    );
    assert.equal(review.status, "failed");
    assert.equal(review.reason, "invalid_model_output");
    assert.equal(review.modelQuery, undefined);
    assert.equal(
      ((await f.core.inspect(f.owner, "playbook", f.playbook.id)) as Playbook)
        .title,
      f.playbook.title,
    );
  } finally {
    await f.store.close();
  }
});

for (const stage of ["compose", "assess"] as const) {
  test(
    "Automatic " +
      stage +
      " recovers model identity and terminates native cancellation",
    async () => {
      const f = await fixture();
      try {
        const job = {
          ...identity(f.scope),
          kind: "case_review",
          stage,
          status: "running",
          sourceIds: [f.source.id],
          sourceRefs: [f.source.id, "extra-support"],
          operationId: "retain-op",
          modelId: "legacy-model",
          assessmentId: "legacy-assessment",
          payload: {
            modelQuery: "Frozen compose request",
            assessmentQuery: "Frozen assessment request",
          },
          engineOperations: ["retain-op"],
          results: [],
          decisions: [],
        };
        await f.store.transaction((tx) => tx.put(entry("job", job), null));
        let current: any = job;
        await (f.core as any).advance(current);
        current = await f.store.transaction((tx) => tx.get<any>("job", job.id));
        assert.equal(
          current[
            stage === "compose" ? "operationId" : "assessmentOperationId"
          ],
          "review-op",
        );
        assert.deepEqual(f.engine.submissions[0]![3], [f.source.id]);
        assert.deepEqual(current.engineOperations, ["retain-op", "review-op"]);
        assert.equal(f.engine.reads, 0);
        f.engine.nativeStatus = "cancelled";
        await (f.core as any).advance(current);
        current = await f.store.transaction((tx) => tx.get<any>("job", job.id));
        assert.equal(current.status, "failed");
        assert.equal(
          current.error,
          stage === "compose"
            ? "native_model_failed"
            : "native_assessment_failed",
        );
        assert.equal(f.engine.submissions.length, 1);
        assert.equal(f.engine.reads, 0);
      } finally {
        await f.store.close();
      }
    },
  );
}
