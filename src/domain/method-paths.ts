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
    if (paths.length > 64) return;
    const step = method.steps[position];
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
          const target = method.steps.findIndex(
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
// not new support for the method.
export function pathReviewErrors(
  methods: Array<
    Pick<Method, "steps"> & { replaces?: { id: string } | undefined }
  >,
  previous: Array<Pick<Method, "id" | "steps">>,
  review: {
    pathChecks?:
      | Array<{
          methodIndex: number;
          pathIndex: number;
          globalConditionsCompatible: boolean;
          stepsCompatible: boolean;
          reason: string;
        }>
      | undefined;
    preservedPaths?:
      | Array<{
          methodId: string;
          pathIndex: number;
          preserved: boolean;
          reason: string;
        }>
      | undefined;
  },
) {
  const errors: string[] = [];
  methods.forEach((method, methodIndex) => {
    const audit = methodPaths(method);
    if (audit.truncated) errors.push("Executable path budget exceeded");
    audit.paths.forEach((_, pathIndex) => {
      const checks =
        review.pathChecks?.filter(
          (c) => c.methodIndex === methodIndex && c.pathIndex === pathIndex,
        ) ?? [];
      if (checks.length !== 1)
        errors.push(
          `Missing or duplicate path review: ${methodIndex}/${pathIndex}`,
        );
      else if (
        !checks[0]!.globalConditionsCompatible ||
        !checks[0]!.stepsCompatible
      )
        errors.push(checks[0]!.reason);
    });
  });
  const replaced = new Set(
    methods.flatMap((m) => (m.replaces ? [m.replaces.id] : [])),
  );
  previous
    .filter((m) => replaced.has(m.id))
    .forEach((method) => {
      methodPaths(method).paths.forEach((_, pathIndex) => {
        const checks =
          review.preservedPaths?.filter(
            (c) => c.methodId === method.id && c.pathIndex === pathIndex,
          ) ?? [];
        if (checks.length !== 1)
          errors.push(
            `Missing or duplicate prior path review: ${method.id}/${pathIndex}`,
          );
        else if (!checks[0]!.preserved) errors.push(checks[0]!.reason);
      });
    });
  return errors;
}
