import test from "node:test";
import assert from "node:assert/strict";
import { apiServer } from "../src/core/server.js";
import { CoreService } from "../src/core/service.js";
import type { ProductStore, Transaction } from "../src/store/postgres.js";
import type { HindsightEngine } from "../src/adapters/hindsight/engine.js";

test("Review API preserves permission, missing resource and disabled feature errors", async () => {
  const tx = { get: async () => undefined } as unknown as Transaction;
  const store = {
    transaction: async <T>(read: (tx: Transaction) => Promise<T>) => read(tx),
  } as ProductStore;
  const core = new CoreService(store, {} as HindsightEngine);
  const user = { id: "user", channel: "user" as const, scopes: ["scope"] };
  const token = "u".repeat(32),
    agentToken = "a".repeat(32);
  const server = apiServer(core, [
    { token, principal: user },
    {
      token: agentToken,
      principal: { ...user, id: "agent", channel: "agent" },
    },
  ]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const rpc = async (
      operation: string,
      input: unknown,
      credential = token,
    ) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operation, input }),
      });
      return { status: response.status, ...(await response.json()) };
    };
    assert.deepEqual(
      await rpc("reviews.dismiss", { id: "missing" }, agentToken),
      { status: 403, error: "user_operation_required" },
    );
    assert.deepEqual(await rpc("reviews.dismiss", { id: "missing" }), {
      status: 404,
      error: "not_found",
    });
    assert.deepEqual(
      await rpc("reviews.configure", {
        scopeId: "other",
        expectedRevision: 0,
        days: 7,
      }),
      { status: 404, error: "not_found" },
    );
    assert.deepEqual(
      await rpc("reviews.issue", {
        scopeId: "scope",
        problemKey: "problem",
        expectedRevision: 0,
        category: "incorrect_guidance",
        status: "suspected",
        severity: "normal",
        evidence: [{ caseId: "case", revision: 1 }],
      }),
      { status: 409, error: "review_disabled" },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
