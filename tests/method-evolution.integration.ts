import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import {
  identity,
  methodSchema,
  type Method,
  type ObjectRef,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
import {
  learningOutputSchema,
  learningAssessmentSchema,
  outputJsonSchema,
} from "../src/core/learning.js";
import { methodPlanKey } from "../src/domain/method-evolution.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
const entry = (kind: string, value: any) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value,
});
class Engine extends HindsightEngine {
  failTitle = "";
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async retainSupport() {}
  override async index(_scope: string, ref: ObjectRef, text: string) {
    if (this.failTitle && text.includes(this.failTitle))
      throw new Error("projection offline");
    return ref.id;
  }
}
async function setup(store: ProductStore) {
  const scope = randomUUID(),
    p = { id: randomUUID(), channel: "user" as const, scopes: [scope] },
    engine = new Engine(),
    core = new CoreService(store, engine);
  await core.configure(p, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const oldInput = await core.submitMaterial(
    p,
    {
      scopeId: scope,
      segments: [
        {
          role: "user",
          text: "Editing the source and regenerating preserves generated output.",
        },
      ],
    },
    "old",
  );
  const source = (await core.listSources(p))[0]!;
  const e = experienceSchema.parse({
    ...identity(scope),
    conclusion: "Edit the source before regenerating",
    level: "L1",
    purpose: "procedure",
    applicability: "general",
    conditions: [],
    exceptions: [],
    topics: [],
    entities: [],
    basis: "reported",
    assessment: "supported",
    evidence: [
      {
        excerpt: "Editing the source",
        role: "user",
        relation: "supports",
        fingerprint: source.id,
      },
    ],
    derivedFrom: [],
    sourceFingerprints: [source.id],
    state: "active",
  });
  const method = methodSchema.parse({
    ...identity(scope),
    title: "Original workflow",
    goal: "Preserve maintained changes",
    applicability: "general",
    conditions: [],
    exceptions: [],
    topics: [],
    state: "active",
    steps: [
      {
        stepId: "s1",
        instruction: "Edit the source and regenerate",
        supportIndexes: [0],
      },
    ],
    supportRefs: [{ kind: "experience", id: e.id, revision: e.revision }],
    completionChecks: [{ text: "Check regenerated output" }],
    stopConditions: [],
    change: {
      kind: "create",
      summary: "Observed workflow",
      caseRefs: [],
      predecessors: [],
    },
  });
  await store.transaction(async (tx) => {
    for (const [kind, value] of [
      ["experience", e],
      ["method", method],
    ] as const) {
      await tx.put(entry(kind, value), null);
      await tx.put(
        entry("projection", {
          id: value.id,
          revision: 1,
          scopeId: scope,
          objectKind: kind,
          objectRevision: 1,
          confirmed: true,
          text: kind === "method" ? method.title : e.conclusion,
        }),
        null,
      );
    }
    const job = await tx.get<any>("job", oldInput.jobId);
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
  const newInput = await core.submitMaterial(
    p,
    {
      scopeId: scope,
      segments: [
        {
          role: "user",
          text: "Version 2 supports editing the extension region directly; version 1 requires regeneration.",
        },
      ],
    },
    "new",
  );
  const exp = {
    conclusion: "Version-specific edit locations differ",
    level: "L4",
    purpose: "procedure",
    applicability: "conditional",
    conditions: [{ text: "Version is known" }],
    exceptions: [],
    topics: [],
    entities: [],
    basis: "reported",
    assessment: "supported",
    evidence: [
      {
        sourceIndex: 0,
        excerpt: "Version 2 supports editing the extension region directly",
        relation: "supports",
      },
    ],
    parentIndexes: [],
    state: "active",
  };
  const draft = (instruction: string, title: string) => ({
    title,
    goal: method.goal,
    applicability: "conditional",
    conditions: [{ text: title }],
    exceptions: [],
    topics: [],
    state: "active",
    steps: [{ stepId: "s1", instruction, supportIndexes: [0, 1] }],
    completionChecks: [{ text: "Check regenerated output" }],
    stopConditions: [],
    experienceIndexes: [0],
    existingSupportRefs: [{ id: e.id, revision: e.revision }],
    replaces: { id: method.id, revision: method.revision },
    changeKind: "split",
    changeSummary: "Separate version-specific procedures",
  });
  const stage = async (
    candidate: unknown,
    verdict: Record<string, unknown> = {},
  ) =>
    store.transaction(async (tx) => {
      const job = await tx.get<any>("job", newInput.jobId);
      await tx.put(
        entry("job", {
          ...job,
          revision: job.revision + 1,
          stage: "publish",
          status: "running",
          learningProfile: "methods-2",
          modelSchema: outputJsonSchema,
          retainedSupport: [e],
          comparisonMethods: [method],
          comparedMethodRefs: [
            { kind: "method", id: method.id, revision: method.revision },
          ],
          candidate: learningOutputSchema.parse(candidate),
          verdict: learningAssessmentSchema.parse({
            acceptedExperienceIndexes: [0],
            methodSupported: true,
            substantiveChange: true,
            supportedEvidenceChange: true,
            acceptedMethodIndexes: [0, 1],
            splitCoherent: true,
            reasons: [],
            ...verdict,
          }),
        }),
        job.revision,
      );
    });
  const split = {
    workCase: null,
    experiences: [exp],
    method: null,
    splitMethods: [
      draft("Edit source for version 1", "Version 1 workflow"),
      draft("Edit extension region for version 2", "Version 2 workflow"),
    ],
    decisions: [],
  };
  return { scope, p, core, engine, e, method, newInput, stage, split, draft };
}
test("Split retires one predecessor atomically and exposes no child until every projection is confirmed", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    const task = await f.core.startTask(f.p, f.scope);
    assert.equal(
      (
        await f.core.prepare(f.p, {
          methodId: f.method.id,
          revision: 1,
          taskRef: task.taskRef,
        })
      ).status,
      "guidance",
    );
    await f.stage(f.split);
    await f.core.tick([f.scope]);
    const methods = (await f.core.browse(f.p, "method")) as unknown as Method[];
    assert.equal(methods.length, 3);
    const original = methods.find((m) => m.id === f.method.id)!;
    assert.equal(original.state, "disabled");
    assert.equal(original.revision, 2);
    const children = methods.filter((m) => m.id !== original.id);
    assert.equal(new Set(children.map((m) => m.id)).size, 2);
    for (const child of children) {
      assert.deepEqual(child.change.predecessors, [
        { kind: "method", id: original.id, revision: 1 },
      ]);
      assert.equal(child.supportRefs.length, 2);
    }
    assert.equal((await f.core.history(f.p, original.id)).length, 1);
    await assert.rejects(
      f.core.setState(f.p, "method", original.id, 2, "active"),
      /reassessment_required/,
    );
    assert.notEqual(
      (
        await f.core.prepare(f.p, {
          methodId: original.id,
          revision: 1,
          taskRef: task.taskRef,
        })
      ).status,
      "guidance",
    );
    f.engine.failTitle = "Version 2 workflow";
    await f.core.syncProjections([f.scope]);
    const partial = await f.core.getJob(f.p, f.newInput.jobId);
    assert.equal(
      partial.results
        .filter((r) => r.kind === "method")
        .some((r) => r.effective),
      false,
    );
    f.engine.failTitle = "";
    await f.core.syncProjections([f.scope]);
    const complete = await f.core.getJob(f.p, f.newInput.jobId);
    assert.equal(
      complete.results
        .filter((r) => r.kind === "method")
        .every((r) => r.effective),
      true,
    );
  } finally {
    await store.close();
  }
});
test("Invalid second child rolls back all products and user control rejects the entire late split", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    const bad = structuredClone(f.split);
    bad.splitMethods[1]!.steps[0]!.supportIndexes = [9];
    await f.stage(bad);
    await f.core.tick([f.scope]);
    assert.equal((await f.core.getJob(f.p, f.newInput.jobId)).status, "failed");
    assert.equal((await f.core.browse(f.p, "method")).length, 1);
    assert.equal((await f.core.browse(f.p, "experience")).length, 1);
    await f.stage(f.split);
    await f.core.setState(f.p, "method", f.method.id, 1, "disabled");
    await f.core.tick([f.scope]);
    assert.equal(
      (await f.core.getJob(f.p, f.newInput.jobId)).error,
      "method_predecessor_changed",
    );
    assert.equal((await f.core.browse(f.p, "method")).length, 1);
  } finally {
    await store.close();
  }
});
test("Method refinements retain prior support and cosmetic plans do not create revisions", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    const {
      id,
      revision,
      scopeId,
      createdAt,
      updatedAt,
      supportRefs,
      change,
      ...body
    } = f.method;
    const cosmetic = {
      ...body,
      title: "Renamed workflow",
      steps: [{ ...body.steps[0]!, stepId: "renumbered" }],
      experienceIndexes: [],
      existingSupportRefs: [{ id: f.e.id, revision: 1 }],
      replaces: { id, revision },
      changeKind: "refine",
      changeSummary: "Renamed only",
    };
    const candidate = {
      workCase: null,
      experiences: [],
      method: cosmetic,
      decisions: [],
    };
    await f.stage(candidate, {
      acceptedExperienceIndexes: [],
      acceptedMethodIndexes: [0],
    });
    await f.core.tick([f.scope]);
    assert.equal(
      ((await f.core.inspect(f.p, "method", id)) as Method).revision,
      1,
    );
    assert.equal((await f.core.history(f.p, id)).length, 0);
    assert.equal(
      methodPlanKey(f.method),
      methodPlanKey({
        ...f.method,
        ...body,
        title: "New title",
        steps: cosmetic.steps,
      }),
    );
    const update = {
      ...f.split,
      splitMethods: undefined,
      method: {
        ...f.draft(
          "Use extension region for version 2; otherwise edit source and regenerate",
          "Version-aware workflow",
        ),
        changeKind: "branch",
      },
    };
    await f.stage(update, { acceptedMethodIndexes: [0] });
    await f.core.tick([f.scope]);
    const changed = (await f.core.inspect(f.p, "method", id)) as Method;
    assert.equal(changed.revision, 2);
    assert.equal(
      changed.supportRefs.some((r) => r.id === f.e.id && r.revision === 1),
      true,
    );
    assert.equal((await f.core.history(f.p, id)).length, 1);
  } finally {
    await store.close();
  }
});

