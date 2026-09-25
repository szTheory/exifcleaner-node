import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Files still flat under `tests/qualification/` while the D-15 kit/webp move is in progress.
 * This plan's Task 3 and Phase 55 Plan 02 shrink this list; Plan 02 ends with it empty.
 * Every entry is a project-root-relative path.
 */
export const PENDING_FLAT_FILES: readonly string[] = [
  "tests/qualification/fault-plan.ts",
  "tests/qualification/generators.ts",
  "tests/qualification/parser.test.ts",
  "tests/qualification/property.test.ts",
  "tests/qualification/transaction.test.ts",
  "tests/qualification/oracles.ts",
  "tests/qualification/oracles.test.ts",
  "tests/qualification/benchmark.test.ts",
];

export interface QualificationListProblemsInput {
  readonly ciList: readonly string[];
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
 * Pure helper (D-16): takes the ci.yml qualification-linux list, the qualify.cjs full-run
 * list, the on-disk kit/webp `.test.ts` set, and the pending-flat allowlist as data, and
 * returns a list of problem strings. Empty means the three sources agree.
 */
export function qualificationListProblems(
  input: QualificationListProblemsInput,
): string[] {
  const {
    ciList,
    ciListExists,
    qualifyList,
    onDiskTestFiles,
    pendingFlatFiles,
  } = input;
  const problems: string[] = [];

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
        `ci.yml lists ${entry}, which is neither an on-disk kit/webp suite nor a pinned PENDING_FLAT_FILES entry`,
      );
    }
  }

  return problems;
}

function extractCiList(ciYmlText: string): string[] {
  const jobMatch = ciYmlText.match(
    /\n {2}qualification-linux:\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:\n|$)/,
  );
  const jobBody = jobMatch?.[1];
  if (jobBody === undefined)
    throw new Error("qualification-linux job not found in ci.yml");
  const runMatch = jobBody.match(/run: npm test -- (.+)/);
  const runArgs = runMatch?.[1];
  if (runArgs === undefined)
    throw new Error(
      "qualification-linux run step (npm test --) not found in ci.yml",
    );
  return runArgs.trim().split(/\s+/);
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

describe("qualification test layout (D-15/D-16)", () => {
  const ciYmlPath = join(projectRoot, ".github/workflows/ci.yml");
  const qualifyCjsPath = join(projectRoot, "scripts/qualification/qualify.cjs");
  const ciYmlText = readFileSync(ciYmlPath, "utf8");
  const qualifyCjsText = readFileSync(qualifyCjsPath, "utf8");

  const ciList = extractCiList(ciYmlText);
  const qualifyList = extractQualifyList(qualifyCjsText);
  const onDiskTestFiles = [
    ...listTestFilesRecursive(join(projectRoot, "tests/qualification/kit")),
    ...listTestFilesRecursive(join(projectRoot, "tests/qualification/webp")),
  ];
  const ciListExists = new Set(
    ciList.filter((entry) => existsSync(join(projectRoot, entry))),
  );

  it("has no problems: ci.yml, qualify.cjs, and the on-disk kit/webp suites agree", () => {
    const problems = qualificationListProblems({
      ciList,
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
});
