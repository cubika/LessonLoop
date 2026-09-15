import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const config = JSON.parse(
  process.env.LESSONLOOP_AGENT_CONFIG_JSON ??
    (await readFile(process.env.LESSONLOOP_AGENT_CONFIG ?? "", "utf8")),
) as { baseUrl: string; token: string };
const base = new URL(config.baseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error("agent_api_must_be_local");
const server = new McpServer({ name: "lessonloop", version: "0.0.1" });
const tools = {
  submitMaterial: "Submit authorized agent material for learning",
  getJob: "Read current learning status",
  searchMethods: "Search currently published method summaries",
  prepareMethod:
    "Get method guidance. input: {methodId, revision, taskRef, methodUseRef?, completedStepIds?, requestId?}. Reuse the taskRef and methodUseRef supplied by the LessonLoop hook. After checking missing facts with real tools, call reassessTask first and pass its completedStepIds here.",
  reassessTask:
    "Check method conditions against tool evidence captured by the host. input: {taskRef, methodId, revision, methodUseRef}. Use the references from the LessonLoop hook. Run the relevant real tools before this call; text claims do not count as observed completion.",
  inspectMethod: "Read current method details",
  recall: "Recall eligible experiences",
  inspect: "Inspect a product experience",
  reviewTopic: "Review a bounded topic",
  feedback: "Report method or experience feedback",
  startTask:
    "Create a separate agent-owned task. input: {scopeId, eventId?}. When the LessonLoop hook already supplied a taskRef, continue that task instead.",
};
const methodInput = {
  methodId: z.string().min(1),
  revision: z.number().int().positive(),
  taskRef: z.string().min(1),
};
const inputs: Record<string, z.ZodTypeAny> = {
  reassessTask: z
    .object({ ...methodInput, methodUseRef: z.string().min(1) })
    .strict(),
  prepareMethod: z
    .object({
      ...methodInput,
      methodUseRef: z.string().min(1).optional(),
      completedStepIds: z.array(z.string()).max(12).optional(),
      requestId: z.string().max(128).optional(),
    })
    .strict(),
};
for (const [name, description] of Object.entries(tools))
  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        input: inputs[name] ?? z.record(z.unknown()),
        eventId: z.string().max(128).optional(),
      },
    },
    async ({ input, eventId }) => {
      const r = await fetch(new URL("/v1/rpc", base), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": eventId ?? randomUUID(),
        },
        body: JSON.stringify({ operation: name, input }),
        signal: AbortSignal.timeout(name === "reassessTask" ? 45000 : 20000),
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await r.json()) },
        ],
        isError: !r.ok,
      };
    },
  );
await server.connect(new StdioServerTransport());
