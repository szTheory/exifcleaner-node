import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Files intentionally kept flat under `tests/qualification/`. The D-15 kit/webp
 * layout move is complete as of Phase 55 Plan 02; this list stays a closed,
 * explicit allowlist so a future stray flat file fails the gate by name
 * instead of silently widening the allowlist. Every entry is a
 * project-root-relative path.
 *
 * `tests/qualification/formats.ts` (Plan 08): the per-format qualification
 * registry, keyed by `NativeFormat`, so a new format fails typecheck until
 * its differential profile, generator and sample all exist. It is not a
 * `.test.ts` file and stays at this level rather than inside `kit/` because
 * it names both `kit/` and `webp/` modules -- it is the seam between them.
 */
export const PENDING_FLAT_FILES: readonly string[] = Object.freeze([
  "tests/qualification/formats.ts",
]);

export interface QualificationListProblemsInput {
  readonly kitList: readonly string[];
  readonly perFormatLists: Readonly<Record<string, readonly string[]>>;
  readonly ciListExists: ReadonlySet<string>;
  readonly qualifyList: readonly string[];
  readonly onDiskTestFiles: readonly string[];
  readonly pendingFlatFiles: readonly string[];
}

function isBenchmarkPath(path: string): boolean {
  const basename = path.split("/").pop();
  return basename !== undefined && basename.includes("benchmark");
}

/**
 * Pure helper (D-16, widened 56-12 D-17): takes the ci.yml qualification-linux
 * job's `QUAL_KIT` list and its per-format `QUAL_<FORMAT>` lists, the
 * qualify.cjs full-run list, the on-disk kit/webp/png `.test.ts` set, and the
 * pending-flat allowlist as data, and returns a list of problem strings.
 * Empty means every source agrees, AND every per-format list's files live
 * under that format's own `tests/qualification/<format>/` directory (D-17:
 * a stray cross-format entry would silently widen or narrow a format's own
 * CI selection).
 */
export function qualificationListProblems(
  input: QualificationListProblemsInput,
): string[] {
  const {
    kitList,
    perFormatLists,
    ciListExists,
    qualifyList,
    onDiskTestFiles,
    pendingFlatFiles,
  } = input;
  const problems: string[] = [];

  const ciList = [...kitList, ...Object.values(perFormatLists).flat()];

  if (ciList.length === 0) {
    problems.push("ci.yml qualification-linux run step has an empty file list");
  }

  for (const entry of ciList) {
    if (!entry.endsWith(".test.ts")) {
      problems.push(`ci.yml entry does not end in .test.ts: ${entry}`);
    }
    if (!ciListExists.has(entry)) {
      problems.push(
        `ci.yml lists a file that does not exist on disk: ${entry}`,
      );
    }
  }

  for (const [format, entries] of Object.entries(perFormatLists)) {
    const requiredPrefix = `tests/qualification/${format}/`;
    for (const entry of entries) {
      if (!entry.startsWith(requiredPrefix)) {
        problems.push(
          `QUAL_${format.toUpperCase()} lists ${entry}, which is not under ${requiredPrefix}`,
        );
      }
    }
  }

  const ciSet = new Set(ciList);
  const qualifySet = new Set(qualifyList);
  for (const entry of ciSet) {
    if (!qualifySet.has(entry)) {
      problems.push(
        `ci.yml lists ${entry} but scripts/qualification/qualify.cjs full-run list omits it`,
      );
    }
  }
  for (const entry of qualifySet) {
    if (!ciSet.has(entry)) {
      problems.push(
        `scripts/qualification/qualify.cjs full-run list has ${entry} but ci.yml omits it`,
      );
    }
  }

  const pendingTestFiles = pendingFlatFiles.filter((file) =>
    file.endsWith(".test.ts"),
  );
  const expected = new Set(
    [...onDiskTestFiles, ...pendingTestFiles].filter(
      (file) => !isBenchmarkPath(file),
    ),
  );
  for (const entry of expected) {
    if (!ciSet.has(entry)) {
      problems.push(
        `on-disk qualification suite ${entry} is missing from the ci.yml qualification-linux list`,
      );
    }
  }
  for (const entry of ciSet) {
    if (!expected.has(entry)) {
      problems.push(
        `ci.yml lists ${entry}, which is neither an on-disk kit/webp/png suite nor a pinned PENDING_FLAT_FILES entry`,
      );
    }
  }

  return problems;
}

