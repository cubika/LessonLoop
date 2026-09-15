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
        "  playbook list [--query text --scope id --topic text --state active|held|disabled --limit n --cursor value --pinned]",
        "  playbook show|work|usage <id> | pin|unpin <id>",
        "  playbook prepare|revise|state|remove|export|rate <input.json>",
        "  experience list [input.json] | show|work <id> | verify <source.json>",
        "  experience revise <input.json> (id, expectedRevision, correctionText; holds for evidence review)",
        "  experience feedback|state|remove <input.json>",
        "  task list [input.json] | review topic <input.json> | job show|cancel|retry <id>",
        "  source list | show|work <id> | submit|append|control <input.json> | cleanup <id>",
        "    append requires sourceFor = {id, revision} from a Source reference.",
        "  connector add|list|sync|schedule|bindings|state|forget|retry",
        "  report list|notifications|configure|dismiss|export",
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
        "Idempotency-Key": process.env.LESSONLOOP_EVENT_ID ?? randomUUID(),
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
  if (command === "playbook") {
    const action = operation;
    const map: Record<string, string> = {
      list: "browsePlaybooks",
      show: "inspectPlaybook",
      work: "getWorkView",
      usage: "getUsageView",
      prepare: "preparePlaybook",
      revise: "revisePlaybook",
      state: "setPlaybookState",
      remove: "removePlaybook",
      export: "exportPlaybook",
      pin: "pinPlaybook",
      unpin: "pinPlaybook",
      rate: "ratePlaybookUse",
    };
    operation = map[operation ?? ""];
    if (operation === "getWorkView")
      input = { kind: "playbook", id: args.shift() };
    else if (operation === "getUsageView") input = { playbookId: args.shift() };
    else if (operation === "pinPlaybook")
      input = { id: args.shift(), pinned: action === "pin" };
    else if (operation === "browsePlaybooks" && args[0]?.startsWith("--")) {
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
    } else if (["inspectPlaybook", "playbookHistory"].includes(operation ?? ""))
      input = { id: args.shift() };
    else if (args[0])
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  } else if (
    [
      "source",
      "connector",
      "report",
      "experience",
      "review",
      "job",
      "task",
    ].includes(command)
  ) {
    const action = operation;
    const maps: Record<string, Record<string, string>> = {
      experience: {
        work: "getWorkView",
        list: "browseExperiences",
        show: "inspectExperience",
        verify: "submitSource",
        revise: "feedback",
        feedback: "feedback",
        state: "setExperienceState",
        remove: "removeExperience",
      },
      review: { topic: "reviewTopic" },
      job: { show: "getJob", cancel: "cancelJob", retry: "retryJob" },
      task: { list: "listTasks" },
      source: {
        submit: "submitSource",
        append: "submitSource",
        show: "inspectSource",
        work: "getWorkView",
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
        "inspectSource",
        "inspectExperience",
        "getJob",
        "cancelJob",
        "retryJob",
      ].includes(operation ?? "")
    )
      input = { id: args.shift() };
    else if (operation === "getWorkView")
      input = { kind: command, id: args.shift() };
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
      command === "source" &&
      action === "append" &&
      !(input as { sourceFor?: unknown }).sourceFor
    )
      throw new Error(
        "source append requires sourceFor with the current source id and revision",
      );
    if (
      command === "experience" &&
      action === "verify" &&
      !(input as { verificationFor?: unknown }).verificationFor
    )
      throw new Error(
        "experience verify requires verificationFor with the held experience id and revision",
      );
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
