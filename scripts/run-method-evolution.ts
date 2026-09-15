import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { type Method, type Material } from "../src/domain/schema.js";
const root = resolve(".local-validation"),
  secret = JSON.parse(
    await readFile(resolve(root, "data/development-secret.json"), "utf8"),
  );
const base = JSON.parse(
  await readFile(resolve(root, "results/p0-method-path.json"), "utf8"),
);
assert.equal(
  base.classification,
  "real_engine_with_authored_executed_workspace_case",
);
const folder = resolve(root, "method-evolution-" + Date.now());
await mkdir(folder, { recursive: true });
const schema = resolve(folder, "schema.json"),
  client = resolve(folder, "client.json");
await writeFile(schema, JSON.stringify({ fields: ["id", "customerId"] }));
const regenerate = async (version: number) => {
  const source = JSON.parse(await readFile(schema, "utf8"));
  const previous = JSON.parse(await readFile(client, "utf8").catch(() => "{}"));
  const result =
    version === 1
      ? source
      : { fields: source.fields, extensions: previous.extensions ?? [] };
  await writeFile(client, JSON.stringify(result));
  return JSON.parse(await readFile(client, "utf8"));
};
await writeFile(
  client,
  JSON.stringify({ fields: ["id", "customerId"], extensions: ["auditTag"] }),
);
const v1 = await regenerate(1);
assert.equal(v1.extensions, undefined);
await writeFile(
  client,
  JSON.stringify({ fields: ["id", "customerId"], extensions: ["auditTag"] }),
);
const v2 = await regenerate(2);
assert.deepEqual(v2, {
  fields: ["id", "customerId"],
  extensions: ["auditTag"],
});
await writeFile(
  client,
  JSON.stringify({
    fields: ["id", "customerId", "temporary"],
    extensions: ["auditTag"],
  }),
);
const v2Fields = await regenerate(2);
assert.deepEqual(v2Fields.fields, ["id", "customerId"]);
assert.deepEqual(v2Fields.extensions, ["auditTag"]);
const store = new ProductStore(
  "postgresql://lessonloop:" +
    encodeURIComponent(secret.password) +
    "@127.0.0.1:19432/postgres",
);
await store.open();
const engine = new HindsightEngine(
    "http://127.0.0.1:19888",
    secret.engineToken,
  ),
  core = new CoreService(store, engine),
  host = {
    id: "evolution-validation-" + randomUUID(),
    channel: "host" as const,
    scopes: [base.scope],
  },
  owner = { ...host, channel: "user" as const };
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope: base.scope,
  classification: "real_provider_executed_synthetic_fixture",
  fixture: { v1, v2, v2Fields },
  profile: "methods-2",
};
try {
  const existing = await store.transaction((tx) =>
    tx.list<Material>("material", [base.scope]),
  );
  assert.equal(
    existing.length,
    1,
    "Only the original synthetic scope is allowed",
  );
  assert.equal(
    existing[0]!.sourceIdentity,
    JSON.stringify([base.scope, "generated-fixture-task-1"]),
  );
  assert.deepEqual(
    existing[0]!.segments.map((s) => s.text),
    [
      "Add customerId to the generated client contract and verify that regeneration preserves it.",
      'The fixture pipeline copies schema.json to client.json. Directly adding customerId to client.json then running the pipeline produced {"fields":["id"]}. Adding customerId to schema.json then running the same pipeline produced {"fields":["id","customerId"]}. Node deepEqual checks confirmed both results.',
    ],
  );
  const original = (await core.inspect(
    host,
    "method",
    base.methods[0].id,
  )) as Method;
  report.before = original;
  const settings = (await core.getSettings(owner))[0]!;
  await core.configure(owner, {
    scopeId: base.scope,
    expectedRevision: settings.revision,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const task = await core.startTask(host, base.scope);
  const received = await core.submitMaterial(
    host,
    {
      scopeId: base.scope,
      context: { taskRef: task.taskRef },
      segments: [
        {
          role: "user",
          text: "Add auditTag as a local client extension in fixture pipeline version 2 while preserving generated schema fields. Check behavior under version 1.",
        },
        {
          role: "tool",
          locator: "synthetic-method-evolution-fixture",
          text:
            "Executed synthetic fixture pipelines. Version 1 copies schema.json to client.json. Version 2 assigns fields from schema.json and preserves the previous client.json extensions array. Adding auditTag directly to client.json extensions then regenerating version 1 produced " +
            JSON.stringify(v1) +
            ". Adding auditTag directly to client.json extensions then regenerating version 2 produced " +
            JSON.stringify(v2) +
            ". Under version 2 a direct temporary addition to client.json fields was removed while the extension remained: " +
            JSON.stringify(v2Fields) +
            ". Node deepEqual checks confirmed these values read from disk.",
        },
      ],
    },
    "version-2-fixture",
  );
  report.receipt = received;
  const deadline = Date.now() + 15 * 60000;
  let previous = "";
  while (Date.now() < deadline) {
    await core.tick([base.scope]);
    const job = await core.getJob(host, received.jobId),
      state = job.stage + ":" + job.status;
    if (state !== previous) {
      console.log(state);
      previous = state;
    }
    if (["completed", "failed", "canceled"].includes(job.status)) {
      report.job = job;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  for (let attempt = 0; attempt < 8; attempt++)
    await core.syncProjections([base.scope]);
  report.after = await core.browse(host, "method");
  report.experiences = await core.browse(host, "experience");
  const after = report.after as Method[];
  report.status =
    after.some((m) => m.id === original.id && m.revision > original.revision) ||
    after.some((m) => m.change.predecessors.some((p) => p.id === original.id))
      ? "evolution_produced_requires_semantic_review"
      : "failed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    resolve(root, "results/method-evolution-validation.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify({ status: report.status, error: report.error }));
process.exitCode = report.status === "failed" ? 1 : 0;
