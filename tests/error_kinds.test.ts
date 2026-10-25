// TEST-12 (66-07): every public MetadataError kind is derived from the exported type with the
// TypeScript checker (no hand-written code list is the source of truth), and each derived kind is
// reached by a real input asserted by code, feature and reason. Never by detail or message text.
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { getCapabilities, inspectFile, sanitizeFile } from "../src/index.js";
import type {
  MetadataError,
  PngCapabilities,
  WebpCapabilities,
} from "../src/index.js";
import { parsePng, PngStructureError } from "../src/png/chunks.js";
import { parseWebp, WebpStructureError } from "../src/webp/riff.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import type { RegisteredHandler } from "../src/admission/registry.js";
import { webpHandler } from "../src/admission/webp-handler.js";
import {
  iccProfileV4,
  metadataWebp,
  mutateIccProfile,
  vp8,
  vp8x,
  webp,
} from "./fixtures.js";
import { materializeMutationCase } from "./qualification/webp/generators.js";
import {
  hostileMutationCases as pngHostileCases,
  materializeMutationCase as materializePngCase,
} from "./qualification/png/generators.js";
import { hostileMutationCases as webpHostileCases } from "./qualification/webp/generators.js";

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

/** Compile-time mirror of the runtime key format of deriveErrorKinds. */
type KeyOf<E> = E extends {
  readonly code: infer C extends string;
  readonly feature: infer F extends string;
  readonly reason: infer R extends string;
}
  ? `${C}/${F}/${R}`
  : E extends {
        readonly code: infer C extends string;
        readonly feature: infer F extends string;
      }
    ? `${C}/${F}`
    : E extends { readonly code: infer C extends string }
      ? C
      : never;
type ErrorKindKey = KeyOf<MetadataError>;

interface Expectation {
  readonly code: string;
  readonly feature?: string;
  readonly reason?: string;
}

interface Ran {
  readonly result: { readonly ok: boolean };
  readonly destinationPath: string;
  /** true when the case itself plants the destination (destination-exists). */
  readonly destinationPlanted?: boolean;
}

interface ReachingCase {
  run(directory: string): Promise<Ran>;
  readonly expect: Expectation;
}

const NO_PRESERVATION = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
} as const;

async function sanitizeWebp(
  directory: string,
  bytes: Buffer,
  overrides: Partial<Parameters<typeof sanitizeFile>[0]> = {},
): Promise<Ran> {
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "clean.webp");
  await writeFile(sourcePath, bytes);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...NO_PRESERVATION,
    ...overrides,
  });
  return { result, destinationPath };
}

/** A real webp handler wrapped so one stage misbehaves after the real write. */
async function withWrappedWebp(
  directory: string,
  afterWrite: (
    destination: import("node:fs/promises").FileHandle,
  ) => Promise<void>,
  afterVerify?: () => Promise<void>,
): Promise<Ran> {
  const inner: RegisteredHandler = webpHandler;
  const wrapped: RegisteredHandler = {
    ...inner,
    async writeOutput(source, destination, plan, signal) {
      await inner.writeOutput(source, destination, plan, signal);
      await afterWrite(destination);
    },
    async verifyOutput(...args) {
      const verified = await inner.verifyOutput(...args);
      await afterVerify?.();
      return verified;
    },
  };
  const restore = setRegisteredHandlersForTests([wrapped]);
  try {
    return await sanitizeWebp(directory, metadataWebp());
  } finally {
    restore();
  }
}

function webpWithExif(exif: Buffer): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x08) },
    { fourCc: "VP8 ", data: vp8() },
    { fourCc: "EXIF", data: exif },
  ]);
}

function webpWithIcc(profile: Buffer): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x20) },
    { fourCc: "ICCP", data: profile },
    { fourCc: "VP8 ", data: vp8() },
  ]);
}

