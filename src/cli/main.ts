#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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
      "LessonLoop development CLI: serve [--initialize], status, rpc <operation> [input.json], method list|show|history|prepare|revise|state|remove|export, source list|control|cleanup, connector add|list|sync|bindings|state|forget|retry, report list|notifications|configure|dismiss, material submit <file.json>",
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
    const map: Record<string, string> = {
      list: "browseMethods",
      show: "inspectMethod",
      history: "methodHistory",
      prepare: "prepareMethod",
      revise: "reviseMethod",
      state: "setMethodState",
      remove: "removeMethod",
      export: "exportMethod",
    };
    operation = map[operation ?? ""];
    if (["inspectMethod", "methodHistory"].includes(operation ?? ""))
      input = { id: args.shift() };
    else if (args[0])
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  } else if (["source", "connector", "report"].includes(command)) {
    const maps: Record<string, Record<string, string>> = {
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
      ].includes(operation ?? "")
    )
      input = { id: args.shift() };
    else if (args[0])
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  } else if (command === "material" && operation === "submit") {
    operation = "submitMaterial";
    input = JSON.parse(await readFile(resolve(args[0] ?? ""), "utf8"));
  } else if (command === "rpc" && args[0])
    input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  else if (command !== "rpc") throw new Error("unknown command");
  if (!operation) throw new Error("operation required");
  const response = await fetch(`${base}/v1/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": process.env.LESSONLOOP_EVENT_ID ?? crypto.randomUUID(),
    },
    body: JSON.stringify({ operation, input }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = response.ok ? 0 : 1;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Command failed");
  process.exitCode = 1;
});
