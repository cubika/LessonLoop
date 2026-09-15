import { workViewSchema } from "../src/core/work-view.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";
import { dispatch } from "../src/core/server.js";
import {
  identity,
  playbookSchema,
  contentByteSize,
  matchText,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");

test("User corrections preserve full text while keeping held objects valid", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scopeId = randomUUID();
    const user = {
      id: randomUUID(),
      channel: "user" as const,
      scopes: [scopeId],
    };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    for (const correctionText of [
      "x".repeat(513),
      "汉".repeat(171),
      "汉".repeat(2048),
      "",
    ]) {
      const fingerprint = "a".repeat(64);
      const experience = experienceSchema.parse({
        ...identity(scopeId),
        conclusion: "The observed check passed",
        purpose: "fact",
        applicability: "general",
        conditions: [],
        exceptions: [],
        topics: [],
        entities: [],
        basis: "observed",
        assessment: "supported",
        evidence: [
          {
            excerpt: "Check passed",
            role: "tool",
            relation: "supports",
            fingerprint,
          },
        ],
        derivedFrom: [],
        sourceFingerprints: [fingerprint],
        state: "active",
      });
      const playbook = playbookSchema.parse({
        ...identity(scopeId),
        title: "Check the output",
        goal: "Verify the result",
        topics: [],
        applicability: "general",
        conditions: [],
        exceptions: [],
        state: "active",
        steps: [
          { stepId: "s1", instruction: "Run the check", supportIndexes: [0] },
        ],
        completionChecks: [{ text: "Check passed" }],
        stopConditions: [],
        supportRefs: [{ kind: "experience", id: experience.id, revision: 1 }],
        change: { kind: "create", summary: "Observed check", predecessors: [] },
      });
      for (const [kind, value] of [
        ["experience", experience],
        ["playbook", playbook],
      ] as const) {
        await store.transaction((tx) =>
          tx.put({ kind, id: value.id, revision: 1, scopeId, value }, null),
        );
        const receipt = await core.feedback(user, {
          target: { kind, id: value.id, revision: 1 },
          rating: "incorrect",
          correctionText,
        });
        assert.equal(receipt.accepted, true);
        assert.equal(receipt.previousUse, "suppressed");
        const stored = await core.inspect(user, kind, value.id);
        const held =
          kind === "playbook"
            ? playbookSchema.parse(stored)
            : experienceSchema.parse(stored);
        assert.equal(held.state, "held");
        assert.ok(Buffer.byteLength(held.review!.question, "utf8") <= 512);
        await store.transaction(async (tx) => {
          const control = await tx.get<any>("control", value.id);
          assert.equal(control.correctionText, correctionText);
          const feedback = (await tx.list<any>("feedback", [scopeId])).find(
            (row) => row.target.id === value.id,
          );
          assert.equal(feedback.correctionText, correctionText);
        });
      }
    }
  } finally {
    await store.close();
  }
});
test("Full content budgets still allow users to hold experiences and playbooks", async () => {
  const store = new ProductStore(url);
  await store.open(true);
  try {
    const scopeId = randomUUID();
    const user = {
      id: randomUUID(),
      channel: "user" as const,
      scopes: [scopeId],
    };
    const core = new CoreService(
      store,
      new HindsightEngine("http://127.0.0.1:19888", "unused"),
    );
    const roots = Array.from({ length: 32 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const match = {
      key: "k".repeat(64),
      values: ["v".repeat(100), "w".repeat(100), "x".repeat(100)],
    };
    const experience = {
      ...identity(scopeId),
      id: "i".repeat(128),
      conclusion: "c".repeat(2048),
      purpose: "fact",
      applicability: "conditional",
      conditions: Array(4).fill({ text: matchText(match), match }),
      exceptions: Array(4).fill({ text: matchText(match), match }),
      topics: Array(8).fill("t".repeat(64)),
      entities: Array(16).fill("e".repeat(128)),
      basis: "observed",
      assessment: "supported",
      sourceFingerprints: roots,
      derivedFrom: Array.from({ length: 8 }, (_, i) => ({
        id: String(i).repeat(128),
        revision: 1,
      })),
      evidence: [
        {
          excerpt: "a".repeat(512),
          role: "tool",
          relation: "supports",
          fingerprint: roots[0],
          locator: "l".repeat(256),
          author: "a".repeat(128),
        },
      ],
      state: "active",
    };
    const gap = 16384 - contentByteSize(experience);
    assert.ok(gap > 0 && gap < 2048);
    experience.conclusion =
      String.fromCharCode(10).repeat(gap) + "c".repeat(2048 - gap);
    const e = experienceSchema.parse(experience);
    const playbook = {
      ...identity(scopeId),
      title: "Review large content",
      goal: "Retain control",
      topics: [],
      applicability: "general",
      conditions: [],
      exceptions: [],
      state: "active",
      steps: Array.from({ length: 12 }, (_, i) => ({
        stepId: "s" + i,
        instruction: "i".repeat(1024),
        rationale: "r".repeat(512),
        supportIndexes: [0],
      })),
      completionChecks: [{ text: "Check output" }],
      stopConditions: [],
      supportRefs: [{ kind: "experience", id: e.id, revision: 1 }],
      change: { kind: "create", summary: "c".repeat(1024), predecessors: [] },
    };
    let bookGap = 32768 - contentByteSize(playbook);
    assert.ok(bookGap > 0);
    for (const step of playbook.steps) {
      const count = Math.min(bookGap, step.instruction.length);
      step.instruction =
        String.fromCharCode(10).repeat(count) + step.instruction.slice(count);
      bookGap -= count;
    }
    assert.equal(bookGap, 0);
    const b = playbookSchema.parse(playbook);
    for (const [kind, value, budget] of [
      ["experience", e, 16384],
      ["playbook", b, 32768],
    ] as const) {
      assert.equal(contentByteSize(value), budget);
      await store.transaction((tx) =>
        tx.put({ kind, id: value.id, revision: 1, scopeId, value }, null),
      );
      await core.feedback(user, {
        target: { kind, id: value.id, revision: 1 },
        rating: "incorrect",
        correctionText: "c".repeat(512),
      });
      const saved = await core.inspect(user, kind, value.id);
      const held =
        kind === "experience"
          ? experienceSchema.parse(saved)
          : playbookSchema.parse(saved);
      assert.equal(held.state, "held");
      assert.equal(held.review?.question, "c".repeat(512));
      assert.equal(contentByteSize(held), budget);
    }
  } finally {
    await store.close();
  }
});

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
        playbook: "literal",
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
    await store.transaction(async (tx) => {
      assert.equal((await tx.list("material", [scopeId])).length, 0);
      const job = await tx.get<any>("job", receipt.jobId);
      assert.deepEqual(
        job.sourceIds,
        receipt.sources.map((s: any) => s.id),
      );
      await tx.put(
        {
          kind: "job",
          id: job.id,
          scopeId,
          revision: job.revision + 1,
          value: { ...job, revision: job.revision + 1, status: "failed" },
        },
        job.revision,
      );
    });
    const retry = await core.retryJob(
      user,
      receipt.jobId,
      "retry-all-segments",
    );
    const retryJob = await store.transaction((tx) =>
      tx.get<any>("job", retry.jobId),
    );
    assert.equal(retryJob.stage, "queued");
    assert.deepEqual(
      retryJob.sourceIds,
      receipt.sources.map((s: any) => s.id),
    );
    await core.cancelJob(user, retry.jobId);
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
    const inputSource = (
      await core.store.transaction((tx) => tx.list<any>("source", [scopeId]))
    )[0];
    assert.deepEqual(inputSource.context, submitted.context);
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
    const work = workViewSchema.parse({
      sequence: 1,
      ...identity(scopeId),
      taskRef: task.taskRef,
      sourceFamily: inputSource.sourceFamily,
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
    });
    const playbook = playbookSchema.parse({
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
        predecessors: [],
      },
    });
    await put("experience", experience);
    await put("work_view", work);
    await put("playbook", playbook);
    for (const object of [experience, playbook])
      await put("projection", {
        ...identity(scopeId),
        id: object.id,
        objectRevision: 1,
        confirmed: true,
        objectKind: object === playbook ? "playbook" : "experience",
      });
    await core.syncProjections([scopeId]);
    const detail = await call("inspectPlaybook", { id: playbook.id });
    assert.equal(detail.change.caseRefs, undefined);
    const view = await call("getWorkView", {
      kind: "playbook",
      id: playbook.id,
    });
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
      "source",
      appendSource.id,
    )) as any;
    assert.equal(appended.taskRef, task.taskRef);
    assert.equal(appended.sourceFamily, source.sourceFamily);
    assert.equal(
      (await call("getJob", { id: append.jobId })).caseTarget,
      undefined,
    );
    const canceled = await call("cancelJob", { id: append.jobId });
    assert.equal(canceled.payload, undefined);
    const prepared = await call(
      "preparePlaybook",
      { playbookId: playbook.id, revision: 1, taskRef: task.taskRef },
      host,
    );
    assert.equal(prepared.status, "guidance");
    assert.equal(prepared.playbook.kind, "playbook");
    assert.equal(prepared.method, undefined);
    assert.deepEqual(prepared.completionChecks, playbook.completionChecks);
    const delivery = await call(
      "updateTaskFeedback",
      {
        taskRef: task.taskRef,
        field: "delivered",
        playbookId: playbook.id,
        revision: 1,
        expectedRevision: prepared.feedbackRevision,
      },
      host,
    );
    await call("updateTaskFeedback", {
      taskRef: task.taskRef,
      field: "userRating",
      playbookId: playbook.id,
      revision: 1,
      expectedRevision: delivery.revision,
      rating: "helpful",
    });
    assert.equal(
      (await call("getUsageView", { playbookId: playbook.id }))[0]
        .classification,
      "user_confirmed_helpful",
    );
    const revision = await call("revisePlaybook", {
      id: playbook.id,
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
      "browseWorkViews",
      "inspectWorkView",
      "listEffectCases",
      "prepareMethod",
    ])
      await assert.rejects(call(old), /unknown_operation/);
  } finally {
    await store.close();
  }
});
