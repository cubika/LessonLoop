import { z } from "zod";
import { ProductStore, Conflict } from "../store/postgres.js";
import { identity, digest, byteSize, refSchema } from "../domain/schema.js";
const eventSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    taskRef: z.string().min(1).max(128),
    scopeId: z.string().min(1).max(128),
    kind: z.enum([
      "task_started",
      "task_ended",
      "delivery",
      "usage",
      "outcome",
      "user_rating",
      "collection_gap",
    ]),
    occurredAt: z.string().datetime(),
    method: refSchema.optional(),
    methodUseRef: z.string().max(128).optional(),
    stepId: z.string().max(128).optional(),
    text: z.string().min(1).max(512),
    outcome: z.enum(["succeeded", "failed", "abandoned", "unknown"]).optional(),
    rating: z.enum(["helpful", "incorrect", "irrelevant"]).optional(),
  })
  .strict()
  .refine(
    (e) => e.kind !== "outcome" || e.outcome !== undefined,
    "outcome_required",
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
    if (caller.channel !== "host") throw new Error("trusted_host_required");
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
          const id = digest([caller.id, event.scopeId, event.taskRef]);
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
          const actual = await tx.get<{ callerId: string; scopeId: string }>(
            "task",
            event.taskRef,
          );
          if (
            !actual ||
            actual.callerId !== caller.id ||
            actual.scopeId !== event.scopeId
          )
            throw new Error("task_identity_mismatch");
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
                callerId: caller.id,
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
      const n = tasks.length;
      const count = (kind: Event["kind"], value?: string) =>
        tasks.filter((t) =>
          t.events.some(
            (e) =>
              e.kind === kind &&
              (!value || e.outcome === value || e.rating === value),
          ),
        ).length;
      return {
        tasks: n,
        coverage: "tasks_with_received_observations",
        ended: count("task_ended"),
        delivered: count("delivery"),
        usageObserved: count("usage"),
        succeeded: count("outcome", "succeeded"),
        failed: count("outcome", "failed"),
        abandoned: count("outcome", "abandoned"),
        unknownOutcome: tasks.filter(
          (t) =>
            !t.events.some(
              (e) =>
                e.kind === "outcome" &&
                e.outcome !== undefined &&
                e.outcome !== "unknown",
            ),
        ).length,
        helpful: count("user_rating", "helpful"),
        reportedIncorrect: count("user_rating", "incorrect"),
        deliveryRate: n ? count("delivery") / n : null,
        successRate: n ? count("outcome", "succeeded") / n : null,
        causalBenefit: "not_inferred",
        windowDays: 30,
      };
    });
  }
  async cases(scopes: string[]) {
    return this.store.transaction(async (tx) =>
      (await tx.list<EffectTask>("effect_task", scopes))
        .filter((t) => Date.parse(t.createdAt) > Date.now() - 30 * 86400000)
        .map((t) => ({
          id: t.id,
          revision: t.revision,
          scopeId: t.scopeId,
          taskRef: t.taskRef,
          classification: t.events.some(
            (e) => e.kind === "user_rating" && e.rating === "incorrect",
          )
            ? "reported_problem"
            : t.events.some(
                  (e) => e.kind === "user_rating" && e.rating === "helpful",
                )
              ? "user_confirmed_helpful"
              : "needs_verification",
          events: t.events,
        })),
    );
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
      return { accepted: true, clearedAt: boundary.clearedAt };
    });
  }
}
