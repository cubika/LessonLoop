import test from "node:test";
import assert from "node:assert/strict";

// The tiny DOM fixture exercises the shipped app.js and RPC payloads; it does
// not claim browser rendering coverage. Loading by URL also works outside cwd.
test(
  "Playbook library UI preserves evidence, task identity, pagination and independent feedback across 29 workflows",
  { timeout: 15000 },
  async () => {
    const harnessUrl = new URL(
      "./fixtures/ui-library-harness.mjs",
      import.meta.url,
    );
    const { runUiLibraryChecks } = (await import(harnessUrl.href)) as {
      runUiLibraryChecks: () => Promise<string[]>;
    };
    const checks = await runUiLibraryChecks();
    assert.equal(checks.length, 29);
    assert.equal(new Set(checks).size, 29);
  },
);
