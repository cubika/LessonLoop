import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP exposes complete guidance retrieval without completion or reassessment tools", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const call = JSON.parse(raw);
    calls.push(call);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        result: {
          status: "guidance",
          steps: [
            {
              stepId: "inspect",
              choices: [{ when: { text: "Generated" }, next: "source" }],
            },
            { stepId: "source", instruction: "Edit the source and regenerate" },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/adapters/copilot/mcp.ts"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      LESSONLOOP_AGENT_CONFIG_JSON: JSON.stringify({
        baseUrl: "http://127.0.0.1:" + address.port,
        token: "test",
      }),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "guidance-test", version: "1" });
  try {
    await client.connect(transport, { timeout: 15000 });
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((t) => t.name === "reassessTask"),
      false,
    );
    assert.ok(listed.tools.some((t) => t.name === "prepareMethod"));
    const input = {
      methodId: "method",
      revision: 1,
      taskRef: "task",
      viewMode: "expanded",
    };
    const result = await client.callTool({
      name: "prepareMethod",
      arguments: { input },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ operation: "prepareMethod", input }]);
    const content = (
      result.content as Array<{ type: string; text?: string }>
    )[0];
    assert.equal(JSON.parse(content!.text!).result.steps.length, 2);
    const rejected = await client.callTool({
      name: "prepareMethod",
      arguments: { input: { ...input, completedStepIds: ["inspect"] } },
    });
    assert.equal(rejected.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
