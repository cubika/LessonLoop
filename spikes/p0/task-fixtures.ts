export interface TaskFixture {
  id: string; family: string; history: string[]; request: string;
  setup: Record<string, unknown>; targetFile: string; generatedFile?: string;
  oracle: { key: string; value: unknown };
}
// Authored mechanism probes. They are not a held-out user benchmark.
export const taskFixtures: TaskFixture[] = [
  {
    id: "generated-client-transfer", family: "generated-artifacts",
    history: [
      "In project A, editing build/api-client.json directly was lost after regeneration. The generator reads definitions/api.json. Editing that source persisted after regeneration and the API check passed.",
      "The separate manual-adapters directory is handwritten and is not regenerated. Do not generalize the source-editing rule to handwritten files.",
    ],
    request: "In this different project, add a customerId field to the orders client contract. Keep the build working and verify the result.",
    setup: {
      "project.json": { pipeline: "Client output is rebuilt by run_check from inputs/order-contract.json into generated/orders-client.json" },
      "inputs/order-contract.json": { fields: ["orderId"] },
      "generated/orders-client.json": { fields: ["orderId"] },
    },
    targetFile: "inputs/order-contract.json", generatedFile: "generated/orders-client.json",
    oracle: { key: "fields", value: ["orderId", "customerId"] },
  },
  {
    id: "handwritten-exception", family: "generated-artifacts",
    history: [
      "In project A, direct generated-client edits were overwritten. Change the generator input and regenerate for generated files.",
      "Handwritten adapters are maintained directly; generation rules do not apply to them.",
    ],
    request: "Add customerId to the handwritten orders adapter and verify it. Avoid changing unrelated build inputs.",
    setup: {
      "project.json": { pipeline: "manual/orders.json is handwritten; inputs/unrelated.json is unrelated" },
      "manual/orders.json": { fields: ["orderId"] },
      "inputs/unrelated.json": { fields: ["unrelated"] },
    },
    targetFile: "manual/orders.json", oracle: { key: "fields", value: ["orderId", "customerId"] },
  },
];
