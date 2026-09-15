import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { CoreService, ApiError, type Principal } from "../core/service.js";
import { ProductStore, Conflict, type Transaction } from "../store/postgres.js";
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
  status: "active" | "paused" | "removed";
  cursor: number;
  prefixDigest: string;
  createdAt: string;
  lastError?: string;
  intervalMinutes?: number;
  nextSyncAt?: string;
  scheduleRevision?: number;
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
  received?: { materialId: string; jobId: string };
  pending?: { materialId: string; jobId: string };
  materialIds?: string[];
  learningStatus?: string;
  resourceType?: "snapshot" | "event";
  mutation: "snapshot" | "append" | "correct" | "withdraw" | "erase";
}
const changeSchema = z
  .object({
    sourceKey: z.string().min(1).max(128),
    parentSourceKey: z.string().min(1).max(128).optional(),
    mutation: z.enum(["snapshot", "append", "correct", "withdraw", "erase"]),
    sourceVersion: z.string().max(128).optional(),
    correctsRef: z
      .object({
        bindingId: z.string(),
        sourceRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    material: materialInputSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      ["withdraw", "erase"].includes(v.mutation) ? !v.material : !!v.material,
    "material_required_only_for_content_changes",
  );
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
    if (Buffer.byteLength(content) > 2 * 1024 * 1024)
      throw new ApiError("sample_file_too_large");
    const rows = z.array(changeSchema).max(1000).parse(JSON.parse(content));
    if (rows.some((r) => r.material && r.material.scopeId !== v.scopeId))
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
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const connections = await tx.list<Connection>("connection", p.scopes);
      for (const connection of connections) await this.settle(tx, connection);
      return connections;
    });
  }
  async state(
    p: Principal,
    id: string,
    expected: number,
    status: "active" | "paused" | "removed",
  ) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const old = await tx.get<Connection>("connection", id);
      if (!old || !p.scopes.includes(old.scopeId))
        throw new ApiError("not_found", 404);
      if (old.revision !== expected) throw new Conflict();
      if (old.status === "removed")
        throw new ApiError("connection_removed", 409);
      const next = { ...old, revision: old.revision + 1, status };
      await tx.put(entry("connection", next), old.revision);
      return next;
    });
  }
  async schedule(p: Principal, input: unknown) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    const v = z
      .object({
        id: z.string(),
        expectedRevision: z.number().int().positive(),
        intervalMinutes: z.number().int().min(0).max(1440),
      })
      .strict()
      .parse(input);
    return this.store.transaction(async (tx) => {
      const old = await tx.get<Connection>("connection", v.id);
      if (!old || !p.scopes.includes(old.scopeId))
        throw new ApiError("not_found", 404);
      if (old.revision !== v.expectedRevision) throw new Conflict();
      if (old.status === "removed")
        throw new ApiError("connection_removed", 409);
      const next = {
        ...old,
        revision: old.revision + 1,
        intervalMinutes: v.intervalMinutes,
        scheduleRevision: (old.scheduleRevision ?? 0) + 1,
        nextSyncAt: new Date().toISOString(),
      };
      await tx.put(entry("connection", next), old.revision);
      return next;
    });
  }
  async tick(scopes: string[], now = Date.now()) {
    const due = await this.store.transaction(async (tx) => {
      const rows = (await tx.list<Connection>("connection", scopes))
        .filter(
          (c) =>
            c.status === "active" &&
            (c.intervalMinutes ?? 0) > 0 &&
            Date.parse(c.nextSyncAt ?? c.createdAt) <= now,
        )
        .sort(
          (a, b) =>
            Date.parse(a.nextSyncAt ?? a.createdAt) -
            Date.parse(b.nextSyncAt ?? b.createdAt),
        )
        .slice(0, 2);
      for (const c of rows)
        await tx.put(
          entry("connection", {
            ...c,
            revision: c.revision + 1,
            nextSyncAt: new Date(
              now + c.intervalMinutes! * 60000,
            ).toISOString(),
          }),
          c.revision,
        );
      return rows;
    });
    const results = [];
    for (const c of due) {
      try {
        results.push({
          id: c.id,
          ...(await this.sync(
            { id: "connector-scheduler", channel: "user", scopes: [c.scopeId] },
            c.id,
            c.scheduleRevision ?? 0,
          )),
        });
      } catch {
        results.push({ id: c.id, status: "retryable" });
      }
    }
    return { results };
  }
  async sync(p: Principal, id: string, scheduledRevision?: number) {
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
      if (connection.status !== "active") return { status: connection.status };
      if (
        scheduledRevision !== undefined &&
        (!(connection.intervalMinutes ?? 0) ||
          (connection.scheduleRevision ?? 0) !== scheduledRevision)
      )
        return { status: "schedule_changed" };
      if ((await realpath(connection.file)) !== connection.file)
        throw new ApiError("selected_file_changed", 409);
      const text = await readFile(connection.file, "utf8");
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new ApiError("sample_file_too_large");
      const changes = z.array(changeSchema).max(1000).parse(JSON.parse(text));
      const parents = new Map<string, string>();
      for (const change of changes)
        if (change.parentSourceKey) {
          if (
            parents.has(change.sourceKey) &&
            parents.get(change.sourceKey) !== change.parentSourceKey
          )
            throw new Conflict("parent_source_changed");
          parents.set(change.sourceKey, change.parentSourceKey);
        }
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
        const change = changes[index]!;
        if (byteSize(change) > 32768)
          throw new ApiError("source_change_too_large");
        if (change.material && change.material.scopeId !== connection.scopeId)
          throw new ApiError("scope_mismatch");
        const result = await this.store.transaction(async (tx) => {
          const latest = await tx.get<Connection>("connection", id);
          if (!latest || latest.status !== "active")
            return { index, status: "paused" };
          if (
            scheduledRevision !== undefined &&
            (!(latest.intervalMinutes ?? 0) ||
              (latest.scheduleRevision ?? 0) !== scheduledRevision)
          )
            return { index, status: "schedule_changed" };
          if (latest.cursor !== index) throw new Conflict("cursor_changed");
          await this.settle(tx, latest);
          const { sourceVersion, ...normalized } = change;
          const bindingId = digest([id, change.sourceKey]),
            hash = digest(normalized);
          const old = await tx.get<Binding>("source_binding", bindingId);
          const exclusions = (
            await tx.list<{ connectionId: string; sourceKey: string }>(
              "connector_exclusion",
              [connection.scopeId],
            )
          ).filter((e) => e.connectionId === id);
          const ancestors = new Set([change.sourceKey]);
          for (
            let parent = parents.get(change.sourceKey);
            parent;
            parent = parents.get(parent)
          ) {
            if (ancestors.has(parent))
              throw new Conflict("source_parent_cycle");
            ancestors.add(parent);
          }
          const ignored =
            old?.excluded || exclusions.some((e) => ancestors.has(e.sourceKey));
          if (ignored && !(await tx.get("connector_exclusion", bindingId)))
            await tx.put(
              entry("connector_exclusion", {
                id: bindingId,
                scopeId: connection.scopeId,
                revision: 1,
                connectionId: id,
                sourceKey: change.sourceKey,
              }),
              null,
            );
          let result: { index: number; status: string; jobId?: string } = {
            index,
            status: ignored ? "ignored" : "unchanged",
          };
          if (!ignored && old?.hash !== hash) {
            if (old?.pending && change.material)
              return { index, status: "pending_learning" };
            if (old && change.mutation === "append")
              throw new Conflict("append_key_conflict");
            if (
              old &&
              change.mutation === "snapshot" &&
              (old.resourceType === "event" ||
                ["append", "correct"].includes(old.mutation))
            )
              throw new Conflict("event_requires_targeted_correction");
            if (
              old &&
              change.mutation === "correct" &&
              old.resourceType === "snapshot"
            )
              throw new Conflict("snapshot_requires_new_snapshot");
            if (
              change.mutation === "correct" &&
              (!old ||
                change.correctsRef?.bindingId !== bindingId ||
                change.correctsRef.sourceRevision !== old.sourceRevision)
            )
              throw new Conflict("correction_target_mismatch");
            if (old && old.parentSourceKey !== change.parentSourceKey)
              throw new Conflict("parent_source_changed");
            const sourceRevision = (old?.sourceRevision ?? 0) + 1;
            let accepted;
            if (change.material)
              accepted = await this.core.submitMaterial(
                {
                  id: `connector:${id}`,
                  channel: "connector",
                  scopes: [connection.scopeId],
                },
                change.material,
                digest([id, change.sourceKey, sourceRevision]),
                `${id}:${change.sourceKey}:${sourceRevision}`,
                tx,
                `${id}:${[...ancestors].at(-1)}`,
              );
            if (old) {
              const previous = new Set([
                ...(old.materialIds ?? []),
                old.current?.materialId,
                old.pending?.materialId,
              ]);
              for (const source of await tx.list<{
                id: string;
                revision: number;
                materialId: string;
                blocked: boolean;
              }>("source", [connection.scopeId]))
                if (
                  previous.has(source.materialId) &&
                  (!source.blocked || change.mutation === "erase")
                )
                  await this.core.controlSource(
                    p,
                    {
                      id: source.id,
                      expectedRevision: source.revision,
                      action:
                        change.mutation === "erase" ? "erase" : "withdraw",
                    },
                    tx,
                  );
            } else if (!change.material)
              throw new ApiError("source_binding_missing", 404);
            const value: Binding = {
              id: bindingId,
              scopeId: connection.scopeId,
              revision: (old?.revision ?? 0) + 1,
              connectionId: id,
              sourceKey: change.sourceKey,
              ...(change.parentSourceKey
                ? { parentSourceKey: change.parentSourceKey }
                : {}),
              sourceRevision,
              hash,
              excluded: false,
              mutation: change.mutation,
              materialIds: [
                ...(old?.materialIds ??
                  [old?.current?.materialId].filter((v): v is string => !!v)),
                ...(accepted ? [accepted.materialId] : []),
              ],
              ...(old?.current ? { current: old.current } : {}),
              ...(accepted
                ? {
                    pending: {
                      materialId: accepted.materialId,
                      jobId: accepted.jobId,
                    },
                  }
                : {}),
              learningStatus: accepted ? "pending" : "source_withdrawn",
            };
            value.resourceType =
              old?.resourceType ??
              (old
                ? old.mutation === "snapshot"
                  ? "snapshot"
                  : "event"
                : change.mutation === "snapshot"
                  ? "snapshot"
                  : "event");
            if (accepted) {
              value.received = {
                materialId: accepted.materialId,
                jobId: accepted.jobId,
              };
              delete value.current;
            }
            await tx.put(entry("source_binding", value), old?.revision ?? null);
            result = {
              index,
              status: "accepted",
              ...(accepted ? { jobId: accepted.jobId } : {}),
            };
          }
          delete latest.lastError;
          await tx.put(
            entry("connection", {
              ...latest,
              cursor: index + 1,
              prefixDigest: digest(changes.slice(0, index + 1)),
              revision: latest.revision + 1,
            }),
            latest.revision,
          );
          return result;
        });
        results.push(result);
        if (
          ["paused", "pending_learning", "schedule_changed"].includes(
            result.status,
          )
        )
          break;
      }
      return { status: "received", results };
    } catch (error) {
      await this.store.transaction(async (tx) => {
        const connection = await tx.get<Connection>("connection", id);
        if (connection && p.scopes.includes(connection.scopeId))
          await tx.put(
            entry("connection", {
              ...connection,
              revision: connection.revision + 1,
              lastError:
                error instanceof ApiError || error instanceof Conflict
                  ? error.message
                  : "source_read_failed",
            }),
            connection.revision,
          );
      });
      throw error;
    } finally {
      this.running.delete(id);
    }
  }
  private async settle(tx: Transaction, connection: Connection) {
    for (const binding of await tx.list<Binding>("source_binding", [
      connection.scopeId,
    ])) {
      if (binding.connectionId !== connection.id || !binding.pending) continue;
      const job = await tx.get<{ status: string }>(
        "job",
        binding.pending.jobId,
      );
      if (!job || !["completed", "failed", "canceled"].includes(job.status))
        continue;
      const next: Binding = {
        ...binding,
        revision: binding.revision + 1,
        learningStatus: job.status,
        ...(job.status === "completed" ? { current: binding.pending } : {}),
      };
      delete next.pending;
      await tx.put(entry("source_binding", next), binding.revision);
    }
  }
  async bindings(p: Principal, id: string) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const connection = await tx.get<Connection>("connection", id);
      if (!connection || !p.scopes.includes(connection.scopeId))
        throw new ApiError("not_found", 404);
      await this.settle(tx, connection);
      return (
        await tx.list<Binding>("source_binding", [connection.scopeId])
      ).filter((b) => b.connectionId === id);
    });
  }
  async retry(p: Principal, id: string, key: string) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const binding = await tx.get<Binding>("source_binding", id);
      if (!binding || !p.scopes.includes(binding.scopeId))
        throw new ApiError("not_found", 404);
      const receiptId = digest([p.id, id, key]);
      const previous = await tx.get<{
        result: { accepted: boolean; jobId: string; duplicate: boolean };
      }>("connector_retry", receiptId);
      if (previous) return { ...previous.result, duplicate: true };
      if (binding.excluded || !binding.received)
        throw new ApiError("binding_not_retryable", 409);
      const result = await this.core.retryJob(
        p,
        binding.received.jobId,
        key,
        tx,
      );
      await tx.put(
        entry("source_binding", {
          ...binding,
          revision: binding.revision + 1,
          pending: {
            materialId: binding.received.materialId,
            jobId: result.jobId,
          },
          received: {
            materialId: binding.received.materialId,
            jobId: result.jobId,
          },
          learningStatus: "pending",
        }),
        binding.revision,
      );
      await tx.put(
        entry("connector_retry", {
          id: receiptId,
          revision: 1,
          scopeId: binding.scopeId,
          result,
        }),
        null,
      );
      return result;
    });
  }
  async forget(p: Principal, id: string, sourceKey: string) {
    if (p.channel !== "user")
      throw new ApiError("user_operation_required", 403);
    return this.store.transaction(async (tx) => {
      const connection = await tx.get<Connection>("connection", id);
      if (!connection || !p.scopes.includes(connection.scopeId))
        throw new ApiError("not_found", 404);
      const bindings = (
        await tx.list<Binding>("source_binding", [connection.scopeId])
      ).filter((b) => b.connectionId === id);
      const keys = new Set([sourceKey]);
      for (let size = -1; size !== keys.size; ) {
        size = keys.size;
        for (const b of bindings)
          if (b.parentSourceKey && keys.has(b.parentSourceKey))
            keys.add(b.sourceKey);
      }
      const cleanupIds = [];
      for (const key of keys) {
        const exclusionId = digest([id, key]);
        if (!(await tx.get("connector_exclusion", exclusionId)))
          await tx.put(
            entry("connector_exclusion", {
              id: exclusionId,
              scopeId: connection.scopeId,
              revision: 1,
              connectionId: id,
              sourceKey: key,
            }),
            null,
          );
      }
      for (const binding of bindings.filter((b) => keys.has(b.sourceKey))) {
        const materials = new Set([
          ...(binding.materialIds ?? []),
          binding.current?.materialId,
          binding.pending?.materialId,
        ]);
        for (const source of await tx.list<{
          id: string;
          revision: number;
          materialId: string;
          excluded: boolean;
        }>("source", [connection.scopeId]))
          if (materials.has(source.materialId) && !source.excluded) {
            const receipt = await this.core.controlSource(
              p,
              {
                id: source.id,
                expectedRevision: source.revision,
                action: "forget",
              },
              tx,
            );
            cleanupIds.push(receipt.cleanupId);
          }
        await tx.put(
          entry("source_binding", {
            ...binding,
            revision: binding.revision + 1,
            excluded: true,
          }),
          binding.revision,
        );
      }
      return { accepted: true, excludedKeys: [...keys], cleanupIds };
    });
  }
}