test("Aborting a partially indexed split disables siblings and leaves explicit reassessment possible", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    await f.stage(f.split);
    await f.core.tick([f.scope]);
    const children = (
      (await f.core.browse(f.p, "method")) as unknown as Method[]
    ).filter((m) => m.id !== f.method.id);
    f.engine.failTitle = "Version 2 workflow";
    await f.core.syncProjections([f.scope]);
    assert.equal(
      (await f.core.getJob(f.p, f.newInput.jobId)).receipt.replacement.status,
      "pending",
    );
    await assert.rejects(
      f.core.revise(f.p, children[0]!.id, 1, { goal: "Changed" }),
      /publication_group_pending/,
    );
    await f.core.setState(f.p, "method", children[0]!.id, 1, "disabled");
    const group = (await f.core.inspect(
      f.p,
      "publication_group",
      f.newInput.jobId,
    )) as any;
    assert.equal(group.state, "invalidated");
    for (const child of children)
      assert.equal(
        ((await f.core.inspect(f.p, "method", child.id)) as Method).state,
        "disabled",
      );
    const sibling = (await f.core.inspect(
      f.p,
      "method",
      children[1]!.id,
    )) as Method;
    await assert.rejects(
      f.core.setState(f.p, "method", sibling.id, sibling.revision, "active"),
      /reassessment_required/,
    );
    const receipt = await f.core.revise(f.p, sibling.id, sibling.revision, {
      goal: "Reassess the version-specific procedure",
    });
    assert.equal(receipt.accepted, true);
    const changed = {
      ...f.method,
      steps: [
        { ...f.method.steps[0]!, instruction: 'Write JSON value "a  b"' },
      ],
    };
    assert.notEqual(
      methodPlanKey(changed),
      methodPlanKey({
        ...changed,
        steps: [
          { ...changed.steps[0]!, instruction: 'Write JSON value "a b"' },
        ],
      }),
    );
  } finally {
    await store.close();
  }
});

