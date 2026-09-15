import { methodPaths } from "../src/domain/method-paths.js";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { type Method } from "../src/domain/schema.js";
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
  classification: "real_generated_method_guidance_and_path_structure",
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
    const prepared = await core.prepare(p, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      viewMode: "expanded",
    });
    assert.equal(prepared.status, "guidance");
    assert.deepEqual(prepared.steps, method.steps);
    const paths = methodPaths(method);
    assert.equal(paths.truncated, false);
    assert.deepEqual(paths.paths[branch]?.steps, ["s1", ...want]);
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
