import {
  canonical,
  digest,
  type Source,
  type Playbook,
} from "../domain/schema.js";
import type { Experience } from "../domain/experience.js";
import { learningQuery, type learningOutputSchema } from "./learning.js";
import { playbookPaths } from "../domain/playbook-paths.js";
import type { z } from "zod";
export interface PromptJob {
  promptVersion?: number;
  inputSources?: Source[];
  comparisonPlaybooks?: Playbook[];
  retainedSupport?: Experience[];
  verificationTarget?: Experience;
  verificationControl?: { reason: string; correctionText?: string };
  synthesisTopicId?: string;
  candidate?: z.infer<typeof learningOutputSchema>;
  repairReasons?: string[] | undefined;
  modelSchema?: Record<string, unknown>;
  modelQuery?: string;
  assessmentQuery?: string;
  modelQueryHash?: string;
  assessmentQueryHash?: string;
}
export class JobPromptError extends Error {}
// Version 1 uses canonical JSON so database round trips preserve request bytes.
export function jobQuery(job: PromptJob, stage: "compose" | "assess"): string {
  const legacy = stage === "compose" ? job.modelQuery : job.assessmentQuery;
  if (legacy !== undefined) return legacy;
  if (job.promptVersion !== 1 || !job.inputSources)
    throw new JobPromptError("job_prompt_version_unsupported");
  const query =
    stage === "compose"
      ? composeV1(job, job.inputSources)
      : assessV1(job, job.inputSources);
  const expected =
    stage === "compose" ? job.modelQueryHash : job.assessmentQueryHash;
  if (expected && digest(query) !== expected)
    throw new JobPromptError("job_prompt_changed");
  return query;
}
function composeV1(current: PromptJob, inputSources: Source[]) {
  const base =
    learningQuery(
      inputSources,
      current.comparisonPlaybooks ?? [],
      current.retainedSupport ?? [],
      current.modelSchema,
      canonical,
    ) +
    (current.verificationTarget
      ? "\nTARGETED VERIFICATION: return workView=null, playbook=null, splitPlaybooks=null and at most one experience resolving the exact claim and open review question below. The target is a question, NOT additional supporting evidence. Use only SOURCE DATA for evidence; preserve authorized boundaries and original claim identity. Do not replace it with an unrelated claim. TARGET: " +
        canonical({
          claim: current.verificationTarget,
          userControl: current.verificationControl ?? null,
        })
      : "") +
    (current.synthesisTopicId ||
    new Set(inputSources.map((s) => s.workKey)).size > 1
      ? "\nThis is a cross-case synthesis. Keep workView=null: distinct cases are not one task. Compare the supplied independent source families for useful new rules, conflicts, conditions or justified scope changes. Stop when the evidence supports the stated scope; no broader explanation is required."
      : "");
  return (
    base +
    (current.repairReasons
      ? "\nONE BOUNDED REVISION: the proposal below was rejected by independent support/path review. Correct only the cited problems using the same authorized evidence; do not weaken scope or invent facts. If no supported playbook is possible return playbook=null.\nREJECTED PROPOSAL (not evidence):\n" +
        canonical(current.candidate) +
        "\nREVIEW FINDINGS (not evidence):\n" +
        canonical(current.repairReasons)
      : "")
  );
}
function assessV1(j: PromptJob, inputSources: Source[]) {
  return (
    "Assess the proposal against authorized source data and the frozen retained support. Do not add evidence. Reject unsupported causal/generalized claims, temporary requests, agent assertions posing as observations, misleading conditions and unsupported steps. Check each claim for future usefulness, sufficient support and explicit scope. A supported local rule can stand on its own; do not require analysis labels, a fixed case count or broader generalization. A bounded logical implication of an explicitly observed mechanism is allowed; do not demand a separate observation for every input value of the same stated deterministic copy operation. Reject empirical equivalence claims about additional unobserved tools or unrelated pipelines. Judge meaning rather than reference-answer wording. For verificationTarget, verifiedTarget must be true only if the single proposed experience resolves that exact claim using authorized source evidence and preserves its boundaries; the old target itself is not evidence. Otherwise verifiedTarget=false. Retained support is not another independent case. Return acceptedExperienceIndexes, playbookSupported, substantiveChange, supportedEvidenceChange, acceptedPlaybookIndexes, splitCoherent and reasons. Playbook indexes follow splitPlaybooks or the single playbook at index 0. Check executablePaths, not just individual sentences: a step without choices always continues to the next array element. Reject any path that falls through into another version or mutually exclusive procedure. Evaluate a task for EACH branch: assume that branch condition true and other branches false, and verify every global condition is compatible. Reject a global condition specific to another branch, or exceptions that are past observations rather than current task exclusion predicates. Reject a new global condition that excludes a still-valid original task unless new evidence disproves that task. For a split require every child to be supported, distinct scope/behavior, and the group to preserve valid portions of the original. A rejected child rejects the whole split. substantiveChange is false for paraphrase/title-only changes, repeated success without new behavior, or no new supported step/condition/check. supportedEvidenceChange is true only when new independent evidence changes or strengthens the specific support for an existing playbook. Changing IDs or repeating the same source is false. Data: " +
    " Before the overall verdict, fill pathChecks for EVERY indexed executable path. Describe in reason a concrete task taking this path and test ALL global conditions/exceptions against that task. globalConditionsCompatible=false if any global requirement belongs only to a different branch or is a historical outcome posing as an exclusion. stepsCompatible=false for contradictory steps or fallthrough. Fill preservedPaths for EVERY path of each replaced playbook: preserved=true only when a task that previously used that path still has a valid path in the proposal. New evidence invalidating an old path needs a separate correction; do not silently retire it during additive evolution. Return empty arrays when there is no proposed playbook." +
    canonical({
      inputSources,
      retainedSupport: j.retainedSupport ?? [],
      existingPlaybooks: j.comparisonPlaybooks ?? [],
      previousPaths: (j.comparisonPlaybooks ?? []).map((m) => ({
        id: m.id,
        ...playbookPaths(m),
      })),
      verificationTarget: j.verificationTarget ?? null,
      verificationControl: j.verificationControl ?? null,
      proposal: j.candidate,
      executablePaths: (
        j.candidate?.splitPlaybooks ??
        (j.candidate?.playbook ? [j.candidate.playbook] : [])
      ).map(playbookPaths),
    })
  );
}
