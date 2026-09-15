import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService, type Principal } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/playbook-engine.js";
import { apiServer, dispatch } from "../src/core/server.js";
import {
  identity,
  digest,
  playbookSchema,
  type ObjectRef,
} from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
import { handleHook } from "../src/adapters/copilot/hook.js";
import { Effects } from "../src/core/effects.js";

const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("test database required");
const row = (kind: string, value: any) => ({
  kind,
  id: value.id,
  scopeId: value.scopeId,
  revision: value.revision,
  value,
});
class Engine extends HindsightEngine {
  calls: Array<{ scope: string; kind: string }> = [];
  beforeRecall?: (() => Promise<void>) | undefined;
  fail = false;
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async searchPublished(
    scope: string,
    _query: string,
    refs: ObjectRef[],
    kind = "playbook",
  ) {
    this.calls.push({ scope, kind });
    if (this.fail) throw new Error("retrieval_failed");
    if (kind === "experience") await this.beforeRecall?.();
    return refs.map((ref) => ({
      id: ref.id,
      text: "fixture",
      type: "world",
      metadata: { product_id: ref.id },
    })) as any;
  }
}
async function fixture() {
  const store = new ProductStore(url!);
  await store.open(true);
  const scopeId = randomUUID();
  const user: Principal = {
    id: randomUUID(),
    channel: "user",
    scopes: [scopeId],
  };
  const agent: Principal = {
    id: randomUUID(),
    channel: "agent",
    scopes: [scopeId],
  };
  const engine = new Engine(),
    core = new CoreService(store, engine);
  await core.configure(user, {
    scopeId,
    expectedRevision: 0,
    learning: true,
    recommendation: false,
    review: true,
    notifications: false,
  });
  const call = (
    input: unknown,
    p = agent,
    key: string = randomUUID(),
  ): Promise<any> => dispatch(core, p, "getGuidance", input, key);
  const put = (kind: string, value: any) =>
    store.transaction((tx) => tx.put(row(kind, value), null));
  const update = (kind: string, value: any, fields: Record<string, unknown>) =>
    store.transaction((tx) =>
      tx.put(
        row(kind, { ...value, ...fields, revision: value.revision + 1 }),
        value.revision,
      ),
    );
  async function seed(large = false) {
    const fp = digest(randomUUID());
    const e = experienceSchema.parse({
      ...identity(scopeId),
      conclusion: "Generated changes need a source edit",
      level: "L1",
      purpose: "fact",
      applicability: "conditional",
      conditions: [{ text: "The file is generated" }],
      exceptions: [],
      topics: ["generation"],
      entities: ["generated"],
      basis: "observed",
      assessment: "supported",
      evidence: [
        {
          excerpt: "Regeneration removed the direct edit",
          role: "tool",
          relation: "supports",
          fingerprint: fp,
        },
      ],
      derivedFrom: [],
      sourceFingerprints: [fp],
      state: "active",
    });
    const m = playbookSchema.parse({
      ...identity(scopeId),
      title: "Repair generated client",
      goal: "Preserve changes after generation",
      topics: ["generation"],
      applicability: "general",
      conditions: [],
      exceptions: [],
      state: "active",
      steps: large
        ? Array.from({ length: 12 }, (_, i) => ({
            stepId: "s" + i,
            instruction: "Check source output. ".repeat(45),
            supportIndexes: [0],
          }))
        : [
            {
              stepId: "inspect",
              instruction: "Inspect the file",
              supportIndexes: [0],
              choices: [
                { when: { text: "The file is generated" }, next: "source" },
                { when: { text: "It is maintained manually" }, next: "stop" },
              ],
            },
            {
              stepId: "source",
              instruction: "Edit the source and regenerate",
              supportIndexes: [0],
            },
          ],
      completionChecks: [{ text: "Changes survive generation" }],
      stopConditions: [],
      supportRefs: [{ kind: "experience", id: e.id, revision: 1 }],
      change: {
        kind: "create",
        summary: "Fixture",
        predecessors: [],
      },
    });
    await put("source", { id: fp, revision: 1, scopeId, blocked: false });
    for (const [kind, item] of [
      ["experience", e],
      ["playbook", m],
    ] as const) {
      await put(kind, item);
      await put("projection", {
        id: item.id,
        revision: 1,
        scopeId,
        objectKind: kind,
        objectRevision: 1,
        confirmed: true,
      });
    }
    await core.syncProjections([scopeId]);
    return { e, m };
  }
  return { store, scopeId, user, agent, engine, core, call, put, update, seed };
}

