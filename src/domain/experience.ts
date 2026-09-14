import { z } from "zod";
import { conditionSchema, digest } from "./schema.js";

const byteText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= max,
      `UTF-8 value exceeds ${max} bytes`,
    );
const condition = conditionSchema;
const reference = z
  .object({ id: byteText(128), revision: z.number().int().positive().safe() })
  .strict();
export const experienceSchema = z
  .object({
    id: byteText(128),
    revision: z.number().int().positive().safe(),
    scopeId: byteText(128),
    conclusion: byteText(2048),
    level: z.enum(["L1", "L2", "L3", "L4", "L5"]),
    purpose: z.enum(["fact", "constraint", "lesson", "procedure", "rationale"]),
    applicability: z.enum(["general", "conditional", "unknown"]),
    conditions: z.array(condition).max(4),
    exceptions: z.array(condition).max(4),
    topics: z.array(byteText(64)).max(8),
    entities: z.array(byteText(128)).max(16),
    basis: z.enum(["reported", "observed", "inferred"]),
    assessment: z.enum(["attributed", "supported", "hypothesis", "contested"]),
    evidence: z
      .array(
        z
          .object({
            excerpt: byteText(512),
            role: z.enum(["user", "agent", "external", "tool"]),
            relation: z.enum(["supports", "contradicts"]),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            locator: byteText(256).optional(),
            author: byteText(128).optional(),
            observedAt: z.string().datetime().optional(),
          })
          .strict(),
      )
      .max(3),
    derivedFrom: z.array(reference).max(8),
    sourceFingerprints: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(32),
    state: z.enum(["active", "held", "disabled"]),
    review: z
      .object({
        reason: z.enum([
          "verification_requested",
          "conflict",
          "source_changed",
          "scope_unclear",
        ]),
        question: byteText(512),
        reviewBy: z.string().datetime(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > 16384)
      fail("Experience exceeds 16 KiB");
    if (Buffer.byteLength(JSON.stringify(record.evidence), "utf8") > 2048)
      fail("Evidence exceeds 2 KiB");
    if (!record.evidence.length && !record.derivedFrom.length)
      fail("Experience requires evidence or derivation");
    if (
      new Set(record.sourceFingerprints).size !==
      record.sourceFingerprints.length
    )
      fail("Duplicate root fingerprints");
    if (
      record.evidence.some(
        (e) => !record.sourceFingerprints.includes(e.fingerprint),
      )
    )
      fail("Evidence fingerprint missing from root sources");
    if (
      !record.derivedFrom.length &&
      record.sourceFingerprints.some(
        (fp) => !record.evidence.some((e) => e.fingerprint === fp),
      )
    )
      fail("Unbound root fingerprint");
    if (
      record.applicability === "general" &&
      (record.conditions.length || record.exceptions.length)
    )
      fail("General experience cannot contain restrictions");
    if (
      record.applicability === "conditional" &&
      !record.conditions.length &&
      !record.exceptions.length
    )
      fail("Conditional experience requires a boundary");
    if (record.state === "held" && !record.review)
      fail("Held experience requires review");
    if (record.state === "active" && record.review)
      fail("Active experience cannot retain pending review");
    if (
      record.validFrom &&
      record.validUntil &&
      Date.parse(record.validFrom) > Date.parse(record.validUntil)
    )
      fail("Invalid validity interval");
    const userRule =
      record.purpose === "constraint" &&
      record.basis === "reported" &&
      record.assessment === "attributed" &&
      record.evidence.some(
        (e) => e.role === "user" && e.relation === "supports",
      );
    if (
      record.state === "active" &&
      record.assessment !== "supported" &&
      !userRule
    )
      fail("Unsubstantiated active experience");
  });
export type Experience = z.infer<typeof experienceSchema>;
export type ContextValues = Record<string, string | string[]>;
export interface RecallInput {
  scopes: ReadonlySet<string>;
  context: ContextValues;
  includeLeads: boolean;
  relevant: boolean;
  trustedContextKeys: ReadonlySet<string>;
  trustedUserConstraint: boolean;
  now?: number;
  targetRevision?: number;
  blockedIds?: ReadonlySet<string>;
  blockedSources?: ReadonlySet<string>;
  conditionEvidence?: ReadonlyMap<string, boolean>;
  published?: ReadonlyMap<string, number>;
}
export type Decision =
  | {
      usage: "guidance" | "lead";
      taskApplicability: "applicable" | "undetermined";
      missingChecks: Array<{
        field: "conditions" | "exceptions";
        index: number;
        question: string;
        contextKey?: string;
      }>;
    }
  | { reason: string };

// Deterministic evaluation checks only: no claim to infer relevance or verify source truth.
export function decide(
  record: Experience,
  input: RecallInput,
  records: ReadonlyMap<string, Experience>,
): Decision {
  const now = input.now ?? Date.now();
  let visited = 0;
  const eligible = (
    item: Experience,
    depth: number,
    ancestors: Set<string>,
  ): boolean => {
    if (++visited > 32 || depth > 5 || ancestors.has(item.id)) return false;
    const userRule =
      input.trustedUserConstraint &&
      item.purpose === "constraint" &&
      item.basis === "reported" &&
      item.assessment === "attributed" &&
      item.evidence.some((e) => e.role === "user" && e.relation === "supports");
    if (
      !input.scopes.has(item.scopeId) ||
      item.state !== "active" ||
      (item.assessment !== "supported" && !userRule) ||
      item.applicability === "unknown"
    )
      return false;
    if (
      (item.validFrom && Date.parse(item.validFrom) > now) ||
      (item.validUntil && Date.parse(item.validUntil) <= now)
    )
      return false;
    if (
      input.blockedIds?.has(item.id) ||
      item.sourceFingerprints.some((fp) => input.blockedSources?.has(fp))
    )
      return false;
    if (input.published && input.published.get(item.id) !== item.revision)
      return false;
    const next = new Set(ancestors).add(item.id);
    const roots = new Set(item.evidence.map((e) => e.fingerprint));
    const parentsValid = item.derivedFrom.every((ref) => {
      const parent = records.get(ref.id);
      parent?.sourceFingerprints.forEach((fp) => roots.add(fp));
      return (
        parent?.revision === ref.revision &&
        parent.scopeId === item.scopeId &&
        eligible(parent, depth + 1, next)
      );
    });
    return (
      parentsValid &&
      roots.size === item.sourceFingerprints.length &&
      item.sourceFingerprints.every((fp) => roots.has(fp))
    );
  };
  if (!eligible(record, 0, new Set())) return { reason: "target_unavailable" };
  if (
    input.targetRevision !== undefined &&
    input.targetRevision !== record.revision
  )
    return { reason: "target_changed" };
  if (!input.relevant) return { reason: "no_match" };
  const missing: Extract<Decision, { usage: string }>["missingChecks"] = [];
  let excluded = false;
  for (const field of ["conditions", "exceptions"] as const) {
    record[field].forEach((item, index) => {
      const evaluated = !item.match
        ? input.conditionEvidence?.get(digest(item))
        : undefined;
      if (evaluated !== undefined) {
        if (
          (field === "conditions" && !evaluated) ||
          (field === "exceptions" && evaluated)
        )
          excluded = true;
        return;
      }
      const actual =
        item.match && input.trustedContextKeys.has(item.match.key)
          ? input.context[item.match.key]
          : undefined;
      if (!item.match || actual === undefined) {
        missing.push({
          field,
          index,
          question: `Check: ${item.text}`,
          ...(item.match ? { contextKey: item.match.key } : {}),
        });
        return;
      }
      const values = Array.isArray(actual) ? actual : [actual];
      const match = item.match.values.some((value) => values.includes(value));
      if (
        (field === "conditions" && !match) ||
        (field === "exceptions" && match)
      )
        excluded = true;
    });
  }
  if (excluded) return { reason: "not_applicable" };
  if (missing.length) {
    if (
      !input.includeLeads ||
      missing.length > 4 ||
      missing.some((check) => Buffer.byteLength(check.question, "utf8") > 256)
    )
      return { reason: "applicability_unknown" };
    return {
      usage: "lead",
      taskApplicability: "undetermined",
      missingChecks: missing,
    };
  }
  return {
    usage: "guidance",
    taskApplicability: "applicable",
    missingChecks: [],
  };
}
