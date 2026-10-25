import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_NAME = join(packageRoot, "__strictness_fixture__.ts");

const REQUIRED_OPTIONS = {
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  allowUnreachableCode: false,
  erasableSyntaxOnly: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
} as const;

type RequiredName = keyof typeof REQUIRED_OPTIONS;

interface Violation {
  readonly flag: RequiredName;
  readonly code: number;
  readonly marker: string;
}

// One violation per flag. Each marker is a unique substring of the offending line.
const FIXTURE_LINES = [
  "export function fallsThrough(value: number) {",
  '  let out = "";',
  "  switch (value) {",
  "    case 1:",
  '      out = "one";',
  "    case 2:",
  '      out = "two";',
  "      break;",
  "  }",
  "  return out;",
  "}",
  "export function missingReturn(flag: boolean) {",
  "  if (flag) {",
  "    return 1;",
  "  }",
  "}",
  "export function unreachable() {",
  "  return 1;",
  "  return 2;",
  "}",
  "export enum Color {",
  "  Red,",
  "}",
  "export function hasUnusedLocal() {",
  "  const unusedLocal = 1;",
  "}",
  "export function hasUnusedParameter(unusedParameter: number) {",
  "  return 1;",
  "}",
];
const FIXTURE_SOURCE = `${FIXTURE_LINES.join("\n")}\n`;

const VIOLATIONS: readonly Violation[] = [
  { flag: "noFallthroughCasesInSwitch", code: 7029, marker: "case 1:" },
  { flag: "noImplicitReturns", code: 7030, marker: "function missingReturn" },
  { flag: "allowUnreachableCode", code: 7027, marker: "return 2;" },
  { flag: "erasableSyntaxOnly", code: 1294, marker: "export enum Color" },
  { flag: "noUnusedLocals", code: 6133, marker: "unusedLocal = 1" },
  {
    flag: "noUnusedParameters",
    code: 6133,
    marker: "hasUnusedParameter(unusedParameter",
  },
];

function lineOf(marker: string): number {
  const matches = FIXTURE_LINES.flatMap((text, index) =>
    text.includes(marker) ? [index + 1] : [],
  );
  expect(matches, `marker ${marker} must match exactly one line`).toHaveLength(
    1,
  );
  return matches[0] as number;
}

function readRealOptions(): ts.CompilerOptions {
  const configPath = join(packageRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    packageRoot,
  );
  expect(parsed.errors).toEqual([]);
  return parsed.options;
}

function compileFixture(options: ts.CompilerOptions): string[] {
  const effective: ts.CompilerOptions = {
    ...options,
    types: [],
    noEmit: true,
  };
  delete effective.rootDir;
  const host = ts.createCompilerHost(effective);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    fileName === FIXTURE_NAME || originalFileExists(fileName);
  host.readFile = (fileName) =>
    fileName === FIXTURE_NAME ? FIXTURE_SOURCE : originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) =>
    fileName === FIXTURE_NAME
      ? ts.createSourceFile(
          fileName,
          FIXTURE_SOURCE,
          languageVersionOrOptions,
          true,
        )
      : originalGetSourceFile(fileName, languageVersionOrOptions, ...rest);
  const program = ts.createProgram([FIXTURE_NAME], effective, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === FIXTURE_NAME)
    .map((diagnostic) => {
      const { line } = ts.getLineAndCharacterOfPosition(
        diagnostic.file as ts.SourceFile,
        diagnostic.start ?? 0,
      );
      return `${diagnostic.code}@${line + 1}`;
    })
    .sort();
}

function expectedPairs(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.code}@${lineOf(v.marker)}`).sort();
}

describe("tsconfig strictness flags (TEST-10)", () => {
  it("the real tsconfig.json sets all six options to the required values", () => {
    const options = readRealOptions();
    const wrong = (Object.keys(REQUIRED_OPTIONS) as RequiredName[]).filter(
      (name) => options[name] !== REQUIRED_OPTIONS[name],
    );
    expect(wrong, `options missing or wrong in tsconfig.json`).toEqual([]);
  });

  it("a copy with one option deleted fails the presence check", () => {
    for (const name of Object.keys(REQUIRED_OPTIONS) as RequiredName[]) {
      const copy: ts.CompilerOptions = { ...readRealOptions() };
      delete copy[name];
      const wrong = (Object.keys(REQUIRED_OPTIONS) as RequiredName[]).filter(
        (key) => copy[key] !== REQUIRED_OPTIONS[key],
      );
      expect(wrong).toEqual([name]);
    }
  });

  it("the fixture compiled with the real options yields every expected diagnostic", () => {
    expect(compileFixture(readRealOptions())).toEqual(
      expectedPairs(VIOLATIONS),
    );
  });

  it("the two TS6133 diagnostics land on two distinct lines", () => {
    const lines = compileFixture(readRealOptions()).filter((pair) =>
      pair.startsWith("6133@"),
    );
    expect(new Set(lines).size).toBe(2);
  });

  it.each(VIOLATIONS.map((v) => [v.flag, v] as const))(
    "dropping %s removes exactly its diagnostic",
    (flag, violation) => {
      const options: ts.CompilerOptions = { ...readRealOptions() };
      if (flag === "allowUnreachableCode") {
        options.allowUnreachableCode = true;
      } else {
        delete options[flag];
      }
      const others = VIOLATIONS.filter((v) => v !== violation);
      expect(compileFixture(options)).toEqual(expectedPairs(others));
    },
  );
});
