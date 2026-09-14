import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { SampleConnector } from "../src/connectors/sample.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
test("Sample connector requires an explicit file scope and advances only after receipt", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scope = randomUUID();
    const p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
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
    const connector = new SampleConnector(core, store);
    const directory = resolve(".local-validation/connector-tests");
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, scope + ".json");
    await writeFile(
      file,
      JSON.stringify([
        {
          sourceKey: "doc-1",
          mutation: "snapshot",
          material: {
            scopeId: scope,
            segments: [{ text: "Selected sample source.", role: "external" }],
          },
        },
      ]),
    );
    const added = await connector.add(p, { scopeId: scope, file });
    assert.equal(added.connection.status, "paused");
    assert.equal(
      (await connector.sync(p, added.connection.id)).status,
      "paused",
    );
    await connector.state(p, added.connection.id, 1, "active");
    const first = await connector.sync(p, added.connection.id);
    assert.equal(first.status, "received");
    const second = await connector.sync(p, added.connection.id);
    assert.deepEqual(second.results, []);
    assert.equal((await connector.list(p))[0]!.cursor, 1);
  } finally {
    await store.close();
  }
});
