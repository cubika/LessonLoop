// Adapted from @vectorize-io/hindsight-coding-agents 0.4.2:
// core/jsonl.ts, core/transcript-copilot.ts and core/transcript-util.ts.
// Copyright (c) 2025 Vectorize AI, Inc. MIT: third-party/hindsight-LICENSE.
// The published bundle has no reader export. See third-party/copilot-collection.md.
import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

// Product changes: use an already authorized handle, bound the snapshot, expose
// byte checkpoints, and leave a partially written final line for the next hook.
export async function* streamLines(
  file: FileHandle,
  start: number,
  end: number,
  dropPartial = false,
) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let position = dropPartial && start > 0 ? start - 1 : start;
  while (position < end) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, end - position),
      position,
    );
    if (!bytesRead) break;
    const ends: number[] = [];
    for (let i = 0; i < bytesRead; i++)
      if (buffer[i] === 10) ends.push(position + i + 1);
    position += bytesRead;
    pending += decoder.write(buffer.subarray(0, bytesRead));
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const offset = ends.shift()!;
      if (dropPartial) {
        dropPartial = false;
        continue;
      }
      yield { line, offset };
    }
  }
}

const MEMORY_TAG_RE =
  /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_knowledge|hindsight_knowledge_refresh)\b[\s\S]*?<\/\1>/g;
export function stripOfficialMemory(text: string) {
  return text.replace(MEMORY_TAG_RE, "");
}

// The upstream reader's event-to-turn mapping, separated from file traversal so
// product event identities and tool receipts remain available to the adapter.
export function copilotTurn(event: {
  type?: string;
  data?: { content?: unknown };
}) {
  const role =
    event.type === "user.message"
      ? "user"
      : event.type === "assistant.message"
        ? "assistant"
        : undefined;
  const content =
    typeof event.data?.content === "string"
      ? stripOfficialMemory(event.data.content).trim()
      : "";
  if (role && content) return { role, content };
}
