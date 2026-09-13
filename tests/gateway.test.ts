import test from "node:test";
import assert from "node:assert/strict";
import type { Memory } from "mem0ai/oss";
import { ProbeGateway } from "../spikes/p0/mem0-gateway.js";
import { sample } from "../spikes/p0/fixtures.js";
import { metadata } from "../spikes/p0/experience.js";

test("ID reads and updates cannot cross the gateway user boundary", async () => {
  const record = sample();
  let updates = 0;
  const fake = { get: async () => ({ id: record.id, user_id: "someone-else", metadata: metadata(record, "nonce") }), update: async () => { updates++; } } as unknown as Memory;
  const gateway = new ProbeGateway(fake, "this-user");
  assert.equal(await gateway.get(record.id), null);
  await assert.rejects(gateway.update({ ...record, revision: 2 }), /gateway owner/);
  assert.equal(updates, 0);
});
test("updates cannot silently change a memory scope or skip revisions", async () => {
  const record = sample();
  const fake = { get: async () => ({ id: record.id, user_id: "this-user", metadata: metadata(record, "nonce") }) } as unknown as Memory;
  const gateway = new ProbeGateway(fake, "this-user");
  await assert.rejects(gateway.update({ ...record, scopeId: "other", revision: 2 }), /gateway owner/);
  await assert.rejects(gateway.update({ ...record, revision: 3 }), /exactly one revision/);
});
