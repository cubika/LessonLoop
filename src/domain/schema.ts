import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const text = (bytes: number) =>
  z
    .string()
    .min(1)
    .max(bytes)
    .refine(
      (v) => Buffer.byteLength(v, "utf8") <= bytes,
      `UTF-8 text exceeds ${bytes} bytes`,
    );
export const id = text(128);
export const revision = z.number().int().positive().safe();
export const refSchema = z
  .object({ kind: z.enum(["work_case", "experience", "method"]), id, revision })
  .strict();
export type ObjectRef = z.infer<typeof refSchema>;
export const matchText = (match: { key: string; values: string[] }) =>
  `context[${JSON.stringify(match.key)}] is one of ${JSON.stringify(match.values)}`;
export const conditionSchema = z
  .object({
    text: text(512),
    match: z
      .object({ key: text(64), values: z.array(text(128)).min(1).max(4) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => !v.match || v.text === matchText(v.match),
    "A match condition must use its canonical text; use a text-only condition for natural language",
  );
export type Condition = z.infer<typeof conditionSchema>;
export const contextSchema = z
  .record(text(64), z.union([text(128), z.array(text(128)).min(1).max(4)]))
  .refine((v) => Object.keys(v).length <= 32);
export const common = {
  id,
  revision,
  scopeId: id,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
export const reviewSchema = z
  .object({
    reason: z.enum([
      "verification_requested",
      "conflict",
      "source_changed",
      "scope_unclear",
    ]),
    question: text(512),
    reviewBy: z.string().datetime(),
  })
  .strict();
export const usage = {
  applicability: z.enum(["general", "conditional", "unknown"]),
  conditions: z.array(conditionSchema).max(4),
  exceptions: z.array(conditionSchema).max(4),
  state: z.enum(["active", "held", "disabled"]),
  review: reviewSchema.optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
};
export const evidenceSchema = z
  .object({
    excerpt: text(512),
    role: z.enum(["user", "agent", "tool", "external"]),
    relation: z.enum(["supports", "contradicts"]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    locator: text(256).optional(),
    author: text(128).optional(),
    observedAt: z.string().datetime().optional(),
  })
  .strict();
export const segmentSchema = z
  .object({
    text: text(32768),
    role: z.enum(["user", "agent", "tool", "external"]),
    locator: text(256).optional(),
    author: text(128).optional(),
    observedAt: z.string().datetime().optional(),
  })
  .strict();
export const materialInputSchema = z
  .object({
    scopeId: id,
    segments: z.array(segmentSchema).min(1).max(16),
    context: contextSchema.optional(),
    caseFor: refSchema.extend({ kind: z.literal("work_case") }).optional(),
    verificationFor: refSchema
      .extend({ kind: z.literal("experience") })
      .optional(),
  })
  .strict()
  .refine((v) => byteSize(v) <= 32768, "Material exceeds 32 KiB");
export type MaterialInput = z.infer<typeof materialInputSchema>;
export type Material = MaterialInput & {
  id: string;
  createdAt: string;
  fingerprints: string[];
  sourceIdentity: string;
  sourceFamily?: string;
  taskRef?: string;
  taskSequence?: number;
};
const stepSchema = z
  .object({
    stepId: id,
    instruction: text(1024),
    rationale: text(512).optional(),
    supportIndexes: z.array(z.number().int().nonnegative()).min(1).max(16),
    choices: z
      .array(z.object({ when: conditionSchema, next: id }).strict())
      .min(1)
      .max(4)
      .optional(),
  })
  .strict();
const checkSchema = z
  .object({ text: text(512), stepIds: z.array(id).min(1).max(12).optional() })
  .strict();
export const methodBodySchema = z
  .object({
    title: text(256),
    goal: text(1024),
    topics: z.array(text(64)).max(8),
    ...usage,
    steps: z.array(stepSchema).min(1).max(12),
    completionChecks: z.array(checkSchema).min(1).max(4),
    stopConditions: z.array(checkSchema).max(4),
    supportRefs: z
      .array(refSchema.extend({ kind: z.literal("experience") }))
      .min(1)
      .max(16),
    change: z
      .object({
        kind: z.enum([
          "create",
          "refine",
          "branch",
          "split",
          "retire",
          "correction",
        ]),
        summary: text(1024),
        caseRefs: z
          .array(refSchema.extend({ kind: z.literal("work_case") }))
          .max(8),
        predecessors: z
          .array(refSchema.extend({ kind: z.literal("method") }))
          .max(4),
      })
      .strict(),
  })
  .strict();
export const methodSchema = methodBodySchema
  .extend(common)
  .superRefine((m, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (byteSize(m) > 32768) fail("Method exceeds 32 KiB");
    usageErrors(m).forEach(fail);
    const positions = new Map(m.steps.map((s, i) => [s.stepId, i]));
    if (positions.size !== m.steps.length || positions.has("stop"))
      fail("Step IDs must be unique and cannot be stop");
    if (new Set(m.supportRefs.map((r) => r.id)).size !== m.supportRefs.length)
      fail("Duplicate support reference");
    m.steps.forEach((s, i) => {
      if (s.supportIndexes.some((n) => n >= m.supportRefs.length))
        fail("Unbound step support");
      s.choices?.forEach((c) => {
        if (c.next !== "stop" && (positions.get(c.next) ?? -1) <= i)
          fail("Branch must point to a later existing step or stop");
      });
    });
    [...m.completionChecks, ...m.stopConditions].forEach((c) => {
      if (c.stepIds?.some((s) => !positions.has(s)))
        fail("Check references an unknown step");
    });
  });
export type Method = z.infer<typeof methodSchema>;
export const workCaseSchema = z
  .object({
    ...common,
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
    methodUses: z
      .array(
        z
          .object({
            methodUseRef: id,
            taskRef: id,
            callerId: id,
            method: refSchema.extend({ kind: z.literal("method") }),
            stepIds: z.array(id).max(12),
            returnedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (byteSize(v) > 65536)
      ctx.addIssue({ code: "custom", message: "WorkCase exceeds 64 KiB" });
    if (
      [
        ...v.attempts.flatMap((a) => a.evidenceIndexes),
        ...v.result.evidenceIndexes,
      ].some((n) => n >= v.evidence.length)
    )
      ctx.addIssue({ code: "custom", message: "Unbound case evidence" });
  });
export type WorkCase = z.infer<typeof workCaseSchema>;
export function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
export function identity(scopeId: string) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    revision: 1,
    scopeId,
    createdAt: now,
    updatedAt: now,
  };
}
export function fingerprint(
  segment: z.infer<typeof segmentSchema>,
  sourceIdentity: string,
) {
  const hash = createHash("sha256");
  for (const value of [
    sourceIdentity,
    segment.role,
    segment.locator ?? "",
    segment.author ?? "",
    segment.observedAt ?? "",
    segment.text.replace(/\r\n?/g, "\n"),
  ]) {
    const bytes = Buffer.from(value, "utf8");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function usageErrors(item: z.infer<typeof methodBodySchema>): string[] {
  const errors: string[] = [];
  if (item.state === "held" && !item.review)
    errors.push("Held object requires review");
  if (item.state === "active" && item.review)
    errors.push("Active object cannot retain pending review");
  if (
    item.applicability === "general" &&
    (item.conditions.length || item.exceptions.length)
  )
    errors.push("General object cannot contain restrictions");
  if (
    item.applicability === "conditional" &&
    !item.conditions.length &&
    !item.exceptions.length
  )
    errors.push("Conditional object requires a boundary");
  if (
    item.validFrom &&
    item.validUntil &&
    Date.parse(item.validFrom) > Date.parse(item.validUntil)
  )
    errors.push("Invalid validity interval");
  return errors;
}
