import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { startLocalEmbeddings } from "./local-embeddings.js";
import { startQdrant } from "./qdrant-runtime.js";
import { createMemory, ProbeGateway } from "./mem0-gateway.js";
import { sample } from "./fixtures.js";
import { workspacePath } from "./paths.js";

async function sqliteFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sqliteFiles(full));
    else if (/\.(sqlite|sqlite3|db)(-wal|-shm)?$/i.test(entry.name)) found.push(full);
    else if (entry.name.endsWith(".json")) continue;
  }
  return found;
}
export async function runStorageProbe() {
  const runId = `storage_${Date.now()}`;
  const started = performance.now();
  const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
  let database: Awaited<ReturnType<typeof startQdrant>> | undefined;
  let embeddings: Awaited<ReturnType<typeof startLocalEmbeddings>> | undefined;
  let errorMessage: string | undefined;
  const recordCheck = (name: string, detail?: unknown) => checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
  try {
    database = await startQdrant(runId);
    const client = new QdrantClient({ url: database.url });
    embeddings = await startLocalEmbeddings();
    recordCheck("real_local_embedding_model", { model: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", dimensions: 384, quantization: "q8" });
    const collection = `p0_${runId}`;
    const memory = await createMemory(database.url, embeddings.url, collection);
    const gateway = new ProbeGateway(memory, "p0-isolated-user");
    const saved = await gateway.add(sample());
    const other = await gateway.add(sample({ id: "fixture-tool", conclusion: "Use the ALPHA_ONLY_TOOL when checking deployment configuration.", entities: ["ALPHA_ONLY_TOOL"], scopeId: "p0:other", conditions: [], exceptions: [], applicability: "general" }));
    assert.deepEqual(saved.conditions, sample().conditions);
    assert.deepEqual(saved.evidence, sample().evidence);
    assert.equal(other.scopeId, "p0:other");
    assert.equal(embeddings.calls.unexpectedLlm, 0);
    recordCheck("per_record_metadata_roundtrip_and_infer_false", { memoryIds: [saved.id, other.id] });
    for (const field of ["ll_scope", "ll_state", "ll_entities", "ll_source_fingerprints"]) await client.createPayloadIndex(collection, { field_name: field, field_schema: "keyword", wait: true });
    await client.createPayloadIndex(collection, { field_name: "ll_valid_until_ms", field_schema: "integer", wait: true });
    await gateway.add(sample({ id: "wrong-scope-exact", scopeId: "p0:other" }));
    await gateway.add(sample({ id: "disabled-exact", state: "disabled" }));
    await gateway.add(sample({ id: "expired-exact", validUntil: "2020-01-01T00:00:00Z" }));
    const hits = await gateway.search("How do I modify an auto-generated client without losing changes?", "p0:engineering", 1);
    assert.equal(hits[0]?.id, saved.id);
    recordCheck("semantic_retrieval_with_selective_filters_small_fixture", { returned: hits.map(row => row.id), exactTextDistractors: ["wrong_scope", "disabled", "expired"], candidateLimitStressTest: false });
    const literal = await client.scroll(collection, { filter: { must: [{ key: "ll_scope", match: { value: "p0:other" } }, { key: "ll_entities", match: { value: "ALPHA_ONLY_TOOL" } }] }, limit: 1, with_payload: true });
    assert.equal(literal.points[0]?.id, other.id);
    recordCheck("native_exact_payload_query");
    const before = embeddings.calls.texts;
    await memory.update(saved.id, { metadata: { ll_probe: "metadata-edit" } });
    assert.ok(embeddings.calls.texts > before);
    recordCheck("metadata_only_update_reembeds", { additionalEmbeddingTexts: embeddings.calls.texts - before });
    const revised = await gateway.update({ ...saved, revision: 2, state: "disabled", updatedAt: new Date().toISOString() });
    assert.equal(revised.state, "disabled");
    assert.equal((await gateway.search("generated client", "p0:engineering")).length, 0);
    recordCheck("revision_update_and_disabled_exclusion");
    const reopened = new ProbeGateway(await createMemory(database.url, embeddings.url, collection), "p0-isolated-user");
    assert.equal((await reopened.get(saved.id))?.revision, 2);
    recordCheck("new_mem0_instance_reads_persistent_revision");
    const allIds: Array<string | number> = [];
    let offset: string | number | null | undefined;
    do {
      const page = await client.scroll(collection, { limit: 1, with_payload: true, ...(offset !== undefined && offset !== null ? { offset } : {}) });
      allIds.push(...page.points.map(point => point.id));
      const nextOffset = page.next_page_offset;
      if (nextOffset !== null && nextOffset !== undefined && typeof nextOffset !== "string" && typeof nextOffset !== "number") throw new Error("Unsupported Qdrant cursor type");
      offset = nextOffset;
    } while (offset !== null && offset !== undefined);
    assert.equal(new Set(allIds).size, 5);
    recordCheck("complete_native_scroll", { pages: allIds.length });
    const operations = `p0_ops_${runId}`;
    await client.createCollection(operations, { vectors: {} });
    const operationId = randomUUID();
    await client.upsert(operations, { wait: true, points: [{ id: operationId, vector: {}, payload: { recordType: "write_operation", status: "prepared", targetId: saved.id } }] });
    assert.equal((await client.retrieve(operations, { ids: [operationId], with_payload: true }))[0]?.payload?.status, "prepared");
    recordCheck("payload_only_management_point");
    await memory.delete(other.id);
    assert.equal(await memory.get(other.id), null);
    recordCheck("delete_readback");
    await database.stop();
    database = await startQdrant(runId);
    const restarted = new ProbeGateway(await createMemory(database.url, embeddings.url, collection), "p0-isolated-user");
    assert.equal((await restarted.get(saved.id))?.state, "disabled");
    assert.equal(await restarted.memory.get(other.id), null);
    const restartedClient = new QdrantClient({ url: database.url });
    assert.equal((await restartedClient.retrieve(operations, { ids: [operationId], with_payload: true }))[0]?.payload?.status, "prepared");
    recordCheck("owned_qdrant_process_restart_preserves_state_and_deletion");
    assert.deepEqual(await sqliteFiles(database.directory), []);
    assert.deepEqual(await sqliteFiles(workspacePath(".p0", "mem0-profile")), []);
    recordCheck("no_sqlite_data_files_in_probe_profiles");
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    checks.push({ name: "probe_execution", passed: false, detail: errorMessage });
  } finally {
    if (embeddings) await embeddings.close();
    if (database) await database.stop();
  }
  const report = {
    runId, timestamp: new Date().toISOString(), status: errorMessage ? "failed" : "passed", elapsedMs: Math.round(performance.now() - started),
    runtime: { node: process.version, mem0: "3.1.8", qdrant: "1.19.1", qdrantClient: "1.18.0" },
    checks, calls: embeddings?.calls,
    packagingFinding: "Unmodified mem0ai/oss import failed because its bundle eagerly imports better-sqlite3; P0 loader rejects unused SQL providers. No SQL storage is installed or used. Qdrant client 1.19.0 removed client.search required by Mem0; pinned to 1.18.0. These compatibility findings need release resolution.",
    limitations: ["Authored storage fixtures, not learned experiences or a quality benchmark.", "Small selective-filter fixture does not prove filtering before the internal candidate limit; large distractor tests remain required.", "English lightweight embedding only; bilingual accuracy not established.", "Owned-process restart is tested after confirmed writes; mid-write crash and uncertain writes are not covered.", "Text update may attempt internal entity LLM work; the probe rejects model calls and records them.", "No Copilot hooks or task benefit tested here."],
  };
  await mkdir(workspacePath(".p0", "results"), { recursive: true });
  await writeFile(workspacePath(".p0", "results", "storage-probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errorMessage) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runStorageProbe();
