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

/** fc.assert and fc.check take (property, parameters); fc.sample takes (generator, parameters); fc.statistics takes (arbitrary, classify, parameters). */
const PARAMETER_INDEX: Readonly<Record<string, number>> = Object.freeze({
  assert: 1,
  check: 1,
  statistics: 2,
  sample: 1,
});

/**
 * Sorted 1-based line numbers of every `fc.assert`, `fc.check`,
 * `fc.sample` or `fc.statistics` call whose parameters argument is absent, a
 * numeric literal (numRuns with a random seed), or an object literal with
 * neither a usable `seed` property (not `seed: undefined`) nor a spread
 * element. Identifiers and
 * call expressions (shared config from kit/replay.ts) are accepted: the guard
 * cannot see through them and they are the seeded-config pattern.
 */
export function findUnseededFastCheckCalls(
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
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "fc" &&
      Object.hasOwn(PARAMETER_INDEX, node.expression.name.text)
    ) {
      const parameters =
        node.arguments[PARAMETER_INDEX[node.expression.name.text]!];
      let seeded: boolean;
      if (parameters === undefined) {
        seeded = false;
      } else if (ts.isNumericLiteral(parameters)) {
        seeded = false;
      } else if (ts.isObjectLiteralExpression(parameters)) {
        seeded = parameters.properties.some((property) => {
          if (ts.isSpreadAssignment(property)) return true;
          if (property.name === undefined) return false;
          const isSeedKey =
            (ts.isIdentifier(property.name) && property.name.text === "seed") ||
            (ts.isStringLiteral(property.name) &&
              property.name.text === "seed");
          if (!isSeedKey) return false;
          return !(
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.initializer) &&
            property.initializer.text === "undefined"
          );
        });
      } else {
        seeded = true;
      }
      if (!seeded) {
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

const SCANNED_EXTENSIONS = /\.(?:ts|mts|cts)$/;

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

/** `<path>:<line>` for every unseeded call under `root/tests` (minus tests/corpus), sorted. */
export function scanTestsForUnseeded(root: string): string[] {
  const files: string[] = [];
  walk(root, join(root, "tests"), files);
  const hits: string[] = [];
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join("/");
    for (const line of findUnseededFastCheckCalls(
      readFileSync(file, "utf8"),
      file,
    )) {
      hits.push(`${relativePath}:${line}`);
    }
  }
  return hits.sort();
}

describe("every fast-check run is seeded (G7)", () => {
  it("finds no unseeded fc.assert, fc.check, fc.sample or fc.statistics under tests/", () => {
    expect(scanTestsForUnseeded(packageRoot)).toEqual([]);
  });

  it("flags a bare fc.assert and one whose parameters have no seed", () => {
    expect(
      findUnseededFastCheckCalls(
        "fc.assert(fc.property(fc.nat(), () => true));",
        "a.ts",
      ),
    ).toEqual([1]);
    expect(
      findUnseededFastCheckCalls("\nfc.assert(p, { numRuns: 40 });", "a.ts"),
    ).toEqual([2]);
    expect(
      findUnseededFastCheckCalls(
        "fc.statistics(a, c, { numRuns: 5 });",
        "a.ts",
      ),
    ).toEqual([1]);
    expect(findUnseededFastCheckCalls("fc.check(p);", "a.ts")).toEqual([1]);
  });

  it("flags a numeric parameters argument, fc.sample and seed: undefined (WR-05)", () => {
    expect(
      findUnseededFastCheckCalls("fc.statistics(a, c, 100);", "a.ts"),
    ).toEqual([1]);
    expect(findUnseededFastCheckCalls("fc.sample(arb, 50);", "a.ts")).toEqual([
      1,
    ]);
    expect(findUnseededFastCheckCalls("fc.sample(arb);", "a.ts")).toEqual([1]);
    expect(
      findUnseededFastCheckCalls("fc.assert(p, { seed: undefined });", "a.ts"),
    ).toEqual([1]);
    expect(
      findUnseededFastCheckCalls(
        "fc.sample(arb, { numRuns: 3, seed: 7 });",
        "a.ts",
      ),
    ).toEqual([]);
  });

  it("accepts a seed property, a spread and a shared config", () => {
    expect(
      findUnseededFastCheckCalls(
        "fc.assert(p, { numRuns: 40, seed: 460_046 });",
        "a.ts",
      ),
    ).toEqual([]);
    expect(findUnseededFastCheckCalls("fc.check(p, config);", "a.ts")).toEqual(
      [],
    );
    expect(
      findUnseededFastCheckCalls("fc.check(p, { ...REPLAY_PARAMS });", "a.ts"),
    ).toEqual([]);
    expect(
      findUnseededFastCheckCalls("fc.statistics(a, c, cfg());", "a.ts"),
    ).toEqual([]);
  });

  it("flags an unseeded file in a temporary tests tree", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-seed-guard-"));
    try {
      mkdirSync(join(root, "tests"));
      writeFileSync(
        join(root, "tests", "bad.test.ts"),
        "import fc from 'fast-check';\nfc.assert(fc.property(fc.nat(), () => true));\n",
      );
      writeFileSync(
        join(root, "tests", "good.test.ts"),
        "fc.assert(p, { seed: 1 });\n",
      );
      expect(scanTestsForUnseeded(root)).toEqual(["tests/bad.test.ts:2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
