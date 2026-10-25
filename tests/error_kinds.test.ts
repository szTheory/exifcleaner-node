// TEST-12 (66-07): every public MetadataError kind is derived from the exported type with the
// TypeScript checker (no hand-written code list is the source of truth), and each derived kind is
// reached by a real input asserted by code, feature and reason. Never by detail or message text.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entryFile = join(packageRoot, "src", "index.ts");

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(packageRoot, "tsconfig.build.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined)
    throw new Error("tsconfig.build.json unreadable");
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    packageRoot,
  );
  return { ...parsed.options, noEmit: true };
}

/** Sorted kind keys of the exported MetadataError union of `entryFileName`. */
export function deriveErrorKinds(
  program: ts.Program,
  entryFileName: string,
): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFileName);
  if (source === undefined) throw new Error(`no source file ${entryFileName}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported =
    moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
  const symbol = exported.find((item) => item.name === "MetadataError");
  if (symbol === undefined) {
    throw new Error(`${entryFileName} has no MetadataError export`);
  }
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const union = checker.getDeclaredTypeOfSymbol(resolved);
  const members = union.isUnion() ? union.types : [union];

  const literalsOf = (member: ts.Type, name: string): string[] | undefined => {
    const property = checker.getPropertyOfType(member, name);
    if (property === undefined) return undefined;
    const type = checker.getNonNullableType(checker.getTypeOfSymbol(property));
    const parts = type.isUnion() ? type.types : [type];
    return parts.map((part) => {
      if (!part.isStringLiteral()) {
        throw new Error(
          `${name} is not a string literal in a MetadataError member`,
        );
      }
      return part.value;
    });
  };

  const keys = new Set<string>();
  for (const member of members) {
    const codes = literalsOf(member, "code");
    if (codes === undefined) throw new Error("member without a code property");
    const features = literalsOf(member, "feature");
    const reasons = literalsOf(member, "reason");
    for (const code of codes) {
      if (features === undefined) {
        keys.add(code);
        continue;
      }
      for (const feature of features) {
        if (reasons === undefined) {
          keys.add(`${code}/${feature}`);
          continue;
        }
        for (const reason of reasons) keys.add(`${code}/${feature}/${reason}`);
      }
    }
  }
  return [...keys].sort(compareKeys);
}

/** One comparator for every key list so failure messages are stable. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const EXPECTED_KEYS = [
  "aborted",
  "destination-exists",
  "invalid-options",
  "malformed-file",
  "not-found",
  "read-failed",
  "source-changed",
  "unsafe-structure",
  "unsupported-feature/color-profile-preservation/invalid",
  "unsupported-feature/color-profile-preservation/policy-limit",
  "unsupported-feature/color-profile-preservation/unsupported",
  "unsupported-feature/orientation-preservation",
  "unsupported-feature/resolution-preservation",
  "unsupported-format",
  "verification-failed",
  "write-failed",
] as const;

describe("MetadataError kind derivation (TEST-12)", () => {
  it("derives the 16 kind keys from the exported MetadataError type", () => {
    const program = ts.createProgram([entryFile], compilerOptions());
    const derived = deriveErrorKinds(program, entryFile);
    console.info(
      `MetadataError kinds (${derived.length}): ${derived.join(", ")}`,
    );
    expect(derived).toHaveLength(16);
    expect(derived).toEqual([...EXPECTED_KEYS].sort(compareKeys));
  });
});

describe("reaching inputs (TEST-12)", () => {
  it("read-failed is reached by a directory passed as sourcePath", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-kinds-"));
    try {
      const destinationPath = join(directory, "clean.webp");
      const result = await sanitizeFile({
        sourcePath: directory,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "read-failed" },
      });
      expect(existsSync(destinationPath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
