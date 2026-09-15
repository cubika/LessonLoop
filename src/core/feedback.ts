import type { ObjectRef } from "../domain/schema.js";

export interface FeedbackEvent {
  kind: string;
  occurredAt: string;
  playbook?: ObjectRef | undefined;
  outcome?: string | undefined;
  rating?: string | undefined;
}

export interface FeedbackTask {
  taskRef: string;
  events: FeedbackEvent[];
}

// Project independent facts from retained receipts. Legacy usage events do not
// establish delivery, adoption, a task result, or a user rating.
export function taskFeedback(task: FeedbackTask, prepared: ObjectRef[] = []) {
  let taskOutcome = "unknown";
  const methods = new Map<
    string,
    {
      taskRef: string;
      playbookId: string;
      revision: number;
      delivered: true | null;
      userRating: string | null;
    }
  >();
  const association = (playbook: ObjectRef) => ({
    taskRef: task.taskRef,
    playbookId: playbook.id,
    revision: playbook.revision,
    delivered: null,
    userRating: null,
  });
  for (const playbook of prepared)
    methods.set(
      JSON.stringify([playbook.id, playbook.revision]),
      association(playbook),
    );
  // Stable sorting lets the later received correction win at the same timestamp.
  for (const event of [...task.events].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  )) {
    if (event.kind === "outcome") taskOutcome = event.outcome ?? "unknown";
    if (!["delivery", "user_rating"].includes(event.kind) || !event.playbook)
      continue;
    const key = JSON.stringify([event.playbook.id, event.playbook.revision]);
    const record = methods.get(key) ?? association(event.playbook);
    if (event.kind === "delivery") record.delivered = true;
    if (event.kind === "user_rating") record.userRating = event.rating ?? null;
    methods.set(key, record);
  }
  return {
    taskOutcome,
    feedback: [...methods.values()].map((record) => ({
      ...record,
      taskOutcome,
    })),
  };
}

export function feedbackSummary(tasks: FeedbackTask[]) {
  const records = tasks.map((task) => taskFeedback(task));
  const outcomes = (value: string) =>
    records.filter((r) => r.taskOutcome === value).length;
  const ratings = (value: string) =>
    records.filter((r) => r.feedback.some((f) => f.userRating === value))
      .length;
  return {
    tasks: tasks.length,
    ended: tasks.filter((t) => t.events.some((e) => e.kind === "task_ended"))
      .length,
    delivered: records.filter((r) => r.feedback.some((f) => f.delivered))
      .length,
    succeeded: outcomes("succeeded"),
    failed: outcomes("failed"),
    abandoned: outcomes("abandoned"),
    unknownOutcome: outcomes("unknown"),
    helpful: ratings("helpful"),
    reportedIncorrect: ratings("incorrect"),
  };
}