test("Guidance creates retryable tasks and enforces ownership, scope and lifetime without a hook", async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    await assert.rejects(
      f.call({ query: "generated" }, f.agent, ""),
      /idempotency_key_required/,
    );
    f.engine.fail = true;
    await assert.rejects(
      f.call({ query: "generated" }, f.agent, key),
      /retrieval_failed/,
    );
    f.engine.fail = false;
    const first = await f.call({ query: "generated" }, f.agent, key);
    assert.deepEqual(first.playbooks, []);
    assert.deepEqual(first.experiences, []);
    assert.equal(first.scopeId, f.scopeId);
    assert.equal(
      (await f.call({ query: "different query" }, f.agent, key)).taskRef,
      first.taskRef,
    );
    const tasks = await f.store.transaction((tx) =>
      tx.list<any>("task", [f.scopeId]),
    );
    assert.equal(tasks.length, 1);
    assert.notEqual(
      (await f.call({ query: "generated" })).taskRef,
      first.taskRef,
    );
    const input = { query: "generated", taskRef: first.taskRef };
    await assert.rejects(
      f.call(input, { ...f.agent, id: "other" }),
      /task_unavailable/,
    );
    await assert.rejects(
      f.call(input, { ...f.agent, scopes: [] }),
      /not_found/,
    );
    const scoped = { ...f.agent, scopes: [f.scopeId, "another-scope"] };
    await assert.rejects(
      f.call({ query: "generated" }, scoped),
      /scope_required/,
    );
    await assert.rejects(
      f.call({ ...input, scopeId: "another-scope" }, scoped),
      /not_found/,
    );
    f.engine.calls = [];
    await f.call(input, scoped);
    assert.ok(f.engine.calls.every((call) => call.scope === f.scopeId));
    const host: Principal = { ...f.agent, id: "host", channel: "host" };
    const hosted = await f.core.startTask(host, f.scopeId);
    assert.equal(
      (
        await f.call(
          { ...input, ...hosted },
          { ...f.agent, taskOwnerId: host.id },
        )
      ).taskRef,
      hosted.taskRef,
    );
    await assert.rejects(
      f.call({ ...input, ...hosted }, f.agent),
      /task_unavailable/,
    );
    await f.update("task", tasks[0], { ended: true });
    await assert.rejects(f.call(input), /task_unavailable/);
    const expired = await f.core.startTask(f.agent, f.scopeId);
    const task = await f.store.transaction((tx) =>
      tx.get<any>("task", expired.taskRef),
    );
    await f.update("task", task, { createdAt: "2020-01-01T00:00:00.000Z" });
    await assert.rejects(f.call({ ...input, ...expired }), /task_unavailable/);
  } finally {
    await f.store.close();
  }
});

test("Guidance combines eligible content, preserves leads and rechecks targets after retrieval", async () => {
  const f = await fixture();
  try {
    const { m, e } = await f.seed();
    const key = randomUUID();
    const result = await f.call({ query: "generated" }, f.agent, key);
    assert.equal(result.playbooks[0].steps.length, 2);
    assert.equal(result.playbooks[0].steps[0].choices.length, 2);
    assert.equal(result.playbooks[0].playbook.kind, "playbook");
    assert.equal(result.experiences[0].usage, "lead");
    assert.equal(result.experiences[0].missingChecks.length, 1);
    const uses = () =>
      f.store.transaction((tx) => tx.list<any>("task_feedback", [f.scopeId]));
    const replay = await f.call({ query: "generated" }, f.agent, key);
    assert.equal(replay.taskRef, result.taskRef);
    assert.equal(
      replay.playbooks[0].feedbackRevision,
      result.playbooks[0].feedbackRevision,
    );
    assert.equal((await uses()).length, 1);
    const target = { kind: "experience", id: e.id, revision: 1 };
    const expanded = await f.call({
      taskRef: result.taskRef,
      target,
      viewMode: "expanded",
      context: { generated: "true" },
    });
    assert.deepEqual(expanded.experiences[0].evidence, e.evidence);
    assert.equal(expanded.experiences[0].usage, "lead");
    assert.equal(
      (
        await f.call({
          taskRef: result.taskRef,
          target: { ...target, revision: 2 },
        })
      ).reason,
      "target_changed",
    );
    f.engine.beforeRecall = async () => {
      await f.update("playbook", m, { state: "disabled" });
      f.engine.beforeRecall = undefined;
    };
    const withdrawn = await f.call({
      query: "generated",
      taskRef: result.taskRef,
    });
    assert.deepEqual(withdrawn.playbooks, []);
    assert.equal(withdrawn.experiences.length, 1);
    const direct = await f.call({
      taskRef: result.taskRef,
      target: { kind: "playbook", id: m.id, revision: 1 },
    });
    assert.equal(direct.playbooks[0].status, "target_changed");
    assert.equal(direct.playbooks[0].steps, undefined);
    await f.update("experience", e, { state: "disabled" });
    assert.deepEqual(
      (await f.call({ query: "generated" }, f.agent, key)).experiences,
      [],
    );
  } finally {
    await f.store.close();
  }
});

