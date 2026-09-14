import { createHash } from "node:crypto";
import { experienceSchema, type Experience } from "../lib/experience.js";

export function sample(overrides: Partial<Experience> = {}): Experience {
  const fingerprint = createHash("sha256").update("authored-p0-fixture:not-production-evidence").digest("hex");
  return experienceSchema.parse({
    id: "fixture-generated", revision: 1, scopeId: "p0:engineering",
    conclusion: "Change the source schema before regenerating a generated API client.",
    level: "L4", purpose: "procedure", applicability: "conditional",
    conditions: [{ text: "The target is a generated artifact.", match: { key: "artifact.kind", values: ["generated"] } }],
    exceptions: [{ text: "The target is maintained by hand.", match: { key: "artifact.kind", values: ["handwritten"] } }],
    topics: ["code-generation"], entities: ["schema"], basis: "observed", assessment: "supported",
    evidence: [{ excerpt: "Generated client edits were replaced on regeneration; the schema change persisted.", role: "tool", relation: "supports", fingerprint }],
    sourceFingerprints: [fingerprint], derivedFrom: [], state: "active",
    createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z", ...overrides,
  });
}
