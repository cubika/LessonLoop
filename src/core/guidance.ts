import { guidanceInput } from "./agent-contract.js";
import type { CoreService, Principal } from "./service.js";

export async function getGuidance(
  core: CoreService,
  p: Principal,
  raw: unknown,
  key: string,
) {
  const input = guidanceInput.parse(raw);
  const task = await core.guidanceTask(p, input, key);
  const caller = { ...p, scopes: [task.scopeId] };
  const playbooks: Record<string, unknown>[] = [];
  const targets =
    input.target?.kind === "playbook"
      ? [input.target]
      : input.target
        ? []
        : (await core.search(caller, input.query!)).results.map(
            (row) => row.playbook,
          );
  const prepare = async (target: {
    id: string;
    revision: number;
  }): Promise<Record<string, unknown>> => ({
    playbook: { kind: "playbook", id: target.id, revision: target.revision },
    ...(await core.prepare(caller, {
      playbookId: target.id,
      revision: target.revision,
      taskRef: task.taskRef,
      ...(input.viewMode ? { viewMode: input.viewMode } : {}),
    })),
  });
  const recalled =
    input.target?.kind === "playbook"
      ? undefined
      : await core.recall(
          caller,
          input.query ?? input.target!.id,
          input.context,
          {
            ...(input.target ? { target: input.target } : {}),
            ...(input.target && input.viewMode === "expanded"
              ? { expanded: true }
              : {}),
          },
        );
  for (const target of targets) {
    const prepared = await prepare(target);
    if (
      !input.target &&
      ["target_changed", "target_unavailable"].includes(String(prepared.status))
    )
      continue;
    playbooks.push(prepared);
    break;
  }
  // Retrieval may outlive the task; do not return guidance for a closed task.
  await core.guidanceTask(p, task, key);
  return {
    ...task,
    playbooks,
    experiences: recalled?.results ?? [],
    ...(recalled?.reason ? { reason: recalled.reason } : {}),
  };
}
