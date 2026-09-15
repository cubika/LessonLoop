import test from "node:test";
import assert from "node:assert/strict";
import {
  pathReviewErrors,
  playbookPaths,
} from "../src/domain/playbook-paths.js";
const previous = {
  id: "old",
  steps: [
    { stepId: "s1", instruction: "Update schema fields", supportIndexes: [0] },
  ],
};
const playbook = {
  replaces: { id: "old" },
  steps: [
    {
      stepId: "s1",
      instruction: "Inspect pipeline",
      supportIndexes: [0],
      choices: [
        { when: { text: "Field request" }, next: "s2" },
        { when: { text: "Extension request" }, next: "stop" },
      ],
    },
    { stepId: "s2", instruction: "Update schema fields", supportIndexes: [0] },
  ],
};
test("A blanket playbook approval cannot replace branch-by-branch and predecessor checks", () => {
  assert.equal(pathReviewErrors([playbook], [previous], {}).length, 3);
  const review = {
    pathChecks: [0, 1].map((pathIndex) => ({
      playbookIndex: 0,
      pathIndex,
      globalConditionsCompatible: true,
      stepsCompatible: true,
      reason: "Compatible path",
    })),
    preservedPaths: [
      {
        playbookId: "old",
        pathIndex: 0,
        preserved: true,
        reason: "Field edits remain reachable",
      },
    ],
  };
  assert.deepEqual(pathReviewErrors([playbook], [previous], review), []);
  review.pathChecks[0]!.globalConditionsCompatible = false;
  review.pathChecks[0]!.reason =
    "Extension-only global requirement excludes ordinary field edits";
  assert.deepEqual(pathReviewErrors([playbook], [previous], review), [
    review.pathChecks[0]!.reason,
  ]);
  review.pathChecks[0]!.globalConditionsCompatible = true;
  review.preservedPaths[0]!.preserved = false;
  assert.equal(pathReviewErrors([playbook], [previous], review).length, 1);
});
test("The path budget accepts exactly 64 paths and detects a 65th", () => {
  const steps = Array.from({ length: 3 }, (_, i) => ({
    stepId: `s${i}`,
    instruction: "choose",
    supportIndexes: [0],
    choices: Array.from({ length: 4 }, (_, n) => ({
      when: { text: String(n) },
      next: i === 2 ? "stop" : `s${i + 1}`,
    })),
  }));
  assert.equal(playbookPaths({ steps }).paths.length, 64);
  assert.equal(playbookPaths({ steps }).truncated, false);
  steps[0]!.choices.push({ when: { text: "extra" }, next: "stop" });
  assert.equal(playbookPaths({ steps }).truncated, true);
});
