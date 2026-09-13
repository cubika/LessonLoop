import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COPILOT_VERSION = "1.0.83";
export const COPILOT_ARCHIVE_SHA256 =
  "0e07221a275fdf7e61619c53566e3a421fd646d74d8e9ca491dbbff221f22945";

const HELP_FLAGS = [
  "--no-auto-update",
  "--log-dir",
  "--disable-builtin-mcps",
  "--output-format",
] as const;

const INHERITED_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
]);

export interface ProbePaths {
  workspace: string;
  executable: string;
  profile: string;
  cache: string;
  logs: string;
  temp: string;
  scratch: string;
  report: string;
}

export function probePaths(workspace: string): ProbePaths {
  const root = resolve(workspace);
  const host = join(root, ".p0", "host");
  return {
    workspace: root,
    executable: join(root, ".p0", "runtime", `copilot-${COPILOT_VERSION}`, "copilot.exe"),
    profile: join(host, "profile"),
    cache: join(host, "cache"),
    logs: join(host, "logs"),
    temp: join(host, "temp"),
    scratch: join(host, "scratch"),
    report: join(root, ".p0", "results", "host-preflight.json"),
  };
}

export function isolatedEnvironment(
  source: NodeJS.ProcessEnv,
  paths: ProbePaths,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const canonical = key.toUpperCase();
    if (value !== undefined && INHERITED_ENV_KEYS.has(canonical)) result[canonical] = value;
  }
  return {
    ...result,
    COPILOT_HOME: paths.profile,
    COPILOT_CACHE_HOME: paths.cache,
    APPDATA: join(paths.profile, "appdata", "roaming"),
    LOCALAPPDATA: join(paths.profile, "appdata", "local"),
    TEMP: paths.temp,
    TMP: paths.temp,
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

export interface Invocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface InvocationResult {
  exitCode: number | null;
  errorCode: string | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
}

export type Runner = (invocation: Invocation) => Promise<InvocationResult>;

const execute: Runner = (invocation) =>
  new Promise((resolveResult) => {
    const started = performance.now();
    execFile(
      invocation.executable,
      [...invocation.args],
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        resolveResult({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          errorCode: typeof error?.code === "string" ? error.code : null,
          signal: error?.signal ?? null,
          timedOut: error?.killed === true,
          durationMs: Math.round(performance.now() - started),
          stdout,
        });
      },
    );
  });

export function helpFlags(output: string): Record<(typeof HELP_FLAGS)[number], boolean> {
  return Object.fromEntries(
    HELP_FLAGS.map((flag) => [flag, new RegExp(`${flag}(?=[\\s=,<]|$)`).test(output)]),
  ) as Record<(typeof HELP_FLAGS)[number], boolean>;
}

function reportedVersion(output: string): string | null {
  return output.match(/^GitHub Copilot CLI v?(\d+\.\d+\.\d+(?:-[\w.-]*[\w-])?)\.?\s*$/m)?.[1] ?? null;
}

function commandSummary(result: InvocationResult) {
  const { stdout: _stdout, ...summary } = result;
  return summary;
}

export const OFFICIAL_FACTS = [
  {
    feature: "userPromptSubmitted",
    status: "documented_only",
    fact: "Config-file command/HTTP hook output is discarded; modifiedPrompt is SDK-only.",
    source: "https://docs.github.com/en/copilot/reference/hooks-reference#userpromptsubmitted--userpromptsubmit",
  },
  {
    feature: "userPromptTransformed",
    status: "requires_fixed_version_runtime_test",
    fact: "modifiedTransformedPrompt can replace model-facing content before persistence.",
    source: "https://docs.github.com/en/copilot/reference/hooks-reference#userprompttransformed",
  },
  {
    feature: "preToolUse",
    status: "documented_only",
    fact: "Command crashes and explicit denial block a tool; hook timeouts remain fail-open.",
    source: "https://docs.github.com/en/copilot/reference/hooks-reference#exit-codes-for-command-hooks",
  },
] as const;

