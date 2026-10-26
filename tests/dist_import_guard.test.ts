import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** A path segment named exactly `dist`, at either end or between separators. */
const DIST_SEGMENT = /(^|[/\\])dist([/\\]|$)/;

/**
 * Sorted 1-based line numbers, one per string-like literal (a line holding two
 * literals appears twice), for every literal whose text names a
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
  const lines: number[] = [];
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
        lines.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines.sort((a, b) => a - b);
}

export interface DistScanEntry {
  relativePath: string;
  lines: number[];
}

const SCANNED_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function walk(root: string, directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (full === join(root, "tests", "corpus")) continue;
      walk(root, full, files);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.test(entry.name)) {
      files.push(full);
    }
  }
}

/** Every file under `root/tests` (minus tests/corpus and node_modules) holding a dist literal. */
export function scanTestsForDist(root: string): DistScanEntry[] {
  const files: string[] = [];
  walk(root, join(root, "tests"), files);
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

/** Files that may keep a dist literal, with the reason. Exactness is asserted by checkAllowlist. */
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
  // Two digest-contract strings; the dynamic import now names src.
  "tests/qualification/webp/benchmark.test.ts": {
    class: "path-data",
    expectedLiteralCount: 2,
  },
  // This file's own fixtures; count re-measured after the controls.
  "tests/dist_import_guard.test.ts": {
    class: "guard-self",
    expectedLiteralCount: 10,
  },
  // Mutation include guard: its negative-control fixtures carry dist imports.
  "tests/mutation_include_guard.test.ts": {
    class: "guard-self",
    expectedLiteralCount: 2,
  },
});

export type AllowlistShape = Readonly<
  Record<string, { class: string; expectedLiteralCount: number }>
>;

/** Problem strings for every allowlist entry that is stale, drifted or missing. */
export function checkAllowlist(
  scanResult: readonly DistScanEntry[],
  allowlist: AllowlistShape,
): string[] {
  const hits = new Map(scanResult.map((e) => [e.relativePath, e.lines.length]));
  const problems: string[] = [];
  for (const path of Object.keys(allowlist).sort()) {
    const expected = allowlist[path]?.expectedLiteralCount;
    const actual = hits.get(path) ?? 0;
    if (actual === 0) {
      problems.push(`${path}: stale allowlist entry, no dist literal found`);
    } else if (actual !== expected) {
      problems.push(
        `${path}: expected ${expected} dist literals, actual ${actual}`,
      );
    }
  }
  return problems;
}

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

describe("whole-tree dist guard", () => {
  const scan = scanTestsForDist(packageRoot);

  it("allows no dist literal outside the allowlist (d)", () => {
    const offenders = scan
      .filter((entry) => !(entry.relativePath in ALLOWLIST))
      .flatMap((entry) =>
        [...new Set(entry.lines)].map(
          (line) => `${entry.relativePath}:${line}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("holds every allowlist entry to its exact literal count (e)", () => {
    expect(checkAllowlist(scan, ALLOWLIST)).toEqual([]);
  });

  it("keeps the allowlist at eleven classed entries (f)", () => {
    const classes = new Set([
      "public-contract",
      "runtime-surface",
      "package-surface",
      "memory-child",
      "path-data",
      "guard-self",
    ]);
    const entries = Object.values(ALLOWLIST);
    expect(entries).toHaveLength(11);
    for (const entry of entries) expect(classes.has(entry.class)).toBe(true);
  });
});

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dist-guard-"));
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

const SIX_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"] as const;
const DIST_IMPORT = `import x from "../dist/index.js";\n`;

describe("negative controls (TEST-09)", () => {
  it("control 1: an unlisted file per extension is reported, sorted", () => {
    withTempRoot((root) => {
      for (const ext of [...SIX_EXTENSIONS].reverse()) {
        writeIn(root, `tests/unlisted.${ext}`, DIST_IMPORT);
      }
      const found = scanTestsForDist(root).map((e) => e.relativePath);
      const expected = SIX_EXTENSIONS.map((e) => `tests/unlisted.${e}`).sort(
        (a, b) => a.localeCompare(b),
      );
      expect(found).toEqual(expected);
      expect(found).toHaveLength(6);
    });
  });

  it("control 2: an allowlisted file that lost its literal is stale", () => {
    withTempRoot((root) => {
      const original = readFileSync(
        join(packageRoot, "tests/png_memory_child.mjs"),
        "utf8",
      );
      const rewritten = original.replaceAll("dist/", "src/");
      expect(rewritten).not.toBe(original);
      writeIn(root, "tests/png_memory_child.mjs", rewritten);
      const problems = checkAllowlist(scanTestsForDist(root), {
        "tests/png_memory_child.mjs": ALLOWLIST["tests/png_memory_child.mjs"]!,
      });
      expect(problems.join("\n")).toContain("stale");
    });
  });

  it("control 3: a count drift names expected and actual", () => {
    withTempRoot((root) => {
      const original = readFileSync(
        join(packageRoot, "tests/isobmff_memory_child.mjs"),
        "utf8",
      );
      const drifted = `${original}\nconst extra = "../dist/extra.js";\n`;
      expect(drifted).not.toBe(original);
      writeIn(root, "tests/isobmff_memory_child.mjs", drifted);
      const problems = checkAllowlist(scanTestsForDist(root), {
        "tests/isobmff_memory_child.mjs":
          ALLOWLIST["tests/isobmff_memory_child.mjs"]!,
      });
      expect(problems.join("\n")).toMatch(/expected 2 .*actual 3/);
    });
  });

  it("control 4: tests/corpus is the only excluded directory", () => {
    withTempRoot((root) => {
      writeIn(root, "tests/corpus/hidden.ts", DIST_IMPORT);
      writeIn(root, "tests/other/visible.ts", DIST_IMPORT);
      const found = scanTestsForDist(root).map((e) => e.relativePath);
      expect(found).toEqual(["tests/other/visible.ts"]);
    });
  });

  it("control 5: two scans of the same tree are deep-equal", () => {
    withTempRoot((root) => {
      for (const ext of SIX_EXTENSIONS) {
        writeIn(root, `tests/unlisted.${ext}`, DIST_IMPORT);
      }
      const first = scanTestsForDist(root);
      expect(first).toHaveLength(6);
      expect(scanTestsForDist(root)).toEqual(first);
    });
  });

  it("control 6: an in-memory dist import is flagged", () => {
    expect(findDistReferences(DIST_IMPORT, "memory.ts")).toEqual([1]);
  });
});