function extractJobBody(ciYmlText: string, jobName: string): string {
  const jobMatch = ciYmlText.match(
    new RegExp(
      `\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:\\n|$)`,
    ),
  );
  const jobBody = jobMatch?.[1];
  if (jobBody === undefined)
    throw new Error(`${jobName} job not found in ci.yml`);
  return jobBody;
}

/** Extracts a literal, double-quoted `KEY: "a b c"` job-level env value as a space-split list. */
function extractEnvList(jobBody: string, key: string): string[] {
  const match = jobBody.match(new RegExp(`\\n {4}${key}: "([^"]*)"`));
  const value = match?.[1];
  if (value === undefined)
    throw new Error(`${key} not found in qualification-linux env block`);
  return value
    .trim()
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
}

function extractQualifyList(qualifyCjsText: string): string[] {
  const marker = "runOracleAuthority() !== 0) return 1;";
  const lastIndex = qualifyCjsText.lastIndexOf(marker);
  if (lastIndex === -1)
    throw new Error("runOracleAuthority guard not found in qualify.cjs");
  const tail = qualifyCjsText.slice(lastIndex + marker.length);
  const callMatch = tail.match(/npm\(\[\s*"test",\s*"--",\s*([\s\S]*?)\]\)/);
  const callBody = callMatch?.[1];
  if (callBody === undefined)
    throw new Error("full-run npm test call not found in qualify.cjs");
  return [...callBody.matchAll(/"([^"]+)"/g)].map((match) => {
    const literal = match[1];
    if (literal === undefined) throw new Error("unreachable: unmatched group");
    return literal;
  });
}

function listTestFilesRecursive(absoluteDir: string): string[] {
  if (!existsSync(absoluteDir)) return [];
  const results: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts"))
        results.push(relative(projectRoot, full).split(sep).join("/"));
    }
  };
  walk(absoluteDir);
  return results;
}

function listFlatEntries(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(projectRoot, join(absoluteDir, entry.name)).split(sep).join("/"),
    );
}

