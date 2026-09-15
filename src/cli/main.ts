#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ProductStore } from "../store/postgres.js";
import { HindsightEngine } from "../adapters/hindsight/engine.js";
import { CoreService } from "../core/service.js";
import { apiServer, tickConnectors, type Credential } from "../core/server.js";
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const configPath = resolve(
  process.env.LESSONLOOP_CONFIG ?? ".local-validation/data/core-config.json",
);
type Config = {
  port: number;
  databaseUrl: string;
  engineUrl: string;
  engineToken: string;
  credentials: Credential[];
};
async function main() {
  if (command === "help") {
    console.log(
      [
        "LessonLoop CLI",
        "  serve [--initialize] | status | rpc <operation> [input.json]",
        "  method list [--query text --scope id --topic text --state active|held|disabled --limit n --cursor value --pinned]",
        "  method show|history <id> | pin|unpin <id> | restore <id> <old-revision>",
        "  method prepare|revise|state|remove|export|rate <input.json>",
        "  case list [input.json] | show <id> | submit|append <material.json>",
        "    append requires material.caseFor = {kind: work_case, id, revision}.",
        "  experience list [input.json] | show <id> | verify <material.json>",
        "  experience revise <input.json> (id, expectedRevision, correctionText; holds for evidence review)",
        "  experience feedback|state|remove <input.json>",
        "  task list [input.json] | review topic <input.json> | job show|cancel|retry <id>",
        "  source list|control|cleanup | connector add|list|sync|schedule|bindings|state|forget|retry",
        "  report list|notifications|configure|dismiss|export | material submit <material.json>",
        "JSON inputs follow the corresponding RPC contract. restore sends old content for review; it does not immediately publish it.",
      ].join("\n"),
    );
    return;
  }
  let configText: string;
  if (process.env.LESSONLOOP_CONFIG_STDIN === "1") {
    configText = "";
    for await (const chunk of process.stdin) configText += chunk;
  } else configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText) as Config;
  if (command === "check") {
    const store = new ProductStore(config.databaseUrl);
    try {
      await store.open();
      await store.transaction((tx) => tx.list("settings"));
    } finally {
      await store.close();
    }
    console.log("Existing product schema is readable");
    return;
  }
  if (command === "initialize") {
    const store = new ProductStore(config.databaseUrl);
    try {
      await store.open(true);
    } finally {
      await store.close();
    }
    console.log("Product schema initialized");
    return;
  }
  if (command === "serve") {
    const store = new ProductStore(config.databaseUrl);
    await store.open(args.includes("--initialize"));
    const core = new CoreService(
      store,
      new HindsightEngine(config.engineUrl, config.engineToken),
    );
    const server = apiServer(core, config.credentials);
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", done);
    });
    console.log(`LessonLoop API listening on 127.0.0.1:${config.port}`);
    const timer = setInterval(() => {
      const scopes = [
        ...new Set(config.credentials.flatMap((c) => c.principal.scopes)),
      ];
      void core.tick(scopes).catch(() => undefined);
      void tickConnectors(core, scopes).catch(() => undefined);
    }, 1500);
    const stop = () => {
      clearInterval(timer);
      server.close(() => {
        void store.close().finally(() => process.exit(0));
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  const base = `http://127.0.0.1:${config.port}`;
  const token = config.credentials.find(
    (c) => c.principal.channel === "user",
  )?.token;
  if (!token) throw new Error("user credential missing");
  const call = async (operation: string, input: unknown) => {
    const response = await fetch(`${base}/v1/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key":
          process.env.LESSONLOOP_EVENT_ID ?? randomUUID(),
      },
      body: JSON.stringify({ operation, input }),
      signal: AbortSignal.timeout(30000),
    });
    const result = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  if (command === "status") {
    const r = await fetch(`${base}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    console.log(JSON.stringify(await r.json(), null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  let operation = args.shift();
  let input: unknown = {};
  if (command === "method") {
    if (operation === "restore") {
      const id = args.shift(),
        revision = Number(args.shift());
      if (!id || !Number.isSafeInteger(revision) || revision < 1)
        throw new Error("method restore requires an id and positive revision");
      const [history, current] = await Promise.all([
        call("methodHistory", { id }),
        call("inspectMethod", { id }),
      ]);
      const previous = (history.result as Array<Record<string, unknown>>).find(
        (v) => v.revision === revision,
      );
      if (!previous) throw new Error("Historical revision is unavailable");
      for (const reference of previous.supportRefs as Array<{
        id: string;
        revision: number;
      }>) {
        const fetched = (await call("inspect", { id: reference.id }))
          .result as { revision: number };
        if (fetched.revision !== reference.revision)
          throw new Error(
            "Historical support has changed. Open the method editor to review current evidence before resubmitting.",
          );
      }
      const body = Object.fromEntries(
        [
          "title",
          "goal",
          "topics",
          "conditions",
          "exceptions",
          "applicability",
          "steps",
          "completionChecks",
          "stopConditions",
          "supportRefs",
        ].map((key) => [key, previous[key]]),
      );
      body.change = {
        ...(previous.change as object),
        kind: "correction",
        summary: `Resubmit content from revision ${revision} for evidence review`,
      };
      console.log(
        JSON.stringify(
          await call("reviseMethod", {
            id,
            expectedRevision: (current.result as { revision: number }).revision,
            body,
          }),
          null,
          2,
        ),
      );
      return;
    }
    const action = operation;
    const map: Record<string, string> = {
      list: "browseMethods",
      show: "inspectMethod",
      history: "methodHistory",
      prepare: "prepareMethod",
      revise: "reviseMethod",
      state: "setMethodState",
      remove: "removeMethod",
      export: "exportMethod",
      pin: "pinMethod",
      unpin: "pinMethod",
      rate: "rateMethodUse",
    };
    operation = map[operation ?? ""];
    if (operation === "pinMethod")
      input = { id: args.shift(), pinned: action === "pin" };
    else if (operation === "browseMethods" && args[0]?.startsWith("--")) {
      const filters: Record<string, unknown> = {};
      while (args.length) {
        const flag = args.shift()!;
        if (flag === "--pinned") {
          filters.pinnedOnly = true;
          continue;
        }
        if (
          ![
            "--query",
            "--scope",
            "--topic",
            "--state",
            "--limit",
            "--cursor",
          ].includes(flag)
        )
          throw new Error(`Unknown filter: ${flag}`);
        const value = args.shift();
        if (!value || value.startsWith("--"))
          throw new Error(`Missing value for ${flag}`);
        if (flag === "--scope")
          filters.scopeIds = [
            ...((filters.scopeIds as string[] | undefined) ?? []),
            value,
          ];
        else if (flag === "--limit") {
          if (!Number.isSafeInteger(Number(value)) || Number(value) < 1)
            throw new Error("--limit must be a positive integer");
          filters.limit = Number(value);
        } else filters[flag.slice(2)] = value;
      }
      input = filters;
    } else if (["inspectMethod", "methodHistory"].includes(operation ?? ""))
      input = { id: args.shift() };
    else if (args[0])
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  } else if (
    [
      "source",
      "connector",
      "report",
      "case",
      "experience",
      "review",
      "job",
      "task",
    ].includes(command)
  ) {
    const action = operation;
    const maps: Record<string, Record<string, string>> = {
      case: {
        list: "browseWorkCases",
        show: "inspectWorkCase",
        submit: "submitMaterial",
        append: "submitMaterial",
      },
      experience: {
        list: "browse",
        show: "inspect",
        verify: "submitMaterial",
        revise: "feedback",
        feedback: "feedback",
        state: "setState",
        remove: "remove",
      },
      review: { topic: "reviewTopic" },
      job: { show: "getJob", cancel: "cancelJob", retry: "retryJob" },
      task: { list: "listTasks" },
      source: {
        list: "listSources",
        control: "controlSource",
        cleanup: "getSourceCleanup",
      },
      connector: {
        add: "connector.add",
        list: "connector.list",
        sync: "connector.sync",
        schedule: "connector.schedule",
        bindings: "connector.bindings",
        state: "connector.state",
        forget: "connector.forget",
        retry: "connector.retry",
      },
      report: {
        list: "reviews.list",
        notifications: "reviews.notifications",
        configure: "reviews.configure",
        export: "reviews.export",
        dismiss: "reviews.dismiss",
      },
    };
    operation = maps[command]![operation ?? ""];
    if (
      [
        "getSourceCleanup",
        "connector.sync",
        "connector.bindings",
        "connector.retry",
        "reviews.dismiss",
        "inspectWorkCase",
        "inspect",
        "getJob",
        "cancelJob",
        "retryJob",
      ].includes(operation ?? "")
    )
      input = { id: args.shift() };
    else if (args[0])
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
    if (command === "experience" && action === "revise") {
      const value = input as {
        id: string;
        expectedRevision: number;
        correctionText: string;
      };
      if (!value.correctionText?.trim())
        throw new Error("An experience correction requires correctionText");
      input = {
        target: {
          kind: "experience",
          id: value.id,
          revision: value.expectedRevision,
        },
        rating: "incorrect",
        correctionText: value.correctionText,
      };
    }
    if (
      command === "case" &&
      action === "append" &&
      !(input as { caseFor?: unknown }).caseFor
    )
      throw new Error(
        "case append requires caseFor with the current case id and revision",
      );
    if (
      command === "experience" &&
      action === "verify" &&
      !(input as { verificationFor?: unknown }).verificationFor
    )
      throw new Error(
        "experience verify requires verificationFor with the held experience id and revision",
      );
  } else if (command === "material" && operation === "submit") {
    operation = "submitMaterial";
    input = JSON.parse(await readFile(resolve(args[0] ?? ""), "utf8"));
  } else if (command === "rpc" && args[0])
    input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  else if (command !== "rpc") throw new Error("unknown command");
  if (!operation) throw new Error("operation required");
  const result = await call(operation, input);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Command failed");
  process.exitCode = 1;
});
