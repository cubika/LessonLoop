import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { apiServer } from "../src/core/server.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
test("HTTP rejects unauthenticated and cross-origin requests; accepted input is readable", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  const scope = randomUUID();
  const p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
  const token = randomUUID() + randomUUID();
  const core = new CoreService(
    store,
    new HindsightEngine("http://127.0.0.1:19888", "unused-test-key"),
  );
  const server = apiServer(core, [{ token, principal: p }]);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("address missing");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (await fetch(base + "/v1/rpc", { method: "POST" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/v1/rpc", {
          method: "POST",
          headers: {
            Origin: "https://untrusted.example",
            Authorization: `Bearer ${token}`,
          },
        })
      ).status,
      403,
    );
    const rpc = async (operation: string, input: unknown) =>
      fetch(base + "/v1/rpc", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "http-1",
        },
        body: JSON.stringify({ operation, input }),
      });
    assert.equal(
      (
        await rpc("settings.update", {
          scopeId: scope,
          expectedRevision: 0,
          learning: true,
          recommendation: false,
          review: false,
          notifications: false,
        })
      ).status,
      200,
    );
    const accepted = await rpc("submitMaterial", {
      scopeId: scope,
      segments: [
        {
          text: "Integration material with a claimed tool role.",
          role: "tool",
        },
      ],
    });
    assert.equal(accepted.status, 200);
    const value = (await accepted.json()) as { result: { jobId: string } };
    const job = await rpc("getJob", { id: value.result.jobId });
    assert.equal(job.status, 200);
    assert.equal(
      (
        await rpc("settings.update", {
          scopeId: "hidden",
          expectedRevision: 0,
          learning: true,
          recommendation: false,
          review: false,
          notifications: false,
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await store.close();
  }
});
