import { z } from "zod";
import { ProductStore, Conflict, type Transaction } from "../store/postgres.js";
import { feedbackSummary, taskFeedback } from "./feedback.js";
import {
  identity,
  digest,
  byteSize,
  refSchema,
  type ObjectRef,
} from "../domain/schema.js";
const eventSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    taskRef: z.string().min(1).max(128),
    scopeId: z.string().min(1).max(128),
    kind: z.enum([
      "task_started",
      "task_ended",
      "delivery",
      "outcome",
      "user_rating",
      "collection_gap",
    ]),
    occurredAt: z.string().datetime(),
    playbook: refSchema.extend({ kind: z.literal("playbook") }).optional(),
    playbookUseRef: z.string().max(128).optional(),
    text: z.string().min(1).max(512),
    outcome: z.enum(["succeeded", "failed", "abandoned", "unknown"]).optional(),
    rating: z.enum(["helpful", "incorrect", "irrelevant"]).optional(),
  })
  .strict()
  .refine(
    (e) => e.kind !== "outcome" || e.outcome !== undefined,
    "outcome_required",
  )
  .refine(
    (e) => e.kind !== "user_rating" || e.rating !== undefined,
    "rating_required",
  );
type Event = z.infer<typeof eventSchema>;
interface EffectTask {
  id: string;
  revision: number;
  scopeId: string;
  callerId: string;
  taskRef: string;
  createdAt: string;
  events: Event[];
}
const entry = <T extends { id: string; revision: number; scopeId: string }>(
  kind: string,
  v: T,
) => ({
  kind,
  id: v.id,
  scopeId: v.scopeId,
  revision: v.revision,
  value: v as unknown as Record<string, unknown>,
});
export class Effects {
  constructor(private readonly store: ProductStore) {}
  async record(
    caller: { id: string; channel: string; scopes: string[] },
    input: unknown,
  ) {
    if (!["host", "user"].includes(caller.channel))
      throw new Error("trusted_host_required");
    const events = z.array(z.unknown()).max(8).parse(input);
    const results = [];
    for (const raw of events) {
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          eventId:
            typeof raw === "object" && raw && "eventId" in raw
              ? String(raw.eventId)
              : "unknown",
          status: "rejected",
          reason: "invalid_event",
        });
        continue;
      }
      const event = parsed.data;
      if (caller.channel === "user" && event.kind !== "user_rating") {
        results.push({
          eventId: event.eventId,
          status: "rejected",
          reason: "trusted_host_required",
        });
        continue;
      }
      try {
        if (!caller.scopes.includes(event.scopeId))
          throw new Error("scope_denied");
        const result = await this.store.transaction(async (tx) => {
          const setting = await tx.get<{ review: boolean }>(
            "settings",
            event.scopeId,
          );
          if (!setting?.review)
            return {
              eventId: event.eventId,
              status: "ignored",
              reason: "review_disabled",
            };
          const boundary = await tx.get<{ clearedAt: string }>(
            "effect_boundary",
            event.scopeId,
          );
          if (
            boundary &&
            Date.parse(event.occurredAt) <= Date.parse(boundary.clearedAt)
          )
            return {
              eventId: event.eventId,
              status: "ignored",
              reason: "before_clear_boundary",
            };
          if (
            Date.parse(event.occurredAt) < Date.now() - 30 * 86400000 ||
            Date.parse(event.occurredAt) > Date.now() + 60000
          )
            throw new Error("event_outside_window");
          const eventKey = digest([caller.id, event.scopeId, event.eventId]);
          const seen = await tx.get<{ hash: string; cleared: boolean }>(
            "effect_event",
            eventKey,
          );
          if (seen) {
            if (seen.hash !== digest(event))
              throw new Conflict("event_conflict");
            return {
              eventId: event.eventId,
              status: seen.cleared ? "ignored" : "duplicate",
            };
          }
          const actual = await tx.get<{
            callerId: string;
            scopeId: string;
            createdAt?: string;
            erasedObservationHashes?: string[];
            endedAt?: string;
          }>("task", event.taskRef);
          if (
            !actual ||
            (caller.channel !== "user" && actual.callerId !== caller.id) ||
            actual.scopeId !== event.scopeId
          )
            throw new Error("task_identity_mismatch");
          const id = digest([actual.callerId, event.scopeId, event.taskRef]);
          if (
            actual.endedAt &&
            (Date.now() > Date.parse(actual.endedAt) + 86400000 ||
              Date.parse(event.occurredAt) >
                Date.parse(actual.endedAt) + 86400000)
          )
            throw new Error("event_outside_window");
          if (
            actual.createdAt &&
            Date.parse(actual.createdAt) < Date.now() - 31 * 86400000
          )
            throw new Error("event_outside_window");
          if (event.playbook || event.playbookUseRef) {
            const uses = await tx.list<{
              taskRef: string;
              callerId: string;
              playbook: ObjectRef;
              playbookUseRef: string;
              returnedAt: string;
            }>("playbook_use", [event.scopeId]);
            if (
              !event.playbook ||
              !event.playbookUseRef ||
              !uses.some(
                (use) =>
                  use.taskRef === event.taskRef &&
                  use.playbook.id === event.playbook!.id &&
                  use.playbook.revision === event.playbook!.revision &&
                  use.playbookUseRef === event.playbookUseRef &&
                  (!boundary ||
                    Date.parse(use.returnedAt) >
                      Date.parse(boundary.clearedAt)) &&
                  Date.parse(use.returnedAt) <= Date.parse(event.occurredAt),
              )
            )
              throw new Error("playbook_use_mismatch");
          } else if (["delivery", "user_rating"].includes(event.kind))
            throw new Error("playbook_use_mismatch");
          if (actual.erasedObservationHashes?.includes(digest(event.text)))
            return {
              eventId: event.eventId,
              status: "ignored",
              reason: "source_erased",
            };
          const task = await tx.get<EffectTask>("effect_task", id);
          const previous = task?.events.find(
            (e) => e.eventId === event.eventId,
          );
          if (previous) {
            if (digest(previous) !== digest(event))
              throw new Conflict("event_conflict");
            return { eventId: event.eventId, status: "duplicate" };
          }
          const next: EffectTask = task
            ? {
                ...task,
                revision: task.revision + 1,
                events: [...task.events, event],
              }
            : {
                ...identity(event.scopeId),
                id,
                callerId: actual.callerId,
                taskRef: event.taskRef,
                createdAt: event.occurredAt,
                events: [event],
              };
          if (byteSize(next) > 65536 || next.events.length > 64)
            throw new Error("effect_task_budget");
          await tx.put(entry("effect_task", next), task?.revision ?? null);
          await tx.put(
            entry("effect_event", {
              id: eventKey,
              revision: 1,
              scopeId: event.scopeId,
              hash: digest(event),
              cleared: false,
            }),
            null,
          );
          return { eventId: event.eventId, status: "accepted" };
        });
        results.push(result);
      } catch (e) {
        results.push({
          eventId: event.eventId,
          status:
            e instanceof Conflict
              ? "conflict"
              : e instanceof Error &&
                  [
                    "scope_denied",
                    "task_identity_mismatch",
                    "playbook_use_mismatch",
                    "event_outside_window",
                    "effect_task_budget",
                  ].includes(e.message)
                ? "rejected"
                : "retryable",
          reason:
            e instanceof Conflict
              ? "event_conflict"
              : e instanceof Error &&
                  [
                    "scope_denied",
                    "task_identity_mismatch",
                    "playbook_use_mismatch",
                    "event_outside_window",
                    "effect_task_budget",
                  ].includes(e.message)
                ? e.message
                : "storage_unavailable",
        });
      }
    }
    return { results };
  }
  async summary(scopes: string[]) {
    return this.store.transaction(async (tx) => {
      const tasks = (await tx.list<EffectTask>("effect_task", scopes)).filter(
        (t) => Date.parse(t.createdAt) > Date.now() - 30 * 86400000,
      );
      return {
        ...feedbackSummary(tasks),
        coverage: "tasks_with_received_observations",
        causalBenefit: "not_inferred",
        windowDays: 30,
      };
    });
  }
  async cases(scopes: string[], transaction?: Transaction) {
    const read = async (tx: Transaction) => {
      const cutoff = Date.now() - 30 * 86400000;
      const boundaries = await tx.list<{ scopeId: string; clearedAt: string }>(
        "effect_boundary",
        scopes,
      );
      const uses = (
        await tx.list<{
          scopeId: string;
          taskRef: string;
          playbook: ObjectRef;
          returnedAt: string;
        }>("playbook_use", scopes)
      ).filter(
        (use) =>
          Date.parse(use.returnedAt) > cutoff &&
          !boundaries.some(
            (boundary) =>
              boundary.scopeId === use.scopeId &&
              Date.parse(use.returnedAt) <= Date.parse(boundary.clearedAt),
          ),
      );
      return (await tx.list<EffectTask>("effect_task", scopes))
        .filter((t) => Date.parse(t.createdAt) > Date.now() - 30 * 86400000)
        .map((t) => {
          const result = taskFeedback(
            t,
            uses
              .filter((u) => u.scopeId === t.scopeId && u.taskRef === t.taskRef)
              .map((u) => u.playbook),
          );
          return {
            id: t.id,
            revision: t.revision,
            scopeId: t.scopeId,
            taskRef: t.taskRef,
            ...result,
            classification: result.feedback.some(
              (f) => f.userRating === "incorrect",
            )
              ? "reported_problem"
              : result.feedback.some((f) => f.userRating === "helpful")
                ? "user_confirmed_helpful"
                : "needs_verification",
            events: t.events,
          };
        });
    };
    return transaction ? read(transaction) : this.store.transaction(read);
  }
  async clear(scopeId: string) {
    return this.store.transaction(async (tx) => {
      const old = await tx.get<{ revision: number }>(
        "effect_boundary",
        scopeId,
      );
      const boundary = {
        id: scopeId,
        scopeId,
        revision: (old?.revision ?? 0) + 1,
        clearedAt: new Date().toISOString(),
      };
      await tx.put(entry("effect_boundary", boundary), old?.revision ?? null);
      for (const t of await tx.list<EffectTask>("effect_task", [scopeId]))
        await tx.remove("effect_task", t.id, t.revision);
      for (const event of await tx.list<{
        id: string;
        revision: number;
        scopeId: string;
        hash: string;
        cleared: boolean;
      }>("effect_event", [scopeId]))
        await tx.put(
          entry("effect_event", {
            ...event,
            revision: event.revision + 1,
            cleared: true,
          }),
          event.revision,
        );
      for (const kind of [
        "effect_review",
        "review_notification",
        "review_issue",
      ])
        for (const row of await tx.list<{ id: string; revision: number }>(
          kind,
          [scopeId],
        ))
          await tx.remove(kind, row.id, row.revision);
      const schedule = await tx.get<{
        id: string;
        revision: number;
        scopeId: string;
        through: string;
      }>("review_schedule", scopeId);
      if (schedule)
        await tx.put(
          entry("review_schedule", {
            ...schedule,
            revision: schedule.revision + 1,
            through: boundary.clearedAt,
          }),
          schedule.revision,
        );
      return { accepted: true, clearedAt: boundary.clearedAt };
    });
  }
  async maintain(scopes: string[]) {
    return this.store.transaction(async (tx) => {
      const cutoff = Date.now() - 30 * 86400000;
      for (const receipt of await tx.list<{
        id: string;
        revision: number;
        occurredAt: string;
      }>("rating_receipt", scopes))
        if (Date.parse(receipt.occurredAt) < cutoff - 86400000)
          await tx.remove("rating_receipt", receipt.id, receipt.revision);
      for (const task of await tx.list<EffectTask>("effect_task", scopes)) {
        const events = task.events.filter(
          (e) => Date.parse(e.occurredAt) > cutoff,
        );
        if (events.length === task.events.length) continue;
        if (!events.length)
          await tx.remove("effect_task", task.id, task.revision);
        else
          await tx.put(
            entry("effect_task", {
              ...task,
              revision: task.revision + 1,
              events,
            }),
            task.revision,
          );
      }
      return { status: "completed" };
    });
  }
}
