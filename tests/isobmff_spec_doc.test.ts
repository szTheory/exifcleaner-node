// docs/isobmff.md final-note drift gate (62.1-13, D-32, QUA-07).
//
// The spec note is the published contract for the HEIC/AVIF engine. This file holds it against
// the code at the same head:
//  1. line 3 is the final status line and every required section heading exists;
//  2. the "## Permitted differences (QUA-01)" table lists exactly the ids of
//     HEIC_PERMITTED_DIFFERENCES and AVIF_PERMITTED_DIFFERENCES, per format;
//  3. the "## Advertised limits" table equals the src/isobmff/caps.ts constants and the
//     `limits` getCapabilities() advertises for heic and avif;
//  4. README.md's "## Formats" table and docs/capabilities.md's "## Supported Surface" table
//     list exactly the formats getCapabilities() returns, each with its media types,
//     extensions and `removes` list, and both state the full `NativeFormat` union.
//
// Every check reads the doc fresh from disk, so deleting a heading or a row turns this red.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ISOBMFF_MAX_BOX_COUNT,
  ISOBMFF_MAX_BOX_DEPTH,
  ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
  ISOBMFF_MAX_META_BYTES,
} from "../src/isobmff/caps.js";
import { getCapabilities } from "../src/index.js";
import { AVIF_PERMITTED_DIFFERENCES } from "./qualification/avif/oracles.js";
import { HEIC_PERMITTED_DIFFERENCES } from "./qualification/heic/oracles.js";

const DOC_PATH = fileURLToPath(new URL("../docs/isobmff.md", import.meta.url));
const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
const CAPABILITIES_PATH = fileURLToPath(
  new URL("../docs/capabilities.md", import.meta.url),
);

const NATIVE_FORMAT_UNION = '"webp" | "png" | "jpeg" | "heic" | "avif"';

export const SPEC_STATUS_LINE = "Status: Final (Phase 62.1).";

/** Every heading the final note must carry (D-32), each exactly once. */
export const REQUIRED_SPEC_HEADINGS = [
  "## Measured real-device sample",
  "### License basis (D-02)",
  "## ExifTool 13.59 baseline (HEIC sample)",
  "## Decline classes",
  "### Public refusal mapping (D-06, 62-12)",
  "## Memory caps",
  "## Advertised limits",
  "## Writer (Phase 62)",
  "### D-34: orphaned properties (deferred, recorded only)",
  "## Permitted differences (QUA-01)",
  "## Essential-bit policy",
  "## C2PA placement",
  "## Qualification baseline (Phase 62.1 measurements)",
  "### Nokia heif_conformance admit rate",
  "### Native vs ExifTool performance (QUA-05)",
  "## Open risks",
  "### AVIF reach gap (D-31)",
  "### Real-device C2PA placement",
] as const;

const EXPECTED_LIMITS = {
  maxMetaBytes: ISOBMFF_MAX_META_BYTES,
  maxBoxCount: ISOBMFF_MAX_BOX_COUNT,
  maxBoxDepth: ISOBMFF_MAX_BOX_DEPTH,
  maxBufferedBytesTotal: ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
} as const;

/** Body of a heading (exclusive) up to the next heading of the same or a higher level. */
export function sectionText(doc: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    throw new Error(`heading ${JSON.stringify(heading)} not found`);
  }
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^(#{1,6})\s/.exec(line);
    if (match && (match[1]?.length ?? 7) <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

/** GFM table rows whose first cell is one backticked token: [token, ...other cells]. */
export function backtickedRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!/^\|\s*`[^`]+`\s*\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push([(cells[0] ?? "").replace(/`/g, ""), ...cells.slice(1)]);
  }
  return rows;
}

async function readDoc(): Promise<string> {
  return readFile(DOC_PATH, "utf8");
}

