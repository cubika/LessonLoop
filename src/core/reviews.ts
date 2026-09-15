import { z } from "zod";
import { ProductStore, Conflict, type Transaction } from "../store/postgres.js";
import { digest, identity, type ObjectRef } from "../domain/schema.js";
import type { Principal } from "./service.js";
import { publicValue } from "./public-contract.js";
const DAY = 86400000;
type Stored = { id: string; revision: number; scopeId: string };
type Review = Stored & {
  start: string;
  end: string;
  createdAt: string;
  mergedPeriods: number;
  coverage: string;
  methodRefs: ObjectRef[];
};
type Schedule = Stored & { days: number; through: string };
type Notification = Stored & {
  reviewId: string;
  issueId?: string;
  createdAt: string;
  read: boolean;
};
type Event = {
  kind: string;
  occurredAt: string;
  outcome?: string;
  rating?: string;
  text: string;
  method?: ObjectRef;
};
type Task = Stored & { taskRef: string; createdAt: string; events: Event[] };
const entry = <T extends Stored>(kind: string, value: T) => ({
  kind,
  id: value.id,
  revision: value.revision,
  scopeId: value.scopeId,
  value: value as unknown as Record<string, unknown>,
});
type Issue = Stored & {
  category:
    | "stale_method"
    | "wrong_scope"
    | "wrong_branch"
    | "incorrect_guidance";
  status: "suspected" | "confirmed" | "resolved";
  severity: "normal" | "serious";
  createdAt: string;
  confirmedBy?: string;
  confirmedEvidence?: Array<{ caseId: string; eventId: string }>;
  evidence: Array<{ caseId: string; eventId: string }>;
};
export class Reviews {
  constructor(private readonly store: ProductStore) {}
  async recordIssue(p: Principal, input: unknown) {
    if (p.channel !== "user") throw new Error("user_operation_required");
    const v = z
      .object({
        scopeId: z.string(),
        problemKey: z.string().min(1).max(128).optional(),
        id: z.string().optional(),
        reconfirm: z.boolean().optional(),
        expectedRevision: z.number().int().nonnegative(),
        category: z.enum([
          "stale_method",
          "wrong_scope",
          "wrong_branch",
          "incorrect_guidance",
        ]),
        status: z.enum(["suspected", "confirmed", "resolved"]),
        severity: z.enum(["normal", "serious"]),
        evidence: z
          .array(z.object({ caseId: z.string(), eventId: z.string() }).strict())
          .min(1)
          .max(32),
      })
      .strict()
      .parse(input);
    if (!p.scopes.includes(v.scopeId)) throw new Error("not_found");
    return this.store.transaction(async (tx) => {
      const settings = await tx.get<{
        review: boolean;
        notifications: boolean;
      }>("settings", v.scopeId);
      if (!settings?.review) throw new Error("review_disabled");
      if (!v.id && !v.problemKey) throw new Error("problem_identity_required");
      const id = v.id ?? digest([v.scopeId, v.problemKey]),
        old = await tx.get<Issue>("review_issue", id);
      if ((old && old.scopeId !== v.scopeId) || (v.id && !old))
        throw new Error("not_found");
      if ((old?.revision ?? 0) !== v.expectedRevision) throw new Conflict();
      if (old && old.category !== v.category)
        throw new Conflict("issue_category_changed");
      const evidence = [
        ...new Map(
          [...(old?.evidence ?? []), ...v.evidence].map((r) => [digest(r), r]),
        ).values(),
      ];
      if (evidence.length > 32) throw new Error("issue_evidence_budget");
      for (const ref of v.evidence) {
        const task = await tx.get<Task>("effect_task", ref.caseId);
        if (
          !task ||
          task.scopeId !== v.scopeId ||
          !task.events.some(
            (e) =>
              (e as Event & { eventId: string }).eventId === ref.eventId &&
              Date.parse(e.occurredAt) > Date.now() - 30 * DAY,
          )
        )
          throw new Error("issue_evidence_unavailable");
      }
      const issue: Issue = {
        id,
        revision: (old?.revision ?? 0) + 1,
        scopeId: v.scopeId,
        category: v.category,
        status: v.status,
        severity: v.severity,
        createdAt: old?.createdAt ?? new Date().toISOString(),
        evidence,
        ...(v.status === "confirmed"
          ? {
              confirmedBy: p.id,
              confirmedEvidence:
                old?.status === "confirmed" && !v.reconfirm
                  ? (old.confirmedEvidence ?? old.evidence)
                  : v.evidence,
            }
          : old?.confirmedBy
            ? {
                confirmedBy: old.confirmedBy,
                ...(old.confirmedEvidence
                  ? { confirmedEvidence: old.confirmedEvidence }
                  : {}),
              }
            : {}),
      };
      await tx.put(entry("review_issue", issue), old?.revision ?? null);
      if (
        issue.status === "confirmed" &&
        issue.severity === "serious" &&
        settings.notifications
      ) {
        const notificationId = digest([id, "confirmed-serious"]);
        if (!(await tx.get("review_notification", notificationId)))
          await tx.put(
            entry("review_notification", {
              id: notificationId,
              revision: 1,
              scopeId: v.scopeId,
              reviewId: id,
              issueId: id,
              createdAt: new Date().toISOString(),
              read: false,
            }),
            null,
          );
      }
      return issue;
    });
  }
  async issues(p: Principal, transaction?: Transaction) {
    const read = async (tx: Transaction) => {
      const cases = await tx.list<Task>("effect_task", p.scopes),
        result = [];
      for (const issue of await tx.list<Issue>("review_issue", p.scopes)) {
        const evidence = issue.evidence.filter((r) =>
          cases.some(
            (c) =>
              c.id === r.caseId &&
              c.scopeId === issue.scopeId &&
              c.events.some(
                (e) =>
                  (e as Event & { eventId: string }).eventId === r.eventId &&
                  Date.parse(e.occurredAt) > Date.now() - 30 * DAY,
              ),
          ),
        );
        if (
          evidence.length &&
          Date.parse(issue.createdAt) > Date.now() - 90 * DAY
        )
          result.push({
            ...issue,
            status:
              issue.status === "confirmed" &&
              !(issue.confirmedEvidence ?? issue.evidence).every((r) =>
                evidence.some(
                  (e) => e.caseId === r.caseId && e.eventId === r.eventId,
                ),
              )
                ? "suspected"
                : issue.status,
            evidence,
            affectedTasks: new Set(evidence.map((e) => e.caseId)).size,
            confirmation:
              issue.confirmedBy &&
              (issue.confirmedEvidence ?? issue.evidence).every((r) =>
                evidence.some(
                  (e) => e.caseId === r.caseId && e.eventId === r.eventId,
                ),
              )
                ? "user_confirmed"
                : "needs_verification",
          });
      }
      return result;
    };
    return transaction ? read(transaction) : this.store.transaction(read);
  }
  async exportCases(p: Principal, input: unknown) {
    if (p.channel !== "user") throw new Error("user_operation_required");
    const v = z
      .object({
        caseIds: z.array(z.string()).min(1).max(8),
        includeObservations: z.boolean().default(false),
        redact: z.array(z.string().min(1).max(512)).max(32).default([]),
      })
      .strict()
      .parse(input);
    return this.store.transaction(async (tx) => {
      const cases = [];
      for (const id of new Set(v.caseIds)) {
        const task = await tx.get<Task>("effect_task", id);
        if (!task || !p.scopes.includes(task.scopeId))
          throw new Error("not_found");
        const events = task.events.filter(
          (e) => Date.parse(e.occurredAt) > Date.now() - 30 * DAY,
        );
        if (!events.length) throw new Error("case_expired");
        const original = await tx.get<{
          rawObservations?: Array<{
            eventId: string;
            text: string;
            occurredAt: string;
          }>;
        }>("task", task.taskRef);
        const observations = v.includeObservations
          ? (original?.rawObservations ?? []).filter(
              (o) => Date.parse(o.occurredAt) > Date.now() - 30 * DAY,
            )
          : [];
        cases.push({
          scopeId: task.scopeId,
          taskRef: task.taskRef,
          events,
          observations,
          coverage: {
            initialWorkspace: "unavailable",
            executionTrace: observations.length
              ? "retained_host_observations"
              : "not_included_or_unavailable",
            methodSnapshots: "not_included",
          },
        });
      }
      const redact = (value: unknown): unknown =>
        typeof value === "string"
          ? v.redact.reduce(
              (text, term) => text.split(term).join("[redacted]"),
              value,
            )
          : Array.isArray(value)
            ? value.map(redact)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([key, v]) => [key, redact(v)]),
                )
              : value;
      const data = redact({
        format: "lessonloop-development-cases-1",
        exportedAt: new Date().toISOString(),
        snapshot:
          "Independent copy. Later source removal does not update this file. No upload is performed.",
        limitations:
          "Incomplete retained evidence; not an independent evaluation dataset or proof of benefit.",
        cases,
      });
      const content = JSON.stringify(publicValue(data), null, 2);
      if (Buffer.byteLength(content) > 262144)
        throw new Error("export_budget_exceeded");
      return {
        filename: "lessonloop-development-cases.json",
        content,
        contentRevision: digest(cases),
        caseCount: cases.length,
        redactionTerms: v.redact.length,
      };
    });
  }
  async configure(p: Principal, input: unknown) {
    if (p.channel !== "user") throw new Error("user_operation_required");
    const v = z
      .object({
        scopeId: z.string(),
        expectedRevision: z.number().int().nonnegative(),
        days: z.number().int().min(1).max(30),
      })
      .strict()
      .parse(input);
    if (!p.scopes.includes(v.scopeId)) throw new Error("not_found");
    return this.store.transaction(async (tx) => {
      const old = await tx.get<Schedule>("review_schedule", v.scopeId);
      if ((old?.revision ?? 0) !== v.expectedRevision) throw new Conflict();
      const next: Schedule = {
        id: v.scopeId,
        scopeId: v.scopeId,
        revision: (old?.revision ?? 0) + 1,
        days: v.days,
        through: old?.through ?? new Date().toISOString(),
      };
      await tx.put(entry("review_schedule", next), old?.revision ?? null);
      return next;
    });
  }
  async maintain(scopes: string[], now = Date.now()) {
    return this.store.transaction(async (tx) => {
      const created = [];
      for (const scope of scopes) {
        const setting = await tx.get<{
          review: boolean;
          notifications: boolean;
        }>("settings", scope);
        if (!setting?.review) continue;
        let schedule = await tx.get<Schedule>("review_schedule", scope);
        if (!schedule) {
          schedule = {
            id: scope,
            scopeId: scope,
            revision: 1,
            days: 7,
            through: new Date(now).toISOString(),
          };
          await tx.put(entry("review_schedule", schedule), null);
          continue;
        }
        const elapsed = now - Date.parse(schedule.through);
        if (elapsed < schedule.days * DAY) continue;
        const start = Math.max(Date.parse(schedule.through), now - 30 * DAY),
          end = now;
        const tasks = (await tx.list<Task>("effect_task", [scope])).filter(
          (t) =>
            Date.parse(t.createdAt) >= start &&
            Date.parse(t.createdAt) < end &&
            t.events.length > 0,
        );
        const methods = (
          await tx.list<{
            id: string;
            revision: number;
            scopeId: string;
            updatedAt: string;
            change?: { kind: string };
          }>("method", [scope])
        )
          .filter(
            (m) =>
              Date.parse(m.updatedAt) >= start && Date.parse(m.updatedAt) < end,
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (tasks.length || methods.length) {
          const id = digest([
            scope,
            schedule.through,
            new Date(end).toISOString(),
          ]);
          const review: Review = {
            ...identity(scope),
            id,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            createdAt: new Date(now).toISOString(),
            mergedPeriods: Math.max(
              1,
              Math.floor(elapsed / (schedule.days * DAY)),
            ),
            coverage:
              Date.parse(schedule.through) < start
                ? "older_observations_expired"
                : "retained_observations_only",
            methodRefs: methods
              .slice(0, 3)
              .map((m) => ({ kind: "method", id: m.id, revision: m.revision })),
          };
          await tx.put(entry("effect_review", review), null);
          created.push(id);
          if (setting.notifications)
            await tx.put(
              entry("review_notification", {
                id,
                revision: 1,
                scopeId: scope,
                reviewId: id,
                createdAt: review.createdAt,
                read: false,
              } as Notification),
              null,
            );
        }
        await tx.put(
          entry("review_schedule", {
            ...schedule,
            revision: schedule.revision + 1,
            through: new Date(end).toISOString(),
          }),
          schedule.revision,
        );
      }
      for (const kind of [
        "effect_review",
        "review_notification",
        "review_issue",
      ]) {
        for (const row of await tx.list<Stored & { createdAt: string }>(
          kind,
          scopes,
        ))
          if (Date.parse(row.createdAt) <= now - 90 * DAY)
            await tx.remove(kind, row.id, row.revision);
      }
      return { created };
    });
  }
  async list(p: Principal, transaction?: Transaction) {
    const read = async (tx: Transaction) => {
      const tasks = await tx.list<Task>("effect_task", p.scopes),
        methods = await tx.list<{
          id: string;
          revision: number;
          scopeId: string;
          title: string;
        }>("method", p.scopes);
      const histories: Array<{
        id: string;
        revision: number;
        scopeId: string;
        title: string;
      }> = [];
      for (const scope of p.scopes)
        histories.push(
          ...(await tx.listHistory<{
            id: string;
            revision: number;
            scopeId: string;
            title: string;
          }>("method", scope)),
        );
      const result = [];
      for (const review of (await tx.list<Review>("effect_review", p.scopes))
        .filter((r) => Date.parse(r.createdAt) > Date.now() - 90 * DAY)
        .sort((a, b) => b.end.localeCompare(a.end))) {
        const cohort = tasks
          .filter((t) => t.scopeId === review.scopeId)
          .filter(
            (t) =>
              Date.parse(t.createdAt) >= Date.parse(review.start) &&
              Date.parse(t.createdAt) < Date.parse(review.end),
          )
          .map((t) => ({
            ...t,
            events: t.events.filter(
              (e) => Date.parse(e.occurredAt) > Date.now() - 30 * DAY,
            ),
          }))
          .filter((t) => t.events.length);
        const count = (kind: string, value?: string) =>
          cohort.filter((t) =>
            t.events.some(
              (e) =>
                e.kind === kind &&
                (!value || e.outcome === value || e.rating === value),
            ),
          ).length;
        const summary = {
          tasks: cohort.length,
          delivered: count("delivery"),
          usageReported: count("usage"),
          succeeded: count("outcome", "succeeded"),
          failed: count("outcome", "failed"),
          abandoned: count("outcome", "abandoned"),
          helpfulCount: count("user_rating", "helpful"),
          problemCount: count("user_rating", "incorrect"),
          unknownOutcome: cohort.filter(
            (t) =>
              !t.events.some(
                (e) =>
                  e.kind === "outcome" && e.outcome && e.outcome !== "unknown",
              ),
          ).length,
        };
        const select = (rating: string) =>
          cohort
            .filter((t) =>
              t.events.some(
                (e) => e.kind === "user_rating" && e.rating === rating,
              ),
            )
            .slice(0, 3)
            .map((t) => ({
              id: t.id,
              taskRef: t.taskRef,
              classification:
                rating === "helpful" ? "reported_helpful" : "reported_problem",
            }));
        result.push({
          ...review,
          summary,
          helpful: select("helpful"),
          problems: select("incorrect"),
          needsVerification: cohort
            .filter(
              (t) =>
                !t.events.some(
                  (e) =>
                    e.kind === "outcome" &&
                    e.outcome &&
                    e.outcome !== "unknown",
                ),
            )
            .slice(0, 2)
            .map((t) => ({ id: t.id, taskRef: t.taskRef })),
          methods: review.methodRefs.flatMap((r) => {
            const current = methods.find(
              (m) => m.id === r.id && m.scopeId === review.scopeId,
            );
            const method =
              current?.revision === r.revision
                ? current
                : current
                  ? histories.find(
                      (m) =>
                        m.id === r.id &&
                        m.revision === r.revision &&
                        m.scopeId === review.scopeId,
                    )
                  : undefined;
            return method
              ? [
                  {
                    ...r,
                    title: method.title,
                    currentRevision: current!.revision,
                  },
                ]
              : [];
          }),
          causalBenefit: "not_inferred",
        });
      }
      return result;
    };
    return transaction ? read(transaction) : this.store.transaction(read);
  }
  async notifications(p: Principal) {
    return this.store.transaction(async (tx) => {
      const reviews = await this.list(p, tx),
        issues = await this.issues(p, tx);
      const settings = await tx.list<{
        scopeId: string;
        review: boolean;
        notifications: boolean;
      }>("settings", p.scopes);
      return (await tx.list<Notification>("review_notification", p.scopes))
        .filter(
          (n) =>
            !n.read &&
            settings.some(
              (s) => s.scopeId === n.scopeId && s.review && s.notifications,
            ) &&
            (n.issueId
              ? issues.some(
                  (i) =>
                    i.id === n.issueId &&
                    i.status === "confirmed" &&
                    i.severity === "serious",
                )
              : reviews.some(
                  (r) =>
                    r.id === n.reviewId &&
                    (r.summary.tasks || r.methods.length),
                )),
        )
        .map((n) => ({
          id: n.id,
          scopeId: n.scopeId,
          reviewId: n.reviewId,
          createdAt: n.createdAt,
          text: n.issueId
            ? "有已确认的严重方法问题待处理"
            : "新的本地效果回顾已就绪",
          ...(n.issueId ? { issueId: n.issueId } : {}),
        }));
    });
  }
  async dismiss(p: Principal, id: string) {
    if (p.channel !== "user") throw new Error("user_operation_required");
    return this.store.transaction(async (tx) => {
      const n = await tx.get<Notification>("review_notification", id);
      if (!n || !p.scopes.includes(n.scopeId)) throw new Error("not_found");
      if (!n.read)
        await tx.put(
          entry("review_notification", {
            ...n,
            read: true,
            revision: n.revision + 1,
          }),
          n.revision,
        );
      return { accepted: true };
    });
  }
}
