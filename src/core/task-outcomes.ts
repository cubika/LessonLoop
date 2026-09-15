import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, byteSize } from "../domain/schema.js";
import type { HindsightEngine } from "../adapters/hindsight/engine.js";
import { ProductStore, type Transaction } from "../store/postgres.js";
import { ApiError, type Principal } from "./service.js";
import { retained, type TaskFeedback } from "./effects.js";

const observation = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(["user", "agent", "tool", "host"]),
    text: z.string().min(1).max(28000),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();
const captureSchema = z
  .object({
    taskRef: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    checkpoint: z
      .object({
        path: z.string().min(1).max(128),
        offset: z.number().int().nonnegative(),
      })
      .strict(),
    observations: z.array(observation).max(192),
    gaps: z.array(z.string().min(1).max(128)).max(32),
    trigger: z.enum(["userPromptTransformed", "agentStop", "sessionEnd"]),
  })
  .strict()
  .refine((v) => byteSize(v) <= 128 * 1024);
const resultSchema = z
  .object({
    taskOutcome: z.enum(["succeeded", "failed", "abandoned", "unknown"]),
    text: z.string().max(512),
    evidence: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            excerpt: z.string().min(1).max(512),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
type Observation = z.infer<typeof observation>;
type Task = {
  callerId: string;
  scopeId: string;
  hostSession?: boolean;
  erasedObservationHashes?: string[];
};
interface OutcomeState {
  id: string;
  scopeId: string;
  revision: number;
  token: string;
  checkpoint: z.infer<typeof captureSchema>["checkpoint"];
  observations: Observation[];
  gaps: string[];
  status: "collecting" | "queued" | "completed" | "unavailable";
  attempts: number;
  retryAt: number;
  updatedAt: number;
  usage?: { input_tokens: number; output_tokens: number };
}
const entry = <T extends { id: string; scopeId: string; revision: number }>(
  kind: string,
  value: T,
) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value: value as unknown as Record<string, unknown>,
});

// Review evidence stays in the product store. It is never retained as learning
// material or placed in a Hindsight bank. One state per session bounds storage.
export class TaskOutcomes {
  constructor(private readonly store: ProductStore) {}

