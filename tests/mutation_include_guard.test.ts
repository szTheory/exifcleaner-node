import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { findDistReferences } from "./dist_import_guard.test.js";
import config, {
  STRYKER_TEST_ALLOWLIST,
} from "../tools/mutation/vitest.stryker.config.js";

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
      const found = FORBIDDEN_REFERENCE.exec(node.getText(sourceFile));
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

/**
 * Line of a tmpdir() call in a file that neither calls mkdtemp* nor builds a
 * per-call unique name (randomUUID, Math.random); fixed names collide across forks.
 */
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
      if (name === "randomUUID") mkdtemp = true;
      if (name === "tmpdir" && tmpdirLine === undefined) {
        tmpdirLine =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    ) {
      mkdtemp = true;
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

export type ExclusionClass =
  | "child-process"
  | "dist-importer"
  | "oracle"
  | "benchmark"
  | "corpus-network"
  | "repo-tooling"
  | "no-src-under-test"
  | "native-addon"
  | "sandbox-incompatible";

/**
 * Every test file Stryker must not run, with the reason. The complement of
 * STRYKER_TEST_ALLOWLIST over tests/**\/*.test.ts (corpus excluded); the
 * whole-tree test below fails on any file in neither or both.
 */
export const EXCLUSIONS: Readonly<
  Record<string, { class: ExclusionClass; reason: string }>
> = Object.freeze({
  "tests/isobmff_decode_oracle.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/isobmff-support/decode-oracle.ts:23); instrumented sources are not loaded by a child.",
  },
  "tests/isobmff_idempotence.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/isobmff_idempotence.test.ts:9); instrumented sources are not loaded by a child.",
  },
  "tests/isobmff_memory.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/isobmff_memory.test.ts:11); instrumented sources are not loaded by a child.",
  },
  "tests/native_bridge_harness.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/native_bridge_harness.test.ts:1); instrumented sources are not loaded by a child.",
  },
  "tests/native_vs_exiftool.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/native_vs_exiftool.test.ts:6); instrumented sources are not loaded by a child.",
  },
  "tests/package_smoke.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/package_smoke.test.ts:13); instrumented sources are not loaded by a child.",
  },
  "tests/png_memory.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/png_memory.test.ts:1); instrumented sources are not loaded by a child.",
  },
  "tests/qualification/avif/decode.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/isobmff-support/decode-oracle.ts:23); instrumented sources are not loaded by a child.",
  },
  "tests/qualification/heic/decode.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/isobmff-support/decode-oracle.ts:23); instrumented sources are not loaded by a child.",
  },
  "tests/qualification/jpeg/golden.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/qualification/jpeg/golden.test.ts:1); instrumented sources are not loaded by a child.",
  },
  "tests/qualification/jpeg/tracer.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/qualification/jpeg/oracles.ts:2); instrumented sources are not loaded by a child.",
  },
  "tests/qualification/kit/build_oracles.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/qualification/kit/build_oracles.test.ts:17); instrumented sources are not loaded by a child.",
  },
  "tests/runtime_surface_gate.test.ts": {
    class: "child-process",
    reason:
      "Spawns subprocesses (tests/runtime_surface_gate.test.ts:8); instrumented sources are not loaded by a child.",
  },
  "tests/fallback.test.ts": {
    class: "dist-importer",
    reason:
      "Imports the built dist (tests/fallback.test.ts:340), which Stryker does not instrument.",
  },
  "tests/isobmff_surface.test.ts": {
    class: "dist-importer",
    reason:
      "Imports the built dist (tests/isobmff_surface.test.ts:21), which Stryker does not instrument.",
  },
  "tests/public_contract.test.ts": {
    class: "dist-importer",
    reason:
      "Imports the built dist (tests/public_contract.test.ts:12), which Stryker does not instrument.",
  },
  "tests/isobmff_registration.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/isobmff_spec_doc.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/avif/oracles.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/avif/parser.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/avif/property.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/avif/tracer.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/heic/oracles.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/heic/parser.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/heic/property.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/heic/tracer.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/jpeg/oracles.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/qualification/jpeg/oracles.test.ts:21); oracle runs need external tools and are slow.",
  },
  "tests/qualification/kit/oracles.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/qualification/kit/oracles.test.ts:14); oracle runs need external tools and are slow.",
  },
  "tests/qualification/kit/rollback.test.ts": {
    class: "oracle",
    reason:
      "Closure reaches an oracle reference (tests/isobmff-support/differential.ts:19); oracle runs need external tools and are slow.",
  },
  "tests/qualification/webp/benchmark.test.ts": {
    class: "benchmark",
    reason: "WebP benchmark harness; spawns a child process and times it.",
  },
  "tests/qualification/avif/transaction.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/heic/transaction.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/jpeg/transaction.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/kit/corpus.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/kit/fetch_corpus.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/png/golden.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/png/oracles.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/png/property.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/png/tracer.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/webp/golden.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/webp/oracles.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/qualification/webp/tracer.test.ts": {
    class: "corpus-network",
    reason:
      "Closure reaches tests/qualification/kit/corpus.ts (tests/qualification/kit/corpus.ts:84 names the benchmark corpus kind); corpus and fetch tooling.",
  },
  "tests/build_native.test.ts": {
    class: "repo-tooling",
    reason: "Tests the native build script; tests no src.",
  },
  "tests/check_evidence_present.test.ts": {
    class: "repo-tooling",
    reason: "Tests the evidence-presence script (spawns node); tests no src.",
  },
  "tests/ci_workflow_wiring.test.ts": {
    class: "repo-tooling",
    reason: "Asserts CI workflow wiring; tests no src.",
  },
  "tests/classify_ci_scope.test.ts": {
    class: "repo-tooling",
    reason: "Tests the CI scope classifier script (spawns node); tests no src.",
  },
  "tests/dispatch_native_matrix.test.ts": {
    class: "repo-tooling",
    reason: "Tests the native dispatch matrix script; tests no src.",
  },
  "tests/dist_import_guard.test.ts": {
    class: "repo-tooling",
    reason: "Scans the test tree for dist literals; tests no src.",
  },
  "tests/fc_seed_guard.test.ts": {
    class: "repo-tooling",
    reason:
      "Guards FC seed and run settings in tests; tests no src. Not changed (D-10).",
  },
  "tests/format_admission_doc.test.ts": {
    class: "repo-tooling",
    reason:
      "Checks the format admission document against the tree; tests no src.",
  },
  "tests/format_neutral_source.test.ts": {
    class: "repo-tooling",
    reason: "Source-shape guard over the tree; tests no src behavior.",
  },
  "tests/isobmff_isolation.test.ts": {
    class: "repo-tooling",
    reason:
      "Asserts the oracle support code never imports src/isobmff; tests no src.",
  },
  "tests/mutation_include_guard.test.ts": {
    class: "repo-tooling",
    reason: "This guard; scans the test tree and tests no src.",
  },
  "tests/mutation_isolation.test.ts": {
    class: "repo-tooling",
    reason:
      "Isolation guard for the Stryker package; spawns git and tests no src.",
  },
  "tests/mutation_report.test.ts": {
    class: "repo-tooling",
    reason: "Tests the mutation scripts, not src.",
  },
  "tests/mutation_ignorer.test.ts": {
    class: "repo-tooling",
    reason: "Tests mutation tooling (error-message ignorer rule), not src.",
  },
  "tests/mutation_disable_lint.test.ts": {
    class: "repo-tooling",
    reason: "Tests mutation tooling (disable-comment lint), not src.",
  },
  "tests/native_artifact_audit.test.ts": {
    class: "repo-tooling",
    reason: "Audits native artifacts; tests no src.",
  },
  "tests/native_source_audit.test.ts": {
    class: "repo-tooling",
    reason: "Audits native sources through a subprocess; tests no src.",
  },
  "tests/qualification_layout.test.ts": {
    class: "repo-tooling",
    reason: "Asserts the qualification directory layout; tests no src.",
  },
  "tests/release_workflow_gate.test.ts": {
    class: "repo-tooling",
    reason:
      "Tests the release workflow gate script (spawns node); tests no src.",
  },
  "tests/tsconfig_strictness.test.ts": {
    class: "repo-tooling",
    reason: "Asserts tsconfig strictness; tests no src.",
  },
  "tests/windows_host_independence.test.ts": {
    class: "repo-tooling",
    reason: "Asserts host independence of scripts; tests no src.",
  },
  "tests/isobmff_builder.test.ts": {
    class: "no-src-under-test",
    reason:
      "Tests the independent ISOBMFF builder support code, which imports nothing from src.",
  },
  "tests/isobmff_inventory.test.ts": {
    class: "no-src-under-test",
    reason:
      "Tests the independent ISOBMFF inventory support code, which imports nothing from src.",
  },
  "tests/qualification/kit/floors.test.ts": {
    class: "no-src-under-test",
    reason: "Tests the qualification floors kit; no src import.",
  },
  "tests/qualification/kit/replay.test.ts": {
    class: "no-src-under-test",
    reason: "Tests the replay kit; no src import.",
  },
  "tests/native_publication.test.ts": {
    class: "native-addon",
    reason:
      "Loads the prebuilt publication.node addon (tests/native_publication.test.ts:35), which is not instrumented.",
  },
  "tests/error_kinds.test.ts": {
    class: "sandbox-incompatible",
    reason:
      "Control A text-replaces src/types.ts, which Stryker instrumentation rewrites; fails the dry run (67-01).",
  },
});

