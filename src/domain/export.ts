import type { Method } from "./schema.js";
import type { Experience } from "./experience.js";

export function exportMethod(
  method: Method,
  support: Experience[],
  format: "markdown" | "checklist" | "skill",
  includeEvidence = false,
) {
  const line = (value: string) => value.replaceAll("\r", "");
  const sections: string[] = [];
  if (format === "skill") {
    const name = `playbook-${method.id}`;
    sections.push(`---
name: ${name}
description: ${JSON.stringify(method.goal)}
---`);
  }
  sections.push(
    `# ${line(method.title)}`,
    `Playbook ${method.id} · revision ${method.revision} · ${method.state}`,
    `Exported ${new Date().toISOString()}. This is an independent snapshot. Check the current revision in LessonLoop before use. Source changes and deletion do not update this file.`,
    line(method.goal),
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
    method.conditions.map((c) => c.text),
  );
  list(
    "Exceptions",
    method.exceptions.map((c) => c.text),
  );
  if (method.validFrom || method.validUntil)
    sections.push(
      `Validity: ${method.validFrom ?? "unbounded"} → ${method.validUntil ?? "unbounded"}`,
    );
  sections.push(
    "## Steps",
    method.steps
      .map(
        (s, i) =>
          `${format === "checklist" ? "- [ ]" : `${i + 1}.`} [${s.stepId}] ${line(s.instruction)}${s.rationale ? `\n   Reason: ${line(s.rationale)}` : ""}${s.choices ? "\n" + s.choices.map((c) => `   - After this step: ${line(c.when.text)} → ${c.next}`).join("\n") : ""}`,
      )
      .join("\n\n"),
  );
  const checks = (values: Method["completionChecks"]) =>
    values.map(
      (c) =>
        `${c.text}${c.stepIds ? ` (steps: ${c.stepIds.join(", ")})` : " (global)"}`,
    );
  list("Completion checks", checks(method.completionChecks));
  list("Stop conditions", checks(method.stopConditions));
  sections.push(
    "## Execution boundary",
    "Use only the determined path. Unknown, conflicting or unmatched choices require observations before continuing. Completing a diagnostic prefix does not prove the entire method succeeded. This snapshot grants no permission to execute commands or access data.",
  );
  list(
    "Support",
    method.supportRefs.map((r) => {
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
  sections.push("## Change", line(method.change.summary));
  return sections.join("\n\n") + "\n";
}
