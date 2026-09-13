import { register } from "node:module";
import { mkdir } from "node:fs/promises";
import type { Memory as MemoryType } from "mem0ai/oss";
import { experienceSchema, metadata, searchText, type Experience } from "./experience.js";
import { workspacePath, loopbackUrl } from "./paths.js";

let registered = false;
export async function createMemory(qdrantUrl: string, embeddingUrl: string, collection: string, llmUrl = embeddingUrl, llmModel = "unconfigured-storage-probe"): Promise<MemoryType> {
  loopbackUrl(qdrantUrl);
  loopbackUrl(embeddingUrl);
  if (!/^p0_[a-z0-9_]+$/.test(collection)) throw new Error("Probe collection must use p0_ namespace");
  process.env.MEM0_TELEMETRY = "false";
  process.env.MEM0_DIR = workspacePath(".p0", "mem0-profile");
  await mkdir(process.env.MEM0_DIR, { recursive: true });
  if (!registered) { register("./mem0-imports.mjs", import.meta.url); registered = true; }
  const { Memory } = await import("mem0ai/oss");
  return new Memory({
    disableHistory: true,
    vectorStore: { provider: "qdrant", config: { url: qdrantUrl, collectionName: collection, dimension: 384 } },
    embedder: { provider: "openai", config: { baseURL: embeddingUrl, apiKey: "local-embedding-only", model: "all-MiniLM-L6-v2-q8" } },
    llm: { provider: "openai", config: { baseURL: llmUrl, apiKey: process.env.LESSONLOOP_MODEL_API_KEY || "local", model: llmModel, temperature: 0, timeout: 20000 } },
  });
}

export class ProbeGateway {
  constructor(readonly memory: MemoryType, readonly userId: string) {}
  async add(record: Experience): Promise<Experience> {
    experienceSchema.parse(record);
    const result = await this.memory.add(searchText(record), { userId: this.userId, infer: false, metadata: metadata(record, `probe-${record.id}-${record.revision}`) });
    const id = result.results[0]?.id;
    if (!id) throw new Error("Mem0 returned no record ID");
    const saved = await this.get(id);
    if (!saved || saved.revision !== record.revision) throw new Error("Mem0 write readback did not match revision");
    return saved;
  }
  async get(id: string): Promise<Experience | null> {
    const item = await this.memory.get(id);
    if (!item) return null;
    const owner = (item as typeof item & { user_id?: string }).user_id;
    if (owner !== this.userId) return null;
    return experienceSchema.parse({ ...item.metadata?.ll_record, id: item.id, revision: item.metadata?.ll_revision });
  }
  async update(record: Experience): Promise<Experience> {
    experienceSchema.parse(record);
    const current = await this.get(record.id);
    if (!current || current.scopeId !== record.scopeId) throw new Error("Update target is not in the gateway owner/scope");
    if (record.revision !== current.revision + 1) throw new Error("Probe update must advance exactly one revision");
    await this.memory.update(record.id, { text: searchText(record), metadata: metadata(record, `probe-update-${record.revision}`) });
    const saved = await this.get(record.id);
    if (!saved || saved.revision !== record.revision) throw new Error("Updated revision readback failed");
    return saved;
  }
  async search(query: string, scopeId: string, topK = 3): Promise<Experience[]> {
    const now = Date.now();
    const results = await this.memory.search(query, { topK, threshold: 0, filters: { user_id: this.userId, ll_scope: scopeId, ll_state: "active", ll_valid_from_ms: { lte: now }, ll_valid_until_ms: { gt: now } } });
    const rows = await Promise.all(results.results.map(item => this.get(item.id)));
    return rows.filter((row): row is Experience => row !== null && row.scopeId === scopeId && row.state === "active" && (!row.validFrom || Date.parse(row.validFrom) <= now) && (!row.validUntil || Date.parse(row.validUntil) > now));
  }
}