/** Each trust format must keep at least one allowlisted test (matched on the path). */
export const FORMAT_GROUP_PATTERNS: Readonly<Record<string, RegExp>> =
  Object.freeze({
    webp: /webp|riff/u,
    png: /png/u,
    jpeg: /jpeg/u,
    isobmff: /isobmff|heic|avif/u,
    metadata: /exif|icc|xmp/u,
  });

/** One problem per format group without an allowlisted test, plus one for an empty allowlist. */
export function checkFormatCoverage(allowlist: readonly string[]): string[] {
  if (allowlist.length === 0) return ["allowlist is empty"];
  return Object.entries(FORMAT_GROUP_PATTERNS)
    .filter(([, pattern]) => !allowlist.some((file) => pattern.test(file)))
    .map(([group]) => `format group ${group} has no allowlisted test`);
}

describe("whole-tree include set", () => {
  const walked = walkTests(packageRoot);

  it("classifies every test file exactly once and finds no forbidden reference", () => {
    const result = classifyTests(
      packageRoot,
      STRYKER_TEST_ALLOWLIST,
      EXCLUSIONS,
    );
    console.info(`include-guard: clean ${result.allowlisted.length}`);
    console.info(`include-guard: excluded ${result.excluded.length}`);
    expect(result.problems).toEqual([]);
    expect(result.walked).toBe(walked.length);
    expect(result.allowlisted.length + result.excluded.length).toBe(
      walked.length,
    );
    expect(walked.length).toBeGreaterThanOrEqual(100);
  });

  it("keeps the allowlist sorted and unique", () => {
    expect([...STRYKER_TEST_ALLOWLIST]).toEqual(
      [...new Set(STRYKER_TEST_ALLOWLIST)].sort(),
    );
  });

  it("covers every format group", () => {
    expect(checkFormatCoverage(STRYKER_TEST_ALLOWLIST)).toEqual([]);
  });

  it("makes the vitest include list equal the allowlist, with no second copy", () => {
    expect(config.test?.include).toEqual([...STRYKER_TEST_ALLOWLIST]);
    const strykerConfig = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "stryker.config.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect("testFiles" in strykerConfig).toBe(false);
  });

  it("keeps the known sandbox-incompatible test excluded", () => {
    expect(EXCLUSIONS["tests/error_kinds.test.ts"]?.class).toBe(
      "sandbox-incompatible",
    );
  });
});

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mutation-include-guard-"));
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeIn(root: string, relativePath: string, text: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

describe("negative controls", () => {
  it("control 1: an allowlisted test importing child_process is red", () => {
    withTempRoot((root) => {
      writeIn(
        root,
        "tests/a.test.ts",
        `import { spawn } from "node:child_process";\nspawn("x");\n`,
      );
      const { problems } = classifyTests(root, ["tests/a.test.ts"], {});
      expect(problems).toEqual([
        "tests/a.test.ts:1:child_process (via tests/a.test.ts)",
      ]);
    });
  });

  it("control 2: an allowlisted test importing the built dist is red", () => {
    withTempRoot((root) => {
      writeIn(
        root,
        "tests/a.test.ts",
        `import { x } from "../dist/index.js";\nvoid x;\n`,
      );
      const { problems } = classifyTests(root, ["tests/a.test.ts"], {});
      expect(problems).toEqual([
        "tests/a.test.ts:1:dist (via tests/a.test.ts)",
      ]);
    });
  });

  it("control 3: a support module two hops away that spawns is red", () => {
    withTempRoot((root) => {
      writeIn(root, "tests/a.test.ts", `import "./support/a.js";\n`);
      writeIn(root, "tests/support/a.ts", `import "./b.js";\n`);
      writeIn(
        root,
        "tests/support/b.ts",
        `import { spawn } from "node:child_process";\nspawn("x");\n`,
      );
      const { problems } = classifyTests(root, ["tests/a.test.ts"], {});
      expect(problems).toEqual([
        "tests/support/b.ts:1:child_process (via tests/a.test.ts)",
      ]);
    });
  });

  it("control 4: an unclassified new test file is red", () => {
    withTempRoot((root) => {
      writeIn(root, "tests/a.test.ts", `export {};\n`);
      writeIn(root, "tests/new.test.ts", `export {};\n`);
      const { problems } = classifyTests(root, ["tests/a.test.ts"], {});
      expect(problems).toEqual(["tests/new.test.ts: unclassified test file"]);
    });
  });

  it("control 5: an allowlist with no jpeg test reports the missing group", () => {
    expect(
      checkFormatCoverage([
        "tests/webp.test.ts",
        "tests/png.test.ts",
        "tests/isobmff.test.ts",
        "tests/exif.test.ts",
      ]),
    ).toEqual(["format group jpeg has no allowlisted test"]);
  });

  it("control 6: an empty allowlist is reported, not passed vacuously", () => {
    expect(checkFormatCoverage([])).toEqual(["allowlist is empty"]);
  });

  it("does not count a comment mentioning child_process", () => {
    expect(
      findForbiddenReferences(
        `// child_process spawn exiftool\n/** oracle benchmark */\nconst a = 1;\n`,
        "c.ts",
      ),
    ).toEqual([]);
  });

  it("flags every forbidden class on a literal", () => {
    for (const literal of [
      "spawn",
      "execFile",
      "fork(",
      "exiftool",
      "oracle",
      "benchmark",
      "tests/corpus",
      "addon.node",
    ]) {
      expect(
        findForbiddenReferences(`const a = "${literal}";\n`, "c.ts"),
      ).toHaveLength(1);
    }
  });

  it("reports a doubly classified and a stale entry", () => {
    withTempRoot((root) => {
      writeIn(root, "tests/a.test.ts", `export {};\n`);
      const { problems } = classifyTests(
        root,
        ["tests/a.test.ts", "tests/gone.test.ts"],
        {
          "tests/a.test.ts": { class: "oracle", reason: "r" },
          "tests/old.test.ts": { class: "oracle", reason: "r" },
        },
      );
      expect(problems).toEqual([
        "tests/a.test.ts: classified twice",
        "tests/gone.test.ts: stale allowlist entry",
        "tests/old.test.ts: stale exclusion entry",
      ]);
    });
  });

  it("reports a fixed tmpdir name and accepts mkdtemp", () => {
    withTempRoot((root) => {
      writeIn(
        root,
        "tests/fixed.test.ts",
        `import { tmpdir } from "node:os";\nconst p = tmpdir();\nvoid p;\n`,
      );
      writeIn(
        root,
        "tests/unique.test.ts",
        `import { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nmkdtempSync(tmpdir());\n`,
      );
      const { problems } = classifyTests(
        root,
        ["tests/fixed.test.ts", "tests/unique.test.ts"],
        {},
      );
      expect(problems).toEqual([
        "tests/fixed.test.ts:2:tmpdir-without-mkdtemp (via tests/fixed.test.ts)",
      ]);
    });
  });

  it("stays inside tests/: a ../src import is not followed", () => {
    withTempRoot((root) => {
      writeIn(root, "tests/a.test.ts", `import "../src/x.js";\n`);
      writeIn(
        root,
        "src/x.ts",
        `import { spawn } from "node:child_process";\n`,
      );
      expect(importClosure(root, "tests/a.test.ts")).toEqual([
        "tests/a.test.ts",
      ]);
    });
  });
});
