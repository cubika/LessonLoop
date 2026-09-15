// Copilot prompt envelope adapted from @vectorize-io/hindsight-coding-agents
// 0.4.2 (Hindsight v0.9.2). Copyright (c) 2025 Vectorize AI, Inc.
// MIT license: third-party/hindsight-LICENSE. Product calls replace native recall.
import { copilotTurn, stripOfficialMemory } from "./upstream.js";
export interface HookEvent {
  sessionId?: string;
  prompt?: string;
  transformedPrompt?: string;
  cwd?: string;
  transcriptPath?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolCallId?: string;
  timestamp?: string | number;
  source?: "startup" | "resume" | "new";
  reason?: string;
  stopReason?: string;
  finalMessage?: string;
  agentId?: string;
  parentToolCallId?: string;
}
export function eventTime(
  value: string | number | undefined,
): string | undefined {
  if (value === undefined) return;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}
export function promptEnvelope(event: HookEvent, context: string) {
  return {
    modifiedTransformedPrompt:
      `${event.transformedPrompt ?? event.prompt ?? ""}\n\n${context}`.trim(),
  };
}
export function transcriptEvent(raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const event = raw as {
    id?: string;
    type?: string;
    timestamp?: string;
    data?: { content?: unknown; result?: unknown; toolCallId?: string };
  };
  const turn = copilotTurn(event);
  const role = turn
    ? turn.role === "assistant"
      ? "agent"
      : "user"
    : event.type === "tool.execution_complete"
      ? "tool"
      : undefined;
  const content = turn
    ? stripInjectedMemory(turn.content).trim()
    : role === "tool"
      ? JSON.stringify(event.data)
      : "";
  if (!role || !content) return;
  return {
    role: role as "user" | "agent" | "tool",
    text: content,
    ...(eventTime(event.timestamp)
      ? { observedAt: eventTime(event.timestamp)! }
      : {}),
    eventId: event.id ?? event.data?.toolCallId,
  };
}

// Adapted from the pinned upstream core/transcript-util.ts. Product guidance
// is excluded as well, so recalled playbooks do not become new source evidence.
const MEMORY_TAG_RE =
  /<(lessonloop-method|lessonloop-playbook)\b[\s\S]*?<\/\1>/g;
export function stripInjectedMemory(text: string) {
  return stripOfficialMemory(text).replace(MEMORY_TAG_RE, "");
}

export function toolText(toolName: unknown, _args: unknown, result: unknown) {
  const value =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return JSON.stringify({
    toolName,
    result: {
      content: value.textResultForLlm ?? value.content ?? result,
      ...(typeof value.success === "boolean"
        ? { success: value.success }
        : typeof value.resultType === "string"
          ? { success: value.resultType === "success" }
          : {}),
    },
  });
}

export function isProductTool(name: unknown) {
  return (
    typeof name === "string" && /(?:^|[._-])lessonloop(?:[._-]|$)/i.test(name)
  );
}
