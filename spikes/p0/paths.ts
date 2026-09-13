import path from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const p0Root = path.join(workspace, ".p0");
export function workspacePath(...parts: string[]): string {
  const target = path.resolve(workspace, ...parts);
  const relative = path.relative(workspace, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("P0 path escapes workspace");
  return target;
}
export function loopbackUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("P0 runtime endpoints must use loopback HTTP");
  }
  return url;
}
