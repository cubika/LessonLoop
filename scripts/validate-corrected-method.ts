import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { digest, type Method } from "../src/domain/schema.js";
const report = JSON.parse(
  await readFile(
    ".local-validation/results/method-path-correction.json",
    "utf8",
  ),
);
assert.equal(
  report.classification,
  "manual_correction_of_real_generated_method",
);
const s = JSON.parse(
  await readFile(".local-validation/data/development-secret.json", "utf8"),
);
const store = new ProductStore(
  "postgresql://lessonloop:" +
    encodeURIComponent(s.password) +
    "@127.0.0.1:19432/postgres",
);
await store.open();
const core = new CoreService(
    store,
    new HindsightEngine("http://127.0.0.1:19888", s.engineToken),
  ),
  p = {
    id: "path-check-" + randomUUID(),
    channel: "host" as const,
    scopes: [report.scope],
  };
const output: any = {
  classification: "real_generated_method_deterministic_branch_validation",
  cases: [],
};
try {
  await core.syncProjections([report.scope]);
  const method = (await core.inspect(p, "method", report.after.id)) as Method;
  assert.equal(method.state, "active");
  for (const [scenario, branch, want] of [
    ["field change", 0, ["s2", "s3"]],
    ["version 2 extension", 1, ["s4", "s5"]],
    ["version 1 unsupported extension", 2, []],
  ] as const) {
    const task = await core.startTask(p, report.scope);
    const conditions: Record<string, boolean> = {};
    method.conditions.forEach((c) => (conditions[digest(c)] = true));
    method.exceptions.forEach((c) => (conditions[digest(c)] = false));
    await core.observe(p, {
      taskRef: task.taskRef,
      eventId: "global",
      text: "Synthetic fixture scope established",
      values: {},
      completedStepIds: [],
      conditionResults: conditions,
    });
    const prefix = await core.prepare(p, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
    });
    assert.equal(prefix.status, "guidance");
    assert.deepEqual(
      (prefix.steps as any[]).map((s) => s.stepId),
      ["s1"],
    );
    method.steps[0]!.choices!.forEach(
      (choice, i) => (conditions[digest(choice.when)] = i === branch),
    );
    await core.observe(p, {
      taskRef: task.taskRef,
      eventId: "branch",
      text: "Synthetic fixture version and requested target inspected",
      values: {},
      completedStepIds: ["s1"],
      conditionResults: conditions,
    });
    const prepared = await core.prepare(p, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      methodUseRef: prefix.methodUseRef,
      completedStepIds: ["s1"],
    });
    assert.equal(prepared.status, "guidance");
    assert.deepEqual(
      (prepared.steps as any[]).map((s) => s.stepId),
      [...want],
    );
    output.cases.push({ scenario, steps: want, status: "passed" });
  }
  output.status = "passed";
  output.method = { id: method.id, revision: method.revision };
} catch (e) {
  output.status = "failed";
  output.error = e instanceof Error ? e.message : "unknown";
  throw e;
} finally {
  await store.close();
  await writeFile(
    ".local-validation/results/corrected-method-task-validation.json",
    JSON.stringify(output, null, 2),
  );
}
console.log(JSON.stringify(output));