async function writeOversizedIccpWebp(path: string): Promise<void> {
  const metadataSize = 16 * 1024 * 1024 + 1;
  const fileSize = 12 + 18 + 8 + metadataSize + (metadataSize & 1) + 18;
  const header = Buffer.alloc(38);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WEBP", 8, 4, "ascii");
  header.write("VP8X", 12, 4, "ascii");
  header.writeUInt32LE(10, 16);
  header[20] = 0x20;
  header.write("ICCP", 30, 4, "ascii");
  header.writeUInt32LE(metadataSize, 34);
  const handle = await open(path, "w+");
  try {
    await handle.write(header);
    await handle.truncate(fileSize);
  } finally {
    await handle.close();
  }
}

async function materialized(id: string, directory: string): Promise<Buffer> {
  const { prefix, fileSize } = materializeMutationCase(id);
  if (fileSize !== prefix.length) {
    throw new Error(`case ${id} is not a plain prefix`);
  }
  await writeFile(join(directory, "unused"), "");
  return prefix;
}

const REACHING = {
  aborted: {
    run: async (directory) => {
      const controller = new AbortController();
      controller.abort();
      return sanitizeWebp(directory, metadataWebp(), {
        signal: controller.signal,
      });
    },
    expect: { code: "aborted" },
  },
  "destination-exists": {
    run: async (directory) => {
      const sourcePath = join(directory, "source.webp");
      const destinationPath = join(directory, "clean.webp");
      await writeFile(sourcePath, metadataWebp());
      await writeFile(destinationPath, "do not replace");
      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...NO_PRESERVATION,
      });
      return { result, destinationPath, destinationPlanted: true };
    },
    expect: { code: "destination-exists" },
  },
  "invalid-options": {
    run: (directory) =>
      sanitizeWebp(directory, metadataWebp(), {
        preserveResolution: "yes" as unknown as boolean,
      }),
    expect: { code: "invalid-options" },
  },
  "malformed-file": {
    run: async (directory) =>
      sanitizeWebp(
        directory,
        await materialized("truncated-last-byte", directory),
      ),
    expect: { code: "malformed-file" },
  },
  "not-found": {
    run: async (directory) => {
      const destinationPath = join(directory, "clean.webp");
      const result = await sanitizeFile({
        sourcePath: join(directory, "missing.webp"),
        destinationPath,
        ...NO_PRESERVATION,
      });
      return { result, destinationPath };
    },
    expect: { code: "not-found" },
  },
  "read-failed": {
    run: async (directory) => {
      const destinationPath = join(directory, "clean.webp");
      const result = await sanitizeFile({
        sourcePath: directory,
        destinationPath,
        ...NO_PRESERVATION,
      });
      return { result, destinationPath };
    },
    expect: { code: "read-failed" },
  },
  "source-changed": {
    run: (directory) =>
      withWrappedWebp(
        directory,
        async () => undefined,
        async () => writeFile(join(directory, "source.webp"), "changed source"),
      ),
    expect: { code: "source-changed" },
  },
  "unsafe-structure": {
    run: async (directory) =>
      sanitizeWebp(
        directory,
        await materialized("private-top-level-chunk", directory),
      ),
    expect: { code: "unsafe-structure" },
  },
  "unsupported-feature/color-profile-preservation/invalid": {
    run: (directory) =>
      sanitizeWebp(
        directory,
        webpWithIcc(mutateIccProfile(iccProfileV4(), "signature")),
        { preserveColorProfile: true },
      ),
    expect: {
      code: "unsupported-feature",
      feature: "color-profile-preservation",
      reason: "invalid",
    },
  },
  "unsupported-feature/color-profile-preservation/policy-limit": {
    run: async (directory) => {
      const sourcePath = join(directory, "source.webp");
      const destinationPath = join(directory, "clean.webp");
      await writeOversizedIccpWebp(sourcePath);
      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...NO_PRESERVATION,
        preserveColorProfile: true,
      });
      return { result, destinationPath };
    },
    expect: {
      code: "unsupported-feature",
      feature: "color-profile-preservation",
      reason: "policy-limit",
    },
  },
  "unsupported-feature/color-profile-preservation/unsupported": {
    run: (directory) => {
      const profile = iccProfileV4();
      profile.write("prtr", 12, 4, "ascii");
      return sanitizeWebp(directory, webpWithIcc(profile), {
        preserveColorProfile: true,
      });
    },
    expect: {
      code: "unsupported-feature",
      feature: "color-profile-preservation",
      reason: "unsupported",
    },
  },
  "unsupported-feature/orientation-preservation": {
    run: (directory) =>
      sanitizeWebp(directory, webpWithExif(Buffer.from("bad")), {
        preserveOrientation: true,
      }),
    expect: {
      code: "unsupported-feature",
      feature: "orientation-preservation",
    },
  },
  "unsupported-feature/resolution-preservation": {
    run: (directory) =>
      sanitizeWebp(directory, metadataWebp(), { preserveResolution: true }),
    expect: {
      code: "unsupported-feature",
      feature: "resolution-preservation",
    },
  },
  "unsupported-format": {
    run: (directory) => sanitizeWebp(directory, Buffer.from("not an image")),
    expect: { code: "unsupported-format" },
  },
  "verification-failed": {
    run: (directory) =>
      withWrappedWebp(directory, async (destination) => {
        const { size } = await destination.stat();
        const byte = Buffer.alloc(1);
        await destination.read(byte, 0, 1, size - 1);
        byte[0] = byte[0]! ^ 0xff;
        await destination.write(byte, 0, 1, size - 1);
      }),
    expect: { code: "verification-failed" },
  },
  "write-failed": {
    run: (directory) =>
      withWrappedWebp(directory, async () => {
        throw new Error("injected write failure");
      }),
    expect: { code: "write-failed" },
  },
} as const satisfies Record<ErrorKindKey, ReachingCase>;

