import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeInput } from "../src/connectors/input.js";
import { readPage, readSampleFile } from "../src/connectors/sample-source.js";
import { byteSize } from "../src/domain/schema.js";

test("Connector splits full UTF-8 content deterministically without losing source attribution", () => {
  const original = 'Observe 中文 🧭 \"quoted\"\n'.repeat(4000);
  const input = {
    kind: "source",
    scopeId: "scope",
    segments: [
      {
        text: original,
        role: "external",
        locator: "file://selected/doc#body",
        author: "Original author",
        observedAt: "2026-09-15T00:00:00.000Z",
      },
    ],
  };
  const parts = normalizeInput(input);
  assert.ok(parts.length > 1 && parts.length <= 8);
  assert.deepEqual(normalizeInput(JSON.parse(JSON.stringify(input))), parts);
  assert.equal(
    parts
      .flatMap((part) => part.material.segments)
      .map((segment) => segment.text)
      .join(""),
    original,
  );
  for (const part of parts) {
    assert.ok(byteSize(part.material) <= 32768);
    for (const segment of part.material.segments) {
      assert.equal(segment.locator, input.segments[0]!.locator);
      assert.equal(segment.author, "Original author");
      assert.equal(segment.observedAt, "2026-09-15T00:00:00.000Z");
      assert.equal(Buffer.from(segment.text).toString("utf8"), segment.text);
    }
  }
});

test("Source drafts retain claims, gaps and evidence without accepting publication authority", () => {
  const evidence = [
    { text: "Command returned exit code 0.", role: "tool", locator: "log:12" },
  ];
  const inputs = [
    {
      kind: "source",
      scopeId: "scope",
      goal: "Verify the build",
      attempts: [{ action: "Run the build" }],
      unresolved: ["Deployment result unknown"],
      evidence,
    },
    {
      kind: "experience_draft",
      scopeId: "scope",
      conclusion: "The build completed",
      conditions: ["Local environment"],
      evidence,
    },
    {
      kind: "playbook_draft",
      scopeId: "scope",
      title: "Build check",
      goal: "Verify the build",
      steps: [
        { stepId: "build", instruction: "Run the build", evidenceIndexes: [0] },
      ],
      completionChecks: ["Exit code is 0"],
      evidence,
    },
  ];
  for (const input of inputs) {
    const parts = normalizeInput(input);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0]!.material.segments[1], evidence[0]);
    const document = JSON.parse(parts[0]!.material.segments[0]!.text);
    assert.equal(document.kind, input.kind);
    assert.equal(document.state, undefined);
    assert.equal(document.assessment, undefined);
    assert.throws(() => normalizeInput({ ...input, state: "active" }));
    assert.throws(() => normalizeInput({ ...input, assessment: "supported" }));
    assert.throws(() => normalizeInput({ ...input, id: "external-id" }));
  }
  const workCase = JSON.parse(
    normalizeInput(inputs[0])[0]!.material.segments[0]!.text,
  );
  assert.equal(workCase.attempts[0].outcome, "unknown");
  assert.equal(workCase.result, undefined);
  assert.deepEqual(workCase.unresolved, ["Deployment result unknown"]);
});

test("Method source draft requires evidence and valid forward branches", () => {
  const draft = {
    kind: "playbook_draft",
    scopeId: "scope",
    title: "Build check",
    goal: "Verify the build",
    steps: [
      { stepId: "build", instruction: "Run the build", evidenceIndexes: [0] },
    ],
    completionChecks: ["Exit code is 0"],
    evidence: [{ text: "Build result", role: "external" }],
  };
  assert.throws(
    () =>
      normalizeInput({
        ...draft,
        steps: [{ ...draft.steps[0], evidenceIndexes: [1] }],
      }),
    /unbound_method_evidence/,
  );
  assert.throws(
    () =>
      normalizeInput({
        ...draft,
        steps: [
          {
            ...draft.steps[0],
            choices: [{ when: "Build fails", next: "build" }],
          },
        ],
      }),
    /invalid_method_branch/,
  );
  assert.throws(() => normalizeInput({ ...draft, evidence: [] }));
  assert.throws(() => normalizeInput({ ...draft, completionChecks: [] }));
});

test("Sample snapshot rejects missing, duplicate and incomplete parts before accepting content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lessonloop-connector-"));
  const file = join(directory, "source.json");
  const material = {
    scopeId: "scope",
    segments: [{ text: "Full source", role: "external" }],
  };
  const change = {
    sourceKey: "doc",
    mutation: "snapshot",
    complete: true,
    partKeys: ["intro", "body"],
    parts: [
      { partKey: "body", source: material },
      { partKey: "intro", source: material },
    ],
  };
  try {
    await writeFile(file, JSON.stringify([change]));
    const snapshot = await readSampleFile(file, "scope");
    assert.deepEqual(
      snapshot.changes[0]!.parts.map((part) => part.partKey),
      ["intro", "body"],
    );
    for (const invalid of [
      { ...change, complete: false },
      { ...change, parts: change.parts.slice(0, 1) },
      { ...change, partKeys: ["intro", "intro"] },
      { ...change, parts: [change.parts[0], change.parts[0]] },
    ]) {
      await writeFile(file, JSON.stringify([invalid]));
      await assert.rejects(
        readSampleFile(file, "scope"),
        /source_parts_incomplete/,
      );
    }
    await writeFile(
      file,
      JSON.stringify([
        {
          ...change,
          parts: [
            {
              partKey: "intro",
              source: { ...material, scopeId: "elsewhere" },
            },
          ],
          partKeys: ["intro"],
        },
      ]),
    );
    await assert.rejects(readSampleFile(file, "scope"), /scope_mismatch/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("Connector read page budgets count material parts and leave complete source changes together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lessonloop-connector-"));
  const file = join(directory, "source.json");
  try {
    const source = (sourceKey: string, count: number) => ({
      sourceKey,
      mutation: "snapshot",
      complete: true,
      partKeys: Array.from({ length: count }, (_, n) => `part-${n}`),
      parts: Array.from({ length: count }, (_, n) => ({
        partKey: `part-${n}`,
        source: {
          scopeId: "scope",
          segments: [{ text: `Evidence ${n}`, role: "external" }],
        },
      })),
    });
    await writeFile(
      file,
      JSON.stringify([source("A", 7), source("B", 2), source("C", 1)]),
    );
    const snapshot = await readSampleFile(file, "scope");
    assert.deepEqual(
      readPage(snapshot, 0).map((change) => change.sourceKey),
      ["A"],
    );
    assert.deepEqual(
      readPage(snapshot, 1).map((change) => change.sourceKey),
      ["B", "C"],
    );
    await writeFile(
      file,
      JSON.stringify([
        {
          sourceKey: "oversized",
          mutation: "snapshot",
          source: {
            scopeId: "scope",
            segments: [{ text: "x".repeat(262144), role: "external" }],
          },
        },
      ]),
    );
    await assert.rejects(
      readSampleFile(file, "scope"),
      /source_change_too_large/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
