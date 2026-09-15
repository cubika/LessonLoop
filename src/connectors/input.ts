import { z } from "zod";
import { ApiError } from "../core/service.js";
import {
  byteSize,
  contextSchema,
  id,
  materialInputSchema,
  segmentSchema,
  text,
  type MaterialInput,
} from "../domain/schema.js";

export const CONNECTOR_LIMITS = {
  parts: 8,
  materialBytes: 32768,
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
export const connectorMaterialSchema = z
  .object({
    ...common,
    segments: evidence,
    caseFor: materialInputSchema.innerType().shape.caseFor,
    verificationFor: materialInputSchema.innerType().shape.verificationFor,
  })
  .strict();
const workCaseInput = z
  .object({
    ...common,
    kind: z.literal("work_case"),
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
const methodInput = z
  .object({
    ...common,
    kind: z.literal("method_draft"),
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
export const connectorInputSchema = z.discriminatedUnion("kind", [
  connectorMaterialSchema.extend({ kind: z.literal("material") }),
  workCaseInput,
  experienceInput,
  methodInput,
]);

export interface MaterialPart {
  partKey: string;
  material: MaterialInput;
}
type SourceMaterial = z.infer<typeof connectorMaterialSchema>;

export function normalizeInput(input: unknown): MaterialPart[] {
  const value = connectorInputSchema.parse(input);
  if (byteSize(value) > CONNECTOR_LIMITS.batchBytes)
    throw new ApiError("source_change_too_large");
  if (value.kind === "material") {
    const { kind, ...material } = value;
    return splitMaterial(material);
  }
  if (value.kind === "method_draft") {
    const positions = new Map(
      value.steps.map((step, index) => [step.stepId, index]),
    );
    if (positions.size !== value.steps.length || positions.has("stop"))
      throw new ApiError("invalid_method_step_ids");
    for (const [index, step] of value.steps.entries()) {
      if (step.evidenceIndexes.some((n) => n >= value.evidence.length))
        throw new ApiError("unbound_method_evidence");
      if (
        step.choices?.some(
          (choice) =>
            choice.next !== "stop" &&
            (positions.get(choice.next) ?? -1) <= index,
        )
      )
        throw new ApiError("invalid_method_branch");
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
  // The core still admits these as external material and performs normal learning.
  return splitMaterial({
    scopeId,
    ...(context ? { context } : {}),
    segments: [
      { text: JSON.stringify({ kind, ...document }), role: "external" },
      ...(sourceEvidence ?? []),
    ],
  });
}

function splitMaterial(source: SourceMaterial): MaterialPart[] {
  const { segments, ...metadata } = source;
  const parts: MaterialPart[] = [];
  let current: MaterialInput = { ...metadata, segments: [] };
  const flush = () => {
    if (!current.segments.length) return;
    parts.push({
      partKey: `part-${String(parts.length + 1).padStart(4, "0")}`,
      material: materialInputSchema.parse(current),
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
          }) <= CONNECTOR_LIMITS.materialBytes
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
