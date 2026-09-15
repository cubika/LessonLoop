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
import { digest } from "../src/domain/schema.js";
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
          source: {
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
    const inputSource = (text: string) => ({
      scopeId: scope,
      segments: [{ text, role: "external" }],
    });
    changes.push({
      sourceKey: "doc",
      mutation: "snapshot",
      source: inputSource("Version A"),
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
      source: inputSource("Version B"),
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
    // Inject failure after the new inputSource receipt, while withdrawing the old source.
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
        source: inputSource("Observed A"),
      },
      {
        sourceKey: "event-2",
        parentSourceKey: "task-1",
        mutation: "append",
        source: inputSource("Observed B"),
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
      source: inputSource("Corrected A"),
    });
    await writeFile(file, JSON.stringify(changes));
    await connector.sync(p, id);
    bindings = await connector.bindings(p, id);
    const second = bindings.find((b) => b.sourceKey === "event-2")!;
    sources = await core.listSources(p);
    assert.equal(
      sources.find((s) => s.id === second.current!.sourceIds[0])!.blocked,
      false,
    );
    const forgotten = await connector.forget(p, id, "task-1");
    assert.equal(forgotten.excludedKeys.length, 3);
    changes.push(
      {
        sourceKey: "event-3",
        parentSourceKey: "task-1",
        mutation: "append",
        source: inputSource("Late C"),
      },
      {
        sourceKey: "grandchild",
        parentSourceKey: "event-3",
        mutation: "append",
        source: inputSource("Late nested C"),
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
      source: { scopeId: scope, segments: [{ text, role: "external" }] },
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
        "source",
        a.pending!.sourceIds[0]!,
      )) as any,
      materialB = (await core.inspect(
        p,
        "source",
        b.pending!.sourceIds[0]!,
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
      (await core.listSources(p)).find((s) => s.id === materialA.id)!.blocked,
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

test("Scheduled connector sync coalesces overdue periods and respects pause across restart", async () => {
  let store = new ProductStore(url!);
  await store.open();
  const scope = randomUUID(),
    p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
  try {
    let core = new CoreService(
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
    await writeFile(
      file,
      JSON.stringify([
        {
          sourceKey: "scheduled",
          mutation: "snapshot",
          source: {
            scopeId: scope,
            segments: [{ text: "Scheduled input", role: "external" }],
          },
        },
      ]),
    );
    const added = await connector.add(p, { scopeId: scope, file });
    let connection = await connector.state(p, added.connection.id, 1, "active");
    assert.equal((await connector.tick([scope])).results.length, 0);
    connection = await connector.schedule(p, {
      id: connection.id,
      expectedRevision: connection.revision,
      intervalMinutes: 5,
    });
    const oldSchedule = connection.scheduleRevision;
    connection = await connector.schedule(p, {
      id: connection.id,
      expectedRevision: connection.revision,
      intervalMinutes: 0,
    });
    assert.equal(
      (await connector.sync(p, connection.id, oldSchedule)).status,
      "schedule_changed",
    );
    assert.equal((await core.listSources(p)).length, 0);
    connection = await connector.schedule(p, {
      id: connection.id,
      expectedRevision: connection.revision,
      intervalMinutes: 5,
    });
    const now = Date.now();
    assert.equal((await connector.tick([scope], now)).results.length, 1);
    assert.equal((await connector.tick([scope], now + 1000)).results.length, 0);
    assert.equal((await core.listSources(p)).length, 1);
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    connector = new SampleConnector(core, store);
    assert.equal(
      (await connector.tick([scope], now + 60 * 60000)).results.length,
      1,
    );
    assert.equal((await core.listSources(p)).length, 1);
    connection = (await connector.list(p))[0]!;
    await connector.state(p, connection.id, connection.revision, "paused");
    assert.equal(
      (await connector.tick([scope], now + 120 * 60000)).results.length,
      0,
    );
  } finally {
    await store.close();
  }
});

test("Connector receives complete snapshots atomically and tracks every learning part across restart", async () => {
  let store = new ProductStore(url!);
  await store.open(true);
  const scope = randomUUID();
  const p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
  try {
    let core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    let connector = new SampleConnector(core, store);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const file = resolve(".local-validation/connector-tests", scope + ".json");
    const inputSource = (text: string) => ({
      scopeId: scope,
      segments: [{ text, role: "external" }],
    });
    const changes: any[] = [
      {
        sourceKey: "document",
        parentSourceKey: "collection",
        mutation: "snapshot",
        source: inputSource("Original snapshot"),
      },
    ];
    await writeFile(file, JSON.stringify(changes));
    const added = await connector.add(p, { scopeId: scope, file });
    await connector.state(p, added.connection.id, 1, "active");
    await connector.sync(p, added.connection.id);
    const initial = (await connector.bindings(p, added.connection.id))[0]!;
    const setJobStatus = (id: string, status: string) =>
      store.transaction(async (tx) => {
        const job = await tx.get<any>("job", id);
        await tx.put(
          {
            kind: "job",
            id,
            scopeId: scope,
            revision: job.revision + 1,
            value: { ...job, revision: job.revision + 1, status },
          },
          job.revision,
        );
      });
    await setJobStatus(initial.pending!.jobId, "completed");
    changes.push({
      sourceKey: "document",
      parentSourceKey: "collection",
      mutation: "snapshot",
      complete: false,
      partKeys: ["intro", "body"],
      parts: [{ partKey: "intro", source: inputSource("New introduction") }],
    });
    await writeFile(file, JSON.stringify(changes));
    await assert.rejects(
      connector.sync(p, added.connection.id),
      /source_parts_incomplete/,
    );
    assert.equal((await connector.list(p))[0]!.cursor, 1);
    assert.equal(
      (await core.listSources(p)).filter((source) => !source.blocked).length,
      1,
    );
    changes[1].complete = true;
    changes[1].parts.push({
      partKey: "body",
      source: inputSource("New full body"),
    });
    await writeFile(file, JSON.stringify(changes));
    const submit = core.submitSource.bind(core);
    let count = 0;
    core.submitSource = async (...args) => {
      if (++count === 2) throw new Error("interrupted second part receipt");
      return submit(...args);
    };
    await assert.rejects(
      connector.sync(p, added.connection.id),
      /interrupted second part/,
    );
    assert.equal((await connector.list(p))[0]!.cursor, 1);
    assert.equal((await core.listSources(p)).length, 1);
    assert.equal((await core.listSources(p))[0]!.blocked, false);
    core.submitSource = submit;
    const accepted = (await connector.sync(p, added.connection.id))
      .results![0]!;
    assert.deepEqual(accepted.partKeys, ["intro", "body"]);
    assert.equal(accepted.jobIds!.length, 2);
    let binding = (await connector.bindings(p, added.connection.id))[0]!;
    assert.equal(binding.pending!.parts.length, 2);
    assert.equal(binding.current, undefined);
    assert.equal(binding.sourceRevision, 2);
    await store.transaction(async (tx) => {
      const parts = await Promise.all(
        binding.pending!.parts.map((part) =>
          tx.get<any>("source", part.sourceIds[0]!),
        ),
      );
      assert.equal(new Set(parts.map((part) => part.sourceFamily)).size, 1);
      assert.equal(new Set(parts.map((part) => part.sourceIdentity)).size, 2);
      assert.equal(
        parts[0].sourceFamily,
        digest([scope, `${added.connection.id}:collection`]),
      );
    });
    assert.equal(
      (await core.listSources(p)).filter((source) => source.blocked).length,
      1,
    );
    await setJobStatus(binding.pending!.parts[0]!.jobId, "completed");
    binding = (await connector.bindings(p, added.connection.id))[0]!;
    assert.equal(binding.learningStatus, "pending");
    assert.equal(binding.current, undefined);
    await store.close();
    store = new ProductStore(url!);
    await store.open();
    core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    connector = new SampleConnector(core, store);
    assert.equal((await connector.list(p))[0]!.cursor, 2);
    await setJobStatus(binding.pending!.parts[1]!.jobId, "failed");
    binding = (await connector.bindings(p, added.connection.id))[0]!;
    assert.equal(binding.learningStatus, "failed");
    assert.equal(binding.current, undefined);
    assert.equal(binding.pending, undefined);
    const completedJob = binding.received!.parts[0]!.jobId;
    const retry = await connector.retry(p, binding.id, "retry-failed-parts");
    assert.equal(retry.jobIds.length, 1);
    assert.deepEqual(
      (await connector.retry(p, binding.id, "retry-failed-parts")).jobIds,
      retry.jobIds,
    );
    binding = (await connector.bindings(p, added.connection.id))[0]!;
    assert.equal(binding.pending!.parts[0]!.jobId, completedJob);
    assert.equal(binding.sourceRevision, 2);
    await setJobStatus(retry.jobId, "completed");
    binding = (await connector.bindings(p, added.connection.id))[0]!;
    assert.equal(binding.learningStatus, "completed");
    assert.equal(binding.current!.parts.length, 2);
    changes.push({ ...changes[1], sourceVersion: "different-opaque-version" });
    await writeFile(file, JSON.stringify(changes));
    assert.equal(
      (await connector.sync(p, added.connection.id)).results![0]!.status,
      "unchanged",
    );
    assert.equal((await core.listSources(p)).length, 3);
    await connector.forget(p, added.connection.id, "collection");
    assert.equal(
      (await core.listSources(p)).every((source) => source.excluded),
      true,
    );
  } finally {
    await store.close();
  }
});

test("Connector draft inputs enter inputSource learning without creating trusted product records", async () => {
  const store = new ProductStore(url!);
  await store.open(true);
  try {
    const scope = randomUUID();
    const p = { id: randomUUID(), channel: "user" as const, scopes: [scope] };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    const connector = new SampleConnector(core, store);
    await core.configure(p, {
      scopeId: scope,
      expectedRevision: 0,
      learning: true,
      recommendation: false,
      review: false,
      notifications: false,
    });
    const evidence = [
      {
        text: "Build completed with exit code 0.",
        role: "tool",
        author: "Selected source",
        locator: "build.log:42",
      },
    ];
    const inputs = [
      {
        kind: "source",
        scopeId: scope,
        goal: "Build the project",
        unresolved: ["Deployment not checked"],
        evidence,
      },
      {
        kind: "experience_draft",
        scopeId: scope,
        conclusion: "The build command succeeded",
        conditions: ["Local environment"],
        evidence,
      },
      {
        kind: "playbook_draft",
        scopeId: scope,
        title: "Build verification",
        goal: "Check the project build",
        steps: [
          {
            stepId: "build",
            instruction: "Run the build",
            evidenceIndexes: [0],
          },
        ],
        completionChecks: ["Exit code is 0"],
        evidence,
      },
    ];
    const file = resolve(".local-validation/connector-tests", scope + ".json");
    await writeFile(
      file,
      JSON.stringify(
        inputs.map((input) => ({
          sourceKey: input.kind,
          mutation: "snapshot",
          input,
        })),
      ),
    );
    const added = await connector.add(p, { scopeId: scope, file });
    assert.equal(added.preview.sourceParts, 3);
    await connector.state(p, added.connection.id, 1, "active");
    assert.equal(
      (await connector.sync(p, added.connection.id)).results!.length,
      3,
    );
    await store.transaction(async (tx) => {
      for (const kind of ["work_view", "experience", "playbook"])
        assert.deepEqual(await tx.list(kind, [scope]), []);
      const inputSources = await tx.list<any>("source", [scope]);
      assert.equal(inputSources.length, 6);
      for (const inputSource of inputSources) {
        assert.equal(
          [inputSource.segment].every(
            (segment: any) => segment.role === "external",
          ),
          true,
        );
        assert.equal(inputSource.taskRef, undefined);
      }
      const quoted = inputSources.filter(
        (s) => s.segment.text === evidence[0]!.text,
      );
      assert.equal(quoted.length, 3);
      for (const source of quoted) {
        assert.equal(source.segment.locator, evidence[0]!.locator);
        assert.equal(source.segment.author, evidence[0]!.author);
      }
    });
  } finally {
    await store.close();
  }
});
