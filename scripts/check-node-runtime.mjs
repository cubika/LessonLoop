import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the compiled CLI and MCP tool calls on the selected Node executable.
const node = resolve(process.argv[2] ?? process.execPath);
const product = resolve(process.argv[3] ?? ".");
const requests = [];
const api = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ headers: request.headers, body: JSON.parse(body) });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ result: { status: "ok" } }));
});
await new Promise((done) => api.listen(0, "127.0.0.1", done));
const port = api.address().port;
const token = "node-runtime-test-fixture";
const environment = { ...process.env };
delete environment.LESSONLOOP_EVENT_ID;
let client;
try {
  const config = {
    port,
    credentials: [{ token, principal: { channel: "user" } }],
  };
  await new Promise((done, reject) => {
    const child = spawn(
      node,
      [resolve(product, "dist/cli/main.js"), "rpc", "searchPlaybooks"],
      {
        windowsHide: true,
        env: { ...environment, LESSONLOOP_CONFIG_STDIN: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0, error);
        assert.equal(JSON.parse(output).result.status, "ok");
        done();
      } catch (failure) {
        reject(failure);
      }
    });
    child.stdin.end(JSON.stringify(config));
  });
  const transport = new StdioClientTransport({
    command: node,
    args: [resolve(product, "dist/adapters/copilot/mcp.js")],
    env: {
      ...process.env,
      LESSONLOOP_AGENT_CONFIG_JSON: JSON.stringify({
        baseUrl: "http://127.0.0.1:" + port,
        token,
      }),
    },
    stderr: "pipe",
  });
  client = new Client({ name: "node-runtime-check", version: "1" });
  await client.connect(transport, { timeout: 15000 });
  transport.stderr?.resume();
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "searchPlaybooks"));
  const result = await client.callTool({
    name: "searchPlaybooks",
    arguments: { input: {} },
  });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).result.status, "ok");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.authorization, "Bearer " + token);
    assert.equal(request.body.operation, "searchPlaybooks");
    assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  }
  console.log(
    JSON.stringify({
      status: "passed",
      node,
      checks: [
        "cli_rpc",
        "mcp_handshake",
        "mcp_tool_call",
        "generated_request_ids",
      ],
    }),
  );
} finally {
  await client?.close();
  await new Promise((done) => api.close(done));
}
