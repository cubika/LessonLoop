import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Older Node test runners do not expand file globs on Windows.
const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => "tests/" + name);
const result = spawnSync(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "--test", ...files],
  { stdio: "inherit", windowsHide: true },
);
process.exitCode = result.status ?? 1;
