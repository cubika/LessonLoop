// Public resource names are independent of the persisted learning model.
export const publicOperations: Record<string, string> = {
  searchPlaybooks: "searchMethods",
  browsePlaybooks: "browseMethods",
  inspectPlaybook: "inspectMethod",
  preparePlaybook: "prepareMethod",
  revisePlaybook: "reviseMethod",
  setPlaybookState: "setMethodState",
  removePlaybook: "removeMethod",
  exportPlaybook: "exportMethod",
  pinPlaybook: "pinMethod",
  ratePlaybookUse: "rateMethodUse",
  browseExperiences: "browse",
  inspectExperience: "inspect",
  reviseExperience: "revise",
  setExperienceState: "setState",
  removeExperience: "remove",
  recallExperiences: "recall",
  getUsageView: "listEffectCases",
};
const names: Record<string, string> = {
  method: "playbook",
  methods: "playbooks",
  methodId: "playbookId",
  methodUseRef: "playbookUseRef",
  methodUses: "playbookUses",
  methodRefs: "playbookRefs",
  comparedMethodRefs: "comparedPlaybookRefs",
  affectedMethods: "affectedPlaybooks",
};
const privateFields = new Set([
  "materialId",
  "materialIds",
  "caseFor",
  "caseTarget",
  "caseRefs",
  "inputCaseRefs",
  "caseRef",
  "caseBindingId",
  "sourceSupplement",
  "candidate",
  "verdict",
  "modelSchema",
  "assessmentSchema",
  "modelQuery",
  "assessmentQuery",
  "retainedSupport",
  "comparisonMethods",
]);
// These fields are source data, not protocol structure. Never rewrite their keys.
const opaque = new Set([
  "context",
  "segments",
  "evidence",
  "match",
  "values",
  "conditionResults",
]);
export function publicValue(value: unknown): any {
  if (Array.isArray(value))
    return value.filter((v) => v?.kind !== "work_case").map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => {
      if (privateFields.has(key)) return [];
      return [
        [
          names[key] ?? key,
          key === "kind" && v === "method"
            ? "playbook"
            : opaque.has(key)
              ? v
              : publicValue(v),
        ],
      ];
    }),
  );
}
export function internalInput(value: unknown): any {
  if (Array.isArray(value)) return value.map(internalInput);
  if (!value || typeof value !== "object") return value;
  const reverse = Object.fromEntries(
    Object.entries(names).map(([a, b]) => [b, a]),
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      reverse[key] ?? key,
      key === "kind" && v === "playbook"
        ? "method"
        : opaque.has(key)
          ? v
          : internalInput(v),
    ]),
  );
}
