// Copilot prompt envelope adapted from @vectorize-io/hindsight-coding-agents
// 0.4.2 (Hindsight v0.9.2). Copyright (c) 2025 Vectorize AI, Inc.
// MIT license: third-party/hindsight-LICENSE. Product calls replace native recall.
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
  timestamp?: string;
}
export function promptEnvelope(event: HookEvent, context: string) {
  return {
    modifiedTransformedPrompt:
      `${event.transformedPrompt ?? event.prompt ?? ""}\n\n${context}`.trim(),
  };
}
export function transcriptEvent(raw: unknown) {
  const event = raw as {
    id?: string;
    type?: string;
    timestamp?: string;
    data?: { content?: unknown; result?: unknown; toolCallId?: string };
  };
  const role =
    event.type === "user.message"
      ? "user"
      : event.type === "assistant.message"
        ? "agent"
        : event.type === "tool.execution_complete"
          ? "tool"
          : undefined;
  const content =
    typeof event.data?.content === "string"
      ? event.data.content
      : event.type === "tool.execution_complete"
        ? JSON.stringify(event.data)
        : "";
  if (!role || !content) return;
  return {
    role: role as "user" | "agent" | "tool",
    text: content,
    ...(event.timestamp ? { observedAt: event.timestamp } : {}),
    eventId: event.id ?? event.data?.toolCallId,
  };
}
