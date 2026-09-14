import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";

const root = resolve(".local-validation");
const secret = JSON.parse(
  await readFile(resolve(root, "data/development-secret.json"), "utf8"),
);
const fixture = resolve(root, "p0-actual-work");
await mkdir(fixture, { recursive: true });
const source = resolve(fixture, "schema.json"),
  generated = resolve(fixture, "client.json");
await writeFile(source, JSON.stringify({ fields: ["id"] }));
await writeFile(generated, await readFile(source));
await writeFile(generated, JSON.stringify({ fields: ["id", "customerId"] }));
await writeFile(generated, await readFile(source));
const failed = JSON.parse(await readFile(generated, "utf8"));
assert.deepEqual(failed.fields, ["id"]);
await writeFile(source, JSON.stringify({ fields: ["id", "customerId"] }));
await writeFile(generated, await readFile(source));
const passed = JSON.parse(await readFile(generated, "utf8"));
assert.deepEqual(passed.fields, ["id", "customerId"]);
const scope = `p0-${randomUUID()}`;
const host = { id: scope, channel: "host" as const, scopes: [scope] };
const user = { ...host, channel: "user" as const };
const store = new ProductStore(
  `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open(true);
const engine = new HindsightEngine(
  "http://127.0.0.1:19888",
  secret.engineToken,
);
const core = new CoreService(store, engine);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope,
  classification: "real_engine_with_authored_executed_workspace_case",
  profile: {
    engine: "0.9.2",
    provider: "github-copilot",
    model: "gpt-5.5",
    embedding: "multilingual-e5-small",
    reranker: "rrf",
  },
  stages: [],
};
try {
  report.engineVersion = await engine.health();
  await core.configure(user, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const receipt = await core.submitMaterial(
    host,
    {
      scopeId: scope,
      segments: [
        {
          role: "user",
          text: "Add customerId to the generated client contract and verify that regeneration preserves it.",
        },
        {
          role: "tool",
          text: `The fixture pipeline copies schema.json to client.json. Directly adding customerId to client.json then running the pipeline produced ${JSON.stringify(failed)}. Adding customerId to schema.json then running the same pipeline produced ${JSON.stringify(passed)}. Node deepEqual checks confirmed both results.`,
          locator: "p0-actual-work",
        },
      ],
    },
    "case-1",
    "generated-fixture-task-1",
  );
  report.receipt = receipt;
  let previous = "";
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await core.tick([scope]);
    const job = await core.getJob(host, receipt.jobId);
    const state = `${job.stage}:${job.status}`;
    if (state !== previous) {
      console.log(state);
      (report.stages as unknown[]).push({
        at: new Date().toISOString(),
        state,
      });
      previous = state;
      await writeFile(
        resolve(root, "results/p0-method-path.json"),
        JSON.stringify(report, null, 2),
      );
    }
    if (["completed", "failed", "canceled"].includes(job.status)) {
      report.job = job;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await core.syncProjections();
  const methods = await core.browse(host, "method");
  report.methods = methods;
  report.experiences = await core.browse(host, "experience");
  if (methods.length) {
    const m = methods[0]!;
    const task = await core.startTask(host, scope);
    report.prepared = await core.prepare(host, {
      methodId: m.id,
      revision: m.revision,
      taskRef: task.taskRef,
    });
  }
  report.runStatus = report.job ? "completed" : "timeout";
  report.gateStatus = methods.length ? "partial_evidence" : "failed";
} catch (e) {
  report.runStatus = "failed";
  report.gateStatus = "failed";
  report.error = e instanceof Error ? e.message : "unknown";
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(root, "results/p0-method-path.json"),
    JSON.stringify(report, null, 2),
  );
  await store.close();
}
console.log(
  JSON.stringify({
    runStatus: report.runStatus,
    gateStatus: report.gateStatus,
    methods: (report.methods as unknown[] | undefined)?.length ?? 0,
  }),
);
