import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import type { Method } from "../src/domain/schema.js";
const root = ".local-validation/",
  prior = JSON.parse(
    await readFile(root + "results/method-evolution-validation.json", "utf8"),
  );
if (prior.classification !== "real_provider_executed_synthetic_fixture")
  throw new Error("synthetic_fixture_required");
const secret = JSON.parse(
  await readFile(root + "data/development-secret.json", "utf8"),
);
const store = new ProductStore(
  "postgresql://lessonloop:" +
    encodeURIComponent(secret.password) +
    "@127.0.0.1:19432/postgres",
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const p = {
  id: "evolution-resume",
  channel: "user" as const,
  scopes: [prior.scope],
};
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope: prior.scope,
  classification: prior.classification,
  before: prior.before,
  fixture: prior.fixture,
  previousJobId: prior.receipt.jobId,
};
const path = root + "results/method-evolution-resume-" + Date.now() + ".json";
try {
  await core.tick([prior.scope]);
  const original = await core.getJob(p, prior.receipt.jobId);
  if (!["failed", "canceled"].includes(original.status))
    throw new Error("original_operation_not_terminal");
  const retry = await core.retryJob(p, original.id, randomUUID());
  report.receipt = retry;
  const deadline = Date.now() + 15 * 60000;
  let last = "";
  while (Date.now() < deadline) {
    await core.tick([prior.scope]);
    const job = await core.getJob(p, retry.jobId);
    const state = job.stage + ":" + job.status;
    report.job = job;
    if (state !== last) {
      console.log(state);
      last = state;
      await writeFile(path, JSON.stringify(report, null, 2));
    }
    if (["completed", "failed", "canceled"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await core.syncProjections([prior.scope]);
  report.after = await core.browse(p, "method");
  report.experiences = await core.browse(p, "experience");
  const methods = report.after as Method[];
  report.status =
    methods.some(
      (m) => m.id === prior.before.id && m.revision > prior.before.revision,
    ) ||
    methods.some((m) =>
      m.change.predecessors.some((r) => r.id === prior.before.id),
    )
      ? "evolution_produced_requires_semantic_review"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.error = e instanceof Error ? e.message : "unknown";
} finally {
  await writeFile(path, JSON.stringify(report, null, 2));
  await store.close();
}
console.log(
  JSON.stringify({ status: report.status, error: report.error, report: path }),
);
process.exitCode = report.status === "failed" ? 1 : 0;
