import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(packageRoot, "docs/format-admission.md");
const readmePath = join(packageRoot, "README.md");
const ciBudgetPath = join(packageRoot, "docs/ci-budget.md");

/**
 * The eight tiered evidence items, in the fixed MILESTONE-GUIDE order
 * (KIT-06, D-23). `docs/format-admission.md` must carry each exactly once,
 * as a `## <n>. <name>` heading, in this order.
 */
export const ADMISSION_ITEMS = [
  "Spec note",
  "Hostile corpus",
  "Differential",
  "Properties",
  "Payload identity",
  "Fault injection",
  "Preservation parity",
  "Rollback",
] as const;

const HEADING_LINE = /^## (\d+)\. (.+)$/u;
const KIT_PROVIDES_LINE = /^Kit provides: *(.*)$/u;
const FORMAT_SUPPLIES_LINE = /^Format supplies: *(.*)$/u;

/**
 * A backticked, repository-relative path under one of these roots is a
 * citation the document makes about the kit or a format's obligations. Every
 * such citation must resolve to a real file, or the document is describing a
 * gate that does not exist (T-55-29).
 */
const CITABLE_PATH_ROOTS = ["src/", "tests/", "scripts/", "docs/", ".github/"];
const BACKTICKED_PATH = /`([^`]+)`/gu;

interface ParsedSection {
  readonly index: number;
  readonly name: string;
  readonly startLine: number;
  endLine: number;
}

function parseHeadings(lines: readonly string[]): readonly ParsedSection[] {
  const sections: ParsedSection[] = [];
  lines.forEach((lineText, lineIndex) => {
    const match = HEADING_LINE.exec(lineText);
    if (match === null) {
      return;
    }
    const indexText = match[1] ?? "";
    const name = match[2] ?? "";
    sections.push({
      index: Number(indexText),
      name,
      startLine: lineIndex,
      endLine: lines.length,
    });
  });
  sections.forEach((section, position) => {
    const next = sections[position + 1];
    if (next !== undefined) {
      section.endLine = next.startLine;
    }
  });
  return sections;
}

/**
 * A glob or template pattern (a literal `*` wildcard, or a placeholder
 * segment like `<format>`) describes a rule, not a real file. It is exempt
 * from the path-existence check.
 */
const GLOB_OR_PLACEHOLDER = /[*<]/u;

function citablePaths(lineText: string): readonly string[] {
  const paths: string[] = [];
  for (const match of lineText.matchAll(BACKTICKED_PATH)) {
    const candidate = match[1];
    if (
      candidate !== undefined &&
      CITABLE_PATH_ROOTS.some((root) => candidate.startsWith(root)) &&
      !GLOB_OR_PLACEHOLDER.test(candidate)
    ) {
      paths.push(candidate);
    }
  }
  return paths;
}

/**
 * A JS-identifier-shaped backticked token, optionally with dotted member
 * segments (`DifferentialProfile.permittedKinds`). A token with spaces,
 * angle brackets, colons, equals signs or slashes is not identifier-shaped
 * (WR-08, gap 2): it is prose or a type expression, not a symbol claim.
 */
export const IDENTIFIER_TOKEN =
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

function isIdentifierShaped(token: string): boolean {
  return IDENTIFIER_TOKEN.test(token);
}

/**
 * A code-shaped head segment reads as a real identifier rather than an
 * English word: camelCase/PascalCase (a lowercase letter immediately
 * followed by an uppercase letter) or SCREAMING_SNAKE_CASE.
 */
const CAMEL_TRANSITION = /[a-z][A-Z]/u;
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;

function isCodeShaped(head: string): boolean {
  return CAMEL_TRANSITION.test(head) || SCREAMING_SNAKE.test(head);
}

function isCitableTsPath(candidate: string): boolean {
  return (
    candidate.endsWith(".ts") &&
    CITABLE_PATH_ROOTS.some((root) => candidate.startsWith(root)) &&
    !GLOB_OR_PLACEHOLDER.test(candidate)
  );
}

/**
 * Splits `text` into paragraphs on blank lines, joining each paragraph's
 * own lines with single spaces so a wrapped attribution (a backticked path
 * and its parenthetical, or a `symbol` in `path` pair, that line-wraps in
 * the markdown source) is seen whole.
 */
function paragraphs(text: string): readonly string[] {
  return text.split(/\n{2,}/u).map((paragraph) => paragraph.split("\n").join(" "));
}

/**
 * Given `text` and the index of an opening `(`, returns the index of its
 * matching `)`, tracking nesting depth. Returns -1 if unbalanced.
 */
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export interface AttributedSymbol {
  readonly symbol: string;
  readonly modulePath: string;
}

const PATH_THEN_PAREN = /`([^`]+\.ts)`\s*\(/gu;
const SYMBOL_THEN_IN_PATH = /`([^`]+)`\s+in\s+`([^`]+\.ts)`/gu;

/**
 * Every `{symbol, modulePath}` pair this document claims: Form A, a
 * backticked citable `.ts` path immediately followed by a parenthetical
 * listing the symbols it provides; and Form B, a backticked symbol
 * immediately followed by "in" and a backticked citable `.ts` path. A pair
 * is this document's explicit claim that `symbol` is a real export of
 * `modulePath` (WR-08, gap 2).
 */
export function attributedSymbols(text: string): readonly AttributedSymbol[] {
  const pairs: AttributedSymbol[] = [];

  for (const paragraph of paragraphs(text)) {
    for (const match of paragraph.matchAll(PATH_THEN_PAREN)) {
      const modulePath = match[1];
      if (modulePath === undefined || !isCitableTsPath(modulePath)) continue;
      const matchIndex = match.index ?? -1;
      if (matchIndex === -1) continue;
      const openIndex = matchIndex + match[0].length - 1;
      const closeIndex = findMatchingParen(paragraph, openIndex);
      if (closeIndex === -1) continue;
      const inner = paragraph.slice(openIndex + 1, closeIndex);
      for (const innerMatch of inner.matchAll(BACKTICKED_PATH)) {
        const symbol = innerMatch[1];
        if (symbol !== undefined && isIdentifierShaped(symbol)) {
          pairs.push({ symbol, modulePath });
        }
      }
    }

    for (const match of paragraph.matchAll(SYMBOL_THEN_IN_PATH)) {
      const symbol = match[1];
      const modulePath = match[2];
      if (
        symbol !== undefined &&
        modulePath !== undefined &&
        isIdentifierShaped(symbol) &&
        isCitableTsPath(modulePath)
      ) {
        pairs.push({ symbol, modulePath });
      }
    }
  }

  return pairs;
}

interface DeclaredModuleNames {
  readonly exports: ReadonlySet<string>;
  readonly declarations: ReadonlySet<string>;
  readonly members: ReadonlySet<string>;
}

const EXPORT_DECL_PATTERN =
  /export\s+(?:async\s+function|function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_LIST_PATTERN = /export\s+(?:type\s+)?\{([^}]*)\}/gu;
const TOP_LEVEL_DECL_PATTERN =
  /^(?:async\s+function|function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
const MEMBER_PATTERN = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gmu;

/**
 * Regex parse (not an AST) of `source`, a TypeScript module's text, into
 * three name sets: `exports` (top-level `export function/const/.../{...}`
 * declarations, including `export type { a }` brace lists via their alias),
 * `declarations` (top-level declarations with no `export` keyword) and
 * `members` (object/interface property names, `name:` or `name?:`,
 * optionally `readonly`-prefixed). Good enough for the drift gate's
 * purpose: a real symbol always appears in one of these sets, and a
 * hallucinated one never does.
 */
export function declaredModuleNames(source: string): DeclaredModuleNames {
  const exports = new Set<string>();
  const declarations = new Set<string>();
  const members = new Set<string>();

  for (const match of source.matchAll(EXPORT_DECL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) exports.add(name);
  }
  for (const match of source.matchAll(EXPORT_LIST_PATTERN)) {
    const list = match[1] ?? "";
    for (const item of list.split(",")) {
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      const asMatch = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(trimmed);
      const name = asMatch !== null ? asMatch[1] : trimmed.split(/\s+/u)[0];
      if (name !== undefined) exports.add(name);
    }
  }
  for (const match of source.matchAll(TOP_LEVEL_DECL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) declarations.add(name);
  }
  for (const match of source.matchAll(MEMBER_PATTERN)) {
    const name = match[1];
    if (name !== undefined) members.add(name);
  }

  return { exports, declarations, members };
}

/**
 * Backticked terms Rule 2 (below) would otherwise flag as an undeclared
 * code symbol, but that are not code identifiers at all. Starts empty.
 * Every entry must be a non-code term with a one-line reason recorded here
 * -- never a real code identifier added to silence a genuine drift finding
 * (WR-08 prohibition: the gate must be satisfied by fixing the document,
 * not by exempting it).
 */
export const DOC_SYMBOL_EXEMPTIONS: ReadonlySet<string> = Object.freeze(
  new Set<string>([]),
);

/**
 * Symbol-and-member drift check (WR-08, gap 2). Rule 1: every attributed
 * pair from `attributedSymbols` must resolve -- the module must be
 * readable, its head segment must be a real export of that module, and
 * each further dotted segment must be a declared member of that module.
 * Rule 2: every identifier-shaped, code-shaped backticked token anywhere
 * in `text` (not just attributed ones) must be declared -- as an export,
 * a private top-level declaration, or a member -- in at least one citable
 * `.ts` module the document cites, unless it is listed in
 * `DOC_SYMBOL_EXEMPTIONS`.
 */
export function admissionDocSymbolProblems(
  text: string,
  readModule: (path: string) => string | undefined,
): readonly string[] {
  const problems: string[] = [];
  const moduleCache = new Map<string, DeclaredModuleNames | undefined>();

  function resolveModule(path: string): DeclaredModuleNames | undefined {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const source = readModule(path);
    const parsed = source === undefined ? undefined : declaredModuleNames(source);
    moduleCache.set(path, parsed);
    return parsed;
  }

  for (const { symbol, modulePath } of attributedSymbols(text)) {
    const parsed = resolveModule(modulePath);
    if (parsed === undefined) {
      problems.push(`unreadable module: \`${modulePath}\``);
      continue;
    }
    const segments = symbol.split(".");
    const head = segments[0]!;
    if (!parsed.exports.has(head)) {
      problems.push(
        `not exported: \`${head}\` is not a real export of \`${modulePath}\``,
      );
      continue;
    }
    for (const segment of segments.slice(1)) {
      if (!parsed.members.has(segment)) {
        problems.push(
          `unknown member: \`${segment}\` is not a declared member of \`${modulePath}\` (from \`${symbol}\`)`,
        );
      }
    }
  }

  const citedPaths = new Set<string>();
  for (const match of text.matchAll(BACKTICKED_PATH)) {
    const candidate = match[1];
    if (candidate !== undefined && isCitableTsPath(candidate)) {
      citedPaths.add(candidate);
    }
  }
  const citedModules = [...citedPaths]
    .map((path) => resolveModule(path))
    .filter((parsed): parsed is DeclaredModuleNames => parsed !== undefined);

  const seenUnresolved = new Set<string>();
  for (const match of text.matchAll(BACKTICKED_PATH)) {
    const token = match[1];
    if (token === undefined || !isIdentifierShaped(token)) continue;
    const head = token.split(".")[0]!;
    if (!isCodeShaped(head)) continue;
    if (DOC_SYMBOL_EXEMPTIONS.has(token)) continue;
    const known = citedModules.some(
      (parsed) =>
        parsed.exports.has(head) ||
        parsed.declarations.has(head) ||
        parsed.members.has(head),
    );
    if (!known && !seenUnresolved.has(token)) {
      seenUnresolved.add(token);
      problems.push(
        `unresolved symbol: \`${token}\` is not declared in any module this document cites`,
      );
    }
  }

  return problems;
}

/**
 * Pure structural check of `text` against `items` (the expected heading
 * names, in order, each exactly once). `pathExists` resolves a
 * repository-relative path so the real-file test can use `existsSync` while
 * negative controls can inject a synthetic resolver.
 *
 * Returns a problem string for each defect found; an empty array means the
 * document is structurally sound.
 */
export function admissionDocProblems(
  text: string,
  pathExists: (path: string) => boolean,
  items: readonly string[] = ADMISSION_ITEMS,
): readonly string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  const sections = parseHeadings(lines);

  const seenNames = new Map<string, number>();
  for (const section of sections) {
    seenNames.set(section.name, (seenNames.get(section.name) ?? 0) + 1);
  }

  items.forEach((expectedName, position) => {
    const expectedIndex = position + 1;
    const matches = sections.filter((section) => section.name === expectedName);
    if (matches.length === 0) {
      problems.push(`missing heading: "## ${expectedIndex}. ${expectedName}"`);
      return;
    }
    if (matches.length > 1) {
      problems.push(
        `duplicated heading: "${expectedName}" appears ${matches.length} times`,
      );
    }
    const first = matches[0];
    if (first !== undefined && first.index !== expectedIndex) {
      problems.push(
        `out-of-order heading: "${expectedName}" is numbered ${first.index}, expected ${expectedIndex}`,
      );
    }
  });

  for (const [name, count] of seenNames) {
    if (!items.includes(name) && count > 1) {
      problems.push(`duplicated heading: "${name}" appears ${count} times`);
    }
  }

  for (const section of sections) {
    if (!items.includes(section.name)) {
      continue;
    }
    const body = lines.slice(section.startLine + 1, section.endLine);
    const kitLine = body.find((lineText) => KIT_PROVIDES_LINE.test(lineText));
    const formatLine = body.find((lineText) =>
      FORMAT_SUPPLIES_LINE.test(lineText),
    );
    if (kitLine === undefined) {
      problems.push(`"${section.name}": missing "Kit provides:" line`);
    } else {
      const match = KIT_PROVIDES_LINE.exec(kitLine);
      if (match === null || (match[1] ?? "").trim().length === 0) {
        problems.push(`"${section.name}": blank "Kit provides:" line`);
      }
    }
    if (formatLine === undefined) {
      problems.push(`"${section.name}": missing "Format supplies:" line`);
    } else {
      const match = FORMAT_SUPPLIES_LINE.exec(formatLine);
      if (match === null || (match[1] ?? "").trim().length === 0) {
        problems.push(`"${section.name}": blank "Format supplies:" line`);
      }
    }
  }

  lines.forEach((lineText) => {
    for (const path of citablePaths(lineText)) {
      if (!pathExists(path)) {
        problems.push(`dangling path: \`${path}\` does not exist`);
      }
    }
  });

  return problems;
}

describe("format admission document (KIT-06)", () => {
  it("has no structural problems across all eight tiered evidence items", () => {
    const text = readFileSync(docPath, "utf8");
    const problems = admissionDocProblems(text, (path) =>
      existsSync(join(packageRoot, path)),
    );
    expect(problems).toEqual([]);
  });

  it("is linked from the README next to the other docs links", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("docs/format-admission.md");
  });

  it("has its CI scoping rule mirrored in docs/ci-budget.md", () => {
    const ciBudget = readFileSync(ciBudgetPath, "utf8");
    expect(ciBudget).toContain("Per-format qualification scoping");
    expect(ciBudget).toContain("qualification-linux");
  });

  it("has no symbol drift: attributed identifiers are real exports and every code symbol is declared in a cited module", () => {
    const text = readFileSync(docPath, "utf8");
    const problems = admissionDocSymbolProblems(text, (path) => {
      const fullPath = join(packageRoot, path);
      return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : undefined;
    });
    expect(problems).toEqual([]);
  });
});

describe("admission doc negative controls", () => {
  const realText = readFileSync(docPath, "utf8");
  const alwaysExists = () => true;

  it("(1) fails when an item heading is removed", () => {
    const mutated = realText.replace("## 5. Payload identity\n", "");
    const problems = admissionDocProblems(mutated, alwaysExists);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some((problem) => problem.includes("Payload identity")),
    ).toBe(true);
  });

  it("(2) fails when two items are swapped", () => {
    const mutated = realText
      .replace("## 3. Differential\n", "## 4. Differential\n")
      .replace("## 4. Properties\n", "## 3. Properties\n");
    const problems = admissionDocProblems(mutated, alwaysExists);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some(
        (problem) =>
          problem.includes("out-of-order") &&
          (problem.includes("Differential") || problem.includes("Properties")),
      ),
    ).toBe(true);
  });

  it("(3) fails when a Format supplies line is blanked", () => {
    const mutated = realText.replace(
      /Format supplies: an honest `capabilities\.preserves` block.*\n(?:.*\n)*?ExifTool\)\.\n/u,
      "Format supplies:\n",
    );
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocProblems(mutated, alwaysExists);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some(
        (problem) =>
          problem.includes("Preservation parity") && problem.includes("blank"),
      ),
    ).toBe(true);
  });

  it("(4) fails when a dangling backticked path is inserted", () => {
    const mutated = realText.replace(
      "## 1. Spec note",
      "## 1. Spec note\n\nSee also `tests/qualification/kit/missing.ts`.",
    );
    const problems = admissionDocProblems(mutated, () => false);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some((problem) =>
        problem.includes("tests/qualification/kit/missing.ts"),
      ),
    ).toBe(true);
  });

  it("(5) fails when two items are merged under one heading", () => {
    const mutated = realText.replace("## 6. Fault injection\n\n", "");
    const problems = admissionDocProblems(mutated, alwaysExists);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some((problem) => problem.includes("Fault injection")),
    ).toBe(true);
  });

  const realResolver = (path: string) => {
    const fullPath = join(packageRoot, path);
    return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : undefined;
  };

  it("(6) fails when a nonexistent export is added to a real attribution's parenthetical", () => {
    const mutated = realText.replace(
      "`tests/qualification/kit/oracles.ts` (",
      "`tests/qualification/kit/oracles.ts` (`runExiftoolOracle`, ",
    );
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocSymbolProblems(mutated, realResolver);
    expect(
      problems.some(
        (problem) =>
          problem.includes("runExiftoolOracle") &&
          problem.includes("tests/qualification/kit/oracles.ts"),
      ),
    ).toBe(true);
  });

  it("(7) fails when a real export is attributed to the wrong module", () => {
    const mutated = realText.replace(
      "## 6. Fault injection",
      "## 6. Fault injection\n\nSee also `isStageFileName` in `tests/qualification/kit/oracles.ts`.",
    );
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocSymbolProblems(mutated, realResolver);
    expect(
      problems.some(
        (problem) =>
          problem.includes("isStageFileName") &&
          problem.includes("tests/qualification/kit/oracles.ts"),
      ),
    ).toBe(true);
    const baseline = admissionDocSymbolProblems(realText, realResolver);
    expect(
      baseline.some((problem) => problem.includes("isStageFileName")),
    ).toBe(false);
  });

  it("(8) fails when a nonexistent dotted member is attributed to a real module", () => {
    const mutated = realText.replace(
      "`tests/qualification/kit/oracles.ts` (",
      "`tests/qualification/kit/oracles.ts` (`DifferentialProfile.exiftoolArguments`, ",
    );
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocSymbolProblems(mutated, realResolver);
    expect(
      problems.some((problem) => problem.includes("exiftoolArguments")),
    ).toBe(true);
  });

  it("(9) fails when an unattributed unknown symbol appears anywhere", () => {
    const mutated = realText.replace(
      "# Format Admission Criteria",
      "# Format Admission Criteria\n\nSee `runExiftoolOracle` for details.",
    );
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocSymbolProblems(mutated, realResolver);
    expect(
      problems.some(
        (problem) =>
          problem.includes("runExiftoolOracle") &&
          problem.includes("unresolved symbol"),
      ),
    ).toBe(true);
  });

  it("(10) fails, never silently passes, when a cited module cannot be read", () => {
    const mutated = realText.replace("Every format", "Every format ");
    expect(mutated).not.toEqual(realText);
    const problems = admissionDocSymbolProblems(mutated, () => undefined);
    expect(
      problems.some((problem) => problem.includes("unreadable module")),
    ).toBe(true);
  });

  it("(11) attributedSymbols on the real document includes the known real pairs and is non-vacuous", () => {
    const pairs = attributedSymbols(realText);
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    expect(
      pairs.some(
        (pair) =>
          pair.symbol === "isStageFileName" &&
          pair.modulePath === "tests/qualification/kit/fault-plan.ts",
      ),
    ).toBe(true);
    expect(
      pairs.some(
        (pair) =>
          pair.symbol === "FormatHandler" &&
          pair.modulePath === "src/admission/handler.ts",
      ),
    ).toBe(true);
    expect(
      pairs.some(
        (pair) =>
          pair.symbol === "runExiftoolDifferential" &&
          pair.modulePath === "tests/qualification/kit/oracles.ts",
      ),
    ).toBe(true);
  });
});
