import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Single source of truth for the tests Stryker runs (D-08). Frozen so a later
// plan cannot mutate it by accident. tests/mutation_include_guard.test.ts
// classifies every other test file in a frozen EXCLUSIONS map and scans each
// entry's transitive imports for subprocess, oracle, corpus, benchmark,
// native-addon and dist references.
export const STRYKER_TEST_ALLOWLIST: readonly string[] = Object.freeze([
  "tests/engine.test.ts",
  "tests/exif_minimal.test.ts",
  "tests/icc_admission.test.ts",
  "tests/io_copy_range.test.ts",
  "tests/isobmff_admission.test.ts",
  "tests/isobmff_boxes.test.ts",
  "tests/isobmff_brand.test.ts",
  "tests/isobmff_generator.test.ts",
  "tests/isobmff_handlers.test.ts",
  "tests/isobmff_hostile.test.ts",
  "tests/isobmff_icc.test.ts",
  "tests/isobmff_iloc.test.ts",
  "tests/isobmff_ipma.test.ts",
  "tests/isobmff_items.test.ts",
  "tests/isobmff_minimal_exif.test.ts",
  "tests/isobmff_negative_controls.test.ts",
  "tests/isobmff_proof_harness.test.ts",
  "tests/isobmff_spec_lists.test.ts",
  "tests/isobmff_verify.test.ts",
  "tests/isobmff_writer.test.ts",
  "tests/isobmff_writer_doc.test.ts",
  "tests/jpeg_handler.test.ts",
  "tests/jpeg_inspection.test.ts",
  "tests/jpeg_orientation.test.ts",
  "tests/jpeg_parser.test.ts",
  "tests/jpeg_preservation.test.ts",
  "tests/jpeg_reassembly.test.ts",
  "tests/jpeg_trailer.test.ts",
  "tests/native_publication.test.ts",
  "tests/png_chunks.test.ts",
  "tests/png_classification.test.ts",
  "tests/png_handler.test.ts",
  "tests/png_inspection.test.ts",
  "tests/png_orientation.test.ts",
  "tests/png_preservation.test.ts",
  "tests/qualification/jpeg/parser.test.ts",
  "tests/qualification/jpeg/property.test.ts",
  "tests/qualification/kit/invariants.test.ts",
  "tests/qualification/png/parser.test.ts",
  "tests/qualification/png/transaction.test.ts",
  "tests/qualification/webp/parser.test.ts",
  "tests/qualification/webp/property.test.ts",
  "tests/qualification/webp/transaction.test.ts",
  "tests/riff.test.ts",
  "tests/safe_transaction.test.ts",
  "tests/stage_cleanup.test.ts",
  "tests/xmp_orientation.test.ts",
] as const);

// Explicit root: the repo root outside Stryker, the sandbox root inside it
// (the sandbox mirrors the repo layout, so two levels up is correct in both).
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  test: {
    include: [...STRYKER_TEST_ALLOWLIST],
    coverage: { enabled: false },
    // Instrumented sources run slower; the large-chunk PNG refusal test needs headroom.
    testTimeout: 30_000,
    // Deterministic property-test settings for reproducible mutation runs (D-10).
    env: { FC_SEED: "460046", FC_RUNS: "50" },
  },
});