describe("docs/isobmff.md final spec note drift gate (62.1-13)", () => {
  it("line 3 is the final status line and no Draft status remains", async () => {
    const doc = await readDoc();
    expect(doc.split("\n")[2]).toBe(SPEC_STATUS_LINE);
    expect(doc).not.toMatch(/Status: Draft/);
  });

  it.each(REQUIRED_SPEC_HEADINGS)(
    "has the heading %s exactly once",
    async (heading) => {
      const doc = await readDoc();
      const count = doc
        .split("\n")
        .filter((line) => line.trimEnd() === heading).length;
      expect(count, `heading ${heading}`).toBe(1);
    },
  );

  it.each([
    ["HEIC", 1, HEIC_PERMITTED_DIFFERENCES],
    ["AVIF", 2, AVIF_PERMITTED_DIFFERENCES],
  ] as const)(
    "the permitted-differences table lists exactly the %s ids",
    async (_format, column, list) => {
      const rows = backtickedRows(
        sectionText(await readDoc(), "## Permitted differences (QUA-01)"),
      );
      const documented = rows
        .filter((row) => row[column] === "yes")
        .map((row) => row[0]);
      expect(new Set(documented)).toEqual(
        new Set(list.map((entry) => entry.id)),
      );
      expect(documented).toHaveLength(list.length);
      for (const row of rows) {
        expect(["yes", "no"], `row ${row[0]}`).toContain(row[column]);
      }
    },
  );

  it("every permitted-difference row cites the doc heading its code entry names", async () => {
    const doc = await readDoc();
    const rows = backtickedRows(
      sectionText(doc, "## Permitted differences (QUA-01)"),
    );
    for (const entry of [
      ...HEIC_PERMITTED_DIFFERENCES,
      ...AVIF_PERMITTED_DIFFERENCES,
    ]) {
      const row = rows.find((candidate) => candidate[0] === entry.id);
      const heading = entry.docsHeading.replace(/^#+\s*/, "");
      expect(row?.join(" | "), entry.id).toContain(heading);
      expect(
        doc.split("\n").some((line) => line.trimEnd() === entry.docsHeading),
      ).toBe(true);
    }
  });

  it("the advertised-limits table equals caps.ts and getCapabilities() for heic and avif", async () => {
    const rows = backtickedRows(
      sectionText(await readDoc(), "## Advertised limits"),
    );
    const documented = Object.fromEntries(
      rows.map((row) => [row[0], Number((row[1] ?? "").replace(/,/g, ""))]),
    );
    expect(documented).toEqual(EXPECTED_LIMITS);
    for (const format of ["heic", "avif"] as const) {
      const entry = getCapabilities().formats.find(
        (candidate) => candidate.format === format,
      );
      expect(entry?.limits, format).toEqual(EXPECTED_LIMITS);
    }
  });

  it("the old Phase 61 'caps are not advertised' note is gone", async () => {
    const doc = await readDoc();
    expect(doc).not.toMatch(/Caps are not advertised/);
  });

  it("the AVIF reach gap records the measured link-u decline classes", async () => {
    const gap = sectionText(await readDoc(), "### AVIF reach gap (D-31)");
    expect(gap).toMatch(/item-graph-invalid/);
    expect(gap).toMatch(/surviving-offset-width-zero/);
    expect(gap).toMatch(/ipma/);
  });
});

describe("README.md and docs/capabilities.md format lists equal getCapabilities() (62.1-13)", () => {
  it.each([
    ["README.md", README_PATH, "## Formats"],
    ["docs/capabilities.md", CAPABILITIES_PATH, "## Supported Surface"],
  ] as const)(
    "%s lists every registered format with its media types, extensions and removes",
    async (_name, path, heading) => {
      // The header row (`| `format` | ...`) is not a format row.
      const rows = backtickedRows(
        sectionText(await readFile(path, "utf8"), heading),
      ).filter((row) => row[0] !== "format");
      const formats = getCapabilities().formats;
      expect(rows.map((row) => row[0]).sort()).toEqual(
        formats.map((entry) => entry.format).sort(),
      );
      for (const entry of formats) {
        const row =
          rows
            .find((candidate) => candidate[0] === entry.format)
            ?.join(" | ") ?? "";
        const tokens = [
          ...entry.mimeTypes,
          ...entry.extensions,
          ...entry.removes,
        ];
        for (const token of tokens) {
          expect(row, `${entry.format} row names ${token}`).toContain(
            `\`${token}\``,
          );
        }
      }
    },
  );

  it("both docs state the full NativeFormat union", async () => {
    const [readme, capabilities] = await Promise.all([
      readFile(README_PATH, "utf8"),
      readFile(CAPABILITIES_PATH, "utf8"),
    ]);
    expect(readme).toContain(`It is currently \`${NATIVE_FORMAT_UNION}\``);
    expect(capabilities.replace(/\s+/g, " ")).toContain(
      `(currently \`${NATIVE_FORMAT_UNION}\`)`,
    );
  });

  it("the old three-handler phrase is gone and HEIC/AVIF capability names are documented", async () => {
    const [readme, capabilities] = await Promise.all([
      readFile(README_PATH, "utf8"),
      readFile(CAPABILITIES_PATH, "utf8"),
    ]);
    expect(capabilities).not.toMatch(/only those three/);
    for (const doc of [readme, capabilities]) {
      expect(doc).toContain("HeicCapabilities");
      expect(doc).toContain("AvifCapabilities");
    }
    expect(capabilities).toContain("magic admission");
    expect(capabilities).toContain(
      '`validation.container: "full"` for ISOBMFF',
    );
  });
});
