import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(process.argv[2] ?? ".local-validation/data");
const secret = JSON.parse(
  readFileSync(resolve(root, "development-secret.json"), "utf8"),
);
// These files share one database. Run sequentially on every supported Node.
const files = [
  "tests/postgres.integration.ts",
  "tests/http.integration.ts",
  "tests/public-contract.integration.ts",
  "tests/connector.integration.ts",
  "tests/source-control.integration.ts",
  "tests/task-learning.integration.ts",
  "tests/reviews.integration.ts",
  "tests/method-evolution.integration.ts",
  "tests/native-method.integration.ts",
  "tests/cross-case.integration.ts",
  "tests/recall.integration.ts",
  "tests/verification.integration.ts",
  "tests/library.integration.ts",
];
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "--test", file],
    {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        LESSONLOOP_TEST_DATABASE_URL: `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
      },
    },
  );
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
