import test from "node:test";
import assert from "node:assert/strict";
import { decide, experienceSchema, type RecallInput } from "../spikes/p0/experience.js";
import { sample } from "../spikes/p0/fixtures.js";
const input = (extra: Partial<RecallInput> = {}): RecallInput => ({ scopes: new Set(["p0:engineering"]), context: {}, trustedContextKeys: new Set(), includeLeads: true, relevant: true, trustedUserConstraint: false, ...extra });

test("missing current context yields a lead without mutating experience", () => {
  const record = sample(); const before = JSON.stringify(record); const result = decide(record, input(), new Map());
  assert.equal("usage" in result && result.usage, "lead"); assert.equal(JSON.stringify(record), before);
});
test("trusted current evidence enables guidance; raw assertion does not", () => {
  const record = sample();
  const untrusted = decide(record, input({ context: { "artifact.kind": "generated" } }), new Map());
  assert.equal("usage" in untrusted && untrusted.usage, "lead");
  const trusted = decide(record, input({ context: { "artifact.kind": "generated" }, trustedContextKeys: new Set(["artifact.kind"]) }), new Map());
  assert.equal("usage" in trusted && trusted.usage, "guidance");
});
test("known exclusion wins over unknown condition without disabling global memory", () => {
  const record = sample({ conditions: [{ text: "Runtime is compatible.", match: { key: "runtime", values: ["v1"] } }] });
  assert.deepEqual(decide(record, input({ context: { "artifact.kind": "handwritten" }, trustedContextKeys: new Set(["artifact.kind"]) }), new Map()), { reason: "not_applicable" });
  assert.equal(record.state, "active");
});
test("source and access checks precede revision disclosure", () => {
  const record = sample();
  assert.deepEqual(decide(record, input({ targetRevision: 2, blockedSources: new Set(record.sourceFingerprints) }), new Map()), { reason: "target_unavailable" });
  assert.deepEqual(decide(record, input({ targetRevision: 2, scopes: new Set() }), new Map()), { reason: "target_unavailable" });
  assert.deepEqual(decide(record, input({ targetRevision: 2 }), new Map()), { reason: "target_changed" });
});
test("stale dependency revisions and cycles cannot be delivered as leads", () => {
  const parent = sample({ id: "parent", revision: 2 }); const child = sample({ id: "child", derivedFrom: [{ id: "parent", revision: 1 }] });
  assert.deepEqual(decide(child, input(), new Map([[parent.id, parent]])), { reason: "target_unavailable" });
  const cycle = sample({ derivedFrom: [{ id: "fixture-generated", revision: 1 }] });
  assert.deepEqual(decide(cycle, input(), new Map([[cycle.id, cycle]])), { reason: "target_unavailable" });
});
test("held, disabled, expired and persistent unknown never become leads", () => {
  for (const record of [sample({ state: "disabled" }), sample({ state: "held", review: { reason: "conflict", question: "Which claim is supported?", reviewBy: "2026-10-01T00:00:00Z" } }), sample({ validUntil: "2020-01-01T00:00:00Z" }), sample({ applicability: "unknown" })]) assert.deepEqual(decide(record, input(), new Map()), { reason: "target_unavailable" });
});
test("attributed fact cannot use active user-constraint escape hatch", () => {
  assert.equal(experienceSchema.safeParse({ ...sample(), assessment: "attributed", basis: "reported" }).success, false);
  const record = sample({ purpose: "constraint", basis: "reported", assessment: "attributed", evidence: sample().evidence.map(e => ({ ...e, role: "user" as const })) });
  assert.deepEqual(decide(record, input(), new Map()), { reason: "target_unavailable" });
});
test("evidence byte limit rejects Unicode rather than truncating", () => {
  assert.equal(experienceSchema.safeParse({ ...sample(), evidence: sample().evidence.map(e => ({ ...e, excerpt: "经".repeat(171) })) }).success, false);
});
test("root source metadata cannot omit the fingerprint of direct evidence", () => {
  assert.equal(experienceSchema.safeParse({ ...sample(), sourceFingerprints: ["a".repeat(64)] }).success, false);
});
