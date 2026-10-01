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
  /**
   * D-14/61-09: specifier substrings a *type-only* (`import type ... from "..."`) occurrence is
   * allowed to match even though it would otherwise trip `forbiddenSpecifierSubstrings` --
   * `hostile.ts`'s one narrow exception (`import type { IsobmffDeclineClass } from
   * ".../errors.js"`). This is an occurrence-level exception, never a blanket allowance: the same
   * specifier imported as a *value* is still forbidden (see the negative control below).
   */
  readonly allowedTypeOnlySpecifierSubstrings?: readonly string[];
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
    forbiddenSpecifierSubstrings: ["src/isobmff/", "inventory", "test-handler"],
  },
  {
    fileName: "inventory.ts",
    forbiddenSpecifierSubstrings: ["src/isobmff/", "builder", "test-handler"],
  },
  {
    fileName: "generator.ts",
    forbiddenSpecifierSubstrings: ["src/isobmff/", "inventory"],
  },
  {
    fileName: "hostile.ts",
    forbiddenSpecifierSubstrings: [
      "src/isobmff/",
      "inventory",
      "generator",
      "test-handler",
    ],
    allowedTypeOnlySpecifierSubstrings: ["src/isobmff/errors.js"],
  },
  // D-16/61-10: test-handler.ts is the one declared seam between the engine and test support --
  // it is explicitly allowed to import src/isobmff/ (it wraps the real classifyIsobmffBrand and
  // admitIsobmff), unlike every other rule-bearing file in this table, which must never import
  // src/isobmff/ directly. It carries no forbidden substrings of its own.
  {
    fileName: "test-handler.ts",
    forbiddenSpecifierSubstrings: [],
  },
];

/**
 * Mirrors `scripts/runtime_surface_gate.mjs`'s `importSpecifiers` static/dynamic import regexes,
 * widened with a `typeOnly` flag per occurrence (D-14/61-09): `hostile.ts` is the first
 * isolation-ruled module allowed one narrow, value-free exception, so the scanner must
 * distinguish a type-only import from a value import at each occurrence, not merely by specifier
 * text (the same specifier text could appear as a type import in one place and a value import in
 * another).
 */
export interface ImportOccurrence {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const STATIC_IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

export function importSpecifiers(source: string): ImportOccurrence[] {
  const occurrences: ImportOccurrence[] = [];
  STATIC_IMPORT.lastIndex = 0;
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      occurrences.push({ specifier, typeOnly: match[1] !== undefined });
    }
  }
  DYNAMIC_IMPORT.lastIndex = 0;
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      occurrences.push({ specifier, typeOnly: false });
    }
  }
  return occurrences;
}

function isForbidden(specifier: string, forbidden: readonly string[]): boolean {
  return forbidden.some((substring) => specifier.includes(substring));
}

function isAllowedTypeOnly(
  specifier: string,
  allowed: readonly string[] | undefined,
): boolean {
  if (allowed === undefined) return false;
  return allowed.some((substring) => specifier.includes(substring));
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
    for (const occurrence of importSpecifiers(file.source)) {
      if (
        !isForbidden(occurrence.specifier, rule.forbiddenSpecifierSubstrings)
      ) {
        continue;
      }
      if (
        occurrence.typeOnly &&
        isAllowedTypeOnly(
          occurrence.specifier,
          rule.allowedTypeOnlySpecifierSubstrings,
        )
      ) {
        continue;
      }
      violations.push({ path: file.path, specifier: occurrence.specifier });
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

  it("inventory.ts importing src/isobmff/ is a violation (second-oracle independence)", () => {
    const violations = isolationViolations([
      {
        path: "inventory.ts",
        source: 'import { parseBox } from "../../src/isobmff/boxes.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "inventory.ts", specifier: "../../src/isobmff/boxes.js" },
    ]);
  });

  it("hostile.ts's type-only IsobmffDeclineClass import is allowed (D-14 exception)", () => {
    const violations = isolationViolations([
      {
        path: "hostile.ts",
        source:
          'import type { IsobmffDeclineClass } from "../../src/isobmff/errors.js";\n',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("hostile.ts importing src/isobmff/errors.js as a VALUE import is still a violation (negative control: the allowance is type-only, never blanket)", () => {
    const violations = isolationViolations([
      {
        path: "hostile.ts",
        source:
          'import { ISOBMFF_DECLINE_CLASSES } from "../../src/isobmff/errors.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "hostile.ts", specifier: "../../src/isobmff/errors.js" },
    ]);
  });

  it("hostile.ts importing any other src/isobmff/ module (even type-only) is a violation", () => {
    const violations = isolationViolations([
      {
        path: "hostile.ts",
        source:
          'import type { IsobmffModel } from "../../src/isobmff/parse.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "hostile.ts", specifier: "../../src/isobmff/parse.js" },
    ]);
  });

  it("hostile.ts importing inventory.ts or generator.ts is a violation (independent-oracle rule)", () => {
    const violations = isolationViolations([
      { path: "hostile.ts", source: 'import { x } from "./inventory.js";\n' },
    ]);
    expect(violations).toEqual([
      { path: "hostile.ts", specifier: "./inventory.js" },
    ]);
  });

  it("hostile.ts importing test-handler.ts is a violation (61-10: the engine seam is not an independent oracle)", () => {
    const violations = isolationViolations([
      {
        path: "hostile.ts",
        source:
          'import { createIsobmffTestHandler } from "./test-handler.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "hostile.ts", specifier: "./test-handler.js" },
    ]);
  });

  it("builder.ts importing test-handler.ts is a violation (61-10)", () => {
    const violations = isolationViolations([
      {
        path: "builder.ts",
        source:
          'import { createIsobmffTestHandler } from "./test-handler.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "builder.ts", specifier: "./test-handler.js" },
    ]);
  });

  it("inventory.ts importing test-handler.ts is a violation (61-10)", () => {
    const violations = isolationViolations([
      {
        path: "inventory.ts",
        source:
          'import { createIsobmffTestHandler } from "./test-handler.js";\n',
      },
    ]);
    expect(violations).toEqual([
      { path: "inventory.ts", specifier: "./test-handler.js" },
    ]);
  });

  it("test-handler.ts importing src/isobmff/ directly is allowed (61-10: the declared engine seam, D-16)", () => {
    const violations = isolationViolations([
      {
        path: "test-handler.ts",
        source:
          'import { admitIsobmff } from "../../src/isobmff/admission.js";\n',
      },
    ]);
    expect(violations).toEqual([]);
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
