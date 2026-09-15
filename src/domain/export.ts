import type { Playbook } from "./schema.js";
import type { Experience } from "./experience.js";

export function exportPlaybook(
  playbook: Playbook,
  support: Experience[],
  format: "markdown" | "checklist" | "skill",
  includeEvidence = false,
) {
  const line = (value: string) => value.replaceAll("\r", "");
  const sections: string[] = [];
  if (format === "skill") {
    const name = `playbook-${playbook.id}`;
    sections.push(`---
name: ${name}
description: ${JSON.stringify(playbook.goal)}
---`);
  }
  sections.push(
    `# ${line(playbook.title)}`,
    `Playbook ${playbook.id} · revision ${playbook.revision} · ${playbook.state}`,
    `Exported ${new Date().toISOString()}. This is an independent snapshot. Check the current revision in LessonLoop before use. Source changes and deletion do not update this file.`,
    line(playbook.goal),
  );
  const list = (title: string, values: string[]) => {
    if (values.length)
      sections.push(
        `## ${title}`,
        values.map((v) => `- ${line(v)}`).join("\n"),
      );
  };
  list(
    "Conditions",
    playbook.conditions.map((c) => c.text),
  );
  list(
    "Exceptions",
    playbook.exceptions.map((c) => c.text),
  );
  if (playbook.validFrom || playbook.validUntil)
    sections.push(
      `Validity: ${playbook.validFrom ?? "unbounded"} → ${playbook.validUntil ?? "unbounded"}`,
    );
  sections.push(
    "## Steps",
    playbook.steps
      .map(
        (s, i) =>
          `${format === "checklist" ? "- [ ]" : `${i + 1}.`} [${s.stepId}] ${line(s.instruction)}${s.rationale ? `\n   Reason: ${line(s.rationale)}` : ""}${s.choices ? "\n" + s.choices.map((c) => `   - After this step: ${line(c.when.text)} → ${c.next}`).join("\n") : ""}`,
      )
      .join("\n\n"),
  );
  const checks = (values: Playbook["completionChecks"]) =>
    values.map(
      (c) =>
        `${c.text}${c.stepIds ? ` (steps: ${c.stepIds.join(", ")})` : " (global)"}`,
    );
  list("Completion checks", checks(playbook.completionChecks));
  list("Stop conditions", checks(playbook.stopConditions));
  sections.push(
    "## Execution boundary",
    "Use only the determined path. Unknown, conflicting or unmatched choices require observations before continuing. Completing a diagnostic prefix does not prove the entire playbook succeeded. This snapshot grants no permission to execute commands or access data.",
  );
  list(
    "Support",
    playbook.supportRefs.map((r) => {
      const e = support.find((e) => e.id === r.id && e.revision === r.revision);
      return `${r.id}@${r.revision}${e ? ` — ${e.level}, ${e.assessment}: ${e.conclusion}` : " — source revision unavailable"}`;
    }),
  );
  if (includeEvidence)
    list(
      "Source excerpts",
      support.flatMap((e) =>
        e.evidence.map(
          (v) =>
            `[${v.role}] ${JSON.stringify(v.excerpt)}${v.locator ? ` (${v.locator})` : ""}`,
        ),
      ),
    );
  sections.push("## Change", line(playbook.change.summary));
  return sections.join("\n\n") + "\n";
}
