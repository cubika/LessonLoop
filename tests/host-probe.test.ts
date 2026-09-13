import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  helpFlags,
  isolatedEnvironment,
  probePaths,
  runHostPreflight,
  type Invocation,
  type Runner,
} from "../spikes/p0/host-probe.js";

test("child environment excludes credentials and executable injection settings", () => {
  const paths = probePaths("probe-workspace");
  const source = {
    Path: "safe-tool-path",
    SYSTEMROOT: "C:\\Windows",
    GH_TOKEN: "not-for-child",
    GITHUB_TOKEN: "not-for-child",
    COPILOT_GITHUB_TOKEN: "not-for-child",
    COPILOT_API_KEY: "not-for-child",
    OPENAI_API_KEY: "not-for-child",
    NODE_OPTIONS: "--require unwanted.js",
    COPILOT_HOME: "default-profile",
    COPILOT_CACHE_HOME: "default-cache",
    APPDATA: "default-appdata",
  };
  const env = isolatedEnvironment(source, paths);
  assert.equal(env.PATH, "safe-tool-path");
  assert.equal(env.COPILOT_HOME, paths.profile);
  assert.equal(env.COPILOT_CACHE_HOME, paths.cache);
  assert.equal(env.APPDATA, join(paths.profile, "appdata", "roaming"));
  assert.equal(JSON.stringify(env).includes("not-for-child"), false);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(source.COPILOT_HOME, "default-profile");
});

test("help detection requires full flags, not similar prefixes", () => {
  const flags = helpFlags("--no-auto-update-extra --log-directory --disable-builtin-mcps --output-format=FORMAT");
  assert.equal(flags["--no-auto-update"], false);
  assert.equal(flags["--log-dir"], false);
  assert.equal(flags["--disable-builtin-mcps"], true);
  assert.equal(flags["--output-format"], true);
});

test("missing runtime blocks preflight without invoking a process", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lessonloop-host-missing-"));
  try {
    const report = await runHostPreflight(workspace, async () => {
      throw new Error("must not run");
    });
    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "binary_missing_or_unreadable");
    assert.deepEqual(report.commands, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preflight only invokes version/help and leaves experience checks untested", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lessonloop-host-preflight-"));
  try {
    const paths = probePaths(workspace);
    await mkdir(dirname(paths.executable), { recursive: true });
    await writeFile(paths.executable, "test placeholder; runner is injected");
    const invocations: Invocation[] = [];
    let versionOutput = "GitHub Copilot CLI 1.0.83.\nRun 'copilot update' to check for updates.\n";
    const runner: Runner = async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        errorCode: null,
        signal: null,
        timedOut: false,
        durationMs: 1,
        stdout: invocation.args.includes("--version")
          ? versionOutput
          : "--no-auto-update --log-dir=DIRECTORY --disable-builtin-mcps --output-format=FORMAT",
      };
    };
    const report = await runHostPreflight(workspace, runner, { GH_TOKEN: "secret" });
    assert.equal(report.status, "passed");
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations.map((call) => call.args.at(-1)), ["--version", "--help"]);
    for (const call of invocations) {
      assert.equal(call.cwd, paths.scratch);
      assert.equal(call.env.COPILOT_HOME, paths.profile);
      assert.equal(call.env.GH_TOKEN, undefined);
      assert.equal(call.args.includes("--no-auto-update"), true);
      assert.equal(call.args.some((arg) => /prompt|plugin|login/.test(arg)), false);
    }
    assert.equal(report.modelRequestsIssued, 0);
    assert.equal(report.pluginInstallationAttempted, false);
    assert.deepEqual(Object.values(report.experienceChecks), ["not_run", "not_run", "not_run"]);
    assert.equal(JSON.stringify(report).includes("stdout"), false);
    assert.equal(JSON.stringify(report).includes("secret"), false);
    versionOutput = "GitHub Copilot CLI 1.0.82.\n";
    const stale = await runHostPreflight(workspace, runner, {});
    assert.equal(stale.status, "failed");
    assert.equal(stale.reason, "version_mismatch");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