  async capture(caller: Principal, input: unknown) {
    if (caller.channel !== "host")
      throw new ApiError("feedback_writer_denied", 403);
    const v = captureSchema.parse(input);
    return this.store.transaction(async (tx) => {
      const row = await tx.get<TaskFeedback>("task_feedback", v.taskRef);
      const task = await tx.get<Task>("task", v.taskRef);
      if (
        !row ||
        !retained(row) ||
        !task ||
        task.callerId !== caller.id ||
        task.scopeId !== row.scopeId ||
        !caller.scopes.includes(row.scopeId)
      )
        throw new ApiError("feedback_unavailable", 404);
      const setting = await tx.get<{ review: boolean; revision: number }>(
        "settings",
        row.scopeId,
      );
      if (!setting?.review) throw new ApiError("review_disabled", 409);
      if ((row.outcomeGeneration ?? 0) !== v.generation)
        throw new ApiError("outcome_generation_changed", 409);
      if (
        (await tx.get<{ pending: boolean }>("scope_barrier", row.scopeId))
          ?.pending
      )
        throw new ApiError("source_cleanup_pending", 409);
      // A user correction (including unknown) remains authoritative on resume.
      if (row.outcomeSource === "user" || row.outcomeSource === "host")
        return { accepted: true, ignored: true };
      const old = await tx.get<OutcomeState>("task_outcome", v.taskRef);
      if (
        old?.checkpoint.path === v.checkpoint.path &&
        old.checkpoint.offset > v.checkpoint.offset
      )
        return { accepted: true, ignored: true };
      const transient = [
        "transcript_unavailable",
        "transcript_identity_mismatch",
        "outcome_prompt_unavailable",
      ];
      const recovering = !v.gaps.some((g) => transient.includes(g));
      const gaps = new Set([
        ...(old?.gaps ?? []).filter(
          (g) => !recovering || !transient.includes(g),
        ),
        ...v.gaps,
      ]);
      if (task.erasedObservationHashes?.length) gaps.add("observation_erased");
      if (
        old &&
        old.checkpoint.path !== v.checkpoint.path &&
        !old.gaps.some((g) => transient.includes(g))
      )
        gaps.add("transcript_replaced");
      const observations = new Map(
        (old?.observations ?? []).map((o) => [o.id, o]),
      );
      for (const item of v.observations) {
        if (task.erasedObservationHashes?.includes(digest(item.text))) {
          gaps.add("observation_erased");
          continue;
        }
        const previous = observations.get(item.id);
        if (previous && digest(previous) !== digest(item))
          throw new ApiError("outcome_event_conflict", 409);
        observations.set(item.id, item);
      }
      const bounded = [...observations.values()].sort((a, b) =>
        a.occurredAt && b.occurredAt
          ? a.occurredAt.localeCompare(b.occurredAt)
          : 0,
      );
      // Keep the original goal and recent evidence. Any lost context prevents
      // a conclusive whole-session result.
      while (
        bounded.length > 192 ||
        byteSize({ observations: bounded, gaps: [...gaps] }) > 120 * 1024
      ) {
        bounded.splice(bounded.length > 16 ? 16 : 0, 1);
        gaps.add("outcome_input_budget");
      }
      const changed =
        !old ||
        digest([old.observations, old.gaps]) !== digest([bounded, [...gaps]]);
      const queue = v.trigger !== "userPromptTransformed";
      if (old && !changed && !(queue && old.status === "collecting")) {
        if (digest(old.checkpoint) !== digest(v.checkpoint))
          await tx.put(
            entry("task_outcome", {
              ...old,
              revision: old.revision + 1,
              checkpoint: v.checkpoint,
            }),
            old.revision,
          );
        return { accepted: true, duplicate: true };
      }
      const next: OutcomeState = {
        id: row.id,
        scopeId: row.scopeId,
        revision: (old?.revision ?? 0) + 1,
        token: randomUUID(),
        checkpoint: v.checkpoint,
        observations: bounded,
        gaps: [...gaps].slice(0, 32),
        status: queue ? "queued" : "collecting",
        attempts: 0,
        retryAt: 0,
        updatedAt: Date.now(),
      };
      await tx.put(entry("task_outcome", next), old?.revision ?? null);
      const feedback = {
        ...row,
        revision: row.revision + 1,
        taskOutcome: "unknown" as const,
        outcomeText: "",
        outcomeAssessment: "pending" as const,
        ...(task.hostSession ? { outcomeScope: "session" as const } : {}),
      };
      delete feedback.outcomeEvidence;
      delete feedback.outcomeSource;
      await tx.put(entry("task_feedback", feedback), row.revision);
      return { accepted: true };
    });
  }

  private async eligible(tx: Transaction, state: OutcomeState) {
    const current = await tx.get<OutcomeState>("task_outcome", state.id);
    if (
      !current ||
      current.token !== state.token ||
      current.status !== "queued"
    )
      return;
    const row = await tx.get<TaskFeedback>("task_feedback", state.id);
    const setting = await tx.get<{ review: boolean; revision: number }>(
      "settings",
      state.scopeId,
    );
    const task = await tx.get<Task>("task", state.id);
    return row &&
      retained(row) &&
      row.scopeId === state.scopeId &&
      !["user", "host"].includes(row.outcomeSource ?? "") &&
      task?.scopeId === state.scopeId &&
      !state.observations.some((o) =>
        task.erasedObservationHashes?.includes(digest(o.text)),
      ) &&
      setting?.review &&
      !(await tx.get<{ pending: boolean }>("scope_barrier", state.scopeId))
        ?.pending
      ? row
      : undefined;
  }

