import type { Method } from "./schema.js";
export function methodPaths(method: Pick<Method, "steps">) {
  const paths: Array<{
    steps: string[];
    decisions: Array<{ stepId: string; condition: string; next: string }>;
  }> = [];
  const walk = (
    position: number,
    steps: string[],
    decisions: Array<{ stepId: string; condition: string; next: string }>,
  ) => {
    if (paths.length >= 64) return;
    const step = method.steps[position];
    if (!step) {
      paths.push({ steps, decisions });
      return;
    }
    const visited = [...steps, step.stepId];
    if (step.choices) {
      for (const choice of step.choices) {
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
          const target = method.steps.findIndex(
            (s) => s.stepId === choice.next,
          );
          if (target > position) walk(target, visited, next);
        }
      }
    } else walk(position + 1, visited, decisions);
  };
  walk(0, [], []);
  return { paths: paths.slice(0, 64), truncated: paths.length >= 64 };
}
