import { ApiError, type CoreService, type Principal } from "./service.js";
import type { Material, WorkCase, Method } from "../domain/schema.js";
import type { Experience } from "../domain/experience.js";
import { publicValue } from "./public-contract.js";
type Source = {
  id: string;
  revision: number;
  scopeId: string;
  materialId: string;
  blocked: boolean;
  erased: boolean;
  excluded: boolean;
};
export async function inspectSource(
  core: CoreService,
  p: Principal,
  id: string,
) {
  // Authorize the source before looking up its retained body.
  return core.store.transaction(async (tx) => {
    const source = await tx.get<Source>("source", id);
    if (!source || !p.scopes.includes(source.scopeId))
      throw new ApiError("not_found", 404);
    const material = await tx.get<Material>("material", source.materialId);
    const index = material?.fingerprints.indexOf(id) ?? -1;
    const segment =
      !source.erased && index >= 0 ? material?.segments[index] : undefined;
    return {
      kind: "source",
      id: source.id,
      revision: source.revision,
      scopeId: source.scopeId,
      blocked: source.blocked,
      erased: source.erased,
      excluded: source.excluded,
      contentStatus: source.erased
        ? "erased"
        : segment
          ? "retained"
          : "expired",
      ...(segment ? { segment } : {}),
      ...(material
        ? {
            createdAt: material.createdAt,
            taskRef: material.taskRef,
            sequence: material.taskSequence,
          }
        : {}),
    };
  });
}
export async function sourceReceipt(
  core: CoreService,
  p: Principal,
  receipt: any,
) {
  const sources = (await core.listSources(p)).filter(
    (s) => s.materialId === receipt.materialId,
  );
  return {
    accepted: receipt.accepted,
    duplicate: receipt.duplicate,
    jobId: receipt.jobId,
    sources: sources.map((s) => ({
      kind: "source",
      id: s.id,
      revision: s.revision,
    })),
  };
}
export async function workView(
  core: CoreService,
  p: Principal,
  target: { kind: "source" | "experience" | "playbook"; id: string },
) {
  const kind = target.kind === "playbook" ? "method" : target.kind;
  return core.store.transaction(async (tx) => {
    const record = await tx.get<Source | Experience | Method>(kind, target.id);
    if (!record || !p.scopes.includes(record.scopeId))
      throw new ApiError("not_found", 404);
    const fingerprints = new Set<string>();
    if (target.kind === "source") fingerprints.add(target.id);
    else if (target.kind === "experience")
      (record as Experience).sourceFingerprints.forEach((fp) =>
        fingerprints.add(fp),
      );
    else
      for (const ref of (record as Method).supportRefs) {
        const e = await tx.get<Experience>("experience", ref.id);
        if (e?.scopeId === record.scopeId && e.revision === ref.revision)
          e.sourceFingerprints.forEach((fp) => fingerprints.add(fp));
      }
    const cases = (
      await tx.list<WorkCase>("work_case", [record.scopeId])
    ).filter((c) => c.evidence.some((e) => fingerprints.has(e.fingerprint)));
    const sources = await tx.list<Source>("source", [record.scopeId]);
    return {
      target,
      available: cases.length > 0,
      items: cases.map((c) => {
        const { id, revision, ...view } = c;
        return {
          ...publicValue(view),
          sources: sources
            .filter((s) => c.evidence.some((e) => e.fingerprint === s.id))
            .map((s) => ({ kind: "source", id: s.id, revision: s.revision })),
        };
      }),
    };
  });
}
