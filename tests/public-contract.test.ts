import test from "node:test";
import assert from "node:assert/strict";
import { publicValue, internalInput } from "../src/core/public-contract.js";
test("Resource translation preserves source text and arbitrary observation keys", () => {
  const data = {
    context: { method: "literal", playbookId: "unchanged" },
    values: { playbookId: "literal" },
    conditionResults: { playbookId: false },
    evidence: [{ excerpt: "method and playbook" }],
    segments: [{ text: "method", role: "tool" }],
  };
  assert.deepEqual(publicValue(data), data);
  assert.deepEqual(internalInput(data), data);
  const view = publicValue({
    method: { kind: "method", id: "m", revision: 2 },
    methodUseRef: "u",
    change: { caseRefs: [{ kind: "work_case", id: "c" }] },
    results: [
      { kind: "work_case", id: "c" },
      { kind: "experience", id: "e" },
    ],
  });
  assert.equal(view.playbook.kind, "playbook");
  assert.equal(view.playbookUseRef, "u");
  assert.equal(view.change.caseRefs, undefined);
  assert.deepEqual(view.results, [{ kind: "experience", id: "e" }]);
});
