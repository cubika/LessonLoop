import test from "node:test";
import assert from "node:assert/strict";
import {
  playbookSchema,
  matchText,
  fingerprint,
  identity,
  conditionSchema,
} from "../src/domain/schema.js";
import {
  preparePlaybook,
  eligible,
  type Eligibility,
} from "../src/domain/prepare.js";
import { experienceSchema } from "../src/domain/experience.js";
import { experienceSchema as evaluationSchema } from "../evals/lib/experience.js";
import { outputJsonSchema } from "../src/core/learning.js";
import { exportPlaybook } from "../src/domain/export.js";

const source = {
  text: "Regeneration removed direct edits. Editing the source preserved the change.",
  role: "tool" as const,
};
const fp = fingerprint(source, "trusted:test");
const experience = experienceSchema.parse({
  ...identity("test"),
  conclusion: source.text,
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
test("analysis labels are optional and existing labels remain compatible", () => {
  for (const schema of [experienceSchema, evaluationSchema]) {
    assert.equal(schema.safeParse(experience).success, true);
    for (const level of ["L1", "L2", "L3", "L4", "L5"])
      assert.equal(schema.safeParse({ ...experience, level }).success, true);
    assert.equal(
      schema.safeParse({ ...experience, level: "L6" }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...experience, evidence: [] }).success,
      false,
    );
  }
  const properties = outputJsonSchema.properties as Record<string, any>;
  assert.equal(properties.experiences.items.required.includes("level"), false);
  for (const support of [experience, { ...experience, level: "L4" as const }]) {
    const exported = exportPlaybook(fixture(), [support], "markdown", true);
    assert.ok(exported.includes("supported: " + experience.conclusion));
    assert.doesNotMatch(exported, /undefined|L[1-5]/);
  }
});

function fixture() {
  const match = (value: string) => {
    const match = { key: "kind", values: [value] };
    return { text: matchText(match), match };
  };
  return playbookSchema.parse({
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
      predecessors: [],
    },
  });
}
function setup() {
  const m = fixture();
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
  return { m, d };
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
test("playbook rejects backward branches, dangling checks and support", () => {
  const m = fixture();
  m.steps[0]!.choices![0]!.next = "inspect";
  assert.equal(playbookSchema.safeParse(m).success, false);
});
test("complete guidance preserves branches and scoped checks without task observations", () => {
  const { m, d } = setup();
  const r = preparePlaybook(m, { callerId: "c", taskRef: "t", revision: 1 }, d);
  assert.equal(r.status, "guidance");
  assert.deepEqual(r.steps, m.steps);
  assert.deepEqual(r.completionChecks, m.completionChecks);
  assert.deepEqual(r.stopConditions, m.stopConditions);
  assert.equal("pendingDecision" in r, false);
  assert.equal("pathComplete" in r, false);
  assert.equal("taskApplicability" in r, false);
});

test("unknown applicability returns all boundaries for the agent to check", () => {
  const { m, d } = setup();
  m.applicability = "conditional";
  m.conditions = [{ text: "The task uses the observed generator" }];
  m.exceptions = [{ text: "The output is maintained by another tool" }];
  m.stopConditions = [{ text: "The generator cannot be identified" }];
  const request = { callerId: "c", taskRef: "t", revision: 1 };
  for (let i = 0; i < 12; i++) {
    const r = preparePlaybook(m, request, d);
    assert.equal(r.status, "guidance");
    assert.deepEqual(r.conditions, m.conditions);
    assert.deepEqual(r.exceptions, m.exceptions);
    assert.deepEqual(r.steps, m.steps);
    assert.deepEqual(r.stopConditions, m.stopConditions);
  }
});

test("usage references are stable without sessions and separate tasks, owners and revisions", () => {
  const { m, d } = setup();
  const request = { callerId: "c", taskRef: "t", revision: 1 };
  const ref = preparePlaybook(m, request, d).playbookUseRef;
  assert.equal(
    preparePlaybook(m, request, { ...d, now: d.now + 1800001 }).playbookUseRef,
    ref,
  );
  assert.equal(
    preparePlaybook(m, { ...request, viewMode: "expanded" }, d).playbookUseRef,
    ref,
  );
  assert.notEqual(
    preparePlaybook(m, { ...request, taskRef: "other" }, d).playbookUseRef,
    ref,
  );
  assert.notEqual(
    preparePlaybook(m, { ...request, callerId: "other" }, d).playbookUseRef,
    ref,
  );
  const updated = { ...m, revision: 2 };
  const published = new Map(d.published).set(m.id, 2);
  assert.notEqual(
    preparePlaybook(updated, { ...request, revision: 2 }, { ...d, published })
      .playbookUseRef,
    ref,
  );
});

test("repeated preparation checks current revisions, permissions and supporting sources", () => {
  const { m, d } = setup();
  const request = { callerId: "c", taskRef: "t", revision: 1 };
  assert.equal(preparePlaybook(m, request, d).status, "guidance");
  assert.equal(
    preparePlaybook(m, { ...request, revision: 2 }, d).status,
    "target_changed",
  );
  for (const data of [
    { ...d, scopes: new Set<string>() },
    { ...d, blockedObjects: new Set([m.id]) },
    { ...d, blockedSources: new Set([fp]) },
    { ...d, published: new Map([[m.id, 1]]) },
    {
      ...d,
      experiences: new Map([[experience.id, { ...experience, revision: 2 }]]),
    },
  ])
    assert.equal(
      preparePlaybook(m, request, data).status,
      "target_unavailable",
    );
  assert.equal(
    preparePlaybook({ ...m, state: "disabled" }, request, d).status,
    "target_unavailable",
  );
  assert.equal(
    preparePlaybook(
      { ...m, validUntil: new Date(d.now - 1).toISOString() },
      request,
      d,
    ).status,
    "target_unavailable",
  );
  assert.equal(eligible(m, d), true);
});

test("oversized guidance requires explicit expansion without dropping branches or checks", () => {
  const { m, d } = setup();
  m.steps = Array.from({ length: 12 }, (_, i) => ({
    stepId: "s" + i,
    instruction: "Check actual output before changing it. ".repeat(26),
    supportIndexes: [0],
  }));
  m.completionChecks = [{ text: "Verify actual output" }];
  const request = { callerId: "c", taskRef: "t", revision: 1 };
  assert.deepEqual(preparePlaybook(m, request, d), {
    status: "requires_expansion",
  });
  const expanded = preparePlaybook(m, { ...request, viewMode: "expanded" }, d);
  assert.equal(expanded.status, "guidance");
  assert.deepEqual(expanded.steps, m.steps);
  assert.deepEqual(expanded.completionChecks, m.completionChecks);
  m.steps.forEach((s) => (s.instruction = "x ".repeat(900)));
  assert.deepEqual(
    preparePlaybook(m, { ...request, viewMode: "expanded" }, d),
    {
      status: "too_large",
    },
  );
});
