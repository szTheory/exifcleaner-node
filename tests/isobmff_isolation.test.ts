// Red-proven import-isolation guard for `tests/isobmff-support/` (D-19/D-21).
//
// The fixture builder, the independent inventory walker (added in 61-03) and the fast-check
// generator (added in 61-12) must never share code with the engine under test (`src/isobmff/`),
// and the builder/inventory pair must never share code with each other -- otherwise the "second
// oracle" each one is meant to be collapses into "the same author's one reading of the spec,
// twice." This file is both the live guard (scans the real files on every test run) and the
// negative-control proof that the guard actually detects a violation (synthetic sources below).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SUPPORT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
);

export interface IsolationFile {
  /** File name only (e.g. "builder.ts") -- matched against `ISOLATION_RULES` by exact name. */
  readonly path: string;
  readonly source: string;
}

export interface IsolationViolation {
  readonly path: string;
  readonly specifier: string;
}

interface IsolationRule {
  readonly fileName: string;
  /** Substrings of an import specifier that are forbidden for this file. */
  readonly forbiddenSpecifierSubstrings: readonly string[];
}

/**
 * One rule per test-support module that exists or is planned for this phase's test-support
 * directory. `inventory.ts` (61-03) and `generator.ts` (61-12) are listed ahead of their own
 * plans landing so this table never needs editing merely to add the files it already anticipates
 * -- only a genuine new independence requirement should touch it.
 */
export const ISOLATION_RULES: readonly IsolationRule[] = [
  {
    fileName: "builder.ts",
    forbiddenSpecifierSubstrings: ["src/isobmff/", "inventory"],
  },
  {
    fileName: "inventory.ts",
    forbiddenSpecifierSubstrings: ["src/isobmff/", "builder"],
  },
  {
    fileName: "generator.ts",
    forbiddenSpecifierSubstrings: ["src/isobmff/", "inventory"],
  },
];

// Mirrors `scripts/runtime_surface_gate.mjs`'s `importSpecifiers` static/dynamic import regexes.
const STATIC_IMPORT =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isForbidden(specifier: string, forbidden: readonly string[]): boolean {
  return forbidden.some((substring) => specifier.includes(substring));
}

/**
 * A module with no matching `ISOLATION_RULES` entry (by exact file name) is not scanned at all --
 * this function only ever reports violations for files this phase has declared a rule for.
 */
export function isolationViolations(
  files: readonly IsolationFile[],
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  for (const file of files) {
    const rule = ISOLATION_RULES.find((r) => r.fileName === file.path);
    if (rule === undefined) continue;
    for (const specifier of importSpecifiers(file.source)) {
      if (isForbidden(specifier, rule.forbiddenSpecifierSubstrings)) {
        violations.push({ path: file.path, specifier });
      }
    }
  }
  return violations;
}

describe("isolationViolations() negative controls (synthetic sources)", () => {
  it("a static import of src/isobmff/ in builder.ts is one violation", () => {
    const violations = isolationViolations([
      {
        path: "builder.ts",
        source: 'import { x } from "../../src/isobmff/boxes.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "builder.ts", specifier: "../../src/isobmff/boxes.js" },
    ]);
  });

  it("a dynamic import of src/isobmff/ in builder.ts is also caught", () => {
    const violations = isolationViolations([
      {
        path: "builder.ts",
        source:
          'async function load() {\n  await import("../../src/isobmff/parse.js");\n}\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "builder.ts", specifier: "../../src/isobmff/parse.js" },
    ]);
  });

  it("builder.ts importing the inventory module is a violation", () => {
    const violations = isolationViolations([
      {
        path: "builder.ts",
        source: 'import { walk } from "./inventory.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "builder.ts", specifier: "./inventory.js" },
    ]);
  });

  it("a module with no matching rule is not scanned at all", () => {
    const violations = isolationViolations([
      {
        path: "not-a-test-support-module.ts",
        source: 'import { x } from "../../src/isobmff/boxes.js";\n',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("inventory.ts importing the builder is a violation (independent-oracle rule)", () => {
    const violations = isolationViolations([
      {
        path: "inventory.ts",
        source: 'import { heifFile } from "./builder.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "inventory.ts", specifier: "./builder.js" },
    ]);
  });
});

describe("isolationViolations() against the real tests/isobmff-support/ files", () => {
  it("every file with a declared rule has zero violations", () => {
    const entries = readdirSync(SUPPORT_DIR, { withFileTypes: true });
    const files: IsolationFile[] = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => ({
        path: entry.name,
        source: readFileSync(join(SUPPORT_DIR, entry.name), "utf8"),
      }));

    // Sanity check that this test is actually exercising at least one rule-bearing file -- an
    // empty `files` list (or a renamed builder.ts) would otherwise make this test vacuously pass.
    const scanned = files.filter((file) =>
      ISOLATION_RULES.some((rule) => rule.fileName === file.path),
    );
    expect(scanned.length).toBeGreaterThan(0);

    expect(isolationViolations(files)).toEqual([]);
  });
});
