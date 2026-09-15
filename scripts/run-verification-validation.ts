import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { experienceSchema } from "../src/domain/experience.js";
import { identity } from "../src/domain/schema.js";
const root = resolve(".local-validation"),
  scope = "verification-" + randomUUID(),
  dir = resolve(root, scope);
await mkdir(dir, { recursive: true });
await writeFile(
  resolve(dir, "schema.json"),
  JSON.stringify({ fields: ["id"] }),
);
await writeFile(
  resolve(dir, "client.json"),
  JSON.stringify({ fields: ["old"], extensions: ["auditTag"] }),
);
const original = JSON.parse(
  await readFile(resolve(dir, "client.json"), "utf8"),
);
const schema = JSON.parse(await readFile(resolve(dir, "schema.json"), "utf8"));
await writeFile(
  resolve(dir, "client.json"),
  JSON.stringify({ fields: schema.fields, extensions: original.extensions }),
);
const result = JSON.parse(await readFile(resolve(dir, "client.json"), "utf8"));
assert.deepEqual(result, { fields: ["id"], extensions: ["auditTag"] });
const s = JSON.parse(
  await readFile(resolve(root, "data/development-secret.json"), "utf8"),
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
  host = { id: scope, channel: "host" as const, scopes: [scope] },
  user = { ...host, channel: "user" as const };
const report: Record<string, unknown> = {
  scope,
  startedAt: new Date().toISOString(),
  classification:
    "real_provider_targeted_verification_authored_held_claim_executed_evidence",
};
try {
  await core.configure(user, {
    scopeId: scope,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: false,
    notifications: false,
  });
  const initial = await core.submitSource(
    host,
    {
      scopeId: scope,
      segments: [
        {
          text: "A preliminary report suggests the version 2 fixture pipeline preserves an existing client.json extensions array; no output check has been recorded yet.",
          role: "external",
        },
      ],
    },
    "hypothesis",
  );
  await core.cancelJob(user, initial.jobId);
  const source = (await core.listSources(user))[0]!;
  const claim = experienceSchema.parse({
    ...identity(scope),
    conclusion:
      "The version 2 fixture pipeline preserves an existing auditTag extension in client.json after regeneration.",
    level: "L1",
    purpose: "fact",
    applicability: "conditional",
    conditions: [
      {
        text: "The observed version 2 fixture pipeline assigns fields from schema.json and preserves client.json extensions.",
      },
    ],
    exceptions: [],
    topics: ["fixture pipeline"],
    entities: ["auditTag", "client.json"],
    basis: "reported",
    assessment: "hypothesis",
    evidence: [
      {
        excerpt:
          "A preliminary report suggests the version 2 fixture pipeline preserves an existing client.json extensions array",
        role: "external",
        relation: "supports",
        fingerprint: source.id,
      },
    ],
    derivedFrom: [],
    sourceFingerprints: [source.id],
    state: "held",
    review: {
      reason: "verification_requested",
      question:
        "Check actual regenerated client.json from disk for the auditTag extension.",
      reviewBy: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  await store.transaction((tx) =>
    tx.put(
      {
        kind: "experience",
        id: claim.id,
        scopeId: scope,
        revision: 1,
        value: claim,
      },
      null,
    ),
  );
  report.before = claim;
  const receipt = await core.submitSource(
    host,
    {
      scopeId: scope,
      verificationFor: { kind: "experience", id: claim.id, revision: 1 },
      segments: [
        {
          role: "tool",
          locator: "synthetic-targeted-verification",
          text:
            "Executed the version 2 fixture: read schema.json fields and existing client.json extensions, wrote a regenerated client.json with those fields and extensions, then read it back. Node deepEqual confirmed " +
            JSON.stringify(result) +
            ". The auditTag extension was present before and after regeneration.",
        },
      ],
    },
    "verified-output",
  );
  report.receipt = receipt;
  const deadline = Date.now() + 12 * 60000;
  let previous = "";
  while (Date.now() < deadline) {
    await core.tick([scope]);
    const job = await core.getJob(host, receipt.jobId);
    report.job = job;
    const status = job.stage + ":" + job.status;
    if (status !== previous) {
      console.log(status);
      previous = status;
    }
    if (["completed", "failed", "canceled"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await core.syncProjections([scope]);
  const after = (await core.inspect(host, "experience", claim.id)) as any;
  report.after = after;
  report.job = await core.getJob(host, receipt.jobId);
  report.recall = await core.recallRequest(host, {
    query: "auditTag",
    target: { id: claim.id, revision: after.revision },
  });
  report.status =
    after.revision === 2 &&
    after.state === "active" &&
    (report.recall as any).results.some(
      (r: any) => r.experience.id === claim.id,
    ) &&
    (report.job as any).receipt.replacement.status === "effective"
      ? "passed"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.error = e instanceof Error ? e.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    resolve(root, "results/targeted-verification.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify({ status: report.status, error: report.error }));
process.exitCode = report.status === "passed" ? 0 : 1;
