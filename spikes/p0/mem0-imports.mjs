// P0-only loader: the published Mem0 OSS bundle eagerly imports unused SQL providers.
// Refuse those providers instead of installing a second storage implementation.
// This changes module loading only; Mem0 memory/embedding/Qdrant code stays intact.
const blocked = new Set(["better-sqlite3", "pg"]);
export async function resolve(specifier, context, nextResolve) {
  if (blocked.has(specifier) && context.parentURL?.includes("/mem0ai/dist/oss/")) {
    return { url: `lessonloop-unused-provider:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith("lessonloop-unused-provider:")) {
    const name = url.slice("lessonloop-unused-provider:".length);
    const fail = `class DisabledProvider { constructor() { throw new Error(${JSON.stringify(`Unused ${name} provider is disabled in the Qdrant-only P0 probe`)}); } }`;
    const source = name === "pg"
      ? `${fail}; export default { Client: DisabledProvider, escapeIdentifier() { throw new Error("PostgreSQL is disabled"); } };`
      : `${fail}; export default DisabledProvider;`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
