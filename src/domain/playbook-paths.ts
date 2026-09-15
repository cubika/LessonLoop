import type { Playbook } from "./schema.js";
export function playbookPaths(playbook: Pick<Playbook, "steps">) {
  const paths: Array<{
    steps: string[];
    decisions: Array<{ stepId: string; condition: string; next: string }>;
  }> = [];
  const walk = (
    position: number,
    steps: string[],
    decisions: Array<{ stepId: string; condition: string; next: string }>,
  ) => {
    if (paths.length > 64) return;
    const step = playbook.steps[position];
    if (!step) {
      paths.push({ steps, decisions });
      return;
    }
    const visited = [...steps, step.stepId];
    if (step.choices) {
      for (const choice of step.choices) {
        if (paths.length > 64) break;
        const next = [
          ...decisions,
          {
            stepId: step.stepId,
            condition: choice.when.text,
            next: choice.next,
          },
        ];
        if (choice.next === "stop")
          paths.push({ steps: visited, decisions: next });
        else {
          const target = playbook.steps.findIndex(
            (s) => s.stepId === choice.next,
          );
          if (target > position) walk(target, visited, next);
        }
      }
    } else walk(position + 1, visited, decisions);
  };
  walk(0, [], []);
  return { paths: paths.slice(0, 64), truncated: paths.length > 64 };
}

// Require a verdict for every executable path, including each predecessor path.
// A blanket approval cannot hide an excluded branch. Reasons remain review evidence,
// not new support for the playbook.
export function pathReviewErrors(
  playbooks: Array<
    Pick<Playbook, "steps"> & { replaces?: { id: string } | undefined }
  >,
  previous: Array<Pick<Playbook, "id" | "steps">>,
  review: {
    pathChecks?:
      | Array<{
          playbookIndex: number;
          pathIndex: number;
          globalConditionsCompatible: boolean;
          stepsCompatible: boolean;
          reason: string;
        }>
      | undefined;
    preservedPaths?:
      | Array<{
          playbookId: string;
          pathIndex: number;
          preserved: boolean;
          reason: string;
        }>
      | undefined;
  },
) {
  const errors: string[] = [];
  playbooks.forEach((playbook, playbookIndex) => {
    const audit = playbookPaths(playbook);
    if (audit.truncated) errors.push("Executable path budget exceeded");
    audit.paths.forEach((_, pathIndex) => {
      const checks =
        review.pathChecks?.filter(
          (c) => c.playbookIndex === playbookIndex && c.pathIndex === pathIndex,
        ) ?? [];
      if (checks.length !== 1)
        errors.push(
          `Missing or duplicate path review: ${playbookIndex}/${pathIndex}`,
        );
      else if (
        !checks[0]!.globalConditionsCompatible ||
        !checks[0]!.stepsCompatible
      )
        errors.push(checks[0]!.reason);
    });
  });
  const replaced = new Set(
    playbooks.flatMap((m) => (m.replaces ? [m.replaces.id] : [])),
  );
  previous
    .filter((m) => replaced.has(m.id))
    .forEach((playbook) => {
      playbookPaths(playbook).paths.forEach((_, pathIndex) => {
        const checks =
          review.preservedPaths?.filter(
            (c) => c.playbookId === playbook.id && c.pathIndex === pathIndex,
          ) ?? [];
        if (checks.length !== 1)
          errors.push(
            `Missing or duplicate prior path review: ${playbook.id}/${pathIndex}`,
          );
        else if (!checks[0]!.preserved) errors.push(checks[0]!.reason);
      });
    });
  return errors;
}
