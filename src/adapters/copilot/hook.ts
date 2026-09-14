import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { digest } from "../../domain/schema.js";
import { promptEnvelope, eventTime, type HookEvent } from "./protocol.js";
type Config = {
  baseUrl: string;
  token: string;
  scopeId: string;
  allowedRoots: string[];
  stateRoot: string;
};
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
  const event = JSON.parse(raw) as HookEvent;
  const type = process.argv[2];
  if (!event.sessionId || !event.cwd) return {};
  const cwd = await realpath(event.cwd);
  let allowed = false;
  for (const root of config.allowedRoots) {
    const actual = await realpath(root);
    const rel = relative(actual, cwd);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) allowed = true;
  }
  if (!allowed) return {};
  const base = new URL(config.baseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("host_api_must_be_local");
  const call = async (operation: string, input: unknown, key: string) => {
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
    if (!response.ok) throw new Error(body.error);
    return body.result;
  };
  await mkdir(config.stateRoot, { recursive: true });
  const path = join(config.stateRoot, `${digest([cwd, event.sessionId])}.json`);
  let state:
    | {
        taskRef: string;
        promptDigest: string;
        ended: boolean;
        methodUseRef?: string;
      }
    | undefined;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  const settings = (await call("settings.get", {}, "settings")) as Array<{
    scopeId: string;
    learning: boolean;
    recommendation: boolean;
  }>;
  const setting = settings.find((v) => v.scopeId === config.scopeId);
  if (!setting) return {};
  if (type === "userPromptTransformed") {
    const prompt = event.prompt ?? event.transformedPrompt ?? "";
    const promptDigest = digest(prompt);
    if (!state || state.ended) {
      const task = (await call(
        "startTask",
        {
          scopeId: config.scopeId,
          eventId: digest([cwd, event.sessionId]),
        },
        "task",
      )) as { taskRef: string };
      state = { taskRef: task.taskRef, promptDigest, ended: false };
      await writeFile(path, JSON.stringify(state));
    }
    if (setting.learning)
      await call(
        "submitMaterial",
        {
          scopeId: config.scopeId,
          segments: [
            {
              text: prompt,
              role: "user",
              locator: `copilot:${event.sessionId}:${state.taskRef}`,
            },
          ],
          context: { taskRef: state.taskRef },
        },
        digest([state.taskRef, "prompt", event.timestamp ?? promptDigest]),
      );
    if (!setting.recommendation) return {};
    const search = (await call(
      "searchMethods",
      { query: prompt },
      "search",
    )) as { results: Array<{ method: { id: string; revision: number } }> };
    const method = search.results[0]?.method;
    if (!method) return {};
    const prepared = (await call(
      "prepareMethod",
      {
        methodId: method.id,
        revision: method.revision,
        taskRef: state.taskRef,
        requestId: digest([
          event.sessionId,
          event.timestamp ?? "",
          promptDigest,
        ]),
      },
      "prepare",
    )) as { status: string; methodUseRef?: string };
    if (!["guidance", "lead"].includes(prepared.status)) return {};
    if (prepared.methodUseRef) {
      state.methodUseRef = prepared.methodUseRef;
      await writeFile(path, JSON.stringify(state));
    }
    return promptEnvelope(
      event,
      `<lessonloop-method task="${state.taskRef}">\n${JSON.stringify(prepared)}\n</lessonloop-method>`,
    );
  }
  if (!state || state.ended) return {};
  if (type === "postToolUse" && event.toolResult !== undefined) {
    const text = JSON.stringify({
      toolName: event.toolName,
      arguments: event.toolArgs,
      result: event.toolResult,
    });
    if (Buffer.byteLength(text) <= 16000)
      await call(
        "recordHostObservation",
        {
          taskRef: state.taskRef,
          eventId: digest([
            event.sessionId,
            event.timestamp,
            event.toolCallId ?? text,
          ]),
          text,
          ...(eventTime(event.timestamp)
            ? { occurredAt: eventTime(event.timestamp) }
            : {}),
        },
        "host-observation",
      );
    if (setting.learning && Buffer.byteLength(text) <= 30000)
      await call(
        "submitMaterial",
        {
          scopeId: config.scopeId,
          segments: [
            {
              text,
              role: "tool",
              locator: `copilot:${event.sessionId}:${state.taskRef}`,
            },
          ],
          context: { taskRef: state.taskRef },
        },
        digest([state.taskRef, event.toolCallId ?? event.timestamp ?? text]),
      );
  }
  if (type === "sessionEnd") {
    await call(
      "recordTaskObservation",
      [
        {
          eventId: `ended:${state.taskRef}`,
          taskRef: state.taskRef,
          scopeId: config.scopeId,
          kind: "task_ended",
          occurredAt: eventTime(event.timestamp) ?? new Date().toISOString(),
          text: "Trusted Copilot session ended; outcome remains unknown.",
        },
      ],
      "effect-ended",
    );
    await call(
      "observeTask",
      {
        taskRef: state.taskRef,
        eventId: "session-ended",
        text: "Copilot session ended. Task success was not inferred.",
        values: {},
        completedStepIds: [],
        conditionResults: {},
        ended: true,
      },
      "session-ended",
    );
    state.ended = true;
    await writeFile(path, JSON.stringify(state));
  }
  return {};
}
run()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch(() => {
    process.stderr.write(
      "LessonLoop hook unavailable; continue the task and inspect doctor.\n",
    );
    process.stdout.write("{}");
  });
