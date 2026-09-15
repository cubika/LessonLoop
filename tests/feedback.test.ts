import test from "node:test";
import assert from "node:assert/strict";
import {
  taskFeedback,
  feedbackSummary,
  type FeedbackEvent,
} from "../src/core/feedback.js";

const playbook = {
  kind: "playbook" as const,
  id: "generated-file-editing",
  revision: 3,
};
const event = (
  kind: string,
  seconds: number,
  fields: Partial<FeedbackEvent> = {},
): FeedbackEvent => ({
  kind,
  occurredAt: new Date(seconds * 1000).toISOString(),
  ...fields,
});

test("Preparation, legacy step usage and task end never infer delivery or a result", () => {
  const task = {
    taskRef: "task",
    events: [
      event("usage", 1, { playbook, outcome: "succeeded" }),
      event("task_ended", 2),
    ],
  };
  assert.deepEqual(taskFeedback(task, [playbook]).feedback, [
    {
      taskRef: "task",
      playbookId: playbook.id,
      revision: 3,
      delivered: null,
      taskOutcome: "unknown",
      userRating: null,
    },
  ]);
  assert.deepEqual(taskFeedback(task).feedback, []);
  assert.equal(feedbackSummary([task]).unknownOutcome, 1);
});

test("Independent feedback folds repeated deliveries, ordered corrections and playbook revisions", () => {
  const task = {
    taskRef: "task",
    events: [
      event("delivery", 1, { playbook }),
      event("delivery", 2, { playbook }),
      event("outcome", 6, { outcome: "failed" }),
      event("outcome", 3, { outcome: "succeeded" }),
      event("user_rating", 5, { playbook, rating: "helpful" }),
      event("user_rating", 4, { playbook, rating: "incorrect" }),
      event("delivery", 7, { playbook: { ...playbook, revision: 4 } }),
    ],
  };
  const records = taskFeedback(task).feedback;
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    taskRef: "task",
    playbookId: playbook.id,
    revision: 3,
    delivered: true,
    taskOutcome: "failed",
    userRating: "helpful",
  });
  assert.equal(records[1]!.userRating, null);
  const totals = feedbackSummary([task, { taskRef: "other", events: [] }]);
  assert.equal(totals.tasks, 2);
  assert.equal(totals.delivered, 1);
  assert.equal(totals.failed, 1);
  assert.equal(totals.succeeded, 0);
  assert.equal(totals.reportedIncorrect, 0);
  assert.equal(totals.helpful, 1);
  assert.equal(totals.unknownOutcome, 1);
});

test("Rating needs no delivery or result and equal-time corrections use receipt order", () => {
  const task = {
    taskRef: "task",
    events: [
      event("user_rating", 1, { playbook, rating: "incorrect" }),
      event("user_rating", 1, { playbook, rating: "helpful" }),
      event("outcome", 2, { outcome: "succeeded" }),
      event("outcome", 3, { outcome: "unknown" }),
    ],
  };
  assert.deepEqual(taskFeedback(task).feedback[0], {
    taskRef: "task",
    playbookId: playbook.id,
    revision: 3,
    delivered: null,
    taskOutcome: "unknown",
    userRating: "helpful",
  });
});