test("Three MCP tools run through real HTTP and storage, including expansion delivery confirmed by the host", async (t) => {
  const f = await fixture();
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lessonloop-delivery-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "events.jsonl");
  await writeFile(
    transcriptPath,
    JSON.stringify({
      type: "session.start",
      data: { sessionId: "delivery", context: { cwd: root } },
    }) + "\n",
  );
  const host: Principal = {
    id: randomUUID(),
    channel: "host",
    scopes: [f.scopeId],
  };
  f.agent.taskOwnerId = host.id;
  const token = randomUUID();
  const hostToken = randomUUID();
  const server = apiServer(f.core, [
    { token, principal: f.agent },
    { token: hostToken, principal: host },
  ]);
  const client = new Client({ name: "three-tools-integration", version: "1" });
  try {
    const { m } = await f.seed(true);
    const readSources = () =>
      f.store.transaction((tx) => tx.list("source", [f.scopeId]));
    const sourcesBefore = await readSources();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = "http://127.0.0.1:" + address.port;
    const hook = () =>
      handleHook(
        {
          baseUrl,
          token: hostToken,
          scopeId: f.scopeId,
          allowedRoots: [root],
          stateRoot: join(root, "state"),
        },
        { sessionId: "delivery", cwd: root, transcriptPath },
        "agentStop",
      );
    await hook();
    const task = (await f.core.listTasks(f.user))[0]!;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/adapters/copilot/mcp.ts"],
        env: {
          ...process.env,
          LESSONLOOP_AGENT_CONFIG_JSON: JSON.stringify({
            baseUrl: "http://127.0.0.1:" + address.port,
            token,
          }),
        },
        stderr: "pipe",
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      ["feedback", "getGuidance", "submitSource"],
    );
    let guidanceContent = "";
    const call = async (name: string, input: unknown) => {
      const reply = await client.callTool({ name, arguments: { input } });
      assert.equal(reply.isError, false, JSON.stringify(reply.content));
      const content = (reply.content as Array<{ text: string }>)[0]!.text;
      if (name === "getGuidance") guidanceContent = content;
      return JSON.parse(content).result;
    };
    const first = await call("getGuidance", {
      taskRef: task.taskRef,
      query: "generated",
    });
    assert.equal(first.playbooks[0].status, "requires_expansion");
    assert.equal(first.playbooks[0].feedbackRevision, undefined);
    assert.equal(
      (
        await f.store.transaction((tx) =>
          tx.list<any>("task_feedback", [f.scopeId]),
        )
      ).flatMap((t) => t.feedback).length,
      0,
    );
    const target = first.playbooks[0].playbook;
    const expanded = await call("getGuidance", {
      taskRef: first.taskRef,
      target,
      viewMode: "expanded",
    });
    assert.equal(expanded.taskRef, first.taskRef);
    assert.equal(expanded.playbooks[0].status, "guidance");
    assert.equal(expanded.playbooks[0].steps.length, m.steps.length);
    const effects = new Effects(f.store);
    const readFeedback = async () => (await effects.cases([f.scopeId]))[0]!;
    assert.equal((await readFeedback()).feedback[0]!.delivered, null);
    await appendFile(
      transcriptPath,
      [
        {
          id: "start",
          type: "tool.execution_start",
          data: { toolCallId: "expand", toolName: "lessonloop-getGuidance" },
        },
        {
          id: "complete",
          type: "tool.execution_complete",
          data: {
            toolCallId: "expand",
            success: true,
            result: { content: guidanceContent },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    await hook();
    const delivered = await readFeedback();
    assert.equal(delivered.feedback[0]!.delivered, true);
    assert.equal(
      delivered.revision,
      expanded.playbooks[0].feedbackRevision + 1,
    );
    assert.equal((await effects.summary([f.scopeId])).delivered, 1);
    assert.deepEqual(await readSources(), sourcesBefore);
    await hook();
    assert.deepEqual(await readFeedback(), delivered);
    const receipt = await call("submitSource", {
      scopeId: first.scopeId,
      segments: [
        {
          role: "agent",
          text: "The source edit may preserve generation output",
        },
      ],
    });
    assert.equal(receipt.accepted, true);
    assert.equal(
      (await f.core.getJob(f.agent, receipt.jobId)).status,
      "queued",
    );
    assert.equal(
      (await call("feedback", { target, rating: "helpful" })).accepted,
      true,
    );
    assert.equal(
      (await f.store.transaction((tx) => tx.list("feedback", [f.scopeId])))
        .length,
      1,
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.store.close();
  }
});
