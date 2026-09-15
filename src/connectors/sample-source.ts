import { readFile, realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { ApiError } from "../core/service.js";
import { Conflict } from "../store/postgres.js";
import { byteSize, id, materialInputSchema } from "../domain/schema.js";
import {
  CONNECTOR_LIMITS,
  connectorInputSchema,
  connectorMaterialSchema,
  normalizeInput,
  type MaterialPart,
} from "./input.js";

const partSchema = z
  .object({ partKey: id, material: materialInputSchema })
  .strict();
const changeSchema = z
  .object({
    sourceKey: id,
    parentSourceKey: id.optional(),
    mutation: z.enum(["snapshot", "append", "correct", "withdraw", "erase"]),
    sourceVersion: z.string().max(128).optional(),
    correctsRef: z
      .object({ bindingId: id, sourceRevision: z.number().int().positive() })
      .strict()
      .optional(),
    material: connectorMaterialSchema.optional(),
    input: connectorInputSchema.optional(),
    parts: z.array(partSchema).min(1).max(CONNECTOR_LIMITS.parts).optional(),
    partKeys: z.array(id).min(1).max(CONNECTOR_LIMITS.parts).optional(),
    complete: z.boolean().optional(),
  })
  .strict();
export type SourceChange = Omit<
  z.infer<typeof changeSchema>,
  "input" | "material" | "parts" | "partKeys" | "complete"
> & { parts: MaterialPart[]; partKeys: string[]; complete: true };
export interface SampleSnapshot {
  file: string;
  changes: SourceChange[];
  parents: Map<string, string>;
}

export async function readSampleFile(
  selectedFile: string,
  scopeId: string,
  requireSamePath = false,
): Promise<SampleSnapshot> {
  const file = await realpath(selectedFile);
  if (requireSamePath && file !== selectedFile)
    throw new ApiError("selected_file_changed", 409);
  if ((await stat(file)).size > 2 * 1024 * 1024)
    throw new ApiError("sample_file_too_large");
  const contents = await readFile(file, "utf8");
  if (Buffer.byteLength(contents) > 2 * 1024 * 1024)
    throw new ApiError("sample_file_too_large");
  const changes = z
    .array(changeSchema)
    .max(1000)
    .parse(JSON.parse(contents))
    .map((row): SourceChange => {
      const {
        material,
        input,
        parts: suppliedParts,
        partKeys,
        complete,
        ...change
      } = row;
      const payloads = [material, input, suppliedParts].filter(
        (v) => v !== undefined,
      ).length;
      const contentChange = !["withdraw", "erase"].includes(change.mutation);
      if (payloads !== (contentChange ? 1 : 0))
        throw new ApiError("material_required_only_for_content_changes");
      if (!suppliedParts && (partKeys !== undefined || complete !== undefined))
        throw new ApiError("unexpected_part_manifest");
      let parts: MaterialPart[] = [];
      if (suppliedParts) {
        if (
          !complete ||
          !partKeys ||
          new Set(partKeys).size !== partKeys.length ||
          new Set(suppliedParts.map((part) => part.partKey)).size !==
            suppliedParts.length ||
          partKeys.length !== suppliedParts.length ||
          partKeys.some(
            (key) => !suppliedParts.some((part) => part.partKey === key),
          )
        )
          throw new ApiError("source_parts_incomplete", 409);
        parts = partKeys.map(
          (key) => suppliedParts.find((part) => part.partKey === key)!,
        );
      } else if (input || material) {
        parts = normalizeInput(input ?? { kind: "material", ...material! });
      }
      if (parts.some((part) => part.material.scopeId !== scopeId))
        throw new ApiError("scope_mismatch");
      const normalized: SourceChange = {
        ...change,
        parts,
        partKeys: parts.map((part) => part.partKey),
        complete: true,
      };
      if (byteSize(normalized) > CONNECTOR_LIMITS.batchBytes)
        throw new ApiError("source_change_too_large");
      return normalized;
    });
  const parents = new Map<string, string>();
  for (const change of changes) {
    if (!change.parentSourceKey) continue;
    if (
      parents.has(change.sourceKey) &&
      parents.get(change.sourceKey) !== change.parentSourceKey
    )
      throw new Conflict("parent_source_changed");
    parents.set(change.sourceKey, change.parentSourceKey);
  }
  for (const sourceKey of parents.keys()) {
    const seen = new Set([sourceKey]);
    for (
      let parent = parents.get(sourceKey);
      parent;
      parent = parents.get(parent)
    ) {
      if (seen.has(parent)) throw new Conflict("source_parent_cycle");
      seen.add(parent);
    }
  }
  return { file, changes, parents };
}

export function readPage(
  snapshot: SampleSnapshot,
  cursor: number,
): SourceChange[] {
  const page: SourceChange[] = [];
  let parts = 0,
    bytes = 0;
  for (const change of snapshot.changes.slice(cursor)) {
    const nextBytes = byteSize(change);
    if (
      page.length === 8 ||
      parts + change.parts.length > CONNECTOR_LIMITS.parts ||
      bytes + nextBytes > CONNECTOR_LIMITS.batchBytes
    )
      break;
    page.push(change);
    parts += change.parts.length;
    bytes += nextBytes;
  }
  return page;
}
