import { z } from "zod";
import {
  contextSchema,
  id,
  revision,
  segmentSchema,
} from "../domain/schema.js";

const reference = z
  .object({
    kind: z.enum(["playbook", "experience"]),
    id,
    revision,
  })
  .strict();

export const guidanceInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .optional()
      .describe("The current problem. Required unless target is supplied."),
    target: reference
      .optional()
      .describe("Retrieve one returned reference at its exact revision."),
    taskRef: id
      .optional()
      .describe(
        "Reuse the taskRef from the hook or a previous getGuidance response.",
      ),
    scopeId: id
      .optional()
      .describe(
        "Required only when starting a task with multiple authorized scopes.",
      ),
    context: contextSchema
      .optional()
      .describe("Reported context; not trusted execution evidence."),
    viewMode: z
      .enum(["auto", "expanded"])
      .optional()
      .describe(
        "Use expanded when guidance requires expansion or to read an experience's evidence.",
      ),
  })
  .strict()
  .refine((v) => v.query !== undefined || v.target !== undefined, {
    message: "query or target is required",
  });

export const sourceInput = z
  .object({
    scopeId: id,
    segments: z
      .array(segmentSchema.extend({ role: z.enum(["agent", "external"]) }))
      .min(1)
      .max(16),
    context: contextSchema.optional(),
    verificationFor: reference
      .extend({ kind: z.literal("experience") })
      .optional(),
    sourceFor: z.object({ id, revision }).strict().optional(),
  })
  .strict();

export const feedbackInput = z
  .object({
    target: reference,
    rating: z.enum(["helpful", "irrelevant", "incorrect"]),
    correctionText: z.string().max(2048).optional(),
  })
  .strict();
