import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateFeedback } from "../src/store/feedback-migration.js";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("LESSONLOOP_TEST_DATABASE_URL is required");

test("Legacy feedback migrates atomically once without inferring adoption or losing learning data", async () => {
  const admin = new pg.Client({ connectionString: url });
  const name = `feedback_migration_${randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  const db = await pool.connect();
  try {
    await db.query(
      "CREATE SCHEMA lessonloop; CREATE TABLE lessonloop.objects(kind text NOT NULL,id text NOT NULL,scope_id text NOT NULL,revision bigint NOT NULL,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id))",
    );
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const playbook = { kind: "playbook", id: "book", revision: 3 };
    const put = (
      kind: string,
      id: string,
      fields: Record<string, unknown> = {},
      scopeId = "enabled",
    ) =>
      db.query("INSERT INTO lessonloop.objects VALUES($1,$2,$3,1,$4)", [
        kind,
        id,
        scopeId,
        JSON.stringify({ id, revision: 1, scopeId, ...fields }),
      ]);
    const get = async (kind: string, id: string) =>
      (
        await db.query(
          "SELECT value FROM lessonloop.objects WHERE kind=$1 AND id=$2",
          [kind, id],
        )
      ).rows[0]?.value;
    await put("settings", "enabled", { review: true });
    await put("settings", "disabled", { review: false }, "disabled");
    await put("effect_boundary", "enabled", { clearedAt: at(-10000) });
    for (const [id, taskRef, scope, returnedAt] of [
      ["prepared", "task", "enabled", at(-8000)],
      ["undelivered", "prepared-only", "enabled", at(-8000)],
      ["disabled-use", "disabled-task", "disabled", at(-8000)],
      ["disabled-only", "disabled-prepared", "disabled", at(-8000)],
      ["old-use", "old-task", "enabled", at(-11000)],
      ["revived-use", "revived-task", "enabled", at(-8000)],
      ["expired-use", "expired-prepared", "enabled", at(-8000)],
    ] as const)
      await put("playbook_use", id, { taskRef, playbook, returnedAt }, scope);
    await put("playbook_use", "revision-4", {
      taskRef: "task",
      playbook: { ...playbook, revision: 4 },
      returnedAt: at(-8000),
    });
    await put("effect_task", "legacy-case", {
      taskRef: "task",
      createdAt: at(-9000),
      events: [
        {
          kind: "outcome",
          occurredAt: at(-1000),
          outcome: "failed",
          text: "Corrected result",
        },
        {
          eventId: "delivery",
          kind: "delivery",
          occurredAt: at(-7000),
          playbook,
        },
        {
          kind: "user_rating",
          occurredAt: at(-5000),
          playbook,
          rating: "incorrect",
          text: "Old rating",
        },
        {
          kind: "outcome",
          occurredAt: at(-6000),
          outcome: "succeeded",
          text: "Old result",
        },
        {
          kind: "user_rating",
          occurredAt: at(-5000),
          playbook,
          rating: "helpful",
          eventId: "rating",
          text: "Corrected rating",
        },
        {
          kind: "usage",
          occurredAt: at(-500),
          playbook: { ...playbook, revision: 4 },
          outcome: "succeeded",
        },
      ],
    });
    await put("effect_task", "ended-case", {
      taskRef: "ended-task",
      createdAt: at(-9000),
      events: [
        { kind: "task_ended", occurredAt: at(-8000), outcome: "succeeded" },
      ],
    });
    await put("effect_task", "expired-case", {
      taskRef: "expired-task",
      createdAt: at(-31 * 86400000),
      events: [
        { kind: "outcome", occurredAt: at(-8000), outcome: "succeeded" },
      ],
    });
    await put("effect_task", "cleared-case", {
      taskRef: "cleared-task", createdAt: at(-11000),
      events: [{ kind: "outcome", occurredAt: at(-5000), outcome: "succeeded" }],
    });
    await put(
      "effect_task",
      "disabled-case",
      {
        taskRef: "disabled-task",
        createdAt: at(-9000),
        events: [
          {
            kind: "outcome",
            occurredAt: at(-8000),
            outcome: "succeeded",
            text: "Recorded before review was disabled",
          },
          {
            kind: "user_rating",
            occurredAt: at(-7000),
            playbook,
            rating: "helpful",
            text: "Saved user rating",
          },
        ],
      },
      "disabled",
    );
    await put(
      "playbook_use",
      "disabled-version",
      {
        taskRef: "disabled-task",
        playbook: { ...playbook, revision: 4 },
        returnedAt: at(-8000),
      },
      "disabled",
    );
    const observations = [
      { eventId: "tool", text: "Source evidence", occurredAt: at(-8000) },
    ];
    await put("task", "task", {
      createdAt: at(-9500),
      rawObservations: observations,
    });
    await put("task", "revived-task", { createdAt: at(-11000) });
    await put("task", "expired-prepared", { createdAt: at(-31 * 86400000) });
    await put("source", "source", {
      segment: { role: "tool", text: "Source evidence" },
    });
    await put("work_view", "work", {
      playbookUses: [{ playbookUseRef: "legacy" }],
      evidence: observations,
    });
    await put("review_issue", "issue", {
      status: "confirmed",
      confirmedBy: "user",
      confirmedEvidence: [{ caseId: "legacy-case", eventId: "rating" }],
      evidence: [
        { caseId: "legacy-case", eventId: "rating" },
        { caseId: "legacy-case", eventId: "delivery" },
        { caseId: "expired-case", eventId: "old" },
      ],
    });
    await put("review_issue", "erased-issue", {
      status: "confirmed",
      evidence: [{ caseId: "legacy-case", eventId: "erased-event" }],
    });
    await put("effect_event", "event", { hash: "old-hash" });
    await put("rating_receipt", "receipt", { hash: "old-rating" });
    const originalQuery = db.query.bind(db);
    const failing = Object.create(db) as pg.PoolClient;
    failing.query = ((...args: unknown[]) => {
      if (String(args[0]).startsWith("DELETE FROM lessonloop.objects"))
        return Promise.reject(new Error("injected_failure"));
      return (originalQuery as (...args: unknown[]) => unknown)(...args);
    }) as typeof db.query;
    await assert.rejects(migrateFeedback(failing), /injected_failure/);
    assert.equal(await get("task_feedback", "task"), undefined);
    assert.equal((await get("review_issue", "issue")).status, "confirmed");
    assert.ok((await get("work_view", "work")).playbookUses);
    assert.equal(
      await get("storage_migration", "direct-task-feedback"),
      undefined,
    );
    await migrateFeedback(db);
    const task = await get("task_feedback", "task");
    assert.equal(task.taskOutcome, "failed");
    assert.equal(task.outcomeText, "Corrected result");
    assert.equal(task.createdAt, at(-9500));
    assert.deepEqual(
      task.feedback.find((f: any) => f.revision === 3),
      {
        playbookId: "book",
        revision: 3,
        delivered: true,
        userRating: "helpful",
        ratingText: "Corrected rating",
      },
    );
    assert.equal(
      task.feedback.find((f: any) => f.revision === 4).delivered,
      null,
    );
    assert.equal(
      (await get("task_feedback", "prepared-only")).taskOutcome,
      "unknown",
    );
    assert.equal(
      (await get("task_feedback", "ended-task")).taskOutcome,
      "unknown",
    );
    assert.equal(
      (await get("task_feedback", "revived-task")).createdAt,
      at(-11000),
    );
    for (const id of [
      "old-task",
      "cleared-task",
      "expired-task",
      "expired-prepared",
      "disabled-prepared",
    ])
      assert.equal(await get("task_feedback", id), undefined);
    const disabled = await get("task_feedback", "disabled-task");
    assert.equal(disabled.taskOutcome, "succeeded");
    assert.equal(disabled.outcomeText, "Recorded before review was disabled");
    assert.equal(
      disabled.feedback.find((f: any) => f.revision === 3).userRating,
      "helpful",
    );
    assert.equal(
      disabled.feedback.find((f: any) => f.revision === 3).ratingText,
      "Saved user rating",
    );
    assert.equal(
      disabled.feedback.find((f: any) => f.revision === 4).delivered,
      null,
    );
    const issue = await get("review_issue", "issue");
    assert.equal(issue.status, "suspected");
    assert.equal(issue.confirmedBy, undefined);
    assert.equal(issue.confirmedEvidence, undefined);
    assert.deepEqual(issue.evidence, [{ caseId: "task", revision: 1 }]);
    assert.deepEqual((await get("review_issue", "erased-issue")).evidence, []);
    assert.deepEqual((await get("task", "task")).rawObservations, observations);
    assert.equal(
      (await get("source", "source")).segment.text,
      "Source evidence",
    );
    assert.deepEqual(await get("work_view", "work"), {
      id: "work",
      revision: 1,
      scopeId: "enabled",
      evidence: observations,
    });
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM lessonloop.objects WHERE kind=ANY($1::text[])",
          [
            [
              "effect_task",
              "effect_event",
              "rating_receipt",
              "playbook_use",
              "effect_boundary",
            ],
          ],
        )
      ).rowCount,
      0,
    );
    const snapshot = (
      await db.query("SELECT * FROM lessonloop.objects ORDER BY kind,id")
    ).rows;
    await migrateFeedback(db);
    assert.deepEqual(
      (await db.query("SELECT * FROM lessonloop.objects ORDER BY kind,id"))
        .rows,
      snapshot,
    );
  } finally {
    db.release();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
