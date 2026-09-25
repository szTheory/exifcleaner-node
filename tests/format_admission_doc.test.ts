import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(packageRoot, "docs/format-admission.md");

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

function citablePaths(lineText: string): readonly string[] {
  const paths: string[] = [];
  for (const match of lineText.matchAll(BACKTICKED_PATH)) {
    const candidate = match[1];
    if (
      candidate !== undefined &&
      CITABLE_PATH_ROOTS.some((root) => candidate.startsWith(root))
    ) {
      paths.push(candidate);
    }
  }
  return paths;
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
  it("has no structural problems against the first tiered evidence item", () => {
    const text = readFileSync(docPath, "utf8");
    const problems = admissionDocProblems(
      text,
      (path) => existsSync(join(packageRoot, path)),
      ADMISSION_ITEMS.slice(0, 1),
    );
    expect(problems).toEqual([]);
  });
});
