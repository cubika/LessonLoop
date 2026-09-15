import { z } from "zod";
import { ProductStore, Conflict, type Transaction } from "../store/postgres.js";
import { digest, type ObjectRef } from "../domain/schema.js";
import { ApiError } from "./service.js";

const DAY = 86400000;
const outcome = z.enum(["succeeded", "failed", "abandoned", "unknown"]);
const rating = z.enum(["helpful", "incorrect", "irrelevant"]);
const base = {
  taskRef: z.string(),
  expectedRevision: z.number().int().positive(),
};
const target = {
  playbookId: z.string(),
  revision: z.number().int().positive(),
};
const text = z.string().max(512).default("");
const updateSchema = z.discriminatedUnion("field", [
  z.object({ ...base, ...target, field: z.literal("delivered") }).strict(),
  z
    .object({
      ...base,
      ...target,
      field: z.literal("userRating"),
      rating,
      text,
    })
    .strict(),
  z
    .object({
      ...base,
      field: z.literal("taskOutcome"),
      taskOutcome: outcome,
      text,
    })
    .strict(),
]);
type Caller = { id: string; channel: string; scopes: string[] };
export interface TaskFeedback {
  id: string;
  revision: number;
  scopeId: string;
  createdAt: string;
  taskOutcome: z.infer<typeof outcome>;
  outcomeText: string;
  outcomeSource?: "ai" | "host" | "user";
  outcomeScope?: "session";
  outcomeEvidence?: Array<{
    role: "user" | "agent" | "tool" | "host";
    excerpt: string;
  }>;
  outcomeAssessment?: "pending" | "completed" | "unavailable";
  outcomeGeneration?: number;
  minimumRevision?: number;
  feedback: Array<{
    playbookId: string;
    revision: number;
    delivered: true | null;
    userRating: z.infer<typeof rating> | null;
    ratingText: string;
  }>;
  cleared?: boolean;
}
const entry = (value: TaskFeedback) => ({
  kind: "task_feedback",
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value: value as unknown as Record<string, unknown>,
});
export const retained = (row: TaskFeedback) =>
  !row.cleared && Date.parse(row.createdAt) > Date.now() - 30 * DAY;

