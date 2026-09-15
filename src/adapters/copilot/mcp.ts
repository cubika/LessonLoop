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
  submitSource: "Submit authorized agent material for learning",
  getJob: "Read current learning status",
  searchPlaybooks: "Search currently published playbook summaries",
  preparePlaybook:
    "Get complete playbook guidance. input: {playbookId, revision, taskRef, viewMode?, requestId?}. Reuse the taskRef supplied by the LessonLoop hook. Check applicability, follow the steps and choose branches using current tool results. No completion report is needed to obtain later steps. If requires_expansion is returned, request viewMode=expanded.",
  inspectPlaybook: "Read current playbook details",
  recallExperiences: "Recall eligible experiences",
  inspectExperience: "Inspect a product experience",
  reviewTopic: "Review a bounded topic",
  feedback: "Report playbook or experience feedback",
  startTask:
    "Create a separate agent-owned task. input: {scopeId, eventId?}. When the LessonLoop hook already supplied a taskRef, continue that task instead.",
};
const methodInput = {
  playbookId: z.string().min(1),
  revision: z.number().int().positive(),
  taskRef: z.string().min(1),
};
const inputs: Record<string, z.ZodTypeAny> = {
  preparePlaybook: z
    .object({
      ...methodInput,
      viewMode: z.enum(["auto", "expanded"]).optional(),
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
        signal: AbortSignal.timeout(20000),
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
