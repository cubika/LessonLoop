import test from "node:test";
import assert from "node:assert/strict";
import { experienceSchema, type Experience } from "../src/domain/experience.js";
import {
  byteSize,
  matchText,
  playbookSchema,
  type Playbook,
} from "../src/domain/schema.js";

const timestamp = "2026-09-15T00:00:00.000Z";
const controls = {
  state: "active" as const,
  revision: 1,
  updatedAt: timestamp,
};

function fillToBoundary(
  body: object,
  limit: number,
  fields: Array<{ value: string; set(value: string): void }>,
) {
  let remaining = limit - byteSize(body);
  assert.ok(remaining > 0, "Fixture must begin below the content limit");
  for (const field of fields) {
    const count = Math.min(remaining, field.value.length);
    // Replacing ASCII with a newline adds one JSON byte without growing the text field.
    field.set("\n".repeat(count) + field.value.slice(count));
    remaining -= count;
  }
  assert.equal(
    remaining,
    0,
    "Fixture must have enough text capacity to reach the boundary",
  );
  assert.equal(byteSize(body), limit);
}

function experienceAtBoundary(): Experience {
  const match = {
    key: "k".repeat(64),
    values: ["v".repeat(100), "w".repeat(100), "x".repeat(100)],
  };
  const roots = Array.from({ length: 32 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const body = {
    id: "i".repeat(128),
    scopeId: "s".repeat(128),
    createdAt: timestamp,
    conclusion: "c".repeat(2047),
    purpose: "procedure" as const,
    applicability: "conditional" as const,
    conditions: Array.from({ length: 4 }, () => ({
      text: matchText(match),
      match,
    })),
    exceptions: Array.from({ length: 4 }, () => ({
      text: matchText(match),
      match,
    })),
    topics: Array(8).fill("t".repeat(64)),
    entities: Array(16).fill("e".repeat(128)),
    basis: "observed" as const,
    assessment: "supported" as const,
    sourceFingerprints: roots,
    derivedFrom: Array.from({ length: 8 }, (_, i) => ({
      id: String(i).repeat(128),
      revision: 1,
    })),
    evidence: [
      {
        excerpt: "a".repeat(512),
        role: "tool" as const,
        relation: "supports" as const,
        fingerprint: roots[0]!,
        locator: "l".repeat(256),
        author: "a".repeat(128),
      },
    ],
  };
  fillToBoundary(body, 16384, [
    {
      value: body.conclusion,
      set: (value) => {
        body.conclusion = value;
      },
    },
  ]);
  return experienceSchema.parse({ ...body, ...controls });
}

function playbookAtBoundary(): Playbook {
  const body = {
    id: "i".repeat(128),
    scopeId: "s".repeat(128),
    createdAt: timestamp,
    title: "t".repeat(255),
    goal: "g".repeat(1024),
    topics: Array(8).fill("t".repeat(64)),
    applicability: "conditional" as const,
    conditions: Array.from({ length: 4 }, () => ({ text: "c".repeat(512) })),
    exceptions: Array.from({ length: 4 }, () => ({ text: "e".repeat(512) })),
    steps: Array.from({ length: 12 }, (_, i) => ({
      stepId: "s" + i,
      instruction: "i".repeat(1024),
      rationale: "r".repeat(256),
      supportIndexes: [i],
    })),
    completionChecks: Array.from({ length: 4 }, () => ({
      text: "c".repeat(512),
    })),
    stopConditions: Array.from({ length: 4 }, () => ({
      text: "s".repeat(512),
    })),
    supportRefs: Array.from({ length: 16 }, (_, i) => ({
      kind: "experience" as const,
      id: String(i).padStart(128, "e"),
      revision: 1,
    })),
    change: {
      kind: "create" as const,
      summary: "s".repeat(1024),
      predecessors: Array.from({ length: 4 }, (_, i) => ({
        kind: "playbook" as const,
        id: String(i).padStart(128, "p"),
        revision: 1,
      })),
    },
  };
  fillToBoundary(
    body,
    32768,
    body.steps.map((step) => ({
      value: step.instruction,
      set: (value) => {
        step.instruction = value;
      },
    })),
  );
  return playbookSchema.parse({ ...body, ...controls });
}

for (const fixture of [
  {
    name: "Experience",
    schema: experienceSchema,
    value: experienceAtBoundary(),
    exceed: (value: Experience | Playbook) => ({
      ...value,
      conclusion: (value as Experience).conclusion + "x",
    }),
    error: "Experience content exceeds 16 KiB",
  },
  {
    name: "Playbook",
    schema: playbookSchema,
    value: playbookAtBoundary(),
    exceed: (value: Experience | Playbook) => ({
      ...value,
      title: (value as Playbook).title + "x",
    }),
    error: "Playbook content exceeds 32 KiB",
  },
]) {
  test(
    fixture.name +
      " at its exact content limit can be held and disabled without dropping content",
    () => {
      const original = fixture.schema.parse(fixture.value);
      const review = {
        reason: "verification_requested" as const,
        question: "\u0000".repeat(512),
        reviewBy: "2027-01-01T00:00:00.000Z",
      };
      const updatedAt = "2026-09-16T00:00:00.000Z";
      const held = fixture.schema.parse({
        ...original,
        state: "held",
        revision: Number.MAX_SAFE_INTEGER - 1,
        updatedAt,
        review,
      });
      assert.deepEqual(held, {
        ...original,
        state: "held",
        revision: Number.MAX_SAFE_INTEGER - 1,
        updatedAt,
        review,
      });
      const { review: _review, ...withoutReview } = held;
      const disabled = fixture.schema.parse({
        ...withoutReview,
        state: "disabled",
        revision: Number.MAX_SAFE_INTEGER,
      });
      assert.deepEqual(disabled, {
        ...original,
        state: "disabled",
        revision: Number.MAX_SAFE_INTEGER,
        updatedAt,
      });
      const invalidReview = fixture.schema.safeParse({
        ...held,
        review: { ...review, question: review.question + "x" },
      });
      assert.equal(
        invalidReview.success,
        false,
        "Control metadata keeps its independent field limit",
      );
      const oversized = fixture.schema.safeParse(fixture.exceed(original));
      assert.equal(oversized.success, false);
      if (!oversized.success)
        assert.deepEqual(
          oversized.error.issues.map((issue) => issue.message),
          [fixture.error],
        );
    },
  );
}