describe("qualification test layout (D-15/D-16, per-format scoping D-17)", () => {
  const ciYmlPath = join(projectRoot, ".github/workflows/ci.yml");
  const qualifyCjsPath = join(projectRoot, "scripts/qualification/qualify.cjs");
  const ciYmlText = readFileSync(ciYmlPath, "utf8");
  const qualifyCjsText = readFileSync(qualifyCjsPath, "utf8");

  const qualificationLinuxBody = extractJobBody(
    ciYmlText,
    "qualification-linux",
  );
  const qualificationRoot = join(projectRoot, "tests/qualification");
  const qualificationSubdirectories = readdirSync(qualificationRoot, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // "kit" is the shared, format-neutral suite (QUAL_KIT); every other
  // subdirectory is a registered format and must have its own QUAL_<FORMAT>
  // env list in qualification-linux.
  const formatDirectoryNames = qualificationSubdirectories.filter(
    (name) => name !== "kit",
  );

  const kitList = extractEnvList(qualificationLinuxBody, "QUAL_KIT");
  const perFormatLists: Record<string, readonly string[]> = Object.fromEntries(
    formatDirectoryNames.map((name) => [
      name,
      extractEnvList(qualificationLinuxBody, `QUAL_${name.toUpperCase()}`),
    ]),
  );
  const qualifyList = extractQualifyList(qualifyCjsText);
  const onDiskTestFiles = qualificationSubdirectories.flatMap((name) =>
    listTestFilesRecursive(join(qualificationRoot, name)),
  );
  const fullCiList = [...kitList, ...Object.values(perFormatLists).flat()];
  const ciListExists = new Set(
    fullCiList.filter((entry) => existsSync(join(projectRoot, entry))),
  );

  it("has no problems: ci.yml (QUAL_KIT + every QUAL_<FORMAT>), qualify.cjs, and the on-disk kit/webp/png suites agree", () => {
    const problems = qualificationListProblems({
      kitList,
      perFormatLists,
      ciListExists,
      qualifyList,
      onDiskTestFiles,
      pendingFlatFiles: PENDING_FLAT_FILES,
    });
    expect(problems).toEqual([]);
  });

  it("only allowlists still-pending flat files directly under tests/qualification/", () => {
    const flatEntries = listFlatEntries(
      join(projectRoot, "tests/qualification"),
    );
    const allowlist = new Set(PENDING_FLAT_FILES);
    const unexpected = flatEntries.filter((entry) => !allowlist.has(entry));
    expect(unexpected).toEqual([]);
  });

  // Permanent negative controls (D-16, D-17): each proves qualificationListProblems
  // actually detects the failure mode it exists for, by mutating the real,
  // currently-green inputs and asserting a problem is reported.
  describe("negative controls (must report a problem when triggered)", () => {
    it("(i) reports a problem when a QUAL_<FORMAT> list drops an on-disk suite", () => {
      const droppedFile = "tests/qualification/webp/parser.test.ts";
      const droppedPerFormatLists = Object.fromEntries(
        Object.entries(perFormatLists).map(([format, entries]) => [
          format,
          entries.filter((entry) => entry !== droppedFile),
        ]),
      );
      const droppedCiList = [
        ...kitList,
        ...Object.values(droppedPerFormatLists).flat(),
      ];
      const problems = qualificationListProblems({
        kitList,
        perFormatLists: droppedPerFormatLists,
        ciListExists: new Set(
          droppedCiList.filter((entry) => ciListExists.has(entry)),
        ),
        qualifyList,
        onDiskTestFiles,
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(problems.some((problem) => problem.includes(droppedFile))).toBe(
        true,
      );
    });

    it("(i-png) reports a problem when a PNG suite is missing from QUAL_PNG (the required 56-12 negative control)", () => {
      const droppedFile = "tests/qualification/png/property.test.ts";
      const droppedPerFormatLists = {
        ...perFormatLists,
        png: (perFormatLists.png ?? []).filter(
          (entry) => entry !== droppedFile,
        ),
      };
      const droppedCiList = [
        ...kitList,
        ...Object.values(droppedPerFormatLists).flat(),
      ];
      const problems = qualificationListProblems({
        kitList,
        perFormatLists: droppedPerFormatLists,
        ciListExists: new Set(
          droppedCiList.filter((entry) => ciListExists.has(entry)),
        ),
        qualifyList,
        onDiskTestFiles,
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(problems.some((problem) => problem.includes(droppedFile))).toBe(
        true,
      );
    });

    it("(ii) reports a problem when a listed path does not exist on disk", () => {
      const bogusPath = "tests/qualification/webp/does-not-exist.test.ts";
      const injectedPerFormatLists = {
        ...perFormatLists,
        webp: [...(perFormatLists.webp ?? []), bogusPath],
      };
      const problems = qualificationListProblems({
        kitList,
        perFormatLists: injectedPerFormatLists,
        ciListExists,
        qualifyList: [...qualifyList, bogusPath],
        onDiskTestFiles,
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(
        problems.some((problem) =>
          problem.includes(`does not exist on disk: ${bogusPath}`),
        ),
      ).toBe(true);
    });

    it("(iii) reports a problem for a stray non-allowlisted flat file", () => {
      const strayPath = "tests/qualification/stray.test.ts";
      const injectedPerFormatLists = {
        ...perFormatLists,
        webp: [...(perFormatLists.webp ?? []), strayPath],
      };
      const problems = qualificationListProblems({
        kitList,
        perFormatLists: injectedPerFormatLists,
        ciListExists: new Set([...ciListExists, strayPath]),
        qualifyList: [...qualifyList, strayPath],
        onDiskTestFiles,
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(
        problems.some((problem) =>
          problem.includes(
            `${strayPath}, which is neither an on-disk kit/webp/png suite nor a pinned PENDING_FLAT_FILES entry`,
          ),
        ),
      ).toBe(true);
    });

    it("(iv) reports a problem when an on-disk suite in a non-kit qualification subdirectory is missing from ci.yml -- proves the generalized subdirectory scan actually runs", () => {
      const missingPngSuite = "tests/qualification/png/x.test.ts";
      const problems = qualificationListProblems({
        kitList,
        perFormatLists,
        ciListExists,
        qualifyList,
        onDiskTestFiles: [...onDiskTestFiles, missingPngSuite],
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(
        problems.some((problem) => problem.includes(missingPngSuite)),
      ).toBe(true);
    });

    it("(v) reports a problem when a format's QUAL_<FORMAT> list contains a file from another format's directory", () => {
      const wrongDirectoryEntry = "tests/qualification/webp/parser.test.ts";
      const injectedPerFormatLists = {
        ...perFormatLists,
        png: [...(perFormatLists.png ?? []), wrongDirectoryEntry],
      };
      const problems = qualificationListProblems({
        kitList,
        perFormatLists: injectedPerFormatLists,
        ciListExists,
        qualifyList,
        onDiskTestFiles,
        pendingFlatFiles: PENDING_FLAT_FILES,
      });
      expect(
        problems.some(
          (problem) =>
            problem.includes("QUAL_PNG") &&
            problem.includes(wrongDirectoryEntry) &&
            problem.includes("not under tests/qualification/png/"),
        ),
      ).toBe(true);
    });
  });
});
