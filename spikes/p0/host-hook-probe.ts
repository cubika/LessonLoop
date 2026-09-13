import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COPILOT_VERSION, isolatedEnvironment, probePaths, type ProbePaths } from "./host-probe.js";

const TASK_MARKER = "P0_HOST_PROTOCOL_SYNTHETIC_ONLY";
const SUBMITTED_MARKER = "P0_SUBMITTED_MODEL_CONTEXT";
const TRANSFORMED_MARKER = "P0_TRANSFORMED_MODEL_CONTEXT";
const READ_MARKER = "P0_SAFE_FIXTURE_READ_RESULT";
const DENIAL_MARKER = "P0_EXPLICIT_FIXTURE_READ_DENIAL";
type ProbeCase = "context" | "deny" | "timeout";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function modelMarkers(body: unknown) {
  const payload = object(body);
  const text = JSON.stringify(payload.messages ?? []);
  return {
    originalTask: text.includes(TASK_MARKER),
    submittedOutput: text.includes(SUBMITTED_MARKER),
    transformedOutput: text.includes(TRANSFORMED_MARKER),
    fixtureResult: text.includes(READ_MARKER),
  };
}

export function findViewTool(body: unknown, fixture: string) {
  const tools = object(body).tools;
  if (!Array.isArray(tools)) return null;
  for (const tool of tools) {
    const definition = object(object(tool).function);
    if (typeof definition.name !== "string" || !/(^|[._])view$/.test(definition.name)) continue;
    const properties = object(object(definition.parameters).properties);
    const pathKey = ["path", "file_path", "filePath"].find((key) => key in properties);
    if (pathKey === undefined) return null;
    return { name: definition.name, args: { [pathKey]: fixture } };
  }
  return null;
}

