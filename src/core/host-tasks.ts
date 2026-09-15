import { z } from "zod";
import { digest, identity, id } from "../domain/schema.js";
import { ApiError, type CoreService, type Principal } from "./service.js";
import { Effects } from "./effects.js";

const inputSchema = z
  .object({
    scopeId: id,
    sessionKey: id,
    occurredAt: z.string().datetime(),
    action: z.enum(["read", "prompt", "stop", "end"]),
    promptKey: id.optional(),
    boundary: z.enum(["new", "continue"]).optional(),
    reason: z.string().max(128).optional(),
  })
  .strict()
  .refine((v) => v.action !== "prompt" || !!v.promptKey);

export interface HostTaskBinding {
  taskRef: string;
  startedAt: string;
  endedAt?: string;
}
type HostTask = {
  id: string;
  revision: number;
  scopeId: string;
  callerId: string;
  hostSession: string;
  hostStartedAt: string;
  hostPrompts: string[];
  hostBoundaryAt: string;
  values: Record<string, string | string[]>;
  observations: unknown[];
  stopped?: boolean;
  ended: boolean;
  endedAt?: string;
};
const row = (task: HostTask) => ({
  kind: "task",
  id: task.id,
  scopeId: task.scopeId,
  revision: task.revision,
  value: task,
});

// The core owns task boundaries. The host retains only capture and injection
// receipts; a lost response can replay this operation without starting or
// closing a second task. Closure and optional effect events commit together.
export async function hostTaskBoundary(
  core: CoreService,
  p: Principal,
  raw: unknown,
) {
  if (p.channel !== "host") throw new ApiError("trusted_host_required", 403);
  const v = inputSchema.parse(raw);
  if (!p.scopes.includes(v.scopeId)) throw new ApiError("not_found", 404);
  return core.store.transaction(async (tx) => {
    const tasks = (await tx.list<HostTask>("task", [v.scopeId]))
      .filter((t) => t.callerId === p.id && t.hostSession === v.sessionKey)
      .sort((a, b) => a.hostStartedAt.localeCompare(b.hostStartedAt));
    const effects = async (events: unknown[]) => {
      const result = await new Effects(core.store).record(p, events, tx);
      if (
        result.results.some((r) => ["retryable", "conflict"].includes(r.status))
      )
        throw new Error("host_effect_retryable");
    };
    const save = async (task: HostTask) => {
      const revision = task.revision;
      task.revision++;
      await tx.put(row(task), revision);
    };
    const close = async (task: HostTask, reason: string) => {
      if (task.ended) return;
      const base = {
        taskRef: task.id,
        scopeId: v.scopeId,
        occurredAt: v.occurredAt,
      };
      await effects([
        {
          ...base,
          eventId: digest([task.id, "ended"]),
          kind: "task_ended",
          text: `Copilot task boundary: ${reason}.`,
        },
      ]);
      task.ended = true;
      task.endedAt = v.occurredAt;
      await save(task);
    };
    let task = [...tasks]
      .reverse()
      .find((t) => t.hostStartedAt <= v.occurredAt);
    let late = false;
    if (v.action === "prompt") {
      const replay = tasks.find((t) => t.hostPrompts.includes(v.promptKey!));
      const old = tasks.at(-1);
      late =
        !replay &&
        !!old &&
        (v.occurredAt < old.hostBoundaryAt ||
          (old.ended && v.occurredAt <= old.endedAt!));
      if (replay) task = replay;
      else if (!late) {
        if (
          old &&
          !old.ended &&
          (v.boundary === "new" || (old.stopped && v.boundary !== "continue"))
        )
          await close(old, "new_prompt");
        task = old;
        if (!task || task.ended) {
          task = {
            ...identity(v.scopeId),
            id: digest([p.id, v.scopeId, v.sessionKey, v.promptKey]),
            callerId: p.id,
            hostSession: v.sessionKey,
            hostStartedAt: v.occurredAt,
            hostPrompts: [v.promptKey!],
            hostBoundaryAt: v.occurredAt,
            ended: false,
            values: {},
            observations: [],
          };
          await tx.put(row(task), null);
          tasks.push(task);
          await effects([
            {
              eventId: `started:${task.id}`,
              taskRef: task.id,
              scopeId: v.scopeId,
              kind: "task_started",
              occurredAt: v.occurredAt,
              text: "Trusted host task started",
            },
          ]);
        } else {
          task.hostPrompts = [...task.hostPrompts, v.promptKey!].slice(-32);
          task.stopped = false;
          task.hostBoundaryAt = v.occurredAt;
          await save(task);
        }
      }
    } else if (task && !task.ended && v.occurredAt >= task.hostBoundaryAt) {
      if (v.action === "stop") {
        task.stopped = true;
        task.hostBoundaryAt = v.occurredAt;
        await save(task);
      }
      if (v.action === "end") await close(task, v.reason ?? "session_end");
    }
    return {
      late,
      taskRef: task?.id,
      tasks: tasks.slice(-8).map(
        (t) =>
          ({
            taskRef: t.id,
            startedAt: t.hostStartedAt,
            ...(t.endedAt ? { endedAt: t.endedAt } : {}),
          }) satisfies HostTaskBinding,
      ),
    };
  });
}
