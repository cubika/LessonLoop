import { canonical, type Method } from "./schema.js";
const text = (value: string) => value;
// Compare executable structure independently of title, step IDs and history metadata.
export function methodPlanKey(method: Method): string {
  const positions = new Map(method.steps.map((s, i) => [s.stepId, i]));
  const conditions = (items: Method["conditions"]) =>
    items
      .map((c) => ({ ...c, text: text(c.text) }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const checks = (items: Method["completionChecks"]) =>
    items
      .map((c) => ({
        text: text(c.text),
        steps: c.stepIds?.map((id) => positions.get(id)).sort(),
      }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return canonical({
    goal: text(method.goal),
    applicability: method.applicability,
    conditions: conditions(method.conditions),
    exceptions: conditions(method.exceptions),
    validFrom: method.validFrom,
    validUntil: method.validUntil,
    steps: method.steps.map((s) => ({
      instruction: text(s.instruction),
      choices: s.choices
        ?.map((c) => ({
          when: conditions([c.when])[0],
          next: c.next === "stop" ? "stop" : positions.get(c.next),
        }))
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    })),
    completionChecks: checks(method.completionChecks),
    stopConditions: checks(method.stopConditions),
  });
}

export function methodSupportKey(method: Method): string {
  const key = (index: number) => method.supportRefs[index];
  return canonical({
    all: [...method.supportRefs].sort((a, b) =>
      canonical(a).localeCompare(canonical(b)),
    ),
    steps: method.steps.map((step) =>
      step.supportIndexes
        .map(key)
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    ),
  });
}
