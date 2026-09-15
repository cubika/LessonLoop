import { getEncoding } from "js-tiktoken";
import type { Experience } from "./experience.js";
import { digest, type Method } from "./schema.js";

const encoder = getEncoding("cl100k_base");
export const tokenCount = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;
export interface Eligibility {
  scopes: ReadonlySet<string>;
  experiences: ReadonlyMap<string, Experience>;
  blockedObjects: ReadonlySet<string>;
  blockedSources: ReadonlySet<string>;
  published: ReadonlyMap<string, number>;
  now: number;
}
export function eligible(
  method: Pick<
    Method,
    | "id"
    | "scopeId"
    | "revision"
    | "state"
    | "applicability"
    | "validFrom"
    | "validUntil"
    | "supportRefs"
  >,
  data: Eligibility,
): boolean {
  if (
    !data.scopes.has(method.scopeId) ||
    !usable(method, data) ||
    data.published.get(method.id) !== method.revision
  )
    return false;
  const visited = new Set<string>();
  const walk = (
    id: string,
    revision: number,
    depth: number,
    ancestors: Set<string>,
  ): boolean => {
    const e = data.experiences.get(id);
    if (
      !e ||
      e.revision !== revision ||
      e.scopeId !== method.scopeId ||
      depth > 5 ||
      ancestors.has(id)
    )
      return false;
    visited.add(id);
    if (
      visited.size > 32 ||
      !usable(e, data) ||
      data.published.get(id) !== revision ||
      e.sourceFingerprints.some((f) => data.blockedSources.has(f))
    )
      return false;
    const constraint =
      e.purpose === "constraint" &&
      e.basis === "reported" &&
      e.assessment === "attributed" &&
      e.evidence.some((v) => v.role === "user" && v.relation === "supports");
    if (e.assessment !== "supported" && !constraint) return false;
    const roots = new Set(e.evidence.map((v) => v.fingerprint));
    for (const p of e.derivedFrom) {
      if (!walk(p.id, p.revision, depth + 1, new Set(ancestors).add(id)))
        return false;
      data.experiences
        .get(p.id)!
        .sourceFingerprints.forEach((f) => roots.add(f));
    }
    return (
      roots.size === e.sourceFingerprints.length &&
      e.sourceFingerprints.every((f) => roots.has(f))
    );
  };
  return method.supportRefs.every((r) => walk(r.id, r.revision, 1, new Set()));
}
function usable(
  v: Pick<
    Method,
    "id" | "scopeId" | "state" | "applicability" | "validFrom" | "validUntil"
  >,
  data: Eligibility,
) {
  return (
    !data.blockedObjects.has(v.id) &&
    v.state === "active" &&
    v.applicability !== "unknown" &&
    (!v.validFrom || Date.parse(v.validFrom) <= data.now) &&
    (!v.validUntil || Date.parse(v.validUntil) > data.now)
  );
}
// The core checks task ownership and lifetime before rendering guidance.
// The usage reference links feedback; it is not an execution session or permit.
export function prepareMethod(
  method: Method | undefined,
  request: {
    callerId: string;
    taskRef: string;
    revision: number;
    viewMode?: "auto" | "expanded" | undefined;
  },
  data: Eligibility,
): Record<string, unknown> {
  if (!method || !data.scopes.has(method.scopeId))
    return { status: "target_unavailable" };
  if (method.revision !== request.revision) return { status: "target_changed" };
  if (!eligible(method, data)) return { status: "target_unavailable" };
  const view = {
    status: "guidance",
    method: { kind: "method", id: method.id, revision: method.revision },
    methodUseRef: digest([
      "method-use",
      request.callerId,
      request.taskRef,
      method.id,
      method.revision,
    ]),
    title: method.title,
    goal: method.goal,
    conditions: method.conditions,
    exceptions: method.exceptions,
    validFrom: method.validFrom,
    validUntil: method.validUntil,
    steps: method.steps,
    completionChecks: method.completionChecks,
    stopConditions: method.stopConditions,
    executionBoundary:
      "Guidance only; the agent checks applicability and chooses the path. Check all global conditions and exceptions before acting. Start at the first step; a step without choices continues to the next step. At a choice, complete the step and use current observations to follow exactly one matching next step or stop. If facts are missing, no choice matches, or choices conflict, investigate or ask instead of guessing. Do not run unselected branches. Apply global checks and checks scoped to the selected steps. Use fresh results for checks that depend on execution; old results do not prove this run completed. Respect task permissions. Verify the actual outcome before reporting success.",
  };
  if (tokenCount(view) > (request.viewMode === "expanded" ? 8192 : 2400))
    return {
      status:
        request.viewMode === "expanded" ? "too_large" : "requires_expansion",
    };
  return view;
}
