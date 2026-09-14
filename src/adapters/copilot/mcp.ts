import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const config = JSON.parse(
  await readFile(process.env.LESSONLOOP_AGENT_CONFIG ?? "", "utf8"),
) as { baseUrl: string; token: string };
const server = new McpServer({ name: "lessonloop", version: "0.0.1" });
const tools = {
  submitMaterial: "Submit authorized agent material for learning",
  getJob: "Read current learning status",
  searchMethods: "Search currently published method summaries",
  prepareMethod: "Prepare a method for a core-bound task",
  inspectMethod: "Read current method details",
  recall: "Recall eligible experiences",
  inspect: "Inspect a product experience",
  reviewTopic: "Review a bounded topic",
  feedback: "Report method or experience feedback",
  startTask: "Create an isolated task identity",
};
for (const [name, description] of Object.entries(tools))
  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        input: z.record(z.unknown()),
        eventId: z.string().max(128).optional(),
      },
    },
    async ({ input, eventId }) => {
      const r = await fetch(new URL("/v1/rpc", config.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": eventId ?? crypto.randomUUID(),
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
