// JSONL tail and event roles adapted from @vectorize-io/hindsight-coding-agents
// 0.4.2, core/jsonl.ts and core/transcript-copilot.ts. Copyright (c) 2025
// Vectorize AI, Inc. MIT: third-party/hindsight-LICENSE. The upstream bundle
// has no reader export; this bounded adaptation adds product cursors and gaps.
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { digest } from "../../domain/schema.js";
import type { HookEvent } from "./protocol.js";

export interface TranscriptRecord {
  id?: string;
  parentId?: string;
  agentId?: string;
  type: string;
  timestamp?: string;
  data: Record<string, any>;
}
export interface TranscriptCursor {
  path: string;
  offset: number;
}
export async function readTranscript(
  event: HookEvent,
  cwd: string,
  cursor?: TranscriptCursor,
  maxBytes = 32 * 1024 * 1024,
) {
  const records: TranscriptRecord[] = [];
  const gaps: string[] = [];
  if (!event.sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.sessionId))
    return { records, gaps: ["transcript_identity_mismatch"] };
  const path =
    event.transcriptPath ??
    join(
      process.env.COPILOT_HOME || join(homedir(), ".copilot"),
      "session-state",
      event.sessionId!,
      "events.jsonl",
    );
  let file;
  try {
    const actual = await realpath(path);
    file = await open(actual, "r");
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("transcript_not_file");
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    await file.read(head, 0, head.length, 0);
    const first = JSON.parse(head.toString("utf8").split("\n")[0]!);
    if (
      first.type !== "session.start" ||
      first.data?.sessionId !== event.sessionId ||
      typeof first.data?.context?.cwd !== "string" ||
      (await realpath(first.data.context.cwd)) !== cwd
    )
      throw new Error("transcript_identity_mismatch");
    const identity = digest(resolve(actual));
    let offset =
      cursor?.path === identity &&
      Number.isSafeInteger(cursor.offset) &&
      cursor.offset >= 0
        ? cursor.offset
        : 0;
    if (offset > stat.size) {
      gaps.push("transcript_replaced");
      offset = 0;
    }
    if (stat.size - offset > maxBytes) {
      gaps.push("transcript_truncated");
      offset = stat.size - maxBytes;
      const prefix = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
      await file.read(prefix, 0, prefix.length, offset);
      const newline = prefix.indexOf(10);
      if (newline < 0)
        return { records, gaps, cursor: { path: identity, offset } };
      offset += newline + 1;
    }
    const buffer = Buffer.alloc(stat.size - offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
    // A partially written final line is retried at the next host hook.
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (
          typeof value?.type === "string" &&
          value.data &&
          typeof value.data === "object"
        )
          records.push(value);
        else gaps.push("transcript_invalid_event");
      } catch {
        gaps.push("transcript_invalid_json");
      }
    }
    return {
      records,
      gaps: [...new Set(gaps)],
      cursor: { path: identity, offset: offset + end },
    };
  } catch (error) {
    gaps.push(
      error instanceof Error && error.message === "transcript_identity_mismatch"
        ? error.message
        : "transcript_unavailable",
    );
    return { records, gaps };
  } finally {
    await file?.close();
  }
}
