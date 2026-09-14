import { randomUUID } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { Experience } from "./experience.js";
import { digest, type Condition, type Method, type ObjectRef } from "./schema.js";

const encoder = getEncoding("cl100k_base");
export const tokenCount = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
export interface Eligibility { scopes: ReadonlySet<string>; experiences: ReadonlyMap<string, Experience>; blockedObjects: ReadonlySet<string>; blockedSources: ReadonlySet<string>; published: ReadonlyMap<string, number>; now: number }
export function eligible(method: Method, data: Eligibility): boolean {
  if (!data.scopes.has(method.scopeId) || !usable(method, data) || data.published.get(method.id) !== method.revision) return false;
  const visited = new Set<string>();
  const walk = (id: string, revision: number, depth: number, ancestors: Set<string>): boolean => {
    const e = data.experiences.get(id);
    if (!e || e.revision !== revision || e.scopeId !== method.scopeId || depth > 5 || ancestors.has(id)) return false;
    visited.add(id);
    if (visited.size > 32 || !usable(e, data) || data.published.get(id) !== revision || e.sourceFingerprints.some(f => data.blockedSources.has(f))) return false;
    const constraint = e.purpose === "constraint" && e.basis === "reported" && e.assessment === "attributed" && e.evidence.some(v => v.role === "user" && v.relation === "supports");
    if (e.assessment !== "supported" && !constraint) return false;
    const roots = new Set(e.evidence.map(v => v.fingerprint));
    for (const p of e.derivedFrom) {
      if (!walk(p.id, p.revision, depth + 1, new Set(ancestors).add(id))) return false;
      data.experiences.get(p.id)!.sourceFingerprints.forEach(f => roots.add(f));
    }
    return roots.size === e.sourceFingerprints.length && e.sourceFingerprints.every(f => roots.has(f));
  };
  return method.supportRefs.every(r => walk(r.id, r.revision, 1, new Set()));
}
function usable(v: Pick<Method, "id" | "scopeId" | "state" | "applicability" | "validFrom" | "validUntil">, data: Eligibility) {
  return !data.blockedObjects.has(v.id) && v.state === "active" && v.applicability !== "unknown" && (!v.validFrom || Date.parse(v.validFrom) <= data.now) && (!v.validUntil || Date.parse(v.validUntil) > data.now);
}
export interface TaskFacts { values: Record<string, string | string[]>; trustedKeys: ReadonlySet<string>; conditions: ReadonlyMap<string, boolean>; completed: ReadonlySet<string> }
export function evaluate(c: Condition, facts: TaskFacts): boolean | undefined {
  if (!c.match) return facts.conditions.get(digest(c));
  if (!facts.trustedKeys.has(c.match.key)) return undefined;
  const actual = facts.values[c.match.key];
  if (actual === undefined) return undefined;
  return (Array.isArray(actual) ? actual : [actual]).some(v => c.match!.values.includes(v));
}
type Session = { callerId: string; taskRef: string; method: ObjectRef; startedAt: number; touchedAt: number; delivered: Set<string>; completed: Set<string>; checks: Map<string, number> };
export class Preparation {
  private readonly sessions = new Map<string, Session>();
  private readonly tasks = new Map<string, { count: number; closed: boolean; startedAt: number; checks: Map<string, number> }>();
  endTask(callerId: string, taskRef: string) { const key = `${callerId}:${taskRef}`; const t = this.tasks.get(key); if (t) t.closed = true; else this.tasks.set(key, { count: 0, closed: true, startedAt: Date.now(), checks: new Map() }); for (const [id, s] of this.sessions) if (s.callerId === callerId && s.taskRef === taskRef) this.sessions.delete(id); }
  prepare(method: Method | undefined, request: { callerId: string; taskRef: string; revision: number; methodUseRef?: string | undefined; completedStepIds?: string[] | undefined; viewMode?: "auto" | "expanded" | undefined }, facts: TaskFacts, data: Eligibility): Record<string, unknown> {
    if (!method || !data.scopes.has(method.scopeId)) return { status: "target_unavailable" };
    if (method.revision !== request.revision) return { status: "target_changed" };
    if (!eligible(method, data)) return { status: "target_unavailable" };
    const key = `${request.callerId}:${request.taskRef}`;
    let task = this.tasks.get(key);
    if (!task) { task = { count: 0, closed: false, startedAt: data.now, checks: new Map() }; this.tasks.set(key, task); }
    if (task.closed || data.now - task.startedAt >= 86400000) return { status: "unavailable", reason: "task_ended_or_expired" };
    if (request.viewMode !== "expanded" && ++task.count > 8) return { status: "unavailable", reason: "task_prepare_budget" };
    let use = request.methodUseRef;
    let s = use ? this.sessions.get(use) : undefined;
    if (use && (!s || s.callerId !== request.callerId || s.taskRef !== request.taskRef || s.method.id !== method.id || s.method.revision !== method.revision || data.now - s.touchedAt >= 1800000 || data.now - s.startedAt >= 86400000)) return { status: "unavailable", reason: "prepare_context_expired" };
    if (!s) {
      if (request.completedStepIds?.length) return { status: "unavailable", reason: "completion_not_previously_delivered" };
      use = randomUUID(); s = { callerId: request.callerId, taskRef: request.taskRef, method: { kind: "method", id: method.id, revision: method.revision }, startedAt: data.now, touchedAt: data.now, delivered: new Set(), completed: new Set(), checks: new Map() }; this.sessions.set(use, s);
    }
    s.touchedAt = data.now;
    for (const step of s.completed) if (!facts.completed.has(step)) s.completed.delete(step);
    for (const step of request.completedStepIds ?? []) { if (!s.delivered.has(step) || !facts.completed.has(step)) return { status: "unavailable", reason: "completion_requires_evidence" }; }
    (request.completedStepIds ?? []).forEach(step => s!.completed.add(step));
    const missing: string[] = []; let excluded = false;
    for (const c of method.conditions) { const v = evaluate(c, facts); if (v === false) excluded = true; else if (v === undefined) missing.push(c.text); }
    for (const c of method.exceptions) { const v = evaluate(c, facts); if (v === true) excluded = true; else if (v === undefined) missing.push(c.text); }
    if (excluded) return { status: "not_applicable" };
    const check = (point: string) => { const key = `${method.id}:${point}`; const n = task!.checks.get(key) ?? 0; task!.checks.set(key, n + 1); return n < 3; };
    if (missing.length) return check("global") ? { status: "lead", taskApplicability: "undetermined", methodUseRef: use, missingChecks: missing } : { status: "unavailable", reason: "condition_check_budget" };
    const selected: string[] = []; const steps: Method["steps"] = []; let pendingDecision: Record<string, unknown> | undefined; let position = 0;
    while (position < method.steps.length) {
      const step = method.steps[position]!; selected.push(step.stepId);
      if (!s.completed.has(step.stepId)) steps.push(step);
      if (step.choices) {
        if (!s.completed.has(step.stepId)) { pendingDecision = { stepId: step.stepId, reason: "complete_step_then_observe", choices: step.choices }; break; }
        const matches = step.choices.map(c => evaluate(c.when, facts));
        if (matches.filter(v => v === true).length !== 1 || matches.some(v => v === undefined)) {
          if (!check(step.stepId)) return { status: "unavailable", reason: "decision_check_budget" };
          pendingDecision = { stepId: step.stepId, reason: matches.some(v => v === undefined) ? "unknown" : matches.filter(v => v === true).length > 1 ? "multiple_matches" : "no_match", choices: step.choices }; break;
        }
        const next = step.choices[matches.indexOf(true)]!.next; if (next === "stop") break; position = method.steps.findIndex(v => v.stepId === next);
      } else position++;
    }
    // New observations can change an already visited decision. Never reuse completion of an unselected path.
    for (const step of s.completed) if (!selected.includes(step)) s.completed.delete(step);
    const checks = (items: Method["completionChecks"]) => items.filter(c => !c.stepIds || c.stepIds.some(id => selected.includes(id)));
    const view = { status: "guidance", taskApplicability: "applicable", method: s.method, methodUseRef: use, title: method.title, goal: method.goal, conditions: method.conditions, exceptions: method.exceptions, steps, completionChecks: checks(method.completionChecks), stopConditions: checks(method.stopConditions), pendingDecision, executionBoundary: "Guidance only. Respect the task permissions. Completing a prefix is not proof of overall success.", pathComplete: !pendingDecision && steps.length === 0 };
    const tokens = tokenCount(view); if (tokens > (request.viewMode === "expanded" ? 8192 : 2400)) return { status: request.viewMode === "expanded" ? "too_large" : "requires_expansion" };
    steps.forEach(step => s!.delivered.add(step.stepId));
    return view;
  }
}
