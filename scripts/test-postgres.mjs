import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(process.argv[2] ?? ".local-validation/data");
const secret = JSON.parse(
  readFileSync(resolve(root, "development-secret.json"), "utf8"),
);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/postgres.integration.ts",
    "tests/http.integration.ts",
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      LESSONLOOP_TEST_DATABASE_URL: `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
    },
  },
);
process.exitCode = result.status ?? 1;
