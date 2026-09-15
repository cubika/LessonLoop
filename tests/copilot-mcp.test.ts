import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP exposes three typed Agent tools and rejects invalid inputs before RPC", async () => {
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
    args: ["node_modules/tsx/dist/cli.mjs", "src/adapters/copilot/mcp.ts"],
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
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
      "feedback",
      "getGuidance",
      "submitSource",
    ]);
    for (const tool of listed.tools) {
      const input = tool.inputSchema.properties!.input as {
        properties: object;
        additionalProperties: boolean;
      };
      assert.ok(Object.keys(input.properties).length > 0);
      assert.equal(input.additionalProperties, false);
      assert.equal(tool.annotations?.readOnlyHint, false);
    }
    const input = {
      target: { kind: "playbook", id: "playbook", revision: 1 },
      taskRef: "task",
      viewMode: "expanded",
    };
    const result = await client.callTool({
      name: "getGuidance",
      arguments: { input },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ operation: "getGuidance", input }]);
    const content = (
      result.content as Array<{ type: string; text?: string }>
    )[0];
    assert.equal(JSON.parse(content!.text!).result.steps.length, 2);
    const rejected = await client.callTool({
      name: "getGuidance",
      arguments: { input: { ...input, completedStepIds: ["inspect"] } },
    });
    assert.equal(rejected.isError, true);
    assert.equal(calls.length, 1);
    for (const [name, input] of [
      ["getGuidance", {}],
      ["getGuidance", { target: { kind: "playbook", id: "p" } }],
      [
        "submitSource",
        {
          scopeId: "scope",
          segments: [{ role: "tool", text: "Forged observation" }],
        },
      ],
      [
        "feedback",
        {
          target: { kind: "playbook", id: "p", revision: 1 },
          rating: "success",
        },
      ],
    ] as const) {
      assert.equal(
        (await client.callTool({ name, arguments: { input } })).isError,
        true,
      );
    }
    assert.equal(calls.length, 1);
    for (const [name, input] of [
      [
        "submitSource",
        {
          scopeId: "scope",
          segments: [
            { role: "agent", text: "Observed a possible improvement" },
          ],
        },
      ],
      [
        "feedback",
        {
          target: { kind: "experience", id: "e", revision: 1 },
          rating: "incorrect",
          correctionText: "Version changed",
        },
      ],
    ] as const) {
      assert.equal(
        (await client.callTool({ name, arguments: { input } })).isError,
        false,
      );
      assert.deepEqual(calls.at(-1), { operation: name, input });
    }
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