test("Support-only revisions require independent evidence and support loss aborts pending groups", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    const {
      id,
      revision,
      scopeId,
      createdAt,
      updatedAt,
      supportRefs,
      change,
      ...body
    } = f.method;
    const candidate = {
      workCase: null,
      experiences: f.split.experiences,
      method: {
        ...body,
        steps: [{ ...body.steps[0]!, supportIndexes: [0, 1] }],
        experienceIndexes: [0],
        existingSupportRefs: [{ id: f.e.id, revision: 1 }],
        replaces: { id, revision },
        changeKind: "refine",
        changeSummary:
          "New independent evidence strengthens the existing method",
      },
      decisions: [],
    };
    await f.stage(candidate, {
      substantiveChange: false,
      supportedEvidenceChange: true,
      acceptedMethodIndexes: [0],
    });
    await f.core.tick([f.scope]);
    const updated = (await f.core.inspect(f.p, "method", id)) as Method;
    assert.equal(updated.revision, 2);
    assert.equal(updated.supportRefs.length, 2);
    const g = await setup(store);
    await g.stage(g.split);
    await g.core.tick([g.scope]);
    g.engine.failTitle = "Version 2 workflow";
    await g.core.syncProjections([g.scope]);
    await g.core.setState(g.p, "experience", g.e.id, 1, "disabled");
    await g.core.syncProjections([g.scope]);
    assert.equal(
      (
        (await g.core.inspect(
          g.p,
          "publication_group",
          g.newInput.jobId,
        )) as any
      ).state,
      "invalidated",
    );
    const children = (
      (await g.core.browse(g.p, "method")) as unknown as Method[]
    ).filter((m) => m.id !== g.method.id);
    assert.equal(
      children.every((m) => m.state === "disabled"),
      true,
    );
  } finally {
    await store.close();
  }
});

