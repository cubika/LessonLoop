import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
if (dirname(output) !== root)
  throw new Error("build_output_outside_repository");
// Removed modules must not survive in distributable output from an earlier build.
rmSync(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync("dist/ui", { recursive: true });
cpSync("src/ui", "dist/ui", { recursive: true });
