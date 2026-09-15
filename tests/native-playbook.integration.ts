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
