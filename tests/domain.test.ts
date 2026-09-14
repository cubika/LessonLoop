import test from "node:test";
import assert from "node:assert/strict";
import {
  methodSchema,
  matchText,
  fingerprint,
  identity,
  conditionSchema,
} from "../src/domain/schema.js";
import {
  Preparation,
  eligible,
  type Eligibility,
  type TaskFacts,
} from "../src/domain/prepare.js";
import { experienceSchema } from "../src/domain/experience.js";

const source = {
  text: "Regeneration removed direct edits. Editing the source preserved the change.",
  role: "tool" as const,
};
const fp = fingerprint(source, "trusted:test");
const experience = experienceSchema.parse({
  ...identity("test"),
  conclusion: source.text,
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
      excerpt: source.text,
      role: "tool",
      relation: "supports",
      fingerprint: fp,
    },
  ],
  derivedFrom: [],
  sourceFingerprints: [fp],
  state: "active",
});
function fixture() {
  const match = (value: string) => {
    const match = { key: "kind", values: [value] };
    return { text: matchText(match), match };
  };
  return methodSchema.parse({
    ...identity("test"),
    title: "Edit the maintenance source",
    goal: "Preserve changes",
    applicability: "general",
    conditions: [],
    exceptions: [],
    topics: [],
    state: "active",
    steps: [
      {
        stepId: "inspect",
        instruction: "Determine who maintains the file",
        supportIndexes: [0],
        choices: [
          { when: match("generated"), next: "source" },
          { when: match("manual"), next: "manual" },
        ],
      },
      {
        stepId: "source",
        instruction: "Edit the source and regenerate",
        supportIndexes: [0],
        choices: [{ when: match("generated"), next: "stop" }],
      },
      {
        stepId: "manual",
        instruction: "Edit the maintained file",
        supportIndexes: [0],
      },
    ],
    supportRefs: [{ kind: "experience", id: experience.id, revision: 1 }],
    completionChecks: [
      { text: "Validate the resulting behavior" },
      { text: "Regenerate and compare", stepIds: ["source"] },
    ],
    stopConditions: [],
    change: {
      kind: "create",
      summary: "Observed maintenance sources",
      caseRefs: [],
      predecessors: [],
    },
  });
}
function setup() {
  const m = fixture();
  const p = new Preparation();
  const d: Eligibility = {
    now: Date.now(),
    scopes: new Set(["test"]),
    experiences: new Map([[experience.id, experience]]),
    blockedObjects: new Set(),
    blockedSources: new Set(),
    published: new Map([
      [m.id, 1],
      [experience.id, 1],
    ]),
  };
  const f: TaskFacts = {
    values: {},
    trustedKeys: new Set(),
    conditions: new Map(),
    completed: new Set(),
  };
  return { m, p, d, f };
}
test("canonical conditions reject misleading text and fingerprints separate identities", () => {
  assert.throws(() =>
    conditionSchema.parse({
      text: "production only",
      match: { key: "env", values: ["dev"] },
    }),
  );
  assert.notEqual(fp, fingerprint(source, "other"));
  assert.equal(
    fp,
    fingerprint({ ...source, text: source.text }, "trusted:test"),
  );
});
test("method rejects backward branches, dangling checks and support", () => {
  const m = fixture();
  m.steps[0]!.choices![0]!.next = "inspect";
  assert.equal(methodSchema.safeParse(m).success, false);
});
test("diagnostic prefix then observed branch; branch-specific checks stay scoped", () => {
  const { m, p, d, f } = setup();
  const r = p.prepare(m, { callerId: "c", taskRef: "t", revision: 1 }, f, d);
  assert.deepEqual(
    (r.steps as Array<{ stepId: string }>).map((s) => s.stepId),
    ["inspect"],
  );
  assert.equal((r.completionChecks as unknown[]).length, 1);
  const facts = {
    ...f,
    values: { kind: "manual" },
    trustedKeys: new Set(["kind"]),
    completed: new Set(["inspect"]),
  };
  const next = p.prepare(
    m,
    {
      callerId: "c",
      taskRef: "t",
      revision: 1,
      methodUseRef: String(r.methodUseRef),
      completedStepIds: ["inspect"],
    },
    facts,
    d,
  );
  assert.deepEqual(
    (next.steps as Array<{ stepId: string }>).map((s) => s.stepId),
    ["manual"],
  );
  assert.equal(next.pathComplete, false);
});
test("self-reported completion and old revision cannot advance", () => {
  const { m, p, d, f } = setup();
  const r = p.prepare(m, { callerId: "c", taskRef: "t", revision: 1 }, f, d);
  assert.equal(
    p.prepare(
      m,
      {
        callerId: "c",
        taskRef: "t",
        revision: 1,
        methodUseRef: String(r.methodUseRef),
        completedStepIds: ["inspect"],
      },
      f,
      d,
    ).status,
    "unavailable",
  );
  assert.equal(
    p.prepare(m, { callerId: "c", taskRef: "t", revision: 2 }, f, d).status,
    "target_changed",
  );
});
test("unpublished, withdrawn and stale supports cannot deliver", () => {
  const { m, d } = setup();
  assert.equal(eligible(m, d), true);
  assert.equal(eligible(m, { ...d, blockedSources: new Set([fp]) }), false);
  assert.equal(eligible(m, { ...d, published: new Map([[m.id, 1]]) }), false);
});
test("expanded and fresh sessions do not reset condition checks", () => {
  const { m, p, d, f } = setup();
  m.applicability = "conditional";
  m.conditions = [{ text: "Check authorized environment" }];
  for (let i = 0; i < 3; i++)
    assert.equal(
      p.prepare(
        m,
        { callerId: "c", taskRef: "t", revision: 1, viewMode: "expanded" },
        f,
        d,
      ).status,
      "lead",
    );
  assert.equal(
    p.prepare(
      m,
      { callerId: "c", taskRef: "t", revision: 1, viewMode: "expanded" },
      f,
      d,
    ).status,
    "unavailable",
  );
});
test("ending a task and restarting preparation invalidate continuation", () => {
  const { m, p, d, f } = setup();
  const r = p.prepare(m, { callerId: "c", taskRef: "t", revision: 1 }, f, d);
  p.endTask("c", "t");
  assert.equal(
    p.prepare(m, { callerId: "c", taskRef: "t", revision: 1 }, f, d).status,
    "unavailable",
  );
  assert.equal(
    new Preparation().prepare(
      m,
      {
        callerId: "c",
        taskRef: "t",
        revision: 1,
        methodUseRef: String(r.methodUseRef),
      },
      f,
      d,
    ).status,
    "unavailable",
  );
});
test("duplicate preparation rechecks current eligibility without spending another budget", () => {
  const { m, p, d, f } = setup();
  const request = {
    callerId: "c",
    taskRef: "t",
    revision: 1,
    requestId: "event-1",
  };
  for (let i = 0; i < 12; i++)
    assert.equal(p.prepare(m, request, f, d).status, "guidance");
  assert.equal(
    p.prepare(m, request, f, { ...d, blockedObjects: new Set([m.id]) }).status,
    "target_unavailable",
  );
});
