import { createHash } from "node:crypto";
import {
  experienceSchema,
  type Experience,
} from "../../src/domain/experience.js";
import { matchText } from "../../src/domain/schema.js";

export function sample(overrides: Partial<Experience> = {}): Experience {
  const fingerprint = createHash("sha256")
    .update("authored-p0-fixture:not-production-evidence")
    .digest("hex");
  const condition = (value: string) => {
    const match = { key: "artifact.kind", values: [value] };
    return { text: matchText(match), match };
  };
  return experienceSchema.parse({
    id: "fixture-generated",
    revision: 1,
    scopeId: "p0:engineering",
    conclusion:
      "Change the source schema before regenerating a generated API client.",
    level: "L4",
    purpose: "procedure",
    applicability: "conditional",
    conditions: [condition("generated")],
    exceptions: [condition("handwritten")],
    topics: ["code-generation"],
    entities: ["schema"],
    basis: "observed",
    assessment: "supported",
    evidence: [
      {
        excerpt:
          "Generated client edits were replaced on regeneration; the schema change persisted.",
        role: "tool",
        relation: "supports",
        fingerprint,
      },
    ],
    sourceFingerprints: [fingerprint],
    derivedFrom: [],
    state: "active",
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z",
    ...overrides,
  });
}