test("Rejected methods get one bounded revision while retaining every native operation identity", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store);
    const candidate = {
      ...f.split,
      splitMethods: null,
      method: {
        ...f.draft("Unsupported proposed step", "Candidate"),
        changeKind: "branch",
      },
    };
    await f.stage(candidate);
    await store.transaction(async (tx) => {
      const j = await tx.get<any>("job", f.newInput.jobId);
      await tx.put(
        entry("job", {
          ...j,
          revision: j.revision + 1,
          stage: "assess",
          assessmentId: "assess-fixture",
          assessmentOperationId: "op-review-1",
          modelQuery: "Original authorized evidence",
          engineOperations: ["op-compose-1", "op-review-1"],
        }),
        j.revision,
      );
    });
    let calls = 0;
    const verdict = {
      acceptedExperienceIndexes: [],
      methodSupported: false,
      substantiveChange: false,
      supportedEvidenceChange: false,
      acceptedMethodIndexes: [],
      splitCoherent: false,
      reasons: ["Unsupported comparison tool"],
    };
    const engine = f.engine as any;
    engine.forJob = () => engine;
    engine.operation = async () => ({ status: "completed" });
    engine.model = async () => ({
      reflect_response: { structured_output: verdict },
    });
    await f.core.tick([f.scope]);
    let j = await store.transaction((tx) =>
      tx.get<any>("job", f.newInput.jobId),
    );
    assert.equal(j.methodRepairCount, 1);
    assert.equal(j.stage, "compose");
    assert.ok(j.modelQuery.includes("not evidence"));
    assert.deepEqual(j.engineOperations, ["op-compose-1", "op-review-1"]);
    assert.equal((await f.core.browse(f.p, "method")).length, 1);
    engine.findModelOperation = async () => undefined;
    engine.createModel = async () => {
      calls++;
      return { operation_id: "op-repaired-compose" };
    };
    engine.operation = async () => ({ status: "pending" });
    await f.core.tick([f.scope]);
    j = await store.transaction((tx) => tx.get<any>("job", f.newInput.jobId));
    assert.equal(calls, 1);
    assert.ok(j.engineOperations.includes("op-repaired-compose"));
    await store.transaction(async (tx) => {
      const old = await tx.get<any>("job", j.id);
      await tx.put(
        entry("job", {
          ...old,
          revision: old.revision + 1,
          stage: "assess",
          candidate: learningOutputSchema.parse(candidate),
          assessmentId: "assess-second",
          assessmentOperationId: "op-review-2",
        }),
        old.revision,
      );
    });
    engine.operation = async () => ({ status: "completed" });
    await f.core.tick([f.scope]);
    j = await store.transaction((tx) => tx.get<any>("job", j.id));
    assert.equal(j.status, "completed");
    assert.equal(j.methodRepairCount, 1);
    assert.equal(calls, 1);
    assert.ok(
      j.decisions.some((d: any) => d.reason === "method_repair_requested"),
    );
    assert.equal((await f.core.browse(f.p, "method")).length, 1);
  } finally {
    await store.close();
  }
});

test("A failing published projection cannot starve later valid objects", async () => {
  const store = new ProductStore(url!);
  await store.open();
  try {
    const f = await setup(store),
      indexed: string[] = [];
    const engine = f.engine as any;
    engine.index = async (_scope: string, ref: ObjectRef) => {
      indexed.push(ref.id);
      if (ref.id.startsWith("a")) throw new Error("temporarily unavailable");
      return ref.id;
    };
    await store.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) {
        const id = (i < 8 ? "a" : "z") + i,
          method = { ...f.method, id };
        await tx.put(entry("method", method), null);
        await tx.put(
          entry("projection", {
            id,
            revision: 1,
            scopeId: f.scope,
            objectKind: "method",
            objectRevision: 1,
            confirmed: false,
            text: id,
          }),
          null,
        );
      }
    });
    await f.core.syncProjections([f.scope]);
    await f.core.syncProjections([f.scope]);
    assert.ok(indexed.includes("z8"));
    assert.ok(indexed.includes("z9"));
  } finally {
    await store.close();
  }
});
