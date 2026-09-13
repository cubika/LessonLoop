import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { workspacePath } from "./paths.js";

export async function startQdrant(runId: string): Promise<{ url: string; directory: string; stop(): Promise<void> }> {
  if (!/^[a-z0-9_]+$/.test(runId)) throw new Error("Unsafe run ID");
  const directory = workspacePath(".p0", "runs", runId);
  await mkdir(directory, { recursive: true });
  const tempDirectory = path.join(directory, "temp");
  await mkdir(tempDirectory, { recursive: true });
  const port = 16433;
  try { await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) }); throw new Error("P0 Qdrant port already in use; refusing to attach to unknown data"); }
  catch (error) { if (error instanceof Error && error.message.startsWith("P0 Qdrant")) throw error; }
  const config = {
    log_level: "WARN", telemetry_disabled: true,
    storage: { storage_path: path.join(directory, "storage").split(path.sep).join("/"), snapshots_path: path.join(directory, "snapshots").split(path.sep).join("/") },
    service: { host: "127.0.0.1", http_port: port, grpc_port: port + 1, enable_cors: false },
    cluster: { enabled: false },
  };
  const configPath = path.join(directory, "config.yaml");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const log = createWriteStream(path.join(directory, "qdrant.log"));
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "NUMBER_OF_PROCESSORS"]) {
    const value = process.env[key]; if (value) childEnv[key] = value;
  }
  const processHandle = spawn(workspacePath(".p0", "runtime", "qdrant-1.19.1", "qdrant.exe"), ["--config-path", configPath], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...childEnv, TEMP: tempDirectory, TMP: tempDirectory, QDRANT__TELEMETRY_DISABLED: "true", QDRANT__SERVICE__HOST: "127.0.0.1", QDRANT__SERVICE__HTTP_PORT: String(port), QDRANT__SERVICE__GRPC_PORT: String(port + 1), QDRANT__STORAGE__STORAGE_PATH: config.storage.storage_path, QDRANT__STORAGE__SNAPSHOTS_PATH: config.storage.snapshots_path },
  });
  processHandle.stdout.pipe(log, { end: false });
  processHandle.stderr.pipe(log, { end: false });
  let spawnError: Error | undefined;
  processHandle.on("error", error => { spawnError = error; });
  const stop = async () => {
    if (processHandle.exitCode === null && processHandle.pid) {
      const stopped = new Promise<void>(resolve => processHandle.once("exit", () => resolve()));
      processHandle.kill();
      await Promise.race([stopped, delay(5000)]);
    }
    log.end();
  };
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError || processHandle.exitCode !== null) { await stop(); throw spawnError ?? new Error(`Qdrant exited ${processHandle.exitCode}; inspect ${directory}`); }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { url: `http://127.0.0.1:${port}`, directory, stop };
    } catch { /* wait for the owned process */ }
    await delay(100);
  }
  await stop();
  throw new Error("Qdrant startup timed out");
}
