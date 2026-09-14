import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
test("Source withdrawal suppresses affected input without canceling unrelated jobs", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scope = randomUUID(),
      p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const a = await core.submitMaterial(
      p,
      { scopeId: scope, segments: [{ text: "source A", role: "user" }] },
      "a",
    );
    const b = await core.submitMaterial(
      p,
      { scopeId: scope, segments: [{ text: "source B", role: "user" }] },
      "b",
    );
    const sources = await core.listSources(p);
    const source = sources.find((s) => s.materialId === a.materialId)!;
    const receipt = await core.controlSource(p, {
      id: source.id,
      expectedRevision: 1,
      action: "withdraw",
    });
    assert.equal(receipt.previousUse, "suppressed");
    assert.equal((await core.getJob(p, a.jobId)).status, "canceled");
    assert.equal((await core.getJob(p, b.jobId)).status, "queued");
    const cleanup = (await core.inspect(
      p,
      "source_cleanup",
      receipt.cleanupId,
    )) as unknown as { status: string; copyManifest: { documents: unknown[] } };
    assert.equal(cleanup.status, "suppressed");
    assert.equal(cleanup.copyManifest.documents.length, 1);
    await core.submitMaterial(
      p,
      { scopeId: scope, segments: [{ text: "source C", role: "user" }] },
      "c",
    );
  } finally {
    await store.close();
  }
});