export async function runHostPreflight(
  workspace: string,
  runner: Runner = execute,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const paths = probePaths(workspace);
  const env = isolatedEnvironment(sourceEnvironment, paths);
  const base = {
    schema: 1,
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    expectedVersion: COPILOT_VERSION,
    executable: paths.executable,
    officialArchive: {
      url: `https://github.com/github/copilot-cli/releases/download/v${COPILOT_VERSION}/copilot-win32-x64.zip`,
      sha256: COPILOT_ARCHIVE_SHA256,
      verification: "download_must_verify_archive_separately",
    },
    isolation: {
      profile: paths.profile,
      cache: paths.cache,
      logs: paths.logs,
      workingDirectory: paths.scratch,
      environment: "system_allowlist_only; credential variables and runtime injection options excluded",
      defaultProfileWriteMonitoring: "not_run",
    },
    modelRequestsIssued: 0,
    pluginInstallationAttempted: false,
    experienceChecks: {
      beforePlanningRecall: "not_run",
      beforeAdoptionRefresh: "not_run",
      trustedMaterialAndCorrectionReceipt: "not_run",
    },
    officialFacts: OFFICIAL_FACTS,
    limitations: [
      "Version/help checks do not validate plugin loading, hooks, model behavior, or user experience.",
      "The child receives isolated paths; default-profile file writes are not independently monitored.",
      "No login, model request, plugin installation, or global configuration change is requested.",
    ],
  };

  let binaryAvailable = false;
  try {
    binaryAvailable = (await stat(paths.executable)).isFile();
  } catch {
    // A missing or unreadable binary is a blocked preflight, not a passed host check.
  }
  if (!binaryAvailable) {
    return { ...base, status: "blocked" as const, reason: "binary_missing_or_unreadable", commands: [] };
  }

  for (const path of [paths.profile, paths.cache, paths.logs, paths.temp, paths.scratch, env.APPDATA, env.LOCALAPPDATA]) {
    if (path !== undefined) await mkdir(path, { recursive: true });
  }
  const commonArgs = ["--no-auto-update", `--log-dir=${paths.logs}`];
  const invoke = (flag: "--version" | "--help") =>
    runner({
      executable: paths.executable,
      args: [...commonArgs, flag],
      cwd: paths.scratch,
      env,
      timeoutMs: 15_000,
    });
  const version = await invoke("--version");
  const help = await invoke("--help");
  const detectedVersion = reportedVersion(version.stdout);
  const supportedFlags = helpFlags(help.stdout);
  const commandsSucceeded = version.exitCode === 0 && help.exitCode === 0;
  const versionMatches = detectedVersion === COPILOT_VERSION;
  const requiredFlagsFound = Object.values(supportedFlags).every(Boolean);
  const passed = commandsSucceeded && versionMatches && requiredFlagsFound;
  return {
    ...base,
    status: passed ? ("passed" as const) : ("failed" as const),
    reason: !commandsSucceeded
      ? "command_failed"
      : !versionMatches
        ? "version_mismatch"
        : !requiredFlagsFound
          ? "required_help_flags_missing"
          : "version_and_help_only",
    detectedVersion,
    supportedFlags,
    commands: [
      { name: "version", ...commandSummary(version) },
      { name: "help", ...commandSummary(help) },
    ],
  };
}

export async function saveHostPreflight(workspace: string) {
  const report = await runHostPreflight(workspace);
  const path = probePaths(workspace).report;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path };
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const { report, path } = await saveHostPreflight(workspace);
    console.log(JSON.stringify({ status: report.status, reason: report.reason, report: path }));
    process.exitCode = report.status === "passed" ? 0 : 2;
  } catch {
    console.error("Host preflight could not finish or save its report. No model request was issued.");
    process.exitCode = 1;
  }
}
