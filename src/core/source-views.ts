import { ApiError, type CoreService, type Principal } from "./service.js";
import type { Source, Playbook } from "../domain/schema.js";
import type { Experience } from "../domain/experience.js";
import type { WorkView } from "./work-view.js";
export async function workView(
  core: CoreService,
  p: Principal,
  target: { kind: "source" | "experience" | "playbook"; id: string },
) {
  return core.store.transaction(async (tx) => {
    const record = await tx.get<Source | Experience | Playbook>(
      target.kind,
      target.id,
    );
    if (!record || !p.scopes.includes(record.scopeId))
      throw new ApiError("not_found", 404);
    const fingerprints = new Set<string>();
    if (target.kind === "source") fingerprints.add(target.id);
    else if (target.kind === "experience")
      (record as Experience).sourceFingerprints.forEach((fp) =>
        fingerprints.add(fp),
      );
    else
      for (const ref of (record as Playbook).supportRefs) {
        const e = await tx.get<Experience>("experience", ref.id);
        if (e?.scopeId === record.scopeId && e.revision === ref.revision)
          e.sourceFingerprints.forEach((fp) => fingerprints.add(fp));
      }
    const cases = (
      await tx.list<WorkView>("work_view", [record.scopeId])
    ).filter((c) => c.evidence.some((e) => fingerprints.has(e.fingerprint)));
    const sources = await tx.list<Source>("source", [record.scopeId]);
    return {
      target,
      available: cases.length > 0,
      items: cases.map((c) => {
        const { id, revision, ...view } = c;
        return {
          ...view,
          sources: sources
            .filter((s) => c.evidence.some((e) => e.fingerprint === s.id))
            .map((s) => ({ kind: "source", id: s.id, revision: s.revision })),
        };
      }),
    };
  });
}