function complete(response: ServerResponse, model: unknown, tool: ReturnType<typeof findViewTool>, streaming: boolean) {
  const message = tool === null
    ? { role: "assistant", content: "Synthetic protocol only. No agent quality or user benefit was evaluated." }
    : { role: "assistant", content: null, tool_calls: [{ id: "p0_safe_read", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] };
  const metadata = { id: "p0-synthetic", created: Math.floor(Date.now() / 1000), model: typeof model === "string" ? model : "p0-synthetic" };
  if (!streaming) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...metadata, object: "chat.completion", choices: [{ index: 0, message, finish_reason: tool === null ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const delta = tool === null
    ? message
    : { role: "assistant", tool_calls: [{ index: 0, id: "p0_safe_read", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] };
  response.write(`data: ${JSON.stringify({ ...metadata, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...metadata, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool === null ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

export const HOOK_SCRIPT = String.raw`
import {appendFileSync} from 'node:fs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const input=JSON.parse(raw);const event=process.argv[2];
const record={event,at:Date.now(),hasOriginalPrompt:typeof input.prompt==='string'&&input.prompt.includes('${TASK_MARKER}'),toolName:input.toolName??null,resultType:input.toolResult?.resultType??null,fixtureResult:JSON.stringify(input.toolResult??'').includes('${READ_MARKER}')};
appendFileSync(process.env.P0_TRACE,JSON.stringify(record)+'\n');
if(event==='userPromptSubmitted')console.log(JSON.stringify({modifiedPrompt:input.prompt+'\n${SUBMITTED_MARKER}'}));
else if(event==='userPromptTransformed')console.log(JSON.stringify({modifiedTransformedPrompt:input.transformedPrompt+'\n${TRANSFORMED_MARKER}'}));
else if(event==='preToolUse'&&process.env.P0_CASE==='deny')console.log(JSON.stringify({permissionDecision:'deny',permissionDecisionReason:'${DENIAL_MARKER}'}));
else if(event==='preToolUse'&&process.env.P0_CASE==='timeout')await new Promise(r=>setTimeout(r,4000));
else console.log('{}');
`;

async function invoke(executable: string, args: string[], cwd: string, env: Record<string, string>) {
  const start = performance.now();
  return new Promise<{ exitCode: number | null; errorCode: string | null; timedOut: boolean; durationMs: number; output: string }>((done) => {
    execFile(executable, args, { cwd, env, timeout: 35_000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
      done({ exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null, errorCode: typeof error?.code === "string" ? error.code : null, timedOut: error?.killed === true, durationMs: Math.round(performance.now() - start), output: stdout + stderr });
    });
  });
}

async function runCase(workspace: string, root: string, mode: ProbeCase) {
  const base = join(root, mode);
  const paths: ProbePaths = { ...probePaths(workspace), profile: join(base, "profile"), cache: join(base, "cache"), logs: join(base, "logs"), temp: join(base, "temp"), scratch: join(base, "scratch") };
  const plugin = join(base, "plugin");
  const hookFile = join(plugin, "hook.mjs");
  const traceFile = join(base, "trace.jsonl");
  const fixture = join(paths.scratch, "fixture.txt");
  for (const directory of [paths.profile, paths.cache, paths.logs, paths.temp, paths.scratch, join(plugin, "com.github.copilot", "hooks")]) await mkdir(directory, { recursive: true });
  await writeFile(fixture, `${READ_MARKER}\n`);
  await writeFile(hookFile, HOOK_SCRIPT);
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "lessonloop-p0-synthetic", version: "0.0.1", description: "Synthetic protocol probe only" }));
  const events = ["userPromptSubmitted", "userPromptTransformed", "preToolUse", "postToolUse"];
  await writeFile(join(plugin, "com.github.copilot", "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: Object.fromEntries(events.map((event) => [event, [{ type: "command", exec: process.execPath, args: [hookFile, event], cwd: paths.scratch, timeoutSec: event === "preToolUse" ? 1 : 5, env: { P0_TRACE: traceFile, P0_CASE: mode } }]])) }));
  const requests: Array<{ at: number; path: string; markers: ReturnType<typeof modelMarkers>; viewToolAvailable: boolean; toolResponseScripted: boolean }> = [];
  let scriptedTool = false;
  let protocolError: string | null = null;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 1024 * 1024) throw new Error("request_too_large");
        chunks.push(buffer);
      }
      if (!request.url?.endsWith("/chat/completions")) {
        protocolError = "unexpected_endpoint";
        response.writeHead(404).end();
        return;
      }
      if (requests.length >= 6) throw new Error("request_budget_exhausted");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const markers = modelMarkers(body);
      const view = findViewTool(body, fixture);
      const tool = mode !== "context" && !scriptedTool ? view : null;
      if (tool !== null) scriptedTool = true;
      requests.push({ at: Date.now(), path: request.url, markers, viewToolAvailable: view !== null, toolResponseScripted: tool !== null });
      complete(response, object(body).model, tool, object(body).stream === true);
    } catch {
      protocolError ??= "protocol_request_failed";
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("local_server_unavailable");
  const env = { ...isolatedEnvironment(process.env, paths), COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions", COPILOT_MODEL: "gpt-4" };
  let command: Awaited<ReturnType<typeof invoke>>;
  try {
    command = await invoke(paths.executable, ["--no-auto-update", "--no-custom-instructions", "--no-remote", "--no-remote-export", "--no-ask-user", "--no-eager-powershell-resolution", "--disable-builtin-mcps", "--available-tools=view", "--allow-tool=read", "--output-format=json", "--stream=off", "--log-dir", paths.logs, "--plugin-dir", plugin, "-p", `${TASK_MARKER}. Synthetic protocol only; read only the provided fixture when requested. No network tools or user files.`], paths.scratch, env);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
  let trace: Array<Record<string, unknown>> = [];
  try { trace = (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => object(JSON.parse(line))); } catch { /* Missing hooks remain unverified. */ }
  const runtimeHooks: Array<{ event: string; hook: string; success: boolean | null; errorKind: string | null }> = [];
  const runtimeTools: Array<{ event: string; success: boolean | null; deniedByProbe: boolean; errorCode: string | null; fixtureResult: boolean }> = [];
  try {
    const sessionRoot = join(paths.profile, "session-state");
    for (const directory of await readdir(sessionRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const events = (await readFile(join(sessionRoot, directory.name, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
      for (const line of events) {
        const event = object(JSON.parse(line));
        const data = object(event.data);
        if (event.type === "tool.execution_complete" && data.toolCallId === "p0_safe_read") {
          const error = object(data.error);
          runtimeTools.push({ event: event.type, success: typeof data.success === "boolean" ? data.success : null, deniedByProbe: typeof error.message === "string" && error.message.includes(DENIAL_MARKER), errorCode: typeof error.code === "string" ? error.code : null, fixtureResult: JSON.stringify(data.result ?? {}).includes(READ_MARKER) });
        }
        if (event.type !== "hook.start" && event.type !== "hook.end") continue;
        const errorMessage = object(data.error).message;
        runtimeHooks.push({ event: event.type, hook: String(data.hookType), success: typeof data.success === "boolean" ? data.success : null, errorKind: typeof errorMessage !== "string" ? null : /SyntaxError/.test(errorMessage) ? "hook_script_syntax_error" : /timed out/i.test(errorMessage) ? "hook_timeout" : "hook_error" });
      }
    }
  } catch { /* Runtime event availability is reported separately from hook observations. */ }
  const firstTask = requests[0];
  const preTool = trace.find((event) => event.event === "preToolUse");
  const postTool = trace.find((event) => event.event === "postToolUse");
  const afterHook = requests.find((request) => preTool !== undefined && typeof preTool.at === "number" && request.at > preTool.at && request.markers.fixtureResult);
  const observations = {
    pluginHookDispatchObserved: runtimeHooks.some((event) => event.event === "hook.start"),
    originalPromptObservedByHook: trace.some((event) => event.event === "userPromptSubmitted" && event.hasOriginalPrompt === true),
    originalTaskInFirstModelInput: firstTask?.markers.originalTask ?? null,
    submittedOutputInModelInput: firstTask?.markers.submittedOutput ?? null,
    transformedOutputInModelInput: firstTask?.markers.transformedOutput ?? null,
    transformedHookBeforeFirstModelRequest: firstTask === undefined ? null : trace.some((event) => event.event === "userPromptTransformed" && typeof event.at === "number" && event.at <= firstTask.at),
    preToolHookObserved: preTool !== undefined,
    toolResponseScripted: scriptedTool,
    explicitProbeDenialObserved: runtimeTools.some((event) => event.success === false && event.errorCode === "denied" && event.deniedByProbe),
    successfulToolCompletionObserved: runtimeTools.some((event) => event.success === true),
    postToolFixtureReadObserved: postTool?.fixtureResult === true,
    fixtureResultInSubsequentModelInput: afterHook !== undefined,
    timeoutWarningObserved: /hook.*timed out|timed out.*hook/i.test(command.output) || runtimeHooks.some((event) => event.errorKind === "hook_timeout"),
    requiresLogin: /not authenticated|authentication required|please.*login|not logged in/i.test(command.output),
    finalSyntheticTextObserved: command.output.includes("Synthetic protocol only"),
  };
  const promptHooksSucceeded = ["userPromptSubmitted", "userPromptTransformed"].every((hook) => runtimeHooks.some((event) => event.event === "hook.end" && event.hook === hook && event.success === true));
  const contextVerified = command.exitCode === 0 && protocolError === null && promptHooksSucceeded && observations.originalPromptObservedByHook && observations.originalTaskInFirstModelInput === true && observations.transformedOutputInModelInput === true && observations.transformedHookBeforeFirstModelRequest === true;
  const caseVerified = contextVerified && (mode === "context" || mode === "deny" && observations.toolResponseScripted && observations.preToolHookObserved && observations.explicitProbeDenialObserved && !observations.successfulToolCompletionObserved && !observations.postToolFixtureReadObserved && !observations.fixtureResultInSubsequentModelInput || mode === "timeout" && observations.toolResponseScripted && observations.preToolHookObserved && observations.timeoutWarningObserved && observations.successfulToolCompletionObserved && observations.postToolFixtureReadObserved && observations.fixtureResultInSubsequentModelInput);
  return {
    case: mode,
    classification: "synthetic_protocol_only",
    verification: caseVerified ? "observed" : "incomplete_or_different_behavior",
    exitCode: command.exitCode,
    errorCode: command.errorCode,
    timedOut: command.timedOut,
    durationMs: command.durationMs,
    protocolError,
    modelEndpoint: "loopback_scripted_response",
    requests,
    trace,
    runtimeHooks,
    runtimeTools,
    observations,
    documentationComparison: {
      source: "https://docs.github.com/en/copilot/reference/hooks-reference#userpromptsubmitted--userpromptsubmit",
      documentedSubmittedCommandOutput: "discarded",
      actualSubmittedModifiedPrompt: firstTask === undefined ? "not_observed" : firstTask.markers.submittedOutput ? "honored" : "not_present",
      agreesWithDocumentation: firstTask === undefined ? null : !firstTask.markers.submittedOutput,
    },
    diagnostic: command.exitCode === 0 ? null : command.output.replaceAll(base, "<probe>").slice(-3000),
  };
}

export async function runHostHookProbe(workspace: string) {
  const root = join(resolve(workspace), ".p0", "host-hooks", randomUUID());
  const cases: Array<Awaited<ReturnType<typeof runCase>>> = [];
  for (const mode of ["context", "deny", "timeout"] as const) {
    cases.push(await runCase(workspace, root, mode));
    if (cases.at(-1)?.observations.requiresLogin || cases.at(-1)?.requests.length === 0) break;
  }
  return { schema: 1, checkedAt: new Date().toISOString(), cliVersion: COPILOT_VERSION, classification: "synthetic_protocol_only", realModelCalls: 0, credentialsProvided: false, pluginInstallation: false, cases, limitations: ["Scripted local protocol responses do not measure agent reasoning, task quality, or memory benefit.", "Plugin loading and timing findings apply only to this CLI version and synthetic input.", "No account credentials or default-profile configuration were supplied; no global file-write audit was run.", "Host-owned session files may be created inside the isolated profile; these are not core memory storage."] };
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const report = await runHostHookProbe(workspace);
    const path = join(workspace, ".p0", "results", "host-hooks.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ classification: report.classification, cases: report.cases.length, report: path, observations: report.cases.map((entry) => ({ case: entry.case, exitCode: entry.exitCode, ...entry.observations })) }));
    process.exitCode = report.cases.length === 3 && report.cases.every((entry) => entry.verification === "observed") ? 0 : 2;
  } catch {
    console.error("Synthetic host hook probe failed before completing its report. No real model call was configured.");
    process.exitCode = 1;
  }
}
