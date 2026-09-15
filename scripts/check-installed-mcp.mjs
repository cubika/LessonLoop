import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/check-installed-mcp.mjs <mcp-config.json>",
  );
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const server = config.mcpServers?.lessonloop;
assert.equal(server?.type, "stdio", "LessonLoop stdio registration missing");
assert.equal(typeof server.command, "string");
assert.ok(Array.isArray(server.args));
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: { ...process.env, ...server.env },
  stderr: "pipe",
});
const client = new Client({
  name: "lessonloop-installed-mcp-check",
  version: "1",
});
const started = Date.now();
let stderrBytes = 0;
try {
  const connecting = client.connect(transport, { timeout: 15000 });
  transport.stderr?.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  await connecting;
  // Listing tools exercises the installed launcher and bidirectional stdio
  // without a model call, product write, or credential in the report.
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name);
  for (const name of ["prepareMethod", "reassessTask", "searchMethods"])
    assert.ok(names.includes(name), `Required tool missing: ${name}`);
  console.log(
    JSON.stringify({
      status: "passed",
      elapsedMs: Date.now() - started,
      tools: names,
      stderrBytes,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.name : "McpHandshakeFailure",
      stderrBytes,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
