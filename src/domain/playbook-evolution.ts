import { canonical, type Playbook } from "./schema.js";
const text = (value: string) => value;
// Compare executable structure independently of title, step IDs and history metadata.
export function playbookPlanKey(playbook: Playbook): string {
  const positions = new Map(playbook.steps.map((s, i) => [s.stepId, i]));
  const conditions = (items: Playbook["conditions"]) =>
    items
      .map((c) => ({ ...c, text: text(c.text) }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const checks = (items: Playbook["completionChecks"]) =>
    items
      .map((c) => ({
        text: text(c.text),
        steps: c.stepIds?.map((id) => positions.get(id)).sort(),
      }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return canonical({
    goal: text(playbook.goal),
    applicability: playbook.applicability,
    conditions: conditions(playbook.conditions),
    exceptions: conditions(playbook.exceptions),
    validFrom: playbook.validFrom,
    validUntil: playbook.validUntil,
    steps: playbook.steps.map((s) => ({
      instruction: text(s.instruction),
      choices: s.choices
        ?.map((c) => ({
          when: conditions([c.when])[0],
          next: c.next === "stop" ? "stop" : positions.get(c.next),
        }))
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    })),
    completionChecks: checks(playbook.completionChecks),
    stopConditions: checks(playbook.stopConditions),
  });
}

export function playbookSupportKey(playbook: Playbook): string {
  const key = (index: number) => playbook.supportRefs[index];
  return canonical({
    all: [...playbook.supportRefs].sort((a, b) =>
      canonical(a).localeCompare(canonical(b)),
    ),
    steps: playbook.steps.map((step) =>
      step.supportIndexes
        .map(key)
        .sort((a, b) => canonical(a).localeCompare(canonical(b))),
    ),
  });
}