  async tick(
    engine: Pick<HindsightEngine, "assessTaskOutcome">,
    scopes?: string[],
  ) {
    const states = await this.store.transaction(async (tx) => {
      const selected: OutcomeState[] = [];
      for (const state of (await tx.list<OutcomeState>("task_outcome", scopes))
        .filter((s) => s.status === "queued" && s.retryAt <= Date.now())
        .sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (await this.eligible(tx, state)) selected.push(state);
        if (selected.length === 2) break;
      }
      return selected;
    });
    for (const state of states) {
      if (!(await this.store.transaction((tx) => this.eligible(tx, state))))
        continue;
      let result: z.infer<typeof resultSchema> | undefined;
      let usage: OutcomeState["usage"];
      try {
        const missingGoal = !state.observations.some(
          (o) => o.role === "user" && o.text.trim(),
        );
        const incomplete = state.gaps.length > 0 || missingGoal;
        const response = incomplete
          ? {
              result: {
                taskOutcome: "unknown",
                text: state.gaps.length
                  ? "会话材料不完整，暂时无法判断整体结果。"
                  : "缺少用户目标，暂时无法判断结果。",
                evidence: [],
              },
            }
          : await engine.assessTaskOutcome({
              observations: state.observations,
              gaps: state.gaps,
            });
        result = resultSchema.parse(response.result);
        if ("usage" in response) usage = response.usage;
        const evidence = result.evidence.map((e) => ({
          ...e,
          observation: state.observations.find((o) => o.id === e.id),
        }));
        if (
          evidence.some(
            (e) =>
              !e.excerpt.trim() || !e.observation?.text.includes(e.excerpt),
          )
        )
          throw new Error("outcome_evidence_unbound");
        const substantive = evidence.some(
          (e) =>
            e.observation?.role === "user" ||
            (result!.taskOutcome !== "abandoned" &&
              e.observation?.role === "tool"),
        );
        if (
          state.gaps.length ||
          (result.taskOutcome !== "unknown" &&
            (!substantive ||
              !state.observations.some((o) => o.role === "user")))
        )
          result = {
            taskOutcome: "unknown",
            text: state.gaps.length
              ? "会话材料不完整，暂时无法判断整体结果。"
              : "缺少用户目标或可核实的结果依据。",
            evidence: [],
          };
      } catch {
        // Reject the entire candidate if schema or evidence validation failed.
        result = undefined;
      }
      await this.store.transaction(async (tx) => {
        const current = await tx.get<OutcomeState>("task_outcome", state.id);
        if (
          !current ||
          current.token !== state.token ||
          current.status !== "queued"
        )
          return;
        const row = await this.eligible(tx, state);
        if (!row) return;
        const next = {
          ...current,
          revision: current.revision + 1,
          attempts: current.attempts + 1,
        };
        if (result) {
          next.status = "completed";
          if (usage) next.usage = usage;
          await tx.put(
            entry("task_feedback", {
              ...row,
              revision: row.revision + 1,
              taskOutcome: result.taskOutcome,
              outcomeText: result.text,
              outcomeSource: "ai",
              outcomeAssessment: "completed",
              outcomeEvidence: result.evidence.map((e) => ({
                role: state.observations.find((o) => o.id === e.id)!.role,
                excerpt: e.excerpt,
              })),
            }),
            row.revision,
          );
        } else {
          next.status = next.attempts >= 3 ? "unavailable" : "queued";
          next.retryAt = Date.now() + next.attempts * 30000;
          await tx.put(
            entry("task_feedback", {
              ...row,
              revision: row.revision + 1,
              outcomeAssessment: "unavailable",
            }),
            row.revision,
          );
        }
        await tx.put(entry("task_outcome", next), current.revision);
      });
    }
  }

  static async invalidate(
    tx: Transaction,
    scopeId: string,
    taskId?: string,
    preserveResult = false,
  ) {
    for (const state of await tx.list<OutcomeState>("task_outcome", [
      scopeId,
    ])) {
      if (taskId && state.id !== taskId) continue;
      await tx.remove("task_outcome", state.id, state.revision);
    }
    for (const row of await tx.list<TaskFeedback>("task_feedback", [scopeId])) {
      if (taskId && row.id !== taskId) continue;
      const next = {
        ...row,
        revision: row.revision + 1,
        outcomeGeneration: (row.outcomeGeneration ?? 0) + 1,
      };
      if (
        !preserveResult &&
        row.outcomeSource !== "user" &&
        row.outcomeSource !== "host"
      ) {
        next.taskOutcome = "unknown";
        next.outcomeText = "";
        delete next.outcomeSource;
        delete next.outcomeEvidence;
        delete next.outcomeAssessment;
      }
      if (preserveResult && next.outcomeAssessment === "pending")
        delete next.outcomeAssessment;
      await tx.put(entry("task_feedback", next), row.revision);
    }
  }
}
