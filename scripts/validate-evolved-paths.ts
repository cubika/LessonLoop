import { methodPaths } from "../src/domain/method-paths.js";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { type Method } from "../src/domain/schema.js";
const source = JSON.parse(
  await readFile(
    ".local-validation/results/method-evolution-validation.json",
    "utf8",
  ),
);
const secret = JSON.parse(
  await readFile(".local-validation/data/development-secret.json", "utf8"),
);
const store = new ProductStore(
  `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const report: any = {
  classification: "real_automatic_method_guidance_structure",
  cases: [],
  status: "failed",
};
try {
  for (let attempt = 0; attempt < 8; attempt++)
    await core.syncProjections([source.scope]);
  const method = source.after.find(
    (m: Method) =>
      m.id === source.before.id && m.revision > source.before.revision,
  ) as Method;
  assert.ok(method, "Automatic revised method required");
  for (const [name, observation, expectedInstruction] of [
    [
      "original field path",
      "Current fixture task requests the generated customerId field. Reading pipeline configuration confirms schema.json can be edited and version 1 copies schema.json to client.json. No extension is requested.",
      "schema.json",
    ],
    [
      "version 2 extension",
      "Current fixture task requests auditTag as a local client extension. Reading pipeline configuration confirms version 2 assigns fields from schema.json and preserves the previous client.json extensions array. The task does not request a generated field edit or a version 1 behavior test.",
      "auditTag",
    ],
  ] as const) {
    const host = { id: name, channel: "host" as const, scopes: [source.scope] };
    const task = await core.startTask(host, source.scope);
    const guidance = await core.prepare(host, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      viewMode: "expanded",
    });
    assert.equal(guidance.status, "guidance");
    assert.deepEqual(guidance.steps, method.steps);
    assert.deepEqual(guidance.conditions, method.conditions);
    const paths = methodPaths(method);
    assert.equal(paths.truncated, false);
    assert.ok(
      paths.paths.some((path) =>
        path.steps.some((id) =>
          method.steps
            .find((s) => s.stepId === id)
            ?.instruction.includes(expectedInstruction),
        ),
      ),
      name + ": operation absent from all paths",
    );
    report.cases.push({
      name,
      scenario: observation,
      guidance,
      paths,
      status: "passed",
      limitation:
        "Structural check only; agent branch selection was not executed.",
    });
  }
  report.status = "passed";
} catch (error) {
  report.error = error instanceof Error ? error.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    ".local-validation/results/automatic-path-validation.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify({ status: report.status, error: report.error }));
process.exitCode = report.status === "passed" ? 0 : 1;
