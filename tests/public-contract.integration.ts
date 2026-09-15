import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { dispatch } from "../src/core/server.js";
import {
  identity,
  workCaseSchema,
  methodSchema,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
test("Public resources preserve source identity, work provenance and playbook feedback", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  const scopeId = randomUUID();
  const user = {
    id: randomUUID(),
    channel: "user" as const,
    scopes: [scopeId],
  };
  const host = { ...user, id: randomUUID(), channel: "host" as const };
  const core = new CoreService(
    store,
    new HindsightEngine("http://127.0.0.1:19888", "unused"),
  );
  const call = (
    op: string,
    input: unknown = {},
    p = user as typeof user | typeof host,
    key = randomUUID(),
  ) => dispatch(core, p, op, input, key) as Promise<any>;
  const put = (kind: string, value: any) =>
    store.transaction((tx) =>
      tx.put(
        { kind, id: value.id, revision: value.revision, scopeId, value },
        null,
      ),
    );
  try {
    await core.configure(user, {
      scopeId,
      expectedRevision: 0,
      learning: true,
      recommendation: true,
      review: true,
      notifications: false,
    });
    const task = await call("startTask", { scopeId }, host);
    const submitted = {
      scopeId,
      context: {
        taskRef: task.taskRef,
        method: "literal",
        playbookId: "literal",
      },
      segments: [
        { role: "tool", text: "Generated output survived verification." },
        { role: "user", text: "A separate source segment." },
      ],
    };
    const key = randomUUID();
    const receipt = await call("submitSource", submitted, host, key);
    assert.equal(receipt.sources.length, 2);
    assert.equal(receipt.materialId, undefined);
    const sources = await call("listSources");
    assert.deepEqual(
      new Set(sources.map((s: any) => s.id)),
      new Set(receipt.sources.map((s: any) => s.id)),
    );
    const source = sources.find(
      (s: any) => s.segment.text === submitted.segments[0]!.text,
    );
    assert.equal(
      (await call("inspectSource", { id: source.id })).segment.role,
      "tool",
    );
    assert.deepEqual(
      (await call("submitSource", submitted, host, key)).sources,
      receipt.sources,
    );
    const material = (
      await core.store.transaction((tx) => tx.list<any>("material", [scopeId]))
    )[0];
    assert.deepEqual(material.context, submitted.context);
    await assert.rejects(
      call(
        "submitSource",
        {
          scopeId,
          sourceFor: { id: source.id, revision: 1 },
          segments: [{ role: "tool", text: "Forged task observation" }],
        },
        { ...host, id: randomUUID() },
      ),
      /task_identity_mismatch/,
    );
    await assert.rejects(
      call("inspectSource", { id: source.id }, { ...user, scopes: [] }),
      /not_found/,
    );
    const evidence = {
      role: "tool",
      relation: "supports",
      fingerprint: source.id,
      excerpt: submitted.segments[0]!.text,
    };
    const experience = experienceSchema.parse({
      ...identity(scopeId),
      conclusion: "The observed generation preserved the output",
      level: "L1",
      purpose: "fact",
      applicability: "general",
      conditions: [],
      exceptions: [],
      topics: [],
      entities: [],
      basis: "observed",
      assessment: "supported",
      evidence: [evidence],
      derivedFrom: [],
      sourceFingerprints: [source.id],
      state: "active",
    });
    const work = workCaseSchema.parse({
      ...identity(scopeId),
      taskRef: task.taskRef,
      sourceFamily: material.sourceFamily,
      topic: "Generation",
      goal: "Preserve output",
      context: {},
      attempts: [],
      result: {
        status: "succeeded",
        summary: "Verified output",
        evidenceIndexes: [0],
      },
      evidence: [evidence],
      unresolved: [],
      coverage: [],
      methodUses: [],
    });
    const method = methodSchema.parse({
      ...identity(scopeId),
      title: "Check generation",
      goal: "Verify output",
      topics: [],
      applicability: "general",
      conditions: [],
      exceptions: [],
      state: "active",
      steps: [
        {
          stepId: "s1",
          instruction: "Generate and inspect the output",
          supportIndexes: [0],
        },
      ],
      completionChecks: [{ text: "Output retained", stepIds: ["s1"] }],
      stopConditions: [],
      supportRefs: [{ kind: "experience", id: experience.id, revision: 1 }],
      change: {
        kind: "create",
        summary: "Observed generation",
        caseRefs: [{ kind: "work_case", id: work.id, revision: 1 }],
        predecessors: [],
      },
    });
    await put("experience", experience);
    await put("work_case", work);
    await put("method", method);
    for (const object of [experience, method])
      await put("projection", {
        ...identity(scopeId),
        id: object.id,
        objectRevision: 1,
        confirmed: true,
        objectKind: object === method ? "method" : "experience",
      });
    const detail = await call("inspectPlaybook", { id: method.id });
    assert.equal(detail.change.caseRefs, undefined);
    const view = await call("getWorkView", { kind: "playbook", id: method.id });
    assert.equal(view.items[0].id, undefined);
    assert.equal(view.items[0].taskRef, task.taskRef);
    assert.ok(view.items[0].sources.some((s: any) => s.id === source.id));
    const append = await call("submitSource", {
      scopeId,
      sourceFor: { id: source.id, revision: 1 },
      segments: [{ role: "user", text: "Later observation" }],
    });
    const appendSource = (await core.listSources(user)).find(
      (s) => s.id === append.sources[0].id,
    )!;
    const appended = (await core.inspect(
      user,
      "material",
      appendSource.materialId,
    )) as any;
    assert.equal(appended.taskRef, task.taskRef);
    assert.equal(appended.caseFor.id, work.id);
    assert.equal(
      (await call("getJob", { id: append.jobId })).caseTarget,
      undefined,
    );
    const canceled = await call("cancelJob", { id: append.jobId });
    assert.equal(canceled.candidate, undefined);
    assert.equal(canceled.modelSchema, undefined);
    const prepared = await call(
      "preparePlaybook",
      { playbookId: method.id, revision: 1, taskRef: task.taskRef },
      host,
    );
    assert.equal(prepared.status, "guidance");
    assert.equal(prepared.playbook.kind, "playbook");
    assert.equal(prepared.method, undefined);
    assert.deepEqual(prepared.completionChecks, method.completionChecks);
    const events = await call(
      "recordTaskObservation",
      [
        {
          eventId: randomUUID(),
          taskRef: task.taskRef,
          scopeId,
          kind: "delivery",
          occurredAt: new Date().toISOString(),
          text: "Host delivery",
          playbook: prepared.playbook,
          playbookUseRef: prepared.playbookUseRef,
        },
      ],
      host,
    );
    assert.equal(events.results[0].status, "accepted");
    await call("ratePlaybookUse", {
      taskRef: task.taskRef,
      playbookUseRef: prepared.playbookUseRef,
      rating: "helpful",
    });
    assert.equal(
      (await call("getUsageView", { playbookId: method.id }))[0].classification,
      "user_confirmed_helpful",
    );
    const revision = await call("revisePlaybook", {
      id: method.id,
      expectedRevision: 1,
      body: {
        change: {
          ...detail.change,
          kind: "correction",
          summary: "Review retained procedure",
        },
      },
    });
    assert.equal(revision.target.kind, "playbook");
    assert.deepEqual(
      ((await core.inspect(user, "method", method.id)) as any).change.caseRefs,
      method.change.caseRefs,
    );
    await call("controlSource", {
      id: source.id,
      expectedRevision: 1,
      action: "withdraw",
    });
    assert.equal(
      (await call("inspectSource", { id: source.id })).blocked,
      true,
    );
    assert.equal(
      (
        await call("inspectSource", {
          id: sources.find((s: any) => s.id !== source.id).id,
        })
      ).blocked,
      false,
    );
    await assert.rejects(
      call("submitSource", {
        scopeId,
        sourceFor: { id: source.id, revision: 1 },
        segments: [{ role: "user", text: "stale" }],
      }),
      /source_target_changed|source_unavailable/,
    );
    for (const old of [
      "submitMaterial",
      "submitWorkCase",
      "browseWorkCases",
      "inspectWorkCase",
      "listEffectCases",
      "prepareMethod",
    ])
      await assert.rejects(call(old), /unknown_operation/);
  } finally {
    await store.close();
  }
});
