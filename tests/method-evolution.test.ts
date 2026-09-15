import { methodPaths } from "../src/domain/method-paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  learningOutputSchema,
  parseLearningAssessment,
  outputJsonSchema,
  learningAssessmentJsonSchema,
} from "../src/core/learning.js";
import {
  legacyOutputJsonSchema,
  legacyAssessmentJsonSchema,
} from "../src/core/legacy-learning-profile.js";
import { methodSchema, identity } from "../src/domain/schema.js";
import {
  methodPlanKey,
  methodSupportKey,
} from "../src/domain/method-evolution.js";
const draft = (id = "parent") => ({
  title: "Version method",
  goal: "Preserve output",
  topics: [],
  applicability: "general",
  conditions: [],
  exceptions: [],
  state: "active",
  steps: [{ stepId: "s1", instruction: "Check output", supportIndexes: [0] }],
  completionChecks: [{ text: "Output matches", stepIds: ["s1"] }],
  stopConditions: [],
  experienceIndexes: [0],
  replaces: { id, revision: 1 },
  changeKind: "split",
  changeSummary: "Distinct cases",
});
test("Split schema requires a coherent predecessor and applies graph constraints to every child", () => {
  const output = {
    workCase: null,
    experiences: [],
    method: null,
    splitMethods: [draft(), draft()],
    decisions: [],
  };
  assert.equal(learningOutputSchema.safeParse(output).success, true);
  assert.equal(
    learningOutputSchema.safeParse({
      ...output,
      splitMethods: [draft(), draft("different")],
    }).success,
    false,
  );
  assert.equal(
    learningOutputSchema.safeParse({ ...output, method: draft() }).success,
    false,
  );
  assert.equal(
    learningOutputSchema.safeParse({
      ...output,
      splitMethods: undefined,
      method: draft(),
    }).success,
    false,
  );
  const nodes: any[] = [];
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.properties?.instruction && value.properties?.stepId)
      nodes.push(value);
    Object.values(value).forEach(walk);
  };
  walk(outputJsonSchema);
  assert.equal(nodes.length >= 2, true);
  for (const node of nodes) {
    assert.deepEqual(
      node.properties.stepId.enum,
      Array.from({ length: 12 }, (_, i) => "s" + (i + 1)),
    );
    assert.equal(
      node.properties.choices.items.properties.next.enum.includes("stop"),
      true,
    );
  }
  assert.equal(
    (legacyOutputJsonSchema as any).properties.splitMethods,
    undefined,
  );
  assert.equal(
    (legacyAssessmentJsonSchema as any).properties.acceptedMethodIndexes,
    undefined,
  );
  assert.ok(
    (learningAssessmentJsonSchema as any).properties.acceptedMethodIndexes,
  );
});
test("Plan and support comparisons preserve meaningful whitespace and include global evidence", () => {
  const { experienceIndexes, replaces, changeKind, changeSummary, ...body } =
    draft();
  const m = methodSchema.parse({
    ...identity("fixture"),
    ...body,
    supportRefs: [{ kind: "experience", id: "support-a", revision: 1 }],
    change: {
      kind: "create",
      summary: "Initial",
      caseRefs: [],
      predecessors: [],
    },
  });
  const renumbered = {
    ...m,
    title: "Changed title",
    steps: [{ ...m.steps[0]!, stepId: "renamed" }],
    completionChecks: [{ text: "Output matches", stepIds: ["renamed"] }],
  };
  assert.equal(methodPlanKey(m), methodPlanKey(renumbered));
  assert.notEqual(
    methodPlanKey({
      ...m,
      steps: [{ ...m.steps[0]!, instruction: 'Write "a  b"' }],
    }),
    methodPlanKey({
      ...m,
      steps: [{ ...m.steps[0]!, instruction: 'Write "a b"' }],
    }),
  );
  assert.notEqual(
    methodSupportKey(m),
    methodSupportKey({
      ...m,
      supportRefs: [
        ...m.supportRefs,
        { kind: "experience", id: "global-support", revision: 1 },
      ],
    }),
  );
});

test("Executable path audit exposes branch fallthrough instead of trusting prose stop conditions", () => {
  const steps = [
    {
      stepId: "s1",
      instruction: "Choose version",
      supportIndexes: [0],
      choices: [
        { when: { text: "Version 2" }, next: "s2" },
        { when: { text: "Version 1" }, next: "s4" },
      ],
    },
    { stepId: "s2", instruction: "Version 2 action", supportIndexes: [0] },
    { stepId: "s3", instruction: "Version 2 check", supportIndexes: [0] },
    { stepId: "s4", instruction: "Version 1 action", supportIndexes: [0] },
  ];
  const before = methodPaths({ steps });
  assert.deepEqual(before.paths[0]!.steps, ["s1", "s2", "s3", "s4"]);
  const fixed = steps.map((s) =>
    s.stepId === "s3"
      ? { ...s, choices: [{ when: { text: "Version 2" }, next: "stop" }] }
      : s,
  );
  assert.deepEqual(methodPaths({ steps: fixed }).paths[0]!.steps, [
    "s1",
    "s2",
    "s3",
  ]);
});

test("Frozen early methods-2 verdicts recover without inventing evidence-change approval", () => {
  const verdict = {
    acceptedExperienceIndexes: [],
    methodSupported: true,
    substantiveChange: true,
    acceptedMethodIndexes: [0],
    splitCoherent: true,
    reasons: [],
  };
  const legacy = structuredClone(learningAssessmentJsonSchema) as any;
  delete legacy.properties.supportedEvidenceChange;
  assert.equal(
    parseLearningAssessment(verdict, legacy).supportedEvidenceChange,
    false,
  );
  assert.throws(() =>
    parseLearningAssessment(verdict, learningAssessmentJsonSchema),
  );
});
