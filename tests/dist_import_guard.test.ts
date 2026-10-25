import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** A path segment named exactly `dist`, at either end or between separators. */
const DIST_SEGMENT = /(^|[/\\])dist([/\\]|$)/;

/**
 * Sorted 1-based line numbers of every string-like literal whose text names a
 * `dist` path segment. Comments, identifiers and regex literals never count:
 * only StringLiteral, NoSubstitutionTemplateLiteral and template parts do.
 */
export function findDistReferences(
  sourceText: string,
  fileName: string,
): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (DIST_SEGMENT.test(node.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        lines.add(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...lines].sort((a, b) => a - b);
}

export interface DistScanEntry {
  relativePath: string;
  lines: number[];
}

const SCANNED_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (full === join(packageRoot, "tests", "corpus")) continue;
      walk(full, files);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.test(entry.name)) {
      files.push(full);
    }
  }
}

/** Every file under `root/tests` (minus tests/corpus and node_modules) holding a dist literal. */
export function scanTestsForDist(root: string): DistScanEntry[] {
  const files: string[] = [];
  walk(join(root, "tests"), files);
  const entries: DistScanEntry[] = [];
  for (const file of files) {
    const lines = findDistReferences(readFileSync(file, "utf8"), file);
    if (lines.length > 0) {
      entries.push({
        relativePath: relative(root, file).split(sep).join("/"),
        lines,
      });
    }
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

type AllowClass =
  | "public-contract"
  | "runtime-surface"
  | "package-surface"
  | "memory-child"
  | "path-data"
  | "guard-self";

/** Files that may keep a dist literal, with the reason. Exactness is asserted in 66-03. */
export const ALLOWLIST: Readonly<
  Record<string, { class: AllowClass; expectedLiteralCount: number }>
> = Object.freeze({
  // Asserts the shipped export map and built entry points.
  "tests/public_contract.test.ts": {
    class: "public-contract",
    expectedLiteralCount: 5,
  },
  // Proves the fallback path against the built package.
  "tests/fallback.test.ts": {
    class: "runtime-surface",
    expectedLiteralCount: 1,
  },
  // Gates the runtime surface of the compiled build.
  "tests/runtime_surface_gate.test.ts": {
    class: "runtime-surface",
    expectedLiteralCount: 13,
  },
  // Smoke-tests the packed tarball.
  "tests/package_smoke.test.ts": {
    class: "package-surface",
    expectedLiteralCount: 1,
  },
  // Asserts the built ISOBMFF surface.
  "tests/isobmff_surface.test.ts": {
    class: "runtime-surface",
    expectedLiteralCount: 7,
  },
  // Child process measuring memory of the shipped PNG build.
  "tests/png_memory_child.mjs": {
    class: "memory-child",
    expectedLiteralCount: 1,
  },
  // Child process measuring memory of the shipped ISOBMFF build.
  "tests/isobmff_memory_child.mjs": {
    class: "memory-child",
    expectedLiteralCount: 2,
  },
  // CI scope classifier: dist is path data it classifies, not an import.
  "tests/classify_ci_scope.test.ts": {
    class: "path-data",
    expectedLiteralCount: 11,
  },
  // Holds 3 until 66-03 repoints its dynamic import.
  "tests/qualification/webp/benchmark.test.ts": {
    class: "path-data",
    expectedLiteralCount: 2,
  },
  // This file's own fixtures; count measured after writing.
  "tests/dist_import_guard.test.ts": {
    class: "guard-self",
    expectedLiteralCount: 7,
  },
});

/** Offenders not yet repointed to src. This list can only shrink. */
export const PENDING_REPOINT: readonly string[] = Object.freeze([
  "tests/qualification/webp/golden.test.ts",
  "tests/qualification/webp/oracles.test.ts",
  "tests/qualification/webp/parser.test.ts",
  "tests/qualification/webp/property.test.ts",
]);

describe("findDistReferences matcher", () => {
  it.each([
    ["relative import", `import x from "../dist/index.js";`],
    ["bare segment", `const a = "dist";`],
    ["nested relative", `import x from "../../dist/png/chunks.js";`],
    ["backslash form", `const a = "..\\\\dist\\\\x.js";`],
    ["template literal", "const a = `${root}/dist/index.js`;"],
  ])("flags %s", (_name, text) => {
    expect(findDistReferences(text, "fixture.ts")).toEqual([1]);
  });

  it.each([
    ["longer segment", `const a = "distribution/x";`],
    ["colon suffix", `const a = "check:dist";`],
    ["prefixed segment", `const a = "predist/";`],
    ["hyphenated segment", `const a = "dist-utils";`],
    ["line comment", `// ../dist/index.js\nconst a = 1;`],
    ["jsdoc mention", `/** Loads ../dist/index.js lazily. */\nconst a = 1;`],
  ])("does not flag %s", (_name, text) => {
    expect(findDistReferences(text, "fixture.ts")).toEqual([]);
  });

  it("reports sorted 1-based line numbers", () => {
    const text = `const a = 1;\nconst b = "dist/x";\nconst c = "../dist/y";\n`;
    expect(findDistReferences(text, "fixture.ts")).toEqual([2, 3]);
  });
});

describe("findDistReferences empty edge", () => {
  it("yields nothing for empty text", () => {
    expect(findDistReferences("", "empty.ts")).toEqual([]);
  });

  it("yields nothing for a file with no literals", () => {
    expect(findDistReferences("const a = 1 + 2;\n", "none.ts")).toEqual([]);
  });
});

describe("tracer", () => {
  it("png_chunks.test.ts no longer references dist", () => {
    const text = readFileSync(
      join(packageRoot, "tests", "png_chunks.test.ts"),
      "utf8",
    );
    expect(findDistReferences(text, "png_chunks.test.ts")).toEqual([]);
  });
});

describe("dist-import ratchet", () => {
  const offenders = scanTestsForDist(packageRoot).filter(
    (entry) => !(entry.relativePath in ALLOWLIST),
  );

  it("allows no dist offender outside the frozen pending list", () => {
    console.info(`dist offenders outside allowlist: ${offenders.length}`);
    console.info(offenders.map((o) => o.relativePath).join("\n"));
    const unlisted = offenders
      .filter((o) => !PENDING_REPOINT.includes(o.relativePath))
      .flatMap((o) => o.lines.map((line) => `${o.relativePath}:${line}`));
    expect(unlisted).toEqual([]);
  });

  it("holds no stale pending entry", () => {
    const offenderPaths = new Set(offenders.map((o) => o.relativePath));
    const stale = PENDING_REPOINT.filter((p) => !offenderPaths.has(p));
    expect(stale, `stale pending: ${stale.join(", ")}`).toEqual([]);
  });
});
