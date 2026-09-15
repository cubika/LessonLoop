import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import {
  identity,
  playbookSchema,
  type ObjectRef,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
const row = (kind: string, value: any) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value,
});
class Engine extends HindsightEngine {
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async retainSupport() {}
  override async index(_s: string, r: ObjectRef) {
    return r.id;
  }
}
async function setup(store: ProductStore, controlled = false) {
  const scope = randomUUID(),
    host = { id: randomUUID(), channel: "host" as const, scopes: [scope] },
    p = { ...host, channel: "user" as const },
    core = new CoreService(store, new Engine());
  await core.configure(p, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const initial = await core.submitSource(
    host,
    {
      scopeId: scope,
      segments: [
        { text: "Initial uncertain pipeline observation", role: "tool" },
      ],
    },
    "initial",
  );
  const source = (await core.listSources(p))[0]!;
  const e = experienceSchema.parse({
    ...identity(scope),
    conclusion: "Regeneration preserves local extensions",
    level: "L1",
    purpose: "fact",
    applicability: "conditional",
    conditions: [{ text: "Observed pipeline version 2" }],
    exceptions: [],
    topics: [],
    entities: [],
    basis: "observed",
    assessment: "hypothesis",
    evidence: [
      {
        excerpt: "Initial uncertain pipeline observation",
        role: "tool",
        relation: "supports",
        fingerprint: source.id,
      },
    ],
    derivedFrom: [],
    sourceFingerprints: [source.id],
    state: "held",
    review: {
      reason: "verification_requested",
      question: "Check extension survives regeneration",
      reviewBy: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const child = experienceSchema.parse({
    ...e,
    ...identity(scope),
    state: "active",
    assessment: "supported",
    review: undefined,
    derivedFrom: [{ id: e.id, revision: 1 }],
    evidence: [],
  });
  const playbook = playbookSchema.parse({
    ...identity(scope),
    title: "Extension workflow",
    goal: "Preserve extension",
    topics: [],
    applicability: "general",
    conditions: [],
    exceptions: [],
    state: "active",
    steps: [
      {
        stepId: "s1",
        instruction: "Use verified extension behavior",
        supportIndexes: [0],
      },
    ],
    completionChecks: [{ text: "Extension survives" }],
    stopConditions: [],
    supportRefs: [{ kind: "experience", id: child.id, revision: 1 }],
    change: {
      kind: "create",
      summary: "Fixture",
      predecessors: [],
    },
  });
  await store.transaction(async (tx) => {
    for (const [kind, value] of [
      ["experience", e],
      ["experience", child],
      ["playbook", playbook],
    ] as const)
      await tx.put(row(kind, value), null);
    const job = await tx.get<any>("job", initial.jobId);
    await tx.put(
      row("job", {
        ...job,
        revision: job.revision + 1,
        status: "completed",
        stage: "done",
      }),
      job.revision,
    );
    if (controlled)
      await tx.put(
        row("control", {
          id: e.id,
          revision: 1,
          scopeId: scope,
          reason: "user_correction",
          correctionText:
            "Only version 2 has been observed; keep this boundary.",
        }),
        null,
      );
  });
  const input = {
    scopeId: scope,
    segments: [
      { text: "Version 2 retained extension after regeneration", role: "tool" },
    ],
    verificationFor: { kind: "experience", id: e.id, revision: 1 },
  };
  const stage = async (jobId: string, approved = true) =>
    store.transaction(async (tx) => {
      const job = await tx.get<any>("job", jobId);
      const candidate = {
        workView: null,
        playbook: null,
        experiences: [
          {
            conclusion: e.conclusion,
            purpose: e.purpose,
            applicability: e.applicability,
            conditions: e.conditions,
            exceptions: [],
            topics: [],
            entities: [],
            basis: "observed",
            assessment: "supported",
            evidence: [
              {
                sourceIndex: job.sourceIds.length - 1,
                excerpt: input.segments[0]!.text,
                relation: "supports",
              },
            ],
            parentIndexes: [],
            state: "active",
          },
        ],
        decisions: [],
      };
      await tx.put(
        row("job", {
          ...job,
          revision: job.revision + 1,
          stage: "publish",
          status: "running",
          candidate,
          verdict: {
            acceptedExperienceIndexes: [0],
            playbookSupported: false,
            verifiedTarget: approved,
            reasons: [],
          },
        }),
        job.revision,
      );
    });
  return { scope, p, host, core, e, child, playbook, input, stage };
}
test("Targeted evidence updates one held claim and invalidates all dependent revisions", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const f = await setup(store);
    const receipt = await f.core.submitSource(f.host, f.input, "verify");
    const replay = await f.core.submitSource(f.host, f.input, "verify");
    assert.equal(receipt.jobId, replay.jobId);
    await assert.rejects(
      f.core.submitSource(f.host, f.input, "second"),
      /verification_already_running/,
    );
    await f.stage(receipt.jobId);
    await f.core.tick([f.scope]);
    const updated = (await f.core.inspect(f.p, "experience", f.e.id)) as any;
    assert.equal(updated.revision, 2);
    assert.equal(updated.state, "active");
    assert.equal((await f.core.browse(f.p, "experience")).length, 2);
    assert.equal(
      ((await f.core.inspect(f.p, "experience", f.child.id)) as any).state,
      "held",
    );
    assert.equal(
      ((await f.core.inspect(f.p, "playbook", f.playbook.id)) as any).state,
      "held",
    );
    await f.core.syncProjections([f.scope]);
    assert.equal(
      (await f.core.getJob(f.p, receipt.jobId)).results.some(
        (r) => r.id === f.e.id && r.effective,
      ),
      true,
    );
  } finally {
    await store.close();
  }
});
test("User control, current target revision and verification deadlines cannot be bypassed", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const f = await setup(store, true);
    await assert.rejects(
      f.core.submitSource({ ...f.host, channel: "agent" }, f.input, "agent"),
      /user_verification_required/,
    );
    const receipt = await f.core.submitSource(f.p, f.input, "owner");
    const job = await store.transaction((tx) =>
      tx.get<any>("job", receipt.jobId),
    );
    assert.equal(
      job.verificationControl.correctionText,
      "Only version 2 has been observed; keep this boundary.",
    );
    await f.stage(receipt.jobId);
    await f.core.feedback(f.p, {
      target: { kind: "experience", id: f.e.id, revision: 1 },
      rating: "incorrect",
      correctionText: "Further correction arrived",
    });
    await f.core.tick([f.scope]);
    assert.equal(
      (await f.core.getJob(f.p, receipt.jobId)).error,
      "verification_target_changed",
    );
    assert.equal(
      ((await f.core.inspect(f.p, "experience", f.e.id)) as any).state,
      "held",
    );
    const g = await setup(store);
    const r = await g.core.submitSource(g.host, g.input, "verify");
    await g.stage(r.jobId);
    await store.transaction(async (tx) => {
      const old = await tx.get<any>("experience", g.e.id);
      old.review.reviewBy = new Date(Date.now() - 1).toISOString();
      await tx.put(row("experience", { ...old, revision: 2 }), 1);
    });
    await g.core.tick([g.scope]);
    assert.equal((await g.core.getJob(g.p, r.jobId)).status, "failed");
  } finally {
    await store.close();
  }
});
test("Rejected verification leaves the same pending claim and no unasked products", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const f = await setup(store);
    const r = await f.core.submitSource(f.host, f.input, "verify");
    await f.stage(r.jobId, false);
    await f.core.tick([f.scope]);
    const e = (await f.core.inspect(f.p, "experience", f.e.id)) as any;
    assert.equal(e.revision, 1);
    assert.equal(e.state, "held");
    assert.equal((await f.core.getJob(f.p, r.jobId)).results.length, 0);
  } finally {
    await store.close();
  }
});
