import { readFile, writeFile } from "node:fs/promises";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import type { Playbook } from "../src/domain/schema.js";
const secret = JSON.parse(
  await readFile(".local-validation/data/development-secret.json", "utf8"),
);
const prior = JSON.parse(
  await readFile(".local-validation/results/p0-playbook-path.json", "utf8"),
);
const store = new ProductStore(
  `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const user = {
  id: "revision-validation",
  channel: "user" as const,
  scopes: [prior.scope],
};
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope: prior.scope,
};
try {
  const playbook = (await core.inspect(
    user,
    "playbook",
    prior.playbooks[0].id,
  )) as Playbook;
  const steps = playbook.steps.map((s) => ({ ...s }));
  steps.at(-1)!.instruction =
    "Compare regenerated client.json fields with the expected field list using a deep equality check.";
  const receipt = await core.revise(user, playbook.id, playbook.revision, {
    steps,
  });
  report.receipt = receipt;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await core.tick([prior.scope]);
    const review = (await core.inspect(
      user,
      "revision_review",
      receipt.reviewId,
    )) as unknown as { status: string };
    if (["completed", "failed"].includes(review.status)) {
      report.review = review;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await core.syncProjections([prior.scope]);
  report.playbook = await core.inspect(user, "playbook", playbook.id);
  report.status =
    (report.review as { status?: string } | undefined)?.status ===
      "completed" && (report.playbook as Playbook).state === "active"
      ? "passed"
      : report.review
        ? "failed"
        : "timeout";
} catch (e) {
  report.status = "failed";
  report.error = e instanceof Error ? e.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    ".local-validation/results/revision-validation.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    review: (report.review as { status?: string } | undefined)?.status,
  }),
);

process.exitCode = report.status === "passed" ? 0 : 1;
