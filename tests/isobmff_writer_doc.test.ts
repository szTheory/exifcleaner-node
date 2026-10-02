// src/isobmff/errors.ts <-> docs/isobmff.md drift gate (62-13, SC4/D-32 writer section).
//
// This test has two independent jobs:
//  1. docs/isobmff.md must carry a `## Writer (Phase 62)` section with one `###` subsection per
//     layout rule D-11..D-19 and the D-34 orphan note.
//  2. the "## Decline classes" table's first column (the backticked internal class names) must
//     equal the actual ISOBMFF_DECLINE_CLASSES set -- never a stale or partial list.
//
// Both checks read the doc fresh from disk on every run, so a doc edit that drops a required
// heading or a decline-class row turns this file red without any other test noticing.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ISOBMFF_DECLINE_CLASSES } from "../src/isobmff/errors.js";

const DOC_PATH = fileURLToPath(new URL("../docs/isobmff.md", import.meta.url));

const REQUIRED_RULE_IDS = [
  "D-11",
  "D-12",
  "D-13",
  "D-14",
  "D-15",
  "D-16",
  "D-17",
  "D-18",
  "D-19",
  "D-34",
] as const;

/** Lines from `startHeading` (exclusive) up to (but not including) the next `#`-prefixed line. */
function sectionBody(doc: string, startHeadingPattern: RegExp): string {
  const lines = doc.split("\n");
  const startIndex = lines.findIndex((line) => startHeadingPattern.test(line));
  if (startIndex === -1) {
    throw new Error(`heading matching ${startHeadingPattern} not found`);
  }
  const body: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Every `### ...` heading text within `sectionText` (one entry per subsection). */
function subsectionHeadings(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .filter((line) => /^### /.test(line))
    .map((line) => line.replace(/^### /, "").trim());
}

/**
 * Collects the full text of the `## Writer (Phase 62)` section, including every `###`
 * subsection's body -- stops at the next `## ` (level-2) heading, never at a `###` one, since the
 * section itself is made of `###` subsections.
 */
function writerSectionText(doc: string): string {
  const lines = doc.split("\n");
  const startIndex = lines.findIndex((line) =>
    /^## Writer \(Phase 62\)\s*$/.test(line),
  );
  if (startIndex === -1) {
    throw new Error("`## Writer (Phase 62)` heading not found");
  }
  const body: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^## /.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Every backticked token in the first `|`-column of a GFM table row, e.g. `| \`foo\`  | ... |`. */
function firstColumnBacktickedTokens(tableSectionText: string): string[] {
  const tokens: string[] = [];
  for (const line of tableSectionText.split("\n")) {
    const match = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|/);
    const token = match?.[1];
    if (token) tokens.push(token);
  }
  return tokens;
}

describe("docs/isobmff.md writer section drift gate (62-13)", () => {
  it("has a `## Writer (Phase 62)` heading", async () => {
    const doc = await readFile(DOC_PATH, "utf8");
    expect(doc).toMatch(/^## Writer \(Phase 62\)\s*$/m);
  });

  it.each(REQUIRED_RULE_IDS)(
    "has a ### subsection naming %s",
    async (ruleId) => {
      const doc = await readFile(DOC_PATH, "utf8");
      const section = writerSectionText(doc);
      const headings = subsectionHeadings(section);
      const matching = headings.filter((heading) => heading.includes(ruleId));
      expect(
        matching.length,
        `expected exactly one ### heading containing ${ruleId} in the Writer (Phase 62) section, ` +
          `found headings: ${JSON.stringify(headings)}`,
      ).toBe(1);
    },
  );

  it("names D-34's orphaned-property example (udes)", async () => {
    const doc = await readFile(DOC_PATH, "utf8");
    const section = writerSectionText(doc);
    expect(section).toMatch(/udes/);
  });

  it("the Decline classes table's backticked first column equals ISOBMFF_DECLINE_CLASSES exactly", async () => {
    const doc = await readFile(DOC_PATH, "utf8");
    const declineSection = sectionBody(doc, /^## Decline classes\s*$/);
    const documented = new Set<string>(
      firstColumnBacktickedTokens(declineSection),
    );
    const actual = new Set<string>(ISOBMFF_DECLINE_CLASSES);

    const missingFromDoc = [...actual].filter(
      (entry) => !documented.has(entry),
    );
    const extraInDoc = [...documented].filter((entry) => !actual.has(entry));

    expect(
      missingFromDoc,
      "classes in ISOBMFF_DECLINE_CLASSES but missing from the doc table",
    ).toEqual([]);
    expect(
      extraInDoc,
      "rows in the doc table naming a class that no longer exists",
    ).toEqual([]);
    expect(documented.size).toBe(actual.size);
  });
});
