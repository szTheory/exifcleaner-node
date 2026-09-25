// Permanent negative control for `npm run check:evidence` (NHY-01) and the
// Policy A wiring it sits in (NHY-01/02).
//
// The gate resolves the archived phase-46 directory relative to its OWN
// location, so each case copies the script into a throwaway tree with a
// sibling `.planning/` and runs it there.  The real ledgers are never touched,
// and the suite runs in a hosted checkout where no sibling `.planning/` exists.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(packageRoot, "scripts", "check_evidence_present.cjs");

// The script is the single source of the required-ledger list; restating it
// here would let the two drift.
const { REQUIRED_EVIDENCE_FILES } = require(scriptPath) as {
  REQUIRED_EVIDENCE_FILES: readonly string[];
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Copies the gate into `<root>/pkg/scripts/` and returns its evidence dir. */
function stageGate(ledgers: readonly string[] | null) {
  // Canonical, because the gate reports paths from its own resolved __dirname
  // (macOS tmpdir() is a /var -> /private/var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-evidence-")));
  temporaryRoots.push(root);
  const script = join(root, "pkg", "scripts", "check_evidence_present.cjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(scriptPath, script);
  const evidenceDirectory = join(
    root,
    ".planning",
    "milestones",
    "v4.8-phases",
    "46-webp-requalification",
  );
  if (ledgers !== null) {
    mkdirSync(evidenceDirectory, { recursive: true });
    for (const ledger of ledgers)
      writeFileSync(join(evidenceDirectory, ledger), "");
  }
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  return { evidenceDirectory, result };
}

describe("check_evidence_present.cjs (NHY-01)", () => {
  it("passes when every required ledger is present", () => {
    const { result } = stageGate(REQUIRED_EVIDENCE_FILES);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `phase-46 evidence present: ${REQUIRED_EVIDENCE_FILES.length} ledgers`,
    );
  });

  it.each(REQUIRED_EVIDENCE_FILES)(
    "fails naming the absolute path when %s is missing",
    (absent) => {
      const { evidenceDirectory, result } = stageGate(
        REQUIRED_EVIDENCE_FILES.filter((ledger) => ledger !== absent),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `missing: ${join(evidenceDirectory, absent)}`,
      );
      expect(result.stderr).toContain(
        "Restore the sibling .planning/milestones/v4.8-phases/46-webp-requalification",
      );
    },
  );

  it("fails naming the directory when the evidence directory is absent", () => {
    const { evidenceDirectory, result } = stageGate(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing: ${evidenceDirectory}\n`);
  });
});

describe("Policy A wiring (NHY-01, NHY-02)", () => {
  it("verify builds the native addon after the evidence gate and before tests", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.verify).toContain(
      "npm run check:evidence && npm run build:native && npm test",
    );
  });

  it("ignores prebuilds/ so a local build cannot be committed", () => {
    const lines = readFileSync(join(packageRoot, ".gitignore"), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim());
    expect(lines).toContain("prebuilds/");
  });
});
