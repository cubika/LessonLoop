import { readFile, writeFile } from "node:fs/promises";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { type Playbook } from "../src/domain/schema.js";
import { playbookPaths } from "../src/domain/playbook-paths.js";
const reportFile = process.argv[2];
if (!reportFile) throw new Error("Pass a synthetic evolution report path");
const prior = JSON.parse(await readFile(reportFile, "utf8"));
if (prior.classification !== "real_provider_executed_synthetic_fixture")
  throw new Error("synthetic_fixture_required");
const secret = JSON.parse(
  await readFile(".local-validation/data/development-secret.json", "utf8"),
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
  ),
  p = {
    id: "synthetic-playbook-review",
    channel: "user" as const,
    scopes: [prior.scope],
  };
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  classification: "manual_correction_of_real_generated_playbook",
  scope: prior.scope,
};
try {
  const playbook = (await core.inspect(
    p,
    "playbook",
    prior.before.id,
  )) as Playbook;
  result.before = playbook;
  result.detectedPaths = playbookPaths(playbook);
  const feedback = await core.feedback(p, {
    target: { kind: "playbook", id: playbook.id, revision: playbook.revision },
    rating: "incorrect",
    correctionText:
      "The version 2 branch falls through s4 into version 1 steps s5/s6, and an extension-only global condition prevents the previous field-edit task. End the version 2 branch explicitly and preserve generated-field applicability.",
  });
  result.feedback = feedback;
  const held = (await core.inspect(p, "playbook", playbook.id)) as Playbook;
  const steps: Playbook["steps"] = [
    {
      stepId: "s1",
      instruction:
        "Inspect the fixture pipeline version and whether the requested change is to schema-owned fields or to client-local extensions.",
      supportIndexes: [0, 5, 6],
      choices: [
        {
          when: {
            text: "The requested change is to schema-owned fields under the observed version 1 or version 2 pipeline.",
          },
          next: "s2",
        },
        {
          when: {
            text: "The requested change is to client-local extensions and the observed version 2 pipeline preserves its extensions array.",
          },
          next: "s4",
        },
        {
          when: {
            text: "The requested change is to client-local extensions and the observed version 1 pipeline copies the complete schema to client.json.",
          },
          next: "stop",
        },
      ],
    },
    {
      stepId: "s2",
      instruction:
        "Change the expected generated fields in schema.json and rerun the corresponding observed fixture pipeline.",
      supportIndexes: [3, 5, 6],
    },
    {
      stepId: "s3",
      instruction:
        "Read client.json from disk and use Node deepEqual to compare its fields with the expected schema-owned field list.",
      supportIndexes: [4, 5, 6],
      choices: [
        {
          when: {
            text: "The requested change is to schema-owned fields under the observed version 1 or version 2 pipeline.",
          },
          next: "stop",
        },
      ],
    },
    {
      stepId: "s4",
      instruction:
        "For the local auditTag addition under version 2, add auditTag to the existing client.json extensions array and rerun version 2 regeneration.",
      supportIndexes: [0, 2, 3],
    },
    {
      stepId: "s5",
      instruction:
        "Read client.json from disk and use Node deepEqual to check fields id and customerId and extensions containing auditTag.",
      supportIndexes: [2, 4],
    },
  ];
  const conditions = [
    {
      text: "The pipeline matches the observed version 1 schema-copying behavior or version 2 field regeneration with extension preservation.",
    },
    {
      text: "The requested change is to schema-owned fields or to the observed client-local auditTag extension.",
    },
  ];
  const completionChecks = [
    {
      text: "The pipeline behavior and target part of the contract are established.",
      stepIds: ["s1"],
    },
    {
      text: "The regenerated fields equal the expected schema-owned list read from disk.",
      stepIds: ["s3"],
    },
    {
      text: "Version 2 preserves fields id and customerId and the auditTag extension after regeneration.",
      stepIds: ["s5"],
    },
  ];
  const stopConditions = [
    {
      text: "If the pipeline behavior or target part is unknown, stop and inspect before choosing a path.",
      stepIds: ["s1"],
    },
    {
      text: "For a version 1 extension-only request, stop: the observed full copy does not preserve direct extensions and no supported persistent extension procedure is available.",
      stepIds: ["s1"],
    },
  ];
  const receipt = await core.revise(p, held.id, held.revision, {
    conditions,
    steps,
    completionChecks,
    stopConditions,
    change: {
      ...held.change,
      kind: "correction",
      summary:
        "Terminate the version 2 branch explicitly and keep both field changes and local extensions in scope.",
    },
  });
  result.receipt = receipt;
  const deadline = Date.now() + 8 * 60000;
  while (Date.now() < deadline) {
    await core.tick([prior.scope]);
    const review = (await core.inspect(
      p,
      "revision_review",
      receipt.reviewId,
    )) as any;
    result.review = review;
    if (["completed", "failed"].includes(review.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await core.syncProjections([prior.scope]);
  const after = (await core.inspect(p, "playbook", held.id)) as Playbook;
  result.after = after;
  result.paths = playbookPaths(after);
  result.status =
    (result.review as any).status === "completed" && after.state === "active"
      ? "corrected_requires_task_validation"
      : "failed";
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    ".local-validation/results/playbook-path-correction.json",
    JSON.stringify(result, null, 2),
  );
}
console.log(JSON.stringify({ status: result.status, error: result.error }));
process.exitCode = result.status === "failed" ? 1 : 0;
