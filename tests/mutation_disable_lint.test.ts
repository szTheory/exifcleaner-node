import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISABLE_FORM,
  lintDisableComments,
  parseDisableReason,
  scanSrcDisables,
  // @ts-expect-error plain .mjs tooling scripts without type declarations
} from "../tools/mutation/disable-lint.mjs";

// Controls for the Stryker disable-comment lint (MUT-03, D-16, D-19).
// These test tooling, not src, so they are excluded from the Stryker run.

const ROOT = join(__dirname, "..");
const classes = JSON.parse(
  readFileSync(
    join(__dirname, "..", "tools", "mutation", "classes.json"),
    "utf8",
  ),
) as { equivalenceClasses: Record<string, string>; mutators: string[] };
const VALID =
  "// Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — kind is narrowed by the caller";

function problems(text: string): string[] {
  return lintDisableComments(text, "src/x.ts", classes).map(
    (p: { line: number; problem: string }) => `${p.line}: ${p.problem}`,
  );
}

describe("valid disable form", () => {
  it("accepts the single-mutator form", () => {
    expect(problems(`${VALID}\nif (a) {}\n`)).toEqual([]);
  });

  it("accepts two mutators", () => {
    expect(
      problems(
        "// Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent-arithmetic — same for every reachable input",
      ),
    ).toEqual([]);
  });

  it("ignores source without any Stryker comment", () => {
    expect(problems("const a = 1; // not a directive\n")).toEqual([]);
    expect(DISABLE_FORM.test(VALID)).toBe(true);
  });
});

describe("red controls (each asserts the exact problem)", () => {
  it.each([
    [
      "bare file-scope disable all",
      "// Stryker disable all",
      "1: only next-line disables are allowed (no file or block scope)",
    ],
    [
      "next-line all",
      "// Stryker disable next-line all: unobservable-message — x",
      "1: mutator list must not contain all",
    ],
    [
      "restore pair",
      "// Stryker restore all",
      "1: Stryker restore is not allowed",
    ],
    [
      "bare disable of one mutator",
      "// Stryker disable StringLiteral",
      "1: only next-line disables are allowed (no file or block scope)",
    ],
    [
      "unknown class",
      "// Stryker disable next-line StringLiteral: made-up-class — x",
      "1: unknown class made-up-class",
    ],
    [
      "unknown mutator",
      "// Stryker disable next-line NoSuchMutator: unobservable-message — x",
      "1: unknown mutator NoSuchMutator",
    ],
    [
      "missing reason",
      "// Stryker disable next-line StringLiteral",
      "1: missing reason: expected `: <class> — <specifics>`",
    ],
    [
      "reason without the em dash",
      "// Stryker disable next-line StringLiteral: unobservable-message - hyphen only",
      "1: reason must be `<class> — <specifics>` (em dash with spaces)",
    ],
    [
      "empty specifics",
      "// Stryker disable next-line StringLiteral: unobservable-message — ",
      "1: reason must be `<class> — <specifics>` (em dash with spaces)",
    ],
    [
      "block comment form",
      "/* Stryker disable next-line StringLiteral: unobservable-message — x */",
      "1: unrecognized Stryker comment (use the next-line form)",
    ],
    [
      "restore with a valid-looking list",
      "// Stryker restore StringLiteral",
      "1: Stryker restore is not allowed",
    ],
  ])("%s", (_name, text, expected) => {
    expect(problems(text)).toEqual([expected]);
  });

  it("reports lines in ascending order", () => {
    const text = `${VALID}\n// Stryker restore all\nok();\n// Stryker disable all\n`;
    expect(problems(text)).toEqual([
      "2: Stryker restore is not allowed",
      "4: only next-line disables are allowed (no file or block scope)",
    ]);
  });
});

describe("parseDisableReason", () => {
  it("accepts a class with specifics", () => {
    expect(
      parseDisableReason("redundant-guard-after-typed-check — x", classes),
    ).toEqual({ valid: true, className: "redundant-guard-after-typed-check" });
  });

  it.each([
    "Ignored using a comment",
    "unknown-class — x",
    "unobservable-message — ",
    "",
  ])("rejects %j", (reason) => {
    expect(parseDisableReason(reason, classes).valid).toBe(false);
  });
});

describe("closed lists", () => {
  it("has at least five classes and no wildcard mutator", () => {
    expect(
      Object.keys(classes.equivalenceClasses).length,
    ).toBeGreaterThanOrEqual(5);
    expect(classes.mutators).not.toContain("all");
    expect(classes.mutators.length).toBeGreaterThanOrEqual(10);
  });
});

describe("scanSrcDisables", () => {
  it("is clean over the real src and counts every tracked file", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "src"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => p.endsWith(".ts"));
    const result = scanSrcDisables(ROOT, classes);
    expect(result.problems).toEqual([]);
    expect(result.scanned).toBe(tracked.length);
    expect(result.scanned).toBeGreaterThanOrEqual(45);
  });

  it("reports a bad disable in a temp tree (negative control)", () => {
    const root = mkdtempSync(join(tmpdir(), "disable-lint-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "x.ts"),
      "// Stryker disable all\nconst a = 1;\n",
    );
    execFileSync("git", ["add", "src/x.ts"], { cwd: root });
    const result = scanSrcDisables(root, classes);
    expect(result.scanned).toBe(1);
    expect(result.problems).toEqual([
      "src/x.ts:1: only next-line disables are allowed (no file or block scope)",
    ]);
  });
});
