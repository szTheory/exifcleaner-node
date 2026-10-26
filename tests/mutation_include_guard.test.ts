import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { findDistReferences } from "./dist_import_guard.test.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * What must never be reachable from a test Stryker runs: a subprocess, the
 * ExifTool oracle, a benchmark, the network corpus, a native addon. Any of them
 * makes a test blind to (or too slow for) instrumented in-process sources.
 */
export const FORBIDDEN_REFERENCE =
  /child_process|spawn|execFile|fork\(|exiftool|oracle|benchmark|tests\/corpus|\.node['"]/u;

export interface ReferenceHit {
  line: number;
  match: string;
}

function isLiteralLike(
  node: ts.Node,
): node is
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateHead
  | ts.TemplateMiddle
  | ts.TemplateTail {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/**
 * Sorted hits for every string-like literal (which includes every import,
 * export, dynamic-import and require specifier) whose text matches
 * FORBIDDEN_REFERENCE, plus the lines findDistReferences reports. Comments,
 * identifiers and regex literals never count.
 */
export function findForbiddenReferences(
  sourceText: string,
  fileName: string,
): ReferenceHit[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const hits: ReferenceHit[] = [];
  const visit = (node: ts.Node): void => {
    if (isLiteralLike(node)) {
      const found = FORBIDDEN_REFERENCE.exec(node.text);
      if (found !== null) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        hits.push({ line: line + 1, match: found[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const line of findDistReferences(sourceText, fileName)) {
    hits.push({ line, match: "dist" });
  }
  return hits.sort((a, b) => a.line - b.line || a.match.localeCompare(b.match));
}

/** Relative module specifiers (import, export-from, import(), require()). */
function relativeSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers.filter((s) => s.startsWith("."));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function resolveSpecifier(
  root: string,
  fromRelative: string,
  specifier: string,
): string | undefined {
  const base = resolve(root, dirname(fromRelative), specifier);
  const candidates = [
    base.replace(/\.(?:js|mjs|cjs)$/u, ".ts"),
    base,
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && /\.(?:ts|mts|cts)$/u.test(candidate)) {
      return toPosix(relative(root, candidate));
    }
  }
  return undefined;
}

/**
 * Package-root-relative files reachable from `relativePath` through relative
 * specifiers, staying inside tests/. Bare packages and ../src imports are the
 * code under test and are not followed. The start file is included.
 */
export function importClosure(root: string, relativePath: string): string[] {
  const seen = new Set<string>();
  const queue = [relativePath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const full = join(root, current);
    if (!existsSync(full)) continue;
    for (const specifier of relativeSpecifiers(
      readFileSync(full, "utf8"),
      full,
    )) {
      const target = resolveSpecifier(root, current, specifier);
      if (target !== undefined && target.startsWith("tests/")) {
        queue.push(target);
      }
    }
  }
  return [...seen].sort();
}

/** Every tests/**\/*.test.ts, minus tests/corpus and node_modules, sorted. */
export function walkTests(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (full === join(root, "tests", "corpus")) continue;
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(toPosix(relative(root, full)));
      }
    }
  };
  visit(join(root, "tests"));
  return files.sort();
}

export interface ClosureHit {
  file: string;
  line: number;
  match: string;
}

/** Forbidden references anywhere in the test's closure, plus fixed-tmpdir hazards. */
export function closureHits(root: string, testFile: string): ClosureHit[] {
  const hits: ClosureHit[] = [];
  for (const file of importClosure(root, testFile)) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    for (const hit of findForbiddenReferences(text, full)) {
      hits.push({ file, ...hit });
    }
    const tmp = fixedTmpdirLine(text, full);
    if (tmp !== undefined) {
      hits.push({ file, line: tmp, match: "tmpdir-without-mkdtemp" });
    }
  }
  return hits;
}

/** Line of a tmpdir() call in a file that never calls mkdtemp*, else undefined. */
function fixedTmpdirLine(
  sourceText: string,
  fileName: string,
): number | undefined {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  let tmpdirLine: number | undefined;
  let mkdtemp = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "mkdtemp" || name === "mkdtempSync") mkdtemp = true;
      if (name === "tmpdir" && tmpdirLine === undefined) {
        tmpdirLine =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mkdtemp ? undefined : tmpdirLine;
}

export interface Classification {
  walked: number;
  allowlisted: string[];
  excluded: string[];
  problems: string[];
}

export interface ExclusionShape {
  class: string;
  reason: string;
}

export function classifyTests(
  root: string,
  allowlist: readonly string[],
  exclusions: Readonly<Record<string, ExclusionShape>>,
): Classification {
  const walked = walkTests(root);
  const walkedSet = new Set(walked);
  const allowSet = new Set(allowlist);
  const excludedPaths = Object.keys(exclusions).sort();
  const problems: string[] = [];
  for (const file of walked) {
    const inAllow = allowSet.has(file);
    const inExcl = file in exclusions;
    if (inAllow && inExcl) problems.push(`${file}: classified twice`);
    if (!inAllow && !inExcl) problems.push(`${file}: unclassified test file`);
  }
  for (const file of [...allowSet].sort()) {
    if (!walkedSet.has(file)) problems.push(`${file}: stale allowlist entry`);
  }
  for (const file of excludedPaths) {
    if (!walkedSet.has(file)) problems.push(`${file}: stale exclusion entry`);
    const entry = exclusions[file]!;
    if (entry.class.length === 0 || entry.reason.length === 0) {
      problems.push(`${file}: exclusion lacks a class or reason`);
    }
  }
  for (const file of [...allowSet].sort()) {
    if (!walkedSet.has(file)) continue;
    for (const hit of closureHits(root, file)) {
      problems.push(`${hit.file}:${hit.line}:${hit.match} (via ${file})`);
    }
  }
  return {
    walked: walked.length,
    allowlisted: walked.filter((f) => allowSet.has(f)),
    excluded: walked.filter((f) => f in exclusions),
    problems,
  };
}

describe("tracer: whole-tree partition", () => {
  it("scans every test file transitively and prints the partition", () => {
    const walked = walkTests(packageRoot);
    const clean: string[] = [];
    const dirty: Array<{ file: string; first: ClosureHit }> = [];
    for (const file of walked) {
      const hits = closureHits(packageRoot, file);
      if (hits.length === 0) clean.push(file);
      else dirty.push({ file, first: hits[0]! });
    }
    console.info(`include-guard: walked ${walked.length}`);
    console.info(`include-guard: clean ${clean.length}`);
    console.info(`include-guard: hit ${dirty.length}`);
    for (const f of clean) console.info(`include-guard: clean-file ${f}`);
    for (const { file, first } of dirty) {
      console.info(
        `include-guard: hit-file ${file} <- ${first.file}:${first.line}:${first.match}`,
      );
    }
    expect(walked.length).toBeGreaterThanOrEqual(100);
    expect(clean).toContain("tests/riff.test.ts");
    expect(clean).toContain("tests/error_kinds.test.ts");
  });
});
