import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { SampleConnector } from "../src/connectors/sample.js";
import { dispatch } from "../src/core/server.js";
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
test("Connector replacement is atomic, corrections stay targeted, and parent forget blocks descendants", async () => {
  const store = new ProductStore(url!);
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
    const file = resolve(".local-validation/connector-tests", scope + ".json");
    const changes: any[] = [];
    const material = (text: string) => ({
      scopeId: scope,
      segments: [{ text, role: "external" }],
    });
    changes.push({
      sourceKey: "doc",
      mutation: "snapshot",
      material: material("Version A"),
    });
    await writeFile(file, JSON.stringify(changes));
    const added = (await dispatch(
      core,
      p,
      "connector.add",
      { scopeId: scope, file },
      "",
    )) as any;
    const id = added.connection.id,
      connector = new SampleConnector(core, store);
    await connector.state(p, id, 1, "active");
    await connector.sync(p, id);
    changes.push({
      sourceKey: "doc",
      mutation: "snapshot",
      material: material("Version B"),
    });
    await writeFile(file, JSON.stringify(changes));
    assert.equal(
      (await connector.sync(p, id)).results?.[0]?.status,
      "pending_learning",
    );
    const finish = async () =>
      store.transaction(async (tx) => {
        for (const job of await tx.list<any>("job", [scope]))
          if (["queued", "running"].includes(job.status))
            await tx.put(
              {
                kind: "job",
                id: job.id,
                scopeId: scope,
                revision: job.revision + 1,
                value: {
                  ...job,
                  revision: job.revision + 1,
                  status: "completed",
                  stage: "done",
                },
              },
              job.revision,
            );
      });
    await finish();
    // Inject failure after the new material receipt, while withdrawing the old source.
    const control = core.controlSource.bind(core);
    core.controlSource = async () => {
      throw new Error("simulated receipt transaction failure");
    };
    await assert.rejects(connector.sync(p, id), /simulated receipt/);
    assert.equal((await core.listSources(p)).length, 1);
    assert.equal((await connector.list(p))[0]!.cursor, 1);
    core.controlSource = control;
    await connector.sync(p, id);
    let bindings = await connector.bindings(p, id);
    assert.equal(bindings[0]!.sourceRevision, 2);
    let sources = await core.listSources(p);
    assert.equal(sources.filter((s) => s.blocked).length, 1);
    await finish();
    changes.push(
      {
        sourceKey: "event-1",
        parentSourceKey: "task-1",
        mutation: "append",
        material: material("Observed A"),
      },
      {
        sourceKey: "event-2",
        parentSourceKey: "task-1",
        mutation: "append",
        material: material("Observed B"),
      },
    );
    await writeFile(file, JSON.stringify(changes));
    await connector.sync(p, id);
    await finish();
    bindings = await connector.bindings(p, id);
    const first = bindings.find((b) => b.sourceKey === "event-1")!;
    changes.push({
      sourceKey: "event-1",
      parentSourceKey: "task-1",
      mutation: "correct",
      correctsRef: { bindingId: first.id, sourceRevision: 1 },
      material: material("Corrected A"),
    });
    await writeFile(file, JSON.stringify(changes));
    await connector.sync(p, id);
    bindings = await connector.bindings(p, id);
    const second = bindings.find((b) => b.sourceKey === "event-2")!;
    sources = await core.listSources(p);
    assert.equal(
      sources.find((s) => s.materialId === second.current!.materialId)!.blocked,
      false,
    );
    const forgotten = await connector.forget(p, id, "task-1");
    assert.equal(forgotten.excludedKeys.length, 3);
    changes.push(
      {
        sourceKey: "event-3",
        parentSourceKey: "task-1",
        mutation: "append",
        material: material("Late C"),
      },
      {
        sourceKey: "grandchild",
        parentSourceKey: "event-3",
        mutation: "append",
        material: material("Late nested C"),
      },
    );
    await writeFile(file, JSON.stringify(changes));
    assert.deepEqual(
      (await connector.sync(p, id)).results?.map((r) => r.status),
      ["ignored", "ignored"],
    );
    const count = (await core.listSources(p)).length;
    assert.deepEqual((await connector.sync(p, id)).results, []);
    assert.equal((await core.listSources(p)).length, count);
    const connection = (await connector.list(p))[0]!;
    await connector.state(p, id, connection.revision, "removed");
    assert.equal((await connector.sync(p, id)).status, "removed");
    await assert.rejects(
      dispatch(
        core,
        { ...p, channel: "agent" },
        "connector.forget",
        { id, sourceKey: "doc" },
        "",
      ),
      /user_operation_required/,
    );
  } finally {
    await store.close();
  }
});
test("Connector keeps stable families, ignores version-only changes, retries received data, and withdraws pending work", async () => {
  const store = new ProductStore(url!);
  await store.open(true);
  try {
    const scope = randomUUID(),
      p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
    const core = new CoreService(
        store,
        new HindsightEngine("http://127.0.0.1:19888", "unused"),
      ),
      connector = new SampleConnector(core, store);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const file = resolve(".local-validation/connector-tests", scope + ".json");
    const changes: any[] = [];
    const event = (key: string, parent: string, text: string) => ({
      sourceKey: key,
      parentSourceKey: parent,
      mutation: "append",
      material: { scopeId: scope, segments: [{ text, role: "external" }] },
    });
    changes.push(
      event("A", "task", "Same task A"),
      event("B", "task", "Same task B"),
    );
    await writeFile(file, JSON.stringify(changes));
    const added = await connector.add(p, { scopeId: scope, file }),
      id = added.connection.id;
    await connector.state(p, id, 1, "active");
    await connector.sync(p, id);
    let bindings = await connector.bindings(p, id);
    const a = bindings.find((b) => b.sourceKey === "A")!,
      b = bindings.find((b) => b.sourceKey === "B")!;
    const materialA = (await core.inspect(
        p,
        "material",
        a.pending!.materialId,
      )) as any,
      materialB = (await core.inspect(
        p,
        "material",
        b.pending!.materialId,
      )) as any;
    assert.equal(materialA.sourceFamily, materialB.sourceFamily);
    assert.notEqual(materialA.sourceIdentity, materialB.sourceIdentity);
    changes.push({ ...changes[0], sourceVersion: "opaque-new-version" });
    await writeFile(file, JSON.stringify(changes));
    assert.equal(
      (await connector.sync(p, id)).results?.[0]?.status,
      "unchanged",
    );
    await store.transaction(async (tx) => {
      const job = await tx.get<any>("job", a.pending!.jobId);
      await tx.put(
        {
          kind: "job",
          id: job.id,
          scopeId: scope,
          revision: job.revision + 1,
          value: { ...job, revision: job.revision + 1, status: "failed" },
        },
        job.revision,
      );
    });
    bindings = await connector.bindings(p, id);
    assert.equal(bindings.find((v) => v.id === a.id)!.learningStatus, "failed");
    const retry = await connector.retry(p, a.id, "retry-1"),
      duplicate = await connector.retry(p, a.id, "retry-1");
    assert.equal(retry.jobId, duplicate.jobId);
    assert.equal((await core.listSources(p)).length, 2);
    assert.equal(
      (await connector.bindings(p, id)).find((v) => v.id === a.id)!
        .sourceRevision,
      1,
    );
    changes.push({
      sourceKey: "A",
      parentSourceKey: "task",
      mutation: "withdraw",
    });
    await writeFile(file, JSON.stringify(changes));
    assert.equal(
      (await connector.sync(p, id)).results?.[0]?.status,
      "accepted",
    );
    assert.equal(
      (await core.listSources(p)).find((s) => s.materialId === materialA.id)!
        .blocked,
      true,
    );
    assert.equal((await core.getJob(p, retry.jobId)).status, "canceled");
    changes.push({
      ...event("B", "task", "Unauthorized replacement"),
      mutation: "snapshot",
    });
    await writeFile(file, JSON.stringify(changes));
    // End B to reach mutation validation instead of the learning backpressure gate.
    await core.cancelJob(p, b.pending!.jobId);
    await assert.rejects(
      connector.sync(p, id),
      /event_requires_targeted_correction/,
    );
    changes.pop();
    await writeFile(file, JSON.stringify(changes));
    await connector.forget(p, id, "forgotten-parent");
    changes.push(
      event("grandchild-first", "child-later", "Must not be accepted"),
      event("child-later", "forgotten-parent", "Must also be ignored"),
    );
    await writeFile(file, JSON.stringify(changes));
    assert.deepEqual(
      (await connector.sync(p, id)).results?.map((r) => r.status),
      ["ignored", "ignored"],
    );
    assert.equal((await core.listSources(p)).length, 2);
  } finally {
    await store.close();
  }
});