/** Keys present in exactly one of the two lists, by exact string equality. */
function compareKinds(
  derived: readonly string[],
  table: readonly string[],
): { readonly missing: string[]; readonly extra: string[] } {
  const tableSet = new Set(table);
  const derivedSet = new Set(derived);
  return {
    missing: derived.filter((key) => !tableSet.has(key)).sort(compareKeys),
    extra: table.filter((key) => !derivedSet.has(key)).sort(compareKeys),
  };
}

/** Equality that refuses an empty derivation instead of passing vacuously. */
function assertKindsEqual(
  derived: readonly string[],
  table: readonly string[],
): void {
  if (derived.length === 0) throw new Error("derived kind set is empty");
  const { missing, extra } = compareKinds(derived, table);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `kind mismatch: no reaching input for [${missing.join(", ")}]; table has unknown [${extra.join(", ")}]`,
    );
  }
}

const REACHING_KEYS = Object.keys(REACHING).sort(compareKeys);

describe("reaching inputs (TEST-12)", () => {
  it("derived kinds and REACHING keys are equal in both directions", () => {
    const program = ts.createProgram([entryFile], compilerOptions());
    const derived = deriveErrorKinds(program, entryFile);
    expect(compareKinds(derived, REACHING_KEYS)).toEqual({
      missing: [],
      extra: [],
    });
    expect(REACHING_KEYS).toEqual(derived);
    expect(() => assertKindsEqual(derived, REACHING_KEYS)).not.toThrow();
  });

  it.each(REACHING_KEYS)("%s is reached by a real input", async (key) => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-kinds-"));
    try {
      const reaching: ReachingCase = REACHING[key as ErrorKindKey];
      const { result, destinationPath, destinationPlanted } =
        await reaching.run(directory);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ error: reaching.expect });
      if (destinationPlanted === true) {
        expect(await readFile(destinationPath, "utf8")).toBe("do not replace");
      } else {
        expect(existsSync(destinationPath)).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("inspectFile reaches not-found by code alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-kinds-"));
    try {
      expect(await inspectFile(join(directory, "missing.webp"))).toMatchObject({
        ok: false,
        error: { code: "not-found" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** The real program, but with one file's text replaced in memory. */
function programWithOverride(
  overridePath: string,
  transform: (text: string) => string,
): { program: ts.Program; original: string; changed: string } {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const original = readFileSyncText(overridePath);
  const changed = transform(original);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === overridePath
      ? ts.createSourceFile(fileName, changed, languageVersion, true)
      : realGetSourceFile(fileName, languageVersion, ...rest);
  return {
    program: ts.createProgram([entryFile], options, host),
    original,
    changed,
  };
}

function readFileSyncText(path: string): string {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error(`cannot read ${path}`);
  return text;
}

describe("derivation and table controls (TEST-12)", () => {
  it("control A: an extra union member is reported as the new key", () => {
    const { program, original, changed } = programWithOverride(
      join(packageRoot, "src", "types.ts"),
      (text) =>
        text.replace(
          "export type MetadataError =\n",
          'export type MetadataError =\n  | { readonly code: "phantom-kind" }\n',
        ),
    );
    expect(changed).not.toBe(original);
    const derived = deriveErrorKinds(program, entryFile);
    expect(derived).toContain("phantom-kind");
    expect(compareKinds(derived, REACHING_KEYS)).toEqual({
      missing: ["phantom-kind"],
      extra: [],
    });
    expect(() => assertKindsEqual(derived, REACHING_KEYS)).toThrow(
      /phantom-kind/,
    );
  });

  it("control B: a satisfies Record table missing a union member is a TS error", () => {
    const fixtureEntry = join(packageRoot, "tests", "__error_kinds_fixture.ts");
    const diagnosticsFor = (table: string): string[] => {
      const source = [
        'type U = { code: "a" } | { code: "b" } | { code: "c" };',
        `const table = ${table} satisfies Record<U["code"], number>;`,
        "export { table };",
      ].join("\n");
      const options: ts.CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      };
      const host = ts.createCompilerHost(options);
      const realGetSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersion, ...rest) =>
        fileName === fixtureEntry
          ? ts.createSourceFile(fileName, source, languageVersion, true)
          : realGetSourceFile(fileName, languageVersion, ...rest);
      const realFileExists = host.fileExists.bind(host);
      host.fileExists = (fileName) =>
        fileName === fixtureEntry || realFileExists(fileName);
      const program = ts.createProgram([fixtureEntry], options, host);
      return ts
        .getPreEmitDiagnostics(program)
        .filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        )
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        );
    };
    // Negative control: the complete table compiles clean, so the error below is the missing key.
    expect(diagnosticsFor("{ a: 1, b: 2, c: 3 }")).toEqual([]);
    const errors = diagnosticsFor("{ a: 1, b: 2 }");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/'c'/);
    console.info(`satisfies diagnostic: ${errors[0]}`);
  });

  it("control C: no MetadataError export throws, an empty key list fails equality", () => {
    const options = { ...compilerOptions(), noEmit: true };
    const noExport = join(packageRoot, "tests", "__error_kinds_empty.ts");
    const host = ts.createCompilerHost(options);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, ...rest) =>
      fileName === noExport
        ? ts.createSourceFile(
            fileName,
            "export const x = 1;",
            languageVersion,
            true,
          )
        : realGetSourceFile(fileName, languageVersion, ...rest);
    const realFileExists = host.fileExists.bind(host);
    host.fileExists = (fileName) =>
      fileName === noExport || realFileExists(fileName);
    const program = ts.createProgram([noExport], options, host);
    expect(() => deriveErrorKinds(program, noExport)).toThrow(
      /no MetadataError export/,
    );
    expect(() => assertKindsEqual([], REACHING_KEYS)).toThrow(/empty/);
  });

  it("keys compare by exact string equality: case and whitespace differ", () => {
    expect(compareKinds(["aborted"], ["Aborted"])).toEqual({
      missing: ["aborted"],
      extra: ["Aborted"],
    });
    expect(compareKinds(["aborted"], ["aborted "])).toEqual({
      missing: ["aborted"],
      extra: ["aborted "],
    });
  });

  it("the three color-profile reasons and three features are distinct keys", () => {
    const colour = REACHING_KEYS.filter((key) =>
      key.startsWith("unsupported-feature/color-profile-preservation/"),
    );
    expect(colour).toHaveLength(3);
    expect(new Set(colour).size).toBe(3);
    const features = REACHING_KEYS.filter((key) =>
      key.startsWith("unsupported-feature/"),
    ).map((key) => key.split("/")[1]);
    expect(new Set(features)).toEqual(
      new Set([
        "color-profile-preservation",
        "orientation-preservation",
        "resolution-preservation",
      ]),
    );
    // A case for one reason cannot satisfy another: expectations differ key for key.
    const reasons = colour.map(
      (key) => (REACHING as Record<string, ReachingCase>)[key]!.expect.reason,
    );
    expect(reasons.sort()).toEqual(["invalid", "policy-limit", "unsupported"]);
  });
});

