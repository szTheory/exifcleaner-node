import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Single source of truth for the tests Stryker runs (D-08). Frozen so a later
// plan cannot mutate it by accident; 67-02 expands this list. Tracer value is
// riff.test.ts only: tests/error_kinds.test.ts rewrites src/types.ts text and
// cannot pass against Stryker-instrumented sources (its control A fails the
// dry run), so 67-02 must classify it as sandbox-incompatible.
export const STRYKER_TEST_ALLOWLIST: readonly string[] = Object.freeze([
  "tests/riff.test.ts",
]);

// Explicit root: the repo root outside Stryker, the sandbox root inside it
// (the sandbox mirrors the repo layout, so two levels up is correct in both).
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  test: {
    include: [...STRYKER_TEST_ALLOWLIST],
    coverage: { enabled: false },
    // Deterministic property-test settings for reproducible mutation runs (D-10).
    env: { FC_SEED: "460046", FC_RUNS: "50" },
  },
});
