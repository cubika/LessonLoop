import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { CoreService, ApiError, type Principal } from "../core/service.js";
import { ProductStore, Conflict } from "../store/postgres.js";
import {
  identity,
  digest,
  byteSize,
  materialInputSchema,
} from "../domain/schema.js";
const entry = <T extends { id: string; revision: number; scopeId: string }>(
  kind: string,
  v: T,
) => ({
  kind,
  id: v.id,
  scopeId: v.scopeId,
  revision: v.revision,
  value: v as unknown as Record<string, unknown>,
});
interface Connection {
  id: string;
  revision: number;
  scopeId: string;
  file: string;
  status: "active" | "paused";
  cursor: number;
  prefixDigest: string;
  createdAt: string;
  lastError?: string;
}
interface Binding {
  id: string;
  revision: number;
  scopeId: string;
  connectionId: string;
  sourceKey: string;
  parentSourceKey?: string;
  sourceRevision: number;
  hash: string;
  excluded: boolean;
  current?: { materialId: string; jobId: string };
  pending?: { materialId: string; jobId: string };
  mutation: "snapshot" | "append" | "correct";
}
const changeSchema = z
  .object({
    sourceKey: z.string().min(1).max(128),
    parentSourceKey: z.string().min(1).max(128).optional(),
    mutation: z.enum(["snapshot", "append", "correct"]),
    sourceVersion: z.string().max(128).optional(),
    correctsRef: z
      .object({
        bindingId: z.string(),
        sourceRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    material: materialInputSchema,
  })
  .strict();
export class SampleConnector {
  private running = new Set<string>();
  constructor(
    private readonly core: CoreService,
    private readonly store: ProductStore,
  ) {}
  async add(p: Principal, input: unknown) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    const v = z
      .object({ scopeId: z.string(), file: z.string() })
      .strict()
      .parse(input);
    if (!p.scopes.includes(v.scopeId)) throw new ApiError("not_found", 404);
    const file = await realpath(v.file);
    const content = await readFile(file, "utf8");
    const rows = z.array(changeSchema).max(1000).parse(JSON.parse(content));
    if (rows.some((r) => r.material.scopeId !== v.scopeId))
      throw new ApiError("scope_mismatch");
    const connection: Connection = {
      ...identity(v.scopeId),
      file,
      status: "paused",
      cursor: 0,
      prefixDigest: digest([]),
    };
    await this.store.transaction((tx) =>
      tx.put(entry("connection", connection), null),
    );
    return {
      connection,
      preview: {
        changes: rows.length,
        initialRange: "entire_selected_file",
        requiresResume: true,
      },
    };
  }
  async list(p: Principal) {
    return this.store.transaction((tx) =>
      tx.list<Connection>("connection", p.scopes),
    );
  }
  async state(
    p: Principal,
    id: string,
    expected: number,
    status: "active" | "paused",
  ) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const old = await tx.get<Connection>("connection", id);
      if (!old || !p.scopes.includes(old.scopeId))
        throw new ApiError("not_found", 404);
      if (old.revision !== expected) throw new Conflict();
      const next = { ...old, revision: old.revision + 1, status };
      await tx.put(entry("connection", next), old.revision);
      return next;
    });
  }
  async sync(p: Principal, id: string) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    if (this.running.has(id)) return { status: "already_running" };
    this.running.add(id);
    try {
      const connection = await this.store.transaction((tx) =>
        tx.get<Connection>("connection", id),
      );
      if (!connection || !p.scopes.includes(connection.scopeId))
        throw new ApiError("not_found", 404);
      if (connection.status !== "active") return { status: "paused" };
      const text = await readFile(connection.file, "utf8");
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new ApiError("sample_file_too_large");
      const changes = z.array(changeSchema).max(1000).parse(JSON.parse(text));
      if (
        digest(changes.slice(0, connection.cursor)) !== connection.prefixDigest
      )
        throw new Conflict("sample_history_changed");
      const results = [];
      for (
        let index = connection.cursor;
        index < Math.min(changes.length, connection.cursor + 8);
        index++
      ) {
        const latestConnection = await this.store.transaction((tx) =>
          tx.get<Connection>("connection", id),
        );
        if (latestConnection?.status !== "active") break;
        const change = changes[index]!;
        if (byteSize(change) > 32768)
          throw new ApiError("source_change_too_large");
        if (change.material.scopeId !== connection.scopeId)
          throw new ApiError("scope_mismatch");
        const bindingId = digest([id, change.sourceKey]);
        const hash = digest(change);
        const old = await this.store.transaction((tx) =>
          tx.get<Binding>("source_binding", bindingId),
        );
        if (old?.excluded) {
          results.push({ index, status: "ignored" });
          await this.advanceCursor(
            id,
            index,
            digest(changes.slice(0, index + 1)),
          );
          continue;
        }
        if (old?.hash === hash) {
          results.push({ index, status: "unchanged" });
          await this.advanceCursor(
            id,
            index,
            digest(changes.slice(0, index + 1)),
          );
          continue;
        }
        if (old?.pending) {
          const job = await this.core.getJob(
            { ...p, scopes: [connection.scopeId] },
            old.pending.jobId,
          );
          if (!["completed", "failed", "canceled"].includes(job.status)) break;
        }
        if (old && change.mutation === "append")
          throw new Conflict("append_key_conflict");
        if (
          change.mutation === "correct" &&
          (!old ||
            change.correctsRef?.bindingId !== bindingId ||
            change.correctsRef.sourceRevision !== old.sourceRevision)
        )
          throw new Conflict("correction_target_mismatch");
        if (old)
          throw new ApiError(
            "source_replacement_requires_lifecycle_support",
            409,
          );
        const sourceRevision = 1;
        const accepted = await this.core.submitMaterial(
          {
            id: `connector:${id}`,
            channel: "connector",
            scopes: [connection.scopeId],
          },
          change.material,
          digest([id, change.sourceKey, sourceRevision]),
          `${id}:${change.sourceKey}:${sourceRevision}`,
        );
        await this.store.transaction(async (tx) => {
          const current = await tx.get<Binding>("source_binding", bindingId);
          if (current) {
            if (current.hash === hash) return;
            throw new Conflict();
          }
          const value: Binding = {
            id: bindingId,
            scopeId: connection.scopeId,
            revision: 1,
            connectionId: id,
            sourceKey: change.sourceKey,
            ...(change.parentSourceKey
              ? { parentSourceKey: change.parentSourceKey }
              : {}),
            sourceRevision,
            hash,
            excluded: false,
            mutation: change.mutation,
            pending: { materialId: accepted.materialId, jobId: accepted.jobId },
          };
          await tx.put(entry("source_binding", value), null);
        });
        await this.advanceCursor(
          id,
          index,
          digest(changes.slice(0, index + 1)),
        );
        results.push({ index, status: "accepted", jobId: accepted.jobId });
      }
      return { status: "received", results };
    } finally {
      this.running.delete(id);
    }
  }
  private async advanceCursor(id: string, index: number, prefixDigest: string) {
    await this.store.transaction(async (tx) => {
      const c = await tx.get<Connection>("connection", id);
      if (!c) throw new ApiError("connection_removed");
      if (c.cursor > index) return;
      if (c.cursor !== index) throw new Conflict("cursor_conflict");
      await tx.put(
        entry("connection", {
          ...c,
          cursor: index + 1,
          prefixDigest,
          revision: c.revision + 1,
        }),
        c.revision,
      );
    });
  }
}
