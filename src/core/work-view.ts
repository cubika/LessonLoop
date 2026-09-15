import { z } from "zod";
import {
  common,
  id,
  text,
  contextSchema,
  evidenceSchema,
  refSchema,
  byteSize,
} from "../domain/schema.js";
export const workViewSchema = z
  .object({
    ...common,
    sequence: z.number().int().nonnegative(),
    taskRef: id.optional(),
    sourceFamily: id.optional(),
    topic: text(256),
    goal: text(1024),
    context: contextSchema,
    attempts: z
      .array(
        z
          .object({
            stepId: id,
            action: text(1024),
            observation: text(1024),
            outcome: z.enum([
              "partial",
              "succeeded",
              "failed",
              "abandoned",
              "unknown",
            ]),
            evidenceIndexes: z.array(z.number().int().nonnegative()).max(16),
          })
          .strict()
          .refine((v) => byteSize(v) <= 2048),
      )
      .max(16),
    result: z
      .object({
        status: z.enum([
          "partial",
          "succeeded",
          "failed",
          "abandoned",
          "unknown",
        ]),
        summary: text(1024),
        evidenceIndexes: z.array(z.number().int().nonnegative()).max(16),
      })
      .strict(),
    evidence: z.array(evidenceSchema).max(16),
    unresolved: z.array(text(512)).max(8),
    coverage: z.array(text(512)).max(8),
    playbookUses: z
      .array(
        z
          .object({
            playbookUseRef: id,
            taskRef: id,
            callerId: id,
            playbook: refSchema.extend({ kind: z.literal("playbook") }),
            returnedAt: z.string().datetime(),
          })
          // Strip obsolete returned-step snapshots from historical views.
          .strip(),
      )
      .max(8),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (byteSize(v) > 65536)
      ctx.addIssue({ code: "custom", message: "WorkView exceeds 64 KiB" });
    if (
      [
        ...v.attempts.flatMap((a) => a.evidenceIndexes),
        ...v.result.evidenceIndexes,
      ].some((n) => n >= v.evidence.length)
    )
      ctx.addIssue({ code: "custom", message: "Unbound case evidence" });
  });
export type WorkView = z.infer<typeof workViewSchema>;

export type WorkViewRef = { id: string; revision: number };