export class Effects {
  constructor(private readonly store: ProductStore) {}
  // Updates never create records. Only task creation or a successful prepare
  // can register feedback, so late writes cannot restore a cleared record.
  async register(
    tx: Transaction,
    task: {
      id: string;
      scopeId: string;
      createdAt: string;
      hostSession?: boolean;
    },
    playbook?: ObjectRef,
  ) {
    if (!(await tx.get<{ review: boolean }>("settings", task.scopeId))?.review)
      return;
    const old = await tx.get<TaskFeedback>("task_feedback", task.id);
    const next: TaskFeedback =
      old && !old.cleared
        ? structuredClone(old)
        : {
            id: task.id,
            scopeId: task.scopeId,
            createdAt: task.createdAt,
            revision: old?.revision ?? 0,
            ...(old?.outcomeGeneration !== undefined
              ? { outcomeGeneration: old.outcomeGeneration }
              : {}),
            ...(old?.minimumRevision !== undefined
              ? { minimumRevision: old.minimumRevision }
              : {}),
            taskOutcome: "unknown",
            outcomeText: "",
            ...(task.hostSession ? { outcomeScope: "session" as const } : {}),
            feedback: [],
          };
    if (
      playbook &&
      !next.feedback.some(
        (f) => f.playbookId === playbook.id && f.revision === playbook.revision,
      )
    ) {
      if (next.feedback.length >= 8) return;
      next.feedback.push({
        playbookId: playbook.id,
        revision: playbook.revision,
        delivered: null,
        userRating: null,
        ratingText: "",
      });
    }
    if (!old || old.cleared || next.feedback.length !== old.feedback.length) {
      next.revision++;
      await tx.put(entry(next), old?.revision ?? null);
    }
    return next.revision;
  }
  async update(caller: Caller, input: unknown) {
    const v = updateSchema.parse(input);
    if (
      !(v.field === "taskOutcome"
        ? ["user", "host"].includes(caller.channel)
        : caller.channel === (v.field === "userRating" ? "user" : "host"))
    )
      throw new ApiError("feedback_writer_denied", 403);
    return this.store.transaction(async (tx) => {
      const row = await tx.get<TaskFeedback>("task_feedback", v.taskRef);
      const task = await tx.get<{
        callerId: string;
        scopeId: string;
        erasedObservationHashes?: string[];
      }>("task", v.taskRef);
      if (
        !row ||
        !retained(row) ||
        !task ||
        !caller.scopes.includes(row.scopeId) ||
        task.scopeId !== row.scopeId ||
        (caller.channel === "host" && task.callerId !== caller.id)
      )
        throw new ApiError("feedback_unavailable", 404);
      if (!(await tx.get<{ review: boolean }>("settings", row.scopeId))?.review)
        throw new ApiError("review_disabled", 409);
      if (
        "text" in v &&
        v.text &&
        task.erasedObservationHashes?.includes(digest(v.text))
      )
        throw new ApiError("observation_erased", 409);
      const next = structuredClone(row);
      if (v.field === "taskOutcome") {
        if (row.outcomeSource === "user" && caller.channel !== "user")
          throw new ApiError("feedback_user_confirmed", 409);
        next.taskOutcome = v.taskOutcome;
        next.outcomeText = v.text;
        next.outcomeSource = caller.channel as "user" | "host";
        next.outcomeAssessment = "completed";
        delete next.outcomeEvidence;
      } else {
        const f = next.feedback.find(
          (f) => f.playbookId === v.playbookId && f.revision === v.revision,
        );
        if (!f) throw new ApiError("feedback_unavailable", 404);
        if (v.field === "delivered") f.delivered = true;
        else {
          f.userRating = v.rating;
          f.ratingText = v.text;
        }
      }
      if (JSON.stringify(next) === JSON.stringify(row))
        return { accepted: true, revision: row.revision };
      if (row.revision !== v.expectedRevision) throw new Conflict();
      next.revision++;
      await tx.put(entry(next), row.revision);
      if (v.field === "taskOutcome") {
        const pending = await tx.get<{ revision: number }>(
          "task_outcome",
          row.id,
        );
        if (pending) await tx.remove("task_outcome", row.id, pending.revision);
      }
      return { accepted: true, revision: next.revision };
    });
  }
  async cases(scopes: string[], transaction?: Transaction) {
    const read = async (tx: Transaction) =>
      (await tx.list<TaskFeedback>("task_feedback", scopes))
        .filter(retained)
        .map((row) => ({
          ...row,
          taskRef: row.id,
          classification: row.feedback.some((f) => f.userRating === "incorrect")
            ? "reported_problem"
            : row.feedback.some((f) => f.userRating === "helpful")
              ? "user_confirmed_helpful"
              : "needs_verification",
        }));
    return transaction ? read(transaction) : this.store.transaction(read);
  }
  static summarize(tasks: TaskFeedback[]) {
    const result = (status: string) =>
      tasks.filter((t) => t.taskOutcome === status).length;
    const rated = (rating: string) =>
      tasks.filter((t) => t.feedback.some((f) => f.userRating === rating))
        .length;
    return {
      tasks: tasks.length,
      delivered: tasks.filter((t) => t.feedback.some((f) => f.delivered))
        .length,
      succeeded: result("succeeded"),
      failed: result("failed"),
      abandoned: result("abandoned"),
      unknownOutcome: result("unknown"),
      outcomeSources: Object.fromEntries(
        ["ai", "host", "user", "unspecified"].map((source) => [
          source,
          tasks.filter((t) => (t.outcomeSource ?? "unspecified") === source)
            .length,
        ]),
      ),
      helpful: rated("helpful"),
      reportedIncorrect: rated("incorrect"),
    };
  }
  async summary(scopes: string[]) {
    return {
      ...Effects.summarize(await this.cases(scopes)),
      coverage: "retained_task_feedback",
      windowDays: 30,
    };
  }
  async clear(scopeId: string) {
    return this.store.transaction(async (tx) => {
      for (const row of await tx.list<TaskFeedback>("task_feedback", [scopeId]))
        if (!row.cleared) {
          const { outcomeSource, outcomeEvidence, outcomeAssessment, ...rest } =
            row;
          await tx.put(
            entry({
              ...rest,
              revision: row.revision + 1,
              taskOutcome: "unknown",
              outcomeText: "",
              outcomeGeneration: (row.outcomeGeneration ?? 0) + 1,
              minimumRevision: row.revision + 1,
              feedback: [],
              cleared: true,
            }),
            row.revision,
          );
        }
      for (const kind of [
        "effect_review",
        "review_notification",
        "review_issue",
        "task_outcome",
      ])
        for (const row of await tx.list<{ id: string; revision: number }>(
          kind,
          [scopeId],
        ))
          await tx.remove(kind, row.id, row.revision);
      return { accepted: true };
    });
  }
  async maintain(scopes: string[]) {
    return this.store.transaction(async (tx) => {
      for (const row of await tx.list<TaskFeedback>("task_feedback", scopes))
        if (Date.parse(row.createdAt) <= Date.now() - 30 * DAY) {
          await tx.remove("task_feedback", row.id, row.revision);
          const pending = await tx.get<{ revision: number }>(
            "task_outcome",
            row.id,
          );
          if (pending)
            await tx.remove("task_outcome", row.id, pending.revision);
        }
    });
  }
}
