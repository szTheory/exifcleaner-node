// Phase 46 evidence resolution, availability, and the evidence-gated registry.
//
// WHY THIS MODULE EXISTS
// ---------------------
// Seven tests in this suite read phase-46 evidence ledgers from a `.planning/`
// directory that is a SIBLING of the package root.  That directory exists only
// in the multi-repository development workspace.  A hosted checkout is
// `.../work/exifcleaner-node/exifcleaner-node`, whose parent holds no
// `.planning/`, so those seven tests cannot run there and failed run
// 35116391808's `quality` job with ENOENT.  The planning repository has no
// remote to check out and the largest ledger is roughly fourteen megabytes, so
// neither checking it out nor committing it into this repository is available.
//
// Excluding tests from CI is one edit away from the unfirable-gate pattern this
// phase has already found four times.  The exclusion is therefore EXPLICIT and
// ASSERTED: every gated test registers its own title AT COLLECTION TIME — so
// the registry is populated even where the tests are skipped — and each
// affected file carries an ALWAYS-RUNNING test comparing that registry against
// a pinned literal list.  Gating an eighth test, or ungating a listed one,
// fails the suite until the pinned list is deliberately updated.
//
// Vitest isolates test files in separate workers, so this module is
// instantiated once PER TEST FILE and the registry below is consequently
// PER FILE.  Each affected file pins its own list.
//
// Locally the exclusion must never fire silently: `npm run check:evidence`
// (wired into `npm run verify`, and deliberately NOT into `npm test` or
// `.github/workflows/ci.yml`) hard-fails when the directory or any required
// ledger is absent.
import { createRequire } from "node:module";
import { it } from "vitest";

const require = createRequire(import.meta.url);

// `scripts/check_evidence_present.cjs` is the SINGLE SOURCE of the required
// ledger list, the resolved directory, and the presence predicate.  It is
// required here rather than restated so the `npm run verify` hard-fail gate and
// this suite's availability predicate cannot drift apart.
const evidenceCheck = require("../../scripts/check_evidence_present.cjs") as {
  EVIDENCE_DIRECTORY: string;
  REQUIRED_EVIDENCE_FILES: readonly string[];
  missingEvidence(): string[];
};

/**
 * Every phase-46 ledger file the test suite reads from the sibling planning
 * directory.  Measured from the call sites, not asserted:
 *   `tests/release_workflow_gate.test.ts` reads
 *   `46-P95-NULL-BRANCH-CLOSURE.json` and `46-PERFORMANCE-P95-DIAGNOSTIC.json`;
 *   `tests/qualification/webp/benchmark.test.ts` reads the other four plus
 *   `46-PERFORMANCE-P95-DIAGNOSTIC.json` again.
 */
export const PHASE_46_EVIDENCE_FILES = evidenceCheck.REQUIRED_EVIDENCE_FILES;

/** The single resolution point for the sibling phase-46 evidence directory. */
export const phase46EvidenceDirectory = evidenceCheck.EVIDENCE_DIRECTORY;

/**
 * Absolute paths that the evidence contract requires and that are absent.
 * Empty means the evidence is fully available.  Presence-based, so no
 * environment variable and no shell env syntax in any npm script.
 */
export function missingPhase46Evidence(): string[] {
  return evidenceCheck.missingEvidence();
}

/** True only when the directory AND every required ledger file are present. */
export const phase46EvidenceAvailable = missingPhase46Evidence().length === 0;

type EvidenceGatedTestFn = () => void | Promise<unknown>;

const registeredEvidenceGatedTitles: string[] = [];

/**
 * The per-file registry of evidence-gated test titles, populated at collection
 * time.  Read by the always-running pinned-registry assertion in each affected
 * file.
 */
export function evidenceGatedTestTitles(): readonly string[] {
  return [...registeredEvidenceGatedTitles];
}

/**
 * Register a test title in the per-file registry and declare the test, gated on
 * evidence availability.  Where the evidence IS available the test RUNS and
 * hard-fails on a missing file; it never silently skips there.
 */
export function evidenceGatedIt(
  title: string,
  fn: EvidenceGatedTestFn,
  timeout?: number,
): void {
  registeredEvidenceGatedTitles.push(title);
  const declare = phase46EvidenceAvailable ? it : it.skip;
  if (timeout === undefined) {
    declare(title, fn);
    return;
  }
  declare(title, fn, timeout);
}
