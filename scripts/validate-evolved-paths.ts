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
  classification: "real_automatic_method_current_task_checks",
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
    const first = await core.prepare(host, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
    });
    await core.recordHostObservation(host, {
      taskRef: task.taskRef,
      eventId: "inspection",
      text: observation,
    });
    const checked = await core.reassessTask(host, {
      taskRef: task.taskRef,
      methodId: method.id,
      revision: method.revision,
      methodUseRef: first.methodUseRef,
    });
    const prefix = await core.prepare(host, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      methodUseRef: first.methodUseRef,
    });
    assert.equal(prefix.status, "guidance", `${name}: global scope excluded`);
    const step = (prefix.steps as any[])[0];
    assert.ok(step);
    await core.recordHostObservation(host, {
      taskRef: task.taskRef,
      eventId: "selection",
      text:
        observation +
        " The branch selection inspection is complete. Selected " +
        name +
        " based on the inspected pipeline and requested change.",
    });
    const nextCheck = await core.reassessTask(host, {
      taskRef: task.taskRef,
      methodId: method.id,
      revision: method.revision,
      methodUseRef: first.methodUseRef,
    });
    const next = await core.prepare(host, {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      methodUseRef: first.methodUseRef,
      completedStepIds: (nextCheck as any).completedStepIds ?? [],
    });
    assert.equal(next.status, "guidance");
    assert.ok(
      JSON.stringify(next.steps).includes(expectedInstruction),
      `${name}: intended operation unreachable`,
    );
    report.cases.push({
      name,
      checked,
      prefix,
      nextCheck,
      next,
      status: "passed",
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