// --- Tier 2: every declared WebP and PNG refusal is reached by a hostile input -----------------

type WebpRefusal = WebpCapabilities["refuses"][number];
type PngRefusal = PngCapabilities["refuses"][number];

interface RefusalCase {
  /** Id of a hostile case in the format's qualification generators. */
  readonly caseId: string;
  /** Public MetadataError code sanitizeFile must return. */
  readonly expectedCode:
    "malformed-file" | "unsafe-structure" | "unsupported-format";
  /** The parser's thrown error kind, or "admission-layer" when parsing succeeds. */
  readonly expectedParserKind:
    | "malformed-file"
    | "unsafe-structure"
    | "unsupported-format"
    | "admission-layer";
}

const WEBP_REFUSALS = {
  "unknown-chunks": {
    caseId: "private-top-level-chunk",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  "malformed-container": {
    caseId: "declared-size-plus-one",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  "unsupported-features": {
    caseId: "exif-flag-without-chunk",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  "resource-limits": {
    caseId: "iccp-limit-plus-one",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  "trailing-data": {
    caseId: "trailer-after-declared-boundary",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
} as const satisfies Record<WebpRefusal, RefusalCase>;

const PNG_REFUSALS = {
  "unknown-critical-chunks": {
    caseId: "unknown-critical-cgbi",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  "malformed-container": {
    caseId: "length-overflow",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  "crc-mismatch": {
    caseId: "crc-idat",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  "chunk-order": {
    caseId: "chunk-order-noncontiguous-idat",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  truncation: {
    caseId: "truncated-iend",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  "trailing-data": {
    caseId: "trailing-byte-after-iend",
    expectedCode: "malformed-file",
    expectedParserKind: "malformed-file",
  },
  animation: {
    caseId: "apng-actl",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  "resource-limits": {
    caseId: "chunk-count-idat-flood",
    expectedCode: "unsafe-structure",
    expectedParserKind: "unsafe-structure",
  },
  "unmeasured-registered-chunks": {
    caseId: "registered-unmeasured-gifg",
    expectedCode: "unsafe-structure",
    expectedParserKind: "admission-layer",
  },
  "unsafe-chunk-adjacency": {
    caseId: "idot-adjacency-text-between",
    expectedCode: "unsafe-structure",
    expectedParserKind: "admission-layer",
  },
} as const satisfies Record<PngRefusal, RefusalCase>;

/** Literals in exactly one of the table keys and the declared refuses list. */
function compareRefusalKeys(
  tableKeys: readonly string[],
  declaredRefuses: readonly string[],
): { readonly missing: string[]; readonly extra: string[] } {
  const table = new Set(tableKeys);
  const declared = new Set(declaredRefuses);
  return {
    missing: declaredRefuses.filter((key) => !table.has(key)).sort(compareKeys),
    extra: tableKeys.filter((key) => !declared.has(key)).sort(compareKeys),
  };
}

function declaredRefuses(format: "webp" | "png"): readonly string[] {
  const entry = getCapabilities().formats.find(
    (item) => item.format === format,
  );
  if (entry === undefined) throw new Error(`no ${format} capability`);
  return entry.refuses;
}

async function withHostileFile(
  extension: "webp" | "png",
  materialize: () => { prefix: Buffer; fileSize: number },
  callback: (
    sourcePath: string,
    fileSize: number,
    directory: string,
  ) => Promise<void>,
): Promise<void> {
  const { prefix, fileSize } = materialize();
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-refusal-"));
  const sourcePath = join(directory, `source.${extension}`);
  try {
    await writeFile(sourcePath, prefix);
    if (fileSize !== prefix.length) {
      const handle = await open(sourcePath, "r+");
      try {
        await handle.truncate(fileSize);
      } finally {
        await handle.close();
      }
    }
    await callback(sourcePath, fileSize, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withReadHandle<T>(
  path: string,
  callback: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  const handle = await open(path, "r");
  try {
    return await callback(handle);
  } finally {
    await handle.close();
  }
}

async function expectPublicRefusal(
  sourcePath: string,
  directory: string,
  extension: string,
  expectedCode: string,
): Promise<void> {
  const destinationPath = join(directory, `clean.${extension}`);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...NO_PRESERVATION,
  });
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({ error: { code: expectedCode } });
  expect(existsSync(destinationPath)).toBe(false);
}

describe("declared refusals (TEST-12 Tier 2)", () => {
  it("the WebP and PNG tables equal getCapabilities() refuses exactly", () => {
    expect(
      compareRefusalKeys(Object.keys(WEBP_REFUSALS), declaredRefuses("webp")),
    ).toEqual({ missing: [], extra: [] });
    expect(
      compareRefusalKeys(Object.keys(PNG_REFUSALS), declaredRefuses("png")),
    ).toEqual({ missing: [], extra: [] });
    expect(Object.keys(WEBP_REFUSALS)).toHaveLength(5);
    expect(Object.keys(PNG_REFUSALS)).toHaveLength(10);
  });

  it.each(Object.entries(WEBP_REFUSALS))(
    "webp refuses %s by a hostile input",
    async (_literal, refusal: RefusalCase) => {
      const generated = webpHostileCases.find(
        (item) => item.id === refusal.caseId,
      );
      expect(generated?.expectedKind).toBe(refusal.expectedCode);
      await withHostileFile(
        "webp",
        () => materializeMutationCase(refusal.caseId),
        async (sourcePath, fileSize, directory) => {
          await expectPublicRefusal(
            sourcePath,
            directory,
            "webp",
            refusal.expectedCode,
          );
          const parsed = withReadHandle(sourcePath, (handle) =>
            parseWebp(handle, fileSize),
          );
          await expect(parsed).rejects.toBeInstanceOf(WebpStructureError);
          await expect(parsed).rejects.toMatchObject({
            kind: refusal.expectedParserKind,
          });
        },
      );
    },
    30_000,
  );

  it.each(Object.entries(PNG_REFUSALS))(
    "png refuses %s by a hostile input",
    async (_literal, refusal: RefusalCase) => {
      const generated = pngHostileCases.find(
        (item) => item.id === refusal.caseId,
      );
      expect(generated?.expectedKind).toBe(refusal.expectedCode);
      expect(generated?.options).toBeUndefined();
      await withHostileFile(
        "png",
        () => materializePngCase(refusal.caseId),
        async (sourcePath, fileSize, directory) => {
          await expectPublicRefusal(
            sourcePath,
            directory,
            "png",
            refusal.expectedCode,
          );
          const parsed = withReadHandle(sourcePath, (handle) =>
            parsePng(handle, fileSize),
          );
          if (refusal.expectedParserKind === "admission-layer") {
            await expect(parsed).resolves.toBeDefined();
            return;
          }
          await expect(parsed).rejects.toBeInstanceOf(PngStructureError);
          await expect(parsed).rejects.toMatchObject({
            kind: refusal.expectedParserKind,
          });
        },
      );
    },
    30_000,
  );

  it("Tier 2 equality control: a dropped or phantom literal is reported", () => {
    for (const [format, table] of [
      ["webp", Object.keys(WEBP_REFUSALS)],
      ["png", Object.keys(PNG_REFUSALS)],
    ] as const) {
      const declared = declaredRefuses(format);
      const dropped = table.slice(1);
      expect(dropped).not.toEqual(table);
      const missingReport = compareRefusalKeys(dropped, declared);
      expect(missingReport).toEqual({ missing: [table[0]!], extra: [] });

      const phantom = [...table, "phantom-refusal"];
      expect(phantom).not.toEqual(table);
      const extraReport = compareRefusalKeys(phantom, declared);
      expect(extraReport).toEqual({ missing: [], extra: ["phantom-refusal"] });
      console.info(
        `Tier 2 control ${format}: dropped ${table[0]} -> ${JSON.stringify(missingReport)}; phantom -> ${JSON.stringify(extraReport)}`,
      );
    }
  });
});
