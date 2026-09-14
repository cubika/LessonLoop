import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse } from "jsonc-parser";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { apiServer } from "../src/core/server.js";
const root = resolve(".local-validation");
const report = JSON.parse(
  await readFile(join(root, "results/p0-method-path.json"), "utf8"),
);
const secret = JSON.parse(
  await readFile(join(root, "data/development-secret.json"), "utf8"),
);
const folder = join(root, `host-validation-${Date.now()}`);
await mkdir(folder, { recursive: true });
const plugin = join(folder, "plugin");
await mkdir(join(plugin, "com.github.copilot/hooks"), { recursive: true });
const token = randomBytes(32).toString("hex");
const principal = {
  id: "host-validation",
  channel: "host" as const,
  scopes: [report.scope],
};
const store = new ProductStore(
  `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const settings = (await core.getSettings(principal))[0]!;
await core.configure(
  { ...principal, channel: "user" },
  {
    scopeId: report.scope,
    expectedRevision: settings.revision,
    learning: false,
    recommendation: true,
    review: false,
    notifications: false,
  },
);
const server = apiServer(core, [{ token, principal }]);
await new Promise<void>((done) => server.listen(19433, "127.0.0.1", done));
const config = join(folder, "host-config.json");
await writeFile(
  config,
  JSON.stringify({
    baseUrl: "http://127.0.0.1:19433",
    token,
    scopeId: report.scope,
    allowedRoots: [folder],
    stateRoot: join(folder, "state"),
  }),
);
await writeFile(
  join(plugin, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "lessonloop-validation",
    version: "0.0.1",
    description: "Local product method integration validation",
  }),
);
const events = ["userPromptTransformed", "postToolUse", "sessionEnd"];
await writeFile(
  join(plugin, "com.github.copilot/hooks/hooks.json"),
  JSON.stringify({
    version: 1,
    hooks: Object.fromEntries(
      events.map((e) => [
        e,
        [
          {
            type: "command",
            exec: process.execPath,
            args: [resolve("dist/adapters/copilot/hook.js"), e],
            cwd: folder,
            timeoutSec: 30,
            env: { LESSONLOOP_HOST_CONFIG: config },
          },
        ],
      ]),
    ),
  }),
);
await writeFile(
  join(folder, "fixture.txt"),
  "The pipeline copies schema.json to client.json. Generated edits are overwritten.",
);
const isolatedHome = join(folder, "copilot-home");
await mkdir(isolatedHome, { recursive: true });
const accountConfig = parse(
  await readFile(
    join(process.env.USERPROFILE!, ".copilot/config.json"),
    "utf8",
  ),
);
await writeFile(
  join(isolatedHome, "config.json"),
  JSON.stringify({
    lastLoggedInUser: accountConfig.lastLoggedInUser,
    loggedInUsers: accountConfig.loggedInUsers,
    trustedFolders: [folder],
  }),
);
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  classification: "real_copilot_product_hook",
  scope: report.scope,
};
try {
  const executable = join(
    process.env.LOCALAPPDATA!,
    "Microsoft/WinGet/Links/copilot.exe",
  );
  const call = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((done) =>
    execFile(
      executable,
      [
        "--no-auto-update",
        "--no-custom-instructions",
        "--no-remote",
        "--no-remote-export",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--available-tools=view",
        "--allow-tool=read",
        "--model=gpt-5.5",
        "--output-format=json",
        "--stream=off",
        "--plugin-dir",
        plugin,
        "--log-dir",
        join(folder, "logs"),
        "-p",
        "Read fixture.txt. Explain the first safe diagnostic for a generated client field that disappears after regeneration. If LessonLoop supplied a method or missing checks, explicitly identify them. Do not edit files.",
      ],
      {
        cwd: folder,
        env: {
          ...process.env,
          COPILOT_HOME: isolatedHome,
          COPILOT_CACHE_HOME: join(folder, "cache"),
        },
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        done({
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
        }),
    ),
  );
  result.exitCode = call.exitCode;
  const outputEvents = call.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  result.output = outputEvents.filter((e) =>
    ["assistant.message", "result", "tool.execution_complete"].includes(e.type),
  );
  result.error = call.stderr;
  const traces = [];
  for (const directory of await readdir(join(isolatedHome, "session-state"), {
    withFileTypes: true,
  })) {
    if (!directory.isDirectory()) continue;
    const lines = (
      await readFile(
        join(isolatedHome, "session-state", directory.name, "events.jsonl"),
        "utf8",
      )
    ).split("\n");
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === "hook.end")
          traces.push({
            hook: e.data.hookType,
            success: e.data.success,
            injected: JSON.stringify(e.data.output ?? {}).includes(
              "<lessonloop-method",
            ),
          });
      } catch {}
    }
  }
  result.hooks = traces;
  result.observedMethod = traces.some(
    (e) => e.hook === "userPromptTransformed" && e.success && e.injected,
  );
  result.status =
    call.exitCode === 0 && result.observedMethod
      ? "injection_observed"
      : "failed";
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await store.close();
  await writeFile(
    join(root, "results/host-product-validation.json"),
    JSON.stringify(result, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: result.status,
    exitCode: result.exitCode,
    observedMethod: result.observedMethod,
  }),
);
