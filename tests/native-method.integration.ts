import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/method-engine.js";
import { identity, methodSchema, type Method } from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
import type { MethodWrite } from "../src/store/method-content.js";
import { splitMethod } from "../src/store/method-content.js";
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
  override async createModel() {
    return { operation_id: "review-op", mental_model_id: "review-model" };
  }
  override async operation() {
    return { status: "completed" as const, operation_id: "review-op" };
  }
  override async model(): Promise<any> {
    return {
      reflect_response: {
        structured_output: {
          acceptedExperienceIndexes: [],
          methodSupported: this.supported,
          reasons: ["Synthetic verdict"],
        },
      },
    };
  }
  override async writeMethodContent(write: MethodWrite) {
    await super.writeMethodContent(write);
    if (this.failAfterWrite) throw new Error("lost reply after native write");
  }
  override async readMethodContent(scope: string, id: string, hash: string) {
    if (this.failRead) throw new Error("native offline");
    return super.readMethodContent(scope, id, hash);
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
  const accepted = await core.submitMaterial(
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
  const method = methodSchema.parse({
    ...identity(scope),
    title: "Template method",
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
      caseRefs: [],
      predecessors: [],
    },
  });
  await store.transaction(async (tx) => {
    for (const [kind, value] of [
      ["experience", exp],
      ["method", method],
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
  return { store, scope, owner, engine, core, method, exp, source };
}
test("Reviewed updates preserve the current body until accepted; product persistence contains metadata only", async () => {
  const f = await fixture();
  let closed = false;
  try {
    const task = await f.core.startTask(f.owner, f.scope);
    const first = await f.core.revise(f.owner, f.method.id, 1, {
      title: "Rejected change",
    });
    assert.equal(first.previousUse, "unchanged");
    assert.equal(
      (
        await f.core.prepare(f.owner, {
          methodId: f.method.id,
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
      ((await f.core.inspect(f.owner, "method", f.method.id)) as Method).title,
      f.method.title,
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
    const second = await f.core.revise(f.owner, f.method.id, 1, {
      title: "Checked change",
    });
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await (f.core as any).advanceRevisionReviews([f.scope]);
    f.engine.failAfterWrite = true;
    await f.core.syncProjections([f.scope]);
    assert.notEqual(
      (
        await f.core.prepare(f.owner, {
          methodId: f.method.id,
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
        tx.get<any>("method", f.method.id, true),
      );
      assert.equal(record.steps, undefined);
      assert.equal(record.title, undefined);
      assert.equal(record.goal, undefined);
      assert.equal(
        await recovered.transaction((tx) =>
          tx.get("method_write", f.method.id),
        ),
        undefined,
      );
      assert.equal(
        ((await core.inspect(f.owner, "method", f.method.id)) as Method).title,
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
            methodId: f.method.id,
            revision: 2,
            taskRef: task.taskRef,
          })
        ).status,
        "guidance",
      );
      f.engine.failRead = true;
      await core.setState(f.owner, "method", f.method.id, 2, "disabled");
      await core.remove(f.owner, "method", f.method.id, 3);
      await core.syncProjections([f.scope]);
      assert.equal(
        await recovered.transaction((tx) =>
          tx.get("method_write", f.method.id),
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
test("New control invalidates a pending review; unreadable methods do not break other metadata operations", async () => {
  const f = await fixture();
  try {
    const review = await f.core.revise(f.owner, f.method.id, 1, {
      title: "Late update",
    });
    await (f.core as any).advanceRevisionReviews([f.scope]);
    await f.core.setState(f.owner, "method", f.method.id, 1, "disabled");
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
      ((await f.core.inspect(f.owner, "method", f.method.id)) as Method).title,
      f.method.title,
    );
    f.engine.failRead = true;
    assert.deepEqual(await f.core.browse(f.owner, "method"), []);
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
    const b = {
      ...f.exp,
      ...identity(f.scope),
      sourceFingerprints: ["source-b"],
      evidence: [{ ...f.exp.evidence[0]!, fingerprint: "source-b" }],
    };
    const c = {
      ...f.exp,
      ...identity(f.scope),
      sourceFingerprints: ["source-c"],
      evidence: [{ ...f.exp.evidence[0]!, fingerprint: "source-c" }],
    };
    const v2 = {
      ...f.method,
      revision: 2,
      title: "Source B method",
      supportRefs: [{ kind: "experience" as const, id: b.id, revision: 1 }],
    };
    await f.store.transaction(async (tx) => {
      await tx.put(entry("experience", b), null);
      await tx.put(entry("experience", c), null);
      await tx.put(
        entry("source", {
          id: "source-b",
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
      await tx.put(entry("method", v2), 1);
    });
    f.engine.failAfterWrite = true;
    await f.core.syncProjections([f.scope]);
    const v3 = {
      ...v2,
      revision: 3,
      title: "Source C method",
      supportRefs: [{ kind: "experience" as const, id: c.id, revision: 1 }],
    };
    await f.store.transaction((tx) => tx.put(entry("method", v3), 2));
    const pending = await f.store.transaction((tx) =>
      tx.get<MethodWrite>("method_write", f.method.id),
    );
    assert.deepEqual(
      new Set(pending!.previousSupport!.map((r) => r.id)),
      new Set([f.exp.id, b.id]),
    );
    const receipt = await f.core.controlSource(f.owner, {
      id: "source-b",
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
      f.engine.readMethodContent(
        f.scope,
        f.method.id,
        splitMethod(v2).record.contentHash,
      ),
      /unavailable/,
    );
    assert.equal(
      await f.store.transaction((tx) => tx.get("method_write", f.method.id)),
      undefined,
    );
  } finally {
    await f.store.close();
  }
});
