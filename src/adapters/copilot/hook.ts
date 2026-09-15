import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  rename,
  rmdir,
  stat,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "../../domain/schema.js";
import {
  promptEnvelope,
  eventTime,
  transcriptEvent,
  toolText,
  isProductTool,
  stripInjectedMemory,
  type HookEvent,
} from "./protocol.js";
import { readTranscript, type TranscriptCursor } from "./transcript.js";

export type Config = {
  baseUrl: string;
  token: string;
  scopeId: string;
  allowedRoots: string[];
  stateRoot: string;
};
type Call = (operation: string, input: any, key: string) => Promise<any>;
type Method = { kind: "playbook"; id: string; revision: number };
type Task = {
  taskRef: string;
  startedAt: string;
  endedAt?: string;
  stopped?: boolean;
  method?: Method;
  playbookUseRef?: string;
  prompts: Array<{
    key: string;
    digest: string;
    responseDigest?: string;
    done?: boolean;
    method?: Method;
    playbookUseRef?: string;
  }>;
  materials: string[];
  observations: string[];
  effects: string[];
  lastAgentDigest?: string;
};
type State = {
  tasks: Task[];
  cursor?: TranscriptCursor;
  tools: Record<string, { name: unknown; eventId?: string }>;
};
const api =
  (config: Config): Call =>
  async (operation, input, key) => {
    const base = new URL(config.baseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
      throw new Error("host_api_must_be_local");
    const response = await fetch(new URL("/v1/rpc", base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ operation, input }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as { result: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? "host_api_failed");
    return body.result;
  };

export async function handleHook(
  config: Config,
  event: HookEvent,
  type: string,
  call: Call = api(config),
) {
  if (event.agentId || event.parentToolCallId) return {};
  if (
    !event.sessionId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(event.sessionId) ||
    !event.cwd
  )
    return {};
  const cwd = await realpath(event.cwd);
  let allowed = false;
  for (const root of config.allowedRoots) {
    const rel = relative(await realpath(root), cwd);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) allowed = true;
  }
  if (!allowed) return {};
  const settings = (await call("settings.get", {}, "settings")) as Array<{
    scopeId: string;
    learning: boolean;
    recommendation: boolean;
    review: boolean;
  }>;
  const setting = settings.find((v) => v.scopeId === config.scopeId);
  if (!setting) return {};
  await mkdir(config.stateRoot, { recursive: true });
  const path = join(config.stateRoot, `${digest([cwd, event.sessionId])}.json`);
  const lock = `${path}.lock`;
  // A busy hook fails open; the next transcript read recovers missed events.
  let locked = false;
  let recoveredLock = false;
  for (let retry = 0; retry < 20 && !locked; retry++) {
    try {
      await mkdir(lock);
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - (await stat(lock)).mtimeMs > 120000) {
        try {
          await rmdir(lock);
          recoveredLock = true;
        } catch {
          /* Another callback may already have recovered it. */
        }
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (!locked) throw new Error("hook_state_busy");
  try {
    let state: State = { tasks: [], tools: {} };
    try {
      const previous = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(previous.tasks)) throw new Error("hook_state_invalid");
      state = previous;
      // Keep replay and feedback identities when opening pre-Playbook hook state.
      for (const task of state.tasks) {
        for (const record of [task, ...task.prompts]) {
          const old = record as typeof record & {
            method?: Method;
            methodUseRef?: string;
          };
          if (old.method) record.method = { ...old.method, kind: "playbook" };
          if (!record.playbookUseRef && old.methodUseRef)
            record.playbookUseRef = old.methodUseRef;
          delete old.methodUseRef;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const save = async () => {
      await writeFile(`${path}.tmp`, JSON.stringify(state));
      await rename(`${path}.tmp`, path);
    };
    const now = eventTime(event.timestamp) ?? new Date().toISOString();
    const current = () => state.tasks.at(-1);
    const taskAt = (time: string) =>
      [...state.tasks].reverse().find((t) => t.startedAt <= time);
    const effect = async (
      task: Task,
      kind: string,
      id: string,
      text: string,
      at = now,
      extra: Record<string, unknown> = {},
    ) => {
      if (
        !setting.review ||
        task.effects.includes(id) ||
        task.effects.length >= 64
      )
        return;
      const result = await call(
        "recordTaskObservation",
        [
          {
            eventId: id,
            taskRef: task.taskRef,
            scopeId: config.scopeId,
            kind,
            occurredAt: at,
            text: text.slice(0, 512),
            ...extra,
          },
        ],
        id,
      );
      const status = result.results?.[0]?.status;
      if (["accepted", "duplicate", "ignored"].includes(status)) {
        task.effects.push(id);
        await save();
      } else if (status === "retryable") throw new Error("effect_retryable");
    };
    const gap = (task: Task, reason: string, at = now) =>
      effect(
        task,
        "collection_gap",
        digest([task.taskRef, "gap", reason]),
        `Copilot collection incomplete: ${reason}.`,
        at,
      );
    const material = async (
      task: Task,
      text: string,
      role: "user" | "agent" | "tool",
      id: string,
      at: string,
    ) => {
      if (!setting.learning || task.materials.includes(id) || !text.trim())
        return;
      if (Buffer.byteLength(text) > 28000 || task.materials.length >= 16) {
        await gap(task, "material_budget", at);
        return;
      }
      try {
        await call(
          "submitSource",
          {
            scopeId: config.scopeId,
            segments: [
              {
                text,
                role,
                locator: `copilot:${event.sessionId}:${task.taskRef}`,
                observedAt: at,
              },
            ],
            context: { taskRef: task.taskRef },
          },
          id,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            "task_material_budget",
            "source_erased_from_task",
            "source_forgotten",
            "learning_disabled",
          ].includes(error.message)
        )
          throw error;
        await gap(task, error.message, at);
      }
      task.materials.push(id);
      if (role === "agent") task.lastAgentDigest = digest(text);
      await save();
    };
    const observeTool = async (
      task: Task,
      text: string,
      id: string,
      at: string,
    ) => {
      if (task.observations.includes(id)) return;
      if (task.endedAt) {
        await gap(task, "late_tool_after_end", at);
        return;
      }
      if (Buffer.byteLength(text) > 16000 || task.observations.length >= 16) {
        await gap(task, "observation_budget", at);
        return;
      }
      try {
        await call(
          "recordHostObservation",
          { taskRef: task.taskRef, eventId: id, text, occurredAt: at },
          id,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["task_observations_too_large", "observation_erased"].includes(
            error.message,
          )
        )
          throw error;
        await gap(task, error.message, at);
      }
      task.observations.push(id);
      await save();
    };
    const finish = async (task: Task, at: string, reason: string) => {
      if (task.endedAt) return;
      const outcome = ["error", "timeout"].includes(reason)
        ? "failed"
        : ["abort", "user_exit"].includes(reason)
          ? "abandoned"
          : "unknown";
      await effect(
        task,
        "outcome",
        digest([task.taskRef, "outcome"]),
        `Copilot host execution ended (${reason}); task goal success was not inferred.`,
        at,
        { outcome },
      );
      await effect(
        task,
        "task_ended",
        digest([task.taskRef, "ended"]),
        `Copilot task boundary: ${reason}.`,
        at,
      );
      await call(
        "observeTask",
        {
          taskRef: task.taskRef,
          eventId: "copilot-ended",
          text: "Copilot task ended. Task success was not inferred.",
          values: {},
          completedStepIds: [],
          conditionResults: {},
          ended: true,
        },
        digest([task.taskRef, "ended"]),
      );
      task.endedAt = at;
      await save();
    };
    const prompt = stripInjectedMemory(
      event.prompt ?? event.transformedPrompt ?? "",
    );
    const promptKey = digest([event.sessionId, event.timestamp ?? "", prompt]);
    const replayTask = state.tasks.find((t) =>
      t.prompts.some((p) => p.key === promptKey && p.done),
    );
    const replay = replayTask?.prompts.find(
      (p) => p.key === promptKey && p.done,
    );
    if (type === "userPromptTransformed" && replayTask?.endedAt) return {};
    // A replay must not re-inject a method that may have since been withdrawn.
    if (type === "userPromptTransformed" && replay) return {};
    const marker = /^\s*\/lessonloop\s+(new|continue)\b/i
      .exec(prompt)?.[1]
      ?.toLowerCase();
    if (type === "userPromptTransformed") {
      const old = current();
      if (old && (now < old.startedAt || (old.endedAt && now <= old.endedAt))) {
        await gap(old, "late_prompt");
        return {};
      }
      if (
        old &&
        !old.endedAt &&
        (marker === "new" || (old.stopped && marker !== "continue"))
      )
        await finish(old, now, "new_prompt");
      if (!old || old.endedAt) {
        const task = await call(
          "startTask",
          {
            scopeId: config.scopeId,
            eventId: digest([cwd, event.sessionId, promptKey]),
          },
          promptKey,
        );
        state.tasks.push({
          taskRef: task.taskRef,
          startedAt: now,
          prompts: [],
          materials: [],
          observations: [],
          effects: [],
        });
        state.tasks = state.tasks.slice(-8);
        await save();
      }
    }
    const active = current();
    if (!active) return {};
    if (recoveredLock) await gap(active, "interrupted_hook");
    const transcript = await readTranscript(event, cwd, state.cursor);
    let toolCallId = event.toolCallId;
    for (const record of transcript.records) {
      if (record.agentId || record.data.parentToolCallId) continue;
      const at = eventTime(record.timestamp) ?? now;
      const task = taskAt(at);
      if (!task) continue;
      const data = record.data;
      if (
        record.type === "tool.execution_start" &&
        typeof data.toolCallId === "string"
      ) {
        state.tools[data.toolCallId] = {
          name: data.toolName,
          ...(record.id ? { eventId: record.id } : {}),
        };
        if (Object.keys(state.tools).length > 32)
          delete state.tools[Object.keys(state.tools)[0]!];
      }
      if (
        record.type === "hook.start" &&
        data.hookType === "postToolUse" &&
        data.input?.timestamp === event.timestamp &&
        record.parentId
      )
        toolCallId ??= Object.entries(state.tools).find(
          ([, t]) => t.eventId === record.parentId,
        )?.[0];
      if (
        record.type === "hook.end" &&
        data.hookType === "userPromptTransformed" &&
        data.success === true
      ) {
        const output = data.output?.modifiedTransformedPrompt;
        const returned =
          typeof output === "string"
            ? task.prompts.find((p) => p.responseDigest === digest(output))
            : undefined;
        if (returned?.method && returned.playbookUseRef)
          await effect(
            task,
            "delivery",
            digest([task.taskRef, "delivery", record.id ?? output]),
            "Copilot acknowledged the transformed prompt containing this method.",
            at,
            {
              playbook: returned.method,
              playbookUseRef: returned.playbookUseRef,
            },
          );
      }
      if (record.type === "tool.execution_complete") {
        const start = state.tools[data.toolCallId];
        // Product guidance is not independent evidence of execution.
        if (isProductTool(start?.name)) continue;
        const result =
          data.result && typeof data.result === "object"
            ? { ...data.result, success: data.success }
            : { content: data.result ?? data.error, success: data.success };
        const text = toolText(start?.name, undefined, result);
        const id = digest([
          task.taskRef,
          "tool",
          data.toolCallId ?? record.id,
          text,
        ]);
        await observeTool(task, text, id, at);
        await material(task, text, "tool", id, at);
      } else {
        const segment = transcriptEvent(record);
        if (segment) {
          if (
            segment.role === "user" &&
            task.prompts.some((p) => p.digest === digest(segment.text))
          )
            continue;
          await material(
            task,
            segment.text,
            segment.role,
            digest([
              task.taskRef,
              record.id ?? [segment.role, segment.text, at],
            ]),
            at,
          );
        }
      }
    }
    if (transcript.cursor) state.cursor = transcript.cursor;
    if (["agentStop", "sessionEnd"].includes(type))
      for (const reason of transcript.gaps) await gap(active, reason);
    await save();
    const task = taskAt(now);
    if (!task) return {};
    if (
      type === "postToolUse" &&
      event.toolResult !== undefined &&
      !isProductTool(event.toolName)
    ) {
      const text = toolText(event.toolName, event.toolArgs, event.toolResult);
      const id = digest([
        task.taskRef,
        "tool",
        toolCallId ?? event.timestamp,
        text,
      ]);
      await observeTool(task, text, id, now);
      await material(task, text, "tool", id, now);
    }
    if (type === "userPromptTransformed") {
      task.stopped = false;
      let output: Record<string, unknown> = {};
      const promptRecord: Task["prompts"][number] = task.prompts.find(
        (p) => p.key === promptKey,
      ) ?? {
        key: promptKey,
        digest: digest(prompt),
        done: false,
      };
      if (!task.prompts.includes(promptRecord)) task.prompts.push(promptRecord);
      task.prompts = task.prompts.slice(-32);
      await material(
        task,
        prompt,
        "user",
        digest([task.taskRef, "prompt", promptKey]),
        now,
      );
      if (setting.recommendation && prompt.trim()) {
        if (!task.method) {
          const search = await call(
            "searchPlaybooks",
            {
              query:
                prompt
                  .replace(/^\s*\/lessonloop\s+(new|continue)\s*/i, "")
                  .slice(0, 2048) || prompt.slice(0, 2048),
            },
            "search",
          );
          task.method = search.results[0]?.playbook;
        }
        if (task.method) {
          const prepared = await call(
            "preparePlaybook",
            {
              playbookId: task.method.id,
              revision: task.method.revision,
              taskRef: task.taskRef,
              requestId: promptKey,
            },
            promptKey,
          );
          if (prepared.status === "guidance") {
            task.playbookUseRef = prepared.playbookUseRef;
            promptRecord.method = task.method;
            if (task.playbookUseRef)
              promptRecord.playbookUseRef = task.playbookUseRef;
            output = promptEnvelope(
              event,
              `<lessonloop-playbook task="${task.taskRef}">\n${JSON.stringify(prepared)}\nUse this complete playbook as guidance. Check its conditions, execute the relevant steps, and choose branches from current observations. The playbookUseRef only links feedback. /lessonloop new starts a separate task; /lessonloop continue keeps this task after a completed turn.\n</lessonloop-playbook>`,
            );
            promptRecord.responseDigest = digest(
              output.modifiedTransformedPrompt,
            );
          } else if (prepared.status === "requires_expansion") {
            output = promptEnvelope(
              event,
              "<lessonloop-playbook>" +
                JSON.stringify({
                  ...prepared,
                  taskRef: task.taskRef,
                  playbook: task.method,
                }) +
                " Full guidance exceeds the automatic budget. Call getGuidance with input {taskRef, target: playbook, viewMode: 'expanded'} using these references (viewMode=expanded).</lessonloop-playbook>",
            );
          } else {
            if (prepared.reason) await gap(task, prepared.reason);
          }
        }
      }
      promptRecord.done = true;
      await save();
      return output;
    }
    if (type === "agentStop") {
      task.stopped = true;
      await save();
    }
    if (type === "sessionEnd") {
      if (
        event.finalMessage &&
        task.lastAgentDigest !==
          digest(stripInjectedMemory(event.finalMessage).trim())
      )
        await material(
          task,
          stripInjectedMemory(event.finalMessage).trim(),
          "agent",
          digest([task.taskRef, "final", event.finalMessage]),
          now,
        );
      await finish(task, now, event.reason ?? "session_end");
    }
    // Copilot can dispatch sessionStart after userPromptTransformed. A new
    // session has its own sessionId; this notification must not close its task.
    return {};
  } finally {
    await rmdir(lock);
  }
}

async function run() {
  const config = JSON.parse(
    process.env.LESSONLOOP_HOST_CONFIG_JSON ??
      (await readFile(process.env.LESSONLOOP_HOST_CONFIG ?? "", "utf8")),
  ) as Config;
  let raw = "";
  for await (const part of process.stdin) {
    raw += part;
    if (Buffer.byteLength(raw) > 262144)
      throw new Error("hook_input_too_large");
  }
  return handleHook(
    config,
    JSON.parse(raw) as HookEvent,
    process.argv[2] ?? "",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  run()
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch(() => {
      process.stderr.write(
        "LessonLoop hook unavailable; continue the task and inspect doctor.\n",
      );
      process.stdout.write("{}");
    });
