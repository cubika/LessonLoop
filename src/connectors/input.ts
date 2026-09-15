import { z } from "zod";
import { ApiError } from "../core/service.js";
import {
  byteSize,
  contextSchema,
  id,
  sourceInputSchema,
  segmentSchema,
  text,
  type SourceInput,
} from "../domain/schema.js";

export const CONNECTOR_LIMITS = {
  parts: 8,
  sourceBytes: 32768,
  batchBytes: 262144,
};
const sourceSegment = segmentSchema.extend({
  text: text(CONNECTOR_LIMITS.batchBytes),
});
const common = { scopeId: id, context: contextSchema.optional() };
const evidence = z.array(sourceSegment).min(1).max(64);
const boundary = z.array(text(512)).max(4).default([]);
const outcome = z.enum([
  "partial",
  "succeeded",
  "failed",
  "abandoned",
  "unknown",
]);

// These are source documents, without internal identities or publication fields.
export const connectorSourceSchema = z
  .object({
    ...common,
    segments: evidence,
    sourceFor: sourceInputSchema.innerType().shape.sourceFor,
    verificationFor: sourceInputSchema.innerType().shape.verificationFor,
  })
  .strict();
const workViewInput = z
  .object({
    ...common,
    kind: z.literal("source"),
    topic: text(256).optional(),
    goal: text(1024),
    attempts: z
      .array(
        z
          .object({
            action: text(1024),
            observation: text(1024).optional(),
            outcome: outcome.default("unknown"),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    result: z
      .object({ status: outcome, summary: text(1024) })
      .strict()
      .optional(),
    unresolved: z.array(text(512)).max(8).default([]),
    evidence: evidence.optional(),
  })
  .strict();
const experienceInput = z
  .object({
    ...common,
    kind: z.literal("experience_draft"),
    conclusion: text(2048),
    conditions: boundary,
    exceptions: boundary,
    evidence,
  })
  .strict();
const playbookInput = z
  .object({
    ...common,
    kind: z.literal("playbook_draft"),
    title: text(256),
    goal: text(1024),
    conditions: boundary,
    exceptions: boundary,
    steps: z
      .array(
        z
          .object({
            stepId: id,
            instruction: text(1024),
            rationale: text(512).optional(),
            evidenceIndexes: z
              .array(z.number().int().nonnegative())
              .min(1)
              .max(16),
            choices: z
              .array(z.object({ when: text(512), next: id }).strict())
              .min(1)
              .max(4)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    completionChecks: z.array(text(512)).min(1).max(4),
    stopConditions: z.array(text(512)).max(4).default([]),
    evidence,
  })
  .strict();
export const connectorInputSchema = z.union([
  connectorSourceSchema.extend({ kind: z.literal("source") }),
  workViewInput,
  experienceInput,
  playbookInput,
]);

export interface SourcePart {
  partKey: string;
  inputSource: SourceInput;
}
type SourceSource = z.infer<typeof connectorSourceSchema>;

export function normalizeInput(input: unknown): SourcePart[] {
  const value = connectorInputSchema.parse(input);
  if (byteSize(value) > CONNECTOR_LIMITS.batchBytes)
    throw new ApiError("source_change_too_large");
  if (value.kind === "source" && "segments" in value) {
    const { kind, ...inputSource } = value;
    return splitSource(inputSource);
  }
  if (value.kind === "playbook_draft") {
    const positions = new Map(
      value.steps.map((step, index) => [step.stepId, index]),
    );
    if (positions.size !== value.steps.length || positions.has("stop"))
      throw new ApiError("invalid_playbook_step_ids");
    for (const [index, step] of value.steps.entries()) {
      if (step.evidenceIndexes.some((n) => n >= value.evidence.length))
        throw new ApiError("unbound_playbook_evidence");
      if (
        step.choices?.some(
          (choice) =>
            choice.next !== "stop" &&
            (positions.get(choice.next) ?? -1) <= index,
        )
      )
        throw new ApiError("invalid_playbook_branch");
    }
  }
  const {
    kind,
    scopeId,
    context,
    evidence: sourceEvidence,
    ...document
  } = value;
  // Keep the structured claims separate from continuous, unchanged source excerpts.
  // The core still admits these as external inputSource and performs normal learning.
  return splitSource({
    scopeId,
    ...(context ? { context } : {}),
    segments: [
      { text: JSON.stringify({ kind, ...document }), role: "external" },
      ...(sourceEvidence ?? []),
    ],
  });
}

function splitSource(source: SourceSource): SourcePart[] {
  const { segments, ...metadata } = source;
  const parts: SourcePart[] = [];
  let current: SourceInput = { ...metadata, segments: [] };
  const flush = () => {
    if (!current.segments.length) return;
    parts.push({
      partKey: `part-${String(parts.length + 1).padStart(4, "0")}`,
      inputSource: sourceInputSchema.parse(current),
    });
    if (parts.length > CONNECTOR_LIMITS.parts)
      throw new ApiError("source_requires_smaller_resources");
    current = { ...metadata, segments: [] };
  };
  for (const segment of segments) {
    const characters = Array.from(segment.text);
    let offset = 0;
    while (offset < characters.length) {
      if (current.segments.length === 16) flush();
      let low = 0,
        high = characters.length - offset;
      while (low < high) {
        const count = Math.ceil((low + high) / 2);
        const candidate = {
          ...segment,
          text: characters.slice(offset, offset + count).join(""),
        };
        if (
          byteSize({
            ...current,
            segments: [...current.segments, candidate],
          }) <= CONNECTOR_LIMITS.sourceBytes
        )
          low = count;
        else high = count - 1;
      }
      if (!low) {
        if (!current.segments.length)
          throw new ApiError("source_change_too_large");
        flush();
        continue;
      }
      current.segments.push({
        ...segment,
        text: characters.slice(offset, offset + low).join(""),
      });
      offset += low;
      if (offset < characters.length) flush();
    }
  }
  flush();
  return parts;
}
