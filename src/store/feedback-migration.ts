import type pg from "pg";

const retired = [
  "effect_task",
  "effect_event",
  "rating_receipt",
  "playbook_use",
  "effect_boundary",
];
const migrationId = "direct-task-feedback";
type Value = Record<string, any>;
type Row = { kind: string; id: string; scope_id: string; value: Value };

// Legacy receipts are folded once at startup; current feedback never replays them.
export async function migrateFeedback(db: pg.PoolClient): Promise<void> {
  await db.query("BEGIN");
  try {
    const migrated = await db.query(
      "SELECT 1 FROM lessonloop.objects WHERE kind='storage_migration' AND id=$1",
      [migrationId],
    );
    if (!migrated.rowCount) {
      const { rows } = await db.query<Row>(
        "SELECT kind,id,scope_id,value FROM lessonloop.objects WHERE kind=ANY($1::text[])",
        [[...retired, "settings", "task", "task_feedback", "review_issue"]],
      );
      const values = (kind: string) => rows.filter((r) => r.kind === kind);
      const enabled = new Set(
        values("settings")
          .filter((r) => r.value.review === true)
          .map((r) => r.scope_id),
      );
      const boundaries = new Map(
        values("effect_boundary").map((r) => [
          r.scope_id,
          Date.parse(r.value.clearedAt),
        ]),
      );
      const cutoff = Date.now() - 30 * 86400000;
      const retained = (scope: string, at: string) =>
        Date.parse(at) > Math.max(cutoff, boundaries.get(scope) ?? 0);
      const current = new Map(
        values("task_feedback").map((r) => [r.id, r.value]),
      );
      const taskDates = new Map([
        ...values("effect_task").map(
          (r) => [r.value.taskRef, r.value.createdAt] as const,
        ),
        ...values("task").map((r) => [r.id, r.value.createdAt] as const),
      ]);
      const cases = new Map<string, Value>();
      const caseFor = (row: Row, at: string) => {
        const id = row.value.taskRef;
        at = taskDates.get(id) ?? at;
        if (Date.parse(at) <= cutoff) return;
        let task = cases.get(id);
        if (!task) {
          task = {
            id,
            revision: 1,
            scopeId: row.scope_id,
            createdAt: at,
            taskOutcome: "unknown",
            outcomeText: "",
            feedback: [],
          };
          cases.set(id, task);
        }
        if (Date.parse(at) < Date.parse(task.createdAt)) task.createdAt = at;
        return task;
      };
      const methodFor = (task: Value, playbook: Value) => {
        let method = task.feedback.find(
          (f: Value) =>
            f.playbookId === playbook.id && f.revision === playbook.revision,
        );
        if (!method) {
          method = {
            playbookId: playbook.id,
            revision: playbook.revision,
            delivered: null,
            userRating: null,
            ratingText: "",
          };
          task.feedback.push(method);
        }
        return method;
      };
      const oldCases = new Map(
        values("effect_task").map((r) => [r.id, r.value.taskRef]),
      );
      const events = values("effect_task")
        .flatMap((row) =>
          (row.value.events ?? []).map((event: Value) => ({ row, event })),
        )
        .sort(
          (a, b) =>
            Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt),
        );
      const retainedEvidence = new Set<string>();
      for (const { row, event } of events) {
        if (
          !retained(row.scope_id, event.occurredAt) ||
          !retained(row.scope_id, row.value.createdAt)
        )
          continue;
        const task = caseFor(row, row.value.createdAt);
        if (!task) continue;
        retainedEvidence.add(JSON.stringify([row.id, event.eventId]));
        if (
          event.kind === "outcome" &&
          ["succeeded", "failed", "abandoned", "unknown"].includes(
            event.outcome,
          )
        ) {
          task.taskOutcome = event.outcome;
          task.outcomeText = event.text ?? "";
        }
        if (!event.playbook) continue;
        if (event.kind === "delivery")
          methodFor(task, event.playbook).delivered = true;
        if (
          event.kind === "user_rating" &&
          ["helpful", "incorrect", "irrelevant"].includes(event.rating)
        ) {
          const method = methodFor(task, event.playbook);
          method.userRating = event.rating;
          method.ratingText = event.text ?? "";
        }
      }
      for (const row of values("playbook_use")) {
        if (
          !retained(row.scope_id, row.value.returnedAt) ||
          (!enabled.has(row.scope_id) &&
            cases.get(row.value.taskRef)?.scopeId !== row.scope_id)
        )
          continue;
        const task = caseFor(row, row.value.returnedAt);
        if (task) methodFor(task, row.value.playbook);
      }
      const write = (kind: string, value: Value, replace = false) =>
        db.query(
          `INSERT INTO lessonloop.objects(kind,id,scope_id,revision,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,id) ${replace ? "DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value,updated_at=now()" : "DO NOTHING"}`,
          [
            kind,
            value.id,
            value.scopeId,
            value.revision,
            JSON.stringify(value),
          ],
        );
      for (const task of cases.values()) {
        await write("task_feedback", task);
        if (!current.has(task.id)) current.set(task.id, task);
      }
      for (const row of values("review_issue")) {
        const issue = row.value;
        if (!issue.evidence?.some((e: Value) => e.eventId !== undefined))
          continue;
        const evidence = issue.evidence.flatMap((e: Value) => {
          if (
            e.eventId !== undefined &&
            !retainedEvidence.has(JSON.stringify([e.caseId, e.eventId]))
          )
            return [];
          const task = current.get(oldCases.get(e.caseId) ?? e.caseId);
          return task && task.scopeId === row.scope_id && !task.cleared
            ? [{ caseId: task.id, revision: task.revision }]
            : [];
        });
        const next: Value = {
          ...issue,
          revision: issue.revision + 1,
          evidence: [
            ...new Map(evidence.map((e: Value) => [e.caseId, e])).values(),
          ],
        };
        if (next.status === "confirmed") next.status = "suspected";
        delete next.confirmedBy;
        delete next.confirmedEvidence;
        await write("review_issue", next, true);
      }
      await db.query(
        "UPDATE lessonloop.objects SET value=value-'playbookUses' WHERE kind='work_view' AND value ? 'playbookUses'",
      );
      await db.query(
        "DELETE FROM lessonloop.objects WHERE kind=ANY($1::text[])",
        [retired],
      );
      await write("storage_migration", {
        id: migrationId,
        scopeId: "system",
        revision: 1,
      });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
