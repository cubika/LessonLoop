import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  guidanceInput,
  sourceInput,
  feedbackInput,
} from "../../core/agent-contract.js";
const config = JSON.parse(
  process.env.LESSONLOOP_AGENT_CONFIG_JSON ??
    (await readFile(process.env.LESSONLOOP_AGENT_CONFIG ?? "", "utf8")),
) as { baseUrl: string; token: string };
const base = new URL(config.baseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error("agent_api_must_be_local");
const server = new McpServer({ name: "lessonloop", version: "0.0.1" });
const tools = {
  getGuidance: {
    description:
      "Get applicable playbook guidance and experiences for the current problem. Reuse the hook's or previous response's taskRef. Without taskRef a task is created, using the only authorized scope or explicit scopeId. Returns taskRef, scopeId, playbooks and experiences; an empty result means no eligible guidance was found. Check conditions and choose branches from current observations. A lead still needs verification. For requires_expansion, repeat with the same taskRef and target reference, viewMode=expanded. No step completion report is needed.",
    schema: guidanceInput,
  },
  submitSource: {
    description:
      "Submit authorized material or new results for asynchronous learning. Use the returned scopeId; sourceFor links a prior source receipt. Agent claims remain agent material; trusted user/tool capture is handled by the host. An accepted receipt is not proof of learning or publication. Job status and management are available in the UI/CLI.",
    schema: sourceInput,
  },
  feedback: {
    description:
      "Rate or correct a playbook or experience using its exact returned reference and revision. This records the caller's assessment, not verified execution success. Submit new supporting evidence with submitSource.",
    schema: feedbackInput,
  },
};
for (const [name, tool] of Object.entries(tools))
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: {
        input: tool.schema as z.ZodTypeAny,
        eventId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Reuse for retries of the same request."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
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
        signal: AbortSignal.timeout(name === "getGuidance" ? 30000 : 20000),
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
