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
type Playbook = { kind: "playbook"; id: string; revision: number };
type State = {
  taskRef?: string;
  collectionGap?: string;
  cursor?: TranscriptCursor;
  tools: Record<string, string>;
  prompts: Array<{
    key: string;
    responseDigest?: string;
    playbook?: Playbook;
    feedbackRevision?: number | undefined;
  }>;
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
): Promise<Record<string, unknown>> {
  // Official prompt/stop hooks are sufficient. Tool and user material comes
  // only from the transcript, avoiding a second ingestion/reconciliation path.
  if (
    !["userPromptTransformed", "agentStop", "sessionEnd"].includes(type) ||
    event.agentId ||
    event.parentToolCallId ||
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
  const sessionKey = digest([cwd, event.sessionId, config.scopeId]);
  const path = join(config.stateRoot, `${sessionKey}.json`);
  const lock = `${path}.lock`;
  let locked = false;
  for (let retry = 0; retry < 20 && !locked; retry++) {
    try {
      await mkdir(lock);
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - (await stat(lock)).mtimeMs > 120000)
        await rmdir(lock).catch(() => {});
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (!locked) throw new Error("hook_state_busy");
  try {
    let state: State = { tools: {}, prompts: [] };
    try {
      state = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(state.prompts) || !state.tools)
        throw new Error("host_session_restart_required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = join(
        config.stateRoot,
        `${digest([cwd, event.sessionId])}.json`,
      );
      if (
        await stat(legacy).then(
          () => true,
          (e) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        )
      )
        throw new Error("host_session_restart_required");
    }
    const save = async () => {
      await writeFile(`${path}.tmp`, JSON.stringify(state));
      await rename(`${path}.tmp`, path);
    };
    // Reuse the existing durable task binding. Stops and resumed sessions
    // never create another LessonLoop task or require boundary synchronization.
    const { taskRef } = await call(
      "startTask",
      { scopeId: config.scopeId, eventId: `copilot-session:${sessionKey}` },
      sessionKey,
    );
    state.taskRef = taskRef;
    const transcript = await readTranscript(event, cwd, state.cursor);
    const gaps = new Set(transcript.gaps);
    for (const record of transcript.records) {
      if (record.agentId || record.data.parentToolCallId) continue;
      const at = eventTime(record.timestamp);
      const data = record.data;
      if (
        record.type === "tool.execution_start" &&
        typeof data.toolCallId === "string" &&
        typeof data.toolName === "string"
      ) {
        state.tools[data.toolCallId] = data.toolName;
        if (Object.keys(state.tools).length > 128)
          delete state.tools[Object.keys(state.tools)[0]!];
      }
      if (
        record.type === "hook.end" &&
        data.hookType === "userPromptTransformed" &&
        data.success &&
        at
      ) {
        const output = data.output?.modifiedTransformedPrompt;
        const receipt =
          typeof output === "string"
            ? state.prompts.find((p) => p.responseDigest === digest(output))
            : undefined;
        if (
          setting.review &&
          receipt?.playbook &&
          receipt.feedbackRevision !== undefined
        ) {
          try {
            await call(
              "updateTaskFeedback",
              {
                taskRef,
                field: "delivered",
                playbookId: receipt.playbook.id,
                revision: receipt.playbook.revision,
                expectedRevision: receipt.feedbackRevision,
              },
              "delivery",
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              ![
                "revision_conflict",
                "feedback_unavailable",
                "review_disabled",
              ].includes(error.message)
            )
              throw error;
          }
        }
      }
      let segment = transcriptEvent(record);
      if (record.type === "tool.execution_complete") {
        const name = state.tools[data.toolCallId];
        if (!name) {
          gaps.add("tool_identity_unavailable");
          continue;
        }
        if (isProductTool(name)) continue;
        const result =
          data.result && typeof data.result === "object"
            ? { ...data.result, success: data.success }
            : { content: data.result ?? data.error, success: data.success };
        segment = {
          role: "tool",
          text: toolText(name, undefined, result),
          eventId: record.id,
        };
      }
      if (!setting.learning || !segment?.text.trim()) continue;
      if (Buffer.byteLength(segment.text) > 28000) {
        gaps.add("source_input_budget");
        continue;
      }
      try {
        await call(
          "submitSource",
          {
            scopeId: config.scopeId,
            context: { taskRef },
            segments: [
              {
                text: segment.text,
                role: segment.role,
                locator: `copilot:${event.sessionId}`,
                ...(at ? { observedAt: at } : {}),
              },
            ],
          },
          digest([sessionKey, record.id ?? record]),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            "source_input_budget",
            "source_erased_from_task",
            "source_forgotten",
            "source_unavailable",
            "learning_disabled",
          ].includes(error.message)
        )
          throw error;
        gaps.add(error.message);
      }
    }
    if (gaps.size) {
      state.collectionGap = [...gaps].join(", ");
      process.stderr.write(
        "LessonLoop collection incomplete: " +
          state.collectionGap +
          "." +
          String.fromCharCode(10),
      );
    }
    // Failed submissions leave the previous checkpoint intact. Replays use
    // transcript identities and timestamps, not callback receipt times.
    if (transcript.cursor) state.cursor = transcript.cursor;
    await save();
    if (type !== "userPromptTransformed" || !setting.recommendation) return {};
    const prompt = stripInjectedMemory(
      event.prompt ?? event.transformedPrompt ?? "",
    ).trim();
    const key = digest([sessionKey, event.timestamp, prompt]);
    if (!prompt || state.prompts.some((p) => p.key === key)) return {};
    const guidance = await call(
      "getGuidance",
      { taskRef, query: prompt.slice(0, 2048) },
      key,
    );
    const prepared = guidance.playbooks?.[0];
    const receipt: State["prompts"][number] = { key };
    state.prompts = [...state.prompts, receipt].slice(-32);
    if (!guidance.playbooks?.length && !guidance.experiences?.length) {
      await save();
      return {};
    }
    const output = promptEnvelope(
      event,
      `<lessonloop-playbook>\n${JSON.stringify(guidance)}\nUse applicable guidance and choose branches from current observations. Reuse taskRef for getGuidance. For requires_expansion, call getGuidance with the same taskRef, target: playbook and viewMode: expanded.\n</lessonloop-playbook>`,
    );
    if (prepared?.status === "guidance")
      Object.assign(receipt, {
        playbook: prepared.playbook,
        feedbackRevision: prepared.feedbackRevision,
        responseDigest: digest(output.modifiedTransformedPrompt),
      });
    await save();
    return output;
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
    .catch((error) => {
      process.stderr.write(
        error.message === "host_session_restart_required"
          ? "LessonLoop collection changed; start a new Copilot session to enable it.\n"
          : "LessonLoop hook unavailable; continue the task and inspect doctor.\n",
      );
      process.stdout.write("{}");
    });
