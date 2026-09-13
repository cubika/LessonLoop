import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ModelClient, parseJsonResponse } from "./model-client.js";
import { startQdrant } from "./qdrant-runtime.js";
import { startLocalEmbeddings } from "./local-embeddings.js";
import { createMemory, ProbeGateway } from "./mem0-gateway.js";
import { experienceSchema } from "./experience.js";
import { taskFixtures } from "./task-fixtures.js";
import { runTask } from "./task-runner.js";
import { workspacePath } from "./paths.js";

const extractionSchema = z.object({ lessons: z.array(z.object({
  conclusion: z.string().min(1), level: z.enum(["L1", "L2", "L3", "L4", "L5"]),
  purpose: z.enum(["fact", "lesson", "procedure", "rationale"]),
  conditions: z.array(z.string()).max(4), exceptions: z.array(z.string()).max(4),
  topics: z.array(z.string()).max(8), entities: z.array(z.string()).max(16),
  sources: z.array(z.object({ index: z.number().int().nonnegative(), quote: z.string().min(1) }).strict()).min(1).max(3),
  supportedWithinStatedConditions: z.boolean(), futureUse: z.string().min(1),
}).strict()).max(4) }).strict();

async function distill(model: ModelClient, history: string[], gateway: ProbeGateway) {
  const raw = await model.complete([
    { role: "system", content: "Extract only useful reusable lessons from the authored historical observations. Return JSON {lessons:[{conclusion,level:L1|L2|L3|L4|L5,purpose:fact|lesson|procedure|rationale,conditions:string[],exceptions:string[],topics:string[],entities:string[],sources:[{index,quote}],supportedWithinStatedConditions:boolean,futureUse:string}]}. Exact source quotes must occur verbatim. Do not invent causality or make a condition broader than the observations. Return no lesson when temporary, redundant, or unsupported. L1-L5 is abstraction, not confidence. At most four concise lessons. Do not infer task answers not in the history." },
    { role: "user", content: JSON.stringify({ historicalObservations: history }) },
  ]);
  const parsed = extractionSchema.parse(parseJsonResponse(raw));
  const accepted = [];
  const rejected: string[] = [];
  for (const [index, proposal] of parsed.lessons.entries()) {
    if (!proposal.supportedWithinStatedConditions) { rejected.push("model_marked_unsupported"); continue; }
    if (proposal.sources.some(source => !history[source.index]?.includes(source.quote))) { rejected.push("invalid_source_quote"); continue; }
    const evidence = proposal.sources.map(source => ({ excerpt: source.quote, role: "tool" as const, relation: "supports" as const, fingerprint: createHash("sha256").update(history[source.index]!).digest("hex") }));
    const now = new Date().toISOString();
    const record = experienceSchema.parse({
      id: `draft-${index}`, revision: 1, scopeId: "p0:task", conclusion: proposal.conclusion, level: proposal.level, purpose: proposal.purpose,
      applicability: proposal.conditions.length || proposal.exceptions.length ? "conditional" : "general",
      conditions: proposal.conditions.map(text => ({ text })), exceptions: proposal.exceptions.map(text => ({ text })),
      topics: proposal.topics, entities: proposal.entities, basis: "observed", assessment: "supported", evidence,
      sourceFingerprints: [...new Set(evidence.map(item => item.fingerprint))], derivedFrom: [], state: "active", createdAt: now, updatedAt: now,
    });
    accepted.push(await gateway.add(record));
  }
  return { accepted, rejected };
}

export async function evaluate() {
  const baseUrl = process.env.LESSONLOOP_MODEL_URL;
  const modelName = process.env.LESSONLOOP_MODEL;
  const output = workspacePath(".p0", "results", "comparison.json");
  await mkdir(path.dirname(output), { recursive: true });
  if (!baseUrl || !modelName) {
    const report = { status: "blocked", reason: "A real OpenAI-compatible extraction/execution model must be configured with LESSONLOOP_MODEL_URL and LESSONLOOP_MODEL. No fake model is substituted.", arms: ["no_memory", "mem0_default", "structured_learning"], fixtureStatus: "authored_mechanism_cases_not_held_out_benchmark", taskBenefitMeasured: false };
    await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); process.exitCode = 2; return report;
  }
  const model = new ModelClient(baseUrl, modelName, process.env.LESSONLOOP_MODEL_API_KEY);
  const runId = `evaluation_${Date.now()}`;
  const database = await startQdrant(runId);
  let embeddings: Awaited<ReturnType<typeof startLocalEmbeddings>> | undefined;
  const results: unknown[] = [];
  let status = "completed";
  let failure: string | undefined;
  try {
    embeddings = await startLocalEmbeddings();
    // Fixed rotation reduces arm-order effects; repeated independent runs are still required.
    for (const [taskIndex, fixture] of taskFixtures.entries()) {
      const arms = ["no_memory", "mem0_default", "structured_learning"] as const;
      for (let offset = 0; offset < arms.length; offset++) {
        const arm = arms[(taskIndex + offset) % arms.length]!;
        const begin = performance.now(); const usageBefore = { ...model.usage }; const embeddingBefore = { ...embeddings.calls };
        let recall: () => Promise<string> = async () => "";
        let formation: unknown = null;
        if (arm !== "no_memory") {
          const memory = await createMemory(database.url, embeddings.url, `p0_${runId}_${taskIndex}_${arm}`, baseUrl, modelName);
          if (arm === "mem0_default") {
            const added = await memory.add(fixture.history.map(content => ({ role: "user", content })), { userId: `p0-${fixture.id}` });
            formation = { records: added.results.length };
            recall = async () => { const found = await memory.search(fixture.request, { topK: 3, filters: { user_id: `p0-${fixture.id}` } }); return JSON.stringify(found.results.map(row => row.memory)); };
          } else {
            const gateway = new ProbeGateway(memory, `p0-${fixture.id}`);
            formation = await distill(model, fixture.history, gateway);
            recall = async () => {
              const found = await gateway.search(fixture.request, "p0:task", 3);
              return JSON.stringify(found.map(row => ({ conclusion: row.conclusion, conditions: row.conditions, exceptions: row.exceptions, use: row.applicability === "conditional" ? "Reference only: inspect current files before applying" : "Reference" })));
            };
          }
        }
        const result = await runTask(model, fixture, workspacePath(".p0", "tasks", runId, fixture.id, arm), recall);
        results.push({ arm, ...result, formation, elapsedMs: Math.round(performance.now() - begin), executionAndDistillationUsage: { requests: model.usage.requests - usageBefore.requests, promptTokens: model.usage.promptTokens - usageBefore.promptTokens, completionTokens: model.usage.completionTokens - usageBefore.completionTokens }, embeddingRequests: embeddings.calls.embeddings - embeddingBefore.embeddings });
      }
    }
  } catch (error) { status = "failed"; failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  finally { if (embeddings) await embeddings.close(); await database.stop(); }
  const report = { runId, status, ...(failure ? { failure } : {}), model: modelName, results,
    limitations: ["Authored tiny task fixtures, not representative/held-out user cases.", "Real model calls and sandbox file actions, but synthetic harness is not Copilot.", "Structured arm is a prototype, not the complete production learner or condition-verification loop.", "Exact-quote checks do not independently establish semantic truth; human review of formation remains required.", "Mem0 internal model usage is not included in ModelClient token counts; total cost must be measured before comparison claims.", "No statistical quality or user-benefit claim can be made from this probe alone."] };
  await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await evaluate();
