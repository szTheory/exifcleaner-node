#!/usr/bin/env node
"use strict";
// The LOCAL hard-fail gate for the phase-46 evidence ledgers.
//
// Seven tests read phase-46 evidence from a `.planning/` directory that is a
// SIBLING of this package root.  In a hosted checkout that directory cannot
// exist, so those tests are skipped there under a pinned, always-asserted
// registry (`tests/support/phase46-evidence.ts`).  In THIS workspace a skip
// would be a silent loss of coverage, which is the unfirable-gate pattern this
// phase keeps catching.  So `npm run verify` — the workflow actually used
// here — runs this check and FAILS when the directory or any required ledger
// is absent.
//
// Deliberately NOT wired into `npm test` and NOT into `.github/workflows/
// ci.yml`: the hosted `quality` job must keep running `npm test` without the
// evidence requirement.
//
// Detection is PRESENCE-BASED.  There is no environment variable, so no shell
// env syntax appears in any npm script and the check is cross-platform.
//
// This file is also the SINGLE SOURCE of the required-file list; the test
// support module requires it rather than restating it, so the two cannot drift.
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const packageRoot = dirname(__dirname);

/**
 * Measured from the call sites in `tests/release_workflow_gate.test.ts` and
 * `tests/qualification/benchmark.test.ts`, not asserted.
 */
const REQUIRED_EVIDENCE_FILES = Object.freeze([
  "46-P95-NULL-BRANCH-CLOSURE.json",
  "46-PERFORMANCE-P95-DIAGNOSTIC.json",
  "46-NODE22-MEMORY-EVIDENCE.json",
  "46-WINDOWS-PUBLICATION-EVIDENCE.json",
  "46-IDENTITY-CLEANUP-EVIDENCE.json",
  "46-HOSTED-EVIDENCE.json",
]);

// This is the ARCHIVED milestone location: the phase-46 ledgers were moved
// under `.planning/milestones/v4.8-phases/` when the v4.8 milestone closed.
// A standalone clone of this package with no sibling workspace `.planning/`
// fails this check by design (see the module header comment above).
const EVIDENCE_DIRECTORY = join(
  packageRoot,
  "..",
  ".planning",
  "milestones",
  "v4.8-phases",
  "46-webp-requalification",
);

/** Absolute paths the contract requires and that are absent. */
function missingEvidence() {
  if (!existsSync(EVIDENCE_DIRECTORY)) return [EVIDENCE_DIRECTORY];
  const missing = [];
  for (const file of REQUIRED_EVIDENCE_FILES) {
    const path = join(EVIDENCE_DIRECTORY, file);
    if (!existsSync(path)) missing.push(path);
  }
  return missing;
}

function main() {
  const missing = missingEvidence();
  if (missing.length === 0) {
    process.stdout.write(
      `phase-46 evidence present: ${REQUIRED_EVIDENCE_FILES.length} ledgers in ${EVIDENCE_DIRECTORY}\n`,
    );
    return 0;
  }
  process.stderr.write(
    "phase-46 evidence is MISSING, so the evidence-bound tests would silently skip.\n",
  );
  for (const path of missing) process.stderr.write(`  missing: ${path}\n`);
  process.stderr.write(
    "Restore the sibling .planning/milestones/v4.8-phases/46-webp-requalification ledgers before running verify.\n",
  );
  return 1;
}

module.exports = {
  EVIDENCE_DIRECTORY,
  REQUIRED_EVIDENCE_FILES,
  missingEvidence,
};

if (require.main === module) process.exit(main());
