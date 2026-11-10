// DOC-06 (68-12, D-22): the published prose is held against the exported types and the handler
// declarations. Every assertion is a pure checker that returns a problems list:
//  1. the property names of the exported `SanitizeOptions` equal the README bullet's field list;
//  2. for every getCapabilities() format each `preserves.*` key that is true appears in that
//     format's README table row as its documented phrase, and a false key's phrase does not;
//  3. every HEIF_REFUSALS member appears in the README refusal table and in docs/isobmff.md, the
//     audit F-1 overclaim sentence is absent and the capability-advertisement sentence present;
//  4. the CHANGELOG carries the section for the package version (Unreleased before the bump) and
//     names ftyp, resolution, the removed codes and the preserves.resolution literal change, and
//     claims the CDATA fix exactly when parseXmp actually has it (a repo fact, never a workspace
//     marker);
//  5. docs/capabilities.md and docs/format-admission.md claim no WebP resolution decline;
//  6. the README quick-start sanitizeFile call passes every required preservation boolean.
// The live-docs test of each assertion expects []; its negative control feeds the same checker a
// text with the claim reverted and expects a problem naming it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API this file uses via
// ts.createSourceFile; revisit at TS 7.1 parity (.github/dependabot.yml).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { getCapabilities } from "../src/index.js";
import { HEIF_REFUSALS } from "../src/isobmff/refusals.js";
import { parseXmp } from "../src/metadata/xmp.js";

/** The fixed README phrase for each `preserves.*` capability key (D-22). */
export const PRESERVES_PHRASES = {
  orientation: "orientation",
  colorProfile: "ICC profile",
  timestamps: "timestamps",
  resolution: "resolution",
} as const;

/** The audit F-1 overclaim, and the D-20 sentences that replace it. */
export const F1_OVERCLAIM_PHRASES = [
  "each returned before any destination is created",
  "report these `refuses` classes",
] as const;
export const REFUSAL_ADVERTISEMENT_PHRASES = [
  "advertises the coarse classes a format can decline with",
  "whose `code` is the consumer signal",
  "the class names are not carried per decline",
  "before any destination is created and is `safe-to-fallback`",
] as const;

const REMOVED_CODES = ["destination-changed", "cleanup-failed"] as const;

const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
const CHANGELOG_PATH = fileURLToPath(
  new URL("../CHANGELOG.md", import.meta.url),
);
const CAPABILITIES_PATH = fileURLToPath(
  new URL("../docs/capabilities.md", import.meta.url),
);
const ADMISSION_PATH = fileURLToPath(
  new URL("../docs/format-admission.md", import.meta.url),
);
const ISOBMFF_PATH = fileURLToPath(
  new URL("../docs/isobmff.md", import.meta.url),
);
const TYPES_PATH = fileURLToPath(new URL("../src/types.ts", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

// Local copies of the two small helpers in tests/isobmff_spec_doc.test.ts (importing that file
// would pull in its test registrations).

/** Body of a heading (exclusive) up to the next heading of the same or a higher level. */
function sectionText(doc: string, heading: string): string {
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
function backtickedRows(text: string): string[][] {
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

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------------------------
// 1. SanitizeOptions property names versus the README bullet.

export interface OptionField {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
}

/** Members of `interface SanitizeOptions` in source order, read with the compiler API. */
export function sanitizeOptionFields(typesSource: string): OptionField[] {
  const file = ts.createSourceFile(
    "types.ts",
    typesSource,
    ts.ScriptTarget.ES2023,
    true,
  );
  const fields: OptionField[] = [];
  let found = false;
  file.forEachChild((node) => {
    if (
      !ts.isInterfaceDeclaration(node) ||
      node.name.text !== "SanitizeOptions"
    )
      return;
    found = true;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name))
        continue;
      fields.push({
        name: member.name.text,
        optional: member.questionToken !== undefined,
        type: member.type?.getText(file) ?? "",
      });
    }
  });
  if (!found) throw new Error("interface SanitizeOptions not found");
  return fields;
}

export function checkSanitizeOptionsBullet(
  readme: string,
  fields: readonly OptionField[],
): string[] {
  const line = readme
    .split("\n")
    .find((candidate) => candidate.startsWith("- `SanitizeOptions`:"));
  if (line === undefined) return ["README has no `SanitizeOptions` bullet"];
  const braces = /\{([^}]*)\}/.exec(line)?.[1];
  if (braces === undefined) return ["the `SanitizeOptions` bullet has no { }"];
  const documented = braces.split(",").map((part) => part.trim());
  const expected = fields.map((field) =>
    field.optional ? `${field.name}?` : field.name,
  );
  const problems: string[] = [];
  for (const name of expected) {
    if (!documented.includes(name)) {
      problems.push(`SanitizeOptions bullet is missing ${name}`);
    }
  }
  for (const name of documented) {
    if (!expected.includes(name)) {
      problems.push(`SanitizeOptions bullet lists unknown ${name}`);
    }
  }
  if (problems.length === 0 && documented.join(",") !== expected.join(",")) {
    problems.push("SanitizeOptions bullet lists the fields in another order");
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 2. preserves.* keys versus the README format table.

export interface FormatPreserves {
  readonly format: string;
  readonly preserves: Readonly<Record<string, boolean>>;
}

export function checkPreservesPhrases(
  readme: string,
  formats: readonly FormatPreserves[],
): string[] {
  const rows = backtickedRows(sectionText(readme, "## Formats")).filter(
    (row) => row[0] !== "format",
  );
  const problems: string[] = [];
  for (const entry of formats) {
    const row = rows.find((candidate) => candidate[0] === entry.format);
    if (row === undefined) {
      problems.push(`README table has no row for ${entry.format}`);
      continue;
    }
    // The last cell is "Preserves on request"; phrases elsewhere in the row do not count.
    const cell = (row[row.length - 1] ?? "").toLowerCase();
    for (const [key, phrase] of Object.entries(PRESERVES_PHRASES)) {
      const value = entry.preserves[key];
      if (value === undefined) {
        problems.push(`${entry.format} capabilities have no preserves.${key}`);
        continue;
      }
      const present = cell.includes(phrase.toLowerCase());
      if (value && !present) {
        problems.push(
          `${entry.format} row does not name "${phrase}" though preserves.${key} is true`,
        );
      }
      if (!value && present) {
        problems.push(
          `${entry.format} row names "${phrase}" though preserves.${key} is false`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 3. HEIF refusals and the F-1 wording.

export function checkRefusalDocs(
  readme: string,
  isobmff: string,
  refusals: readonly string[],
): string[] {
  const problems: string[] = [];
  const tableRows = backtickedRows(sectionText(readme, "## Refusals")).map(
    (row) => row[0],
  );
  const isobmffRows = backtickedRows(isobmff).map((row) => row[0]);
  for (const refusal of refusals) {
    if (!tableRows.includes(refusal)) {
      problems.push(`README refusal table is missing ${refusal}`);
    }
    if (!isobmffRows.includes(refusal)) {
      problems.push(`docs/isobmff.md refusal table is missing ${refusal}`);
    }
  }
  const prose = collapse(readme);
  for (const phrase of F1_OVERCLAIM_PHRASES) {
    if (prose.includes(phrase)) {
      problems.push(`README still carries the F-1 overclaim "${phrase}"`);
    }
  }
  for (const phrase of REFUSAL_ADVERTISEMENT_PHRASES) {
    if (!prose.includes(phrase)) {
      problems.push(`README does not say "${phrase}"`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 4. CHANGELOG.

/** The CHANGELOG repo fact: does parseXmp already refuse a CDATA surrogate entity typed? */
export function cdataFixIsPresent(): boolean {
  const packet = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><![CDATA[&#xD800;]]></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>',
    "utf8",
  );
  try {
    return parseXmp(packet).warnings.length > 0;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** The text of one `## ` section of the CHANGELOG, heading excluded. */
function changelogSection(
  changelog: string,
  matches: (heading: string) => boolean,
): { heading: string; body: string } | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && matches(line.slice(3).trimEnd()),
  );
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return {
    heading: (lines[start] ?? "").slice(3).trimEnd(),
    body: body.join("\n"),
  };
}

export function checkChangelog(
  changelog: string,
  version: string,
  cdataFixed: boolean,
): string[] {
  const problems: string[] = [];
  const versionHeading = (heading: string): boolean =>
    heading === version || heading.startsWith(`${version} - `);
  const topHeading = changelog
    .split("\n")
    .find((line) => line.startsWith("## "))
    ?.slice(3)
    .trimEnd();
  const hasVersionSection = changelogSection(changelog, versionHeading);
  if (topHeading === undefined) return ["CHANGELOG has no section"];
  if (topHeading === "Unreleased") {
    if (hasVersionSection === undefined) {
      problems.push(
        `package version ${version} has no CHANGELOG section but the top section is still Unreleased`,
      );
    }
  } else if (!versionHeading(topHeading)) {
    problems.push(
      `top CHANGELOG section "${topHeading}" is neither Unreleased nor ${version}`,
    );
  }
  // The 0.5.0 release notes: the dated or undated 0.5.0 section once renamed, else Unreleased.
  const release =
    changelogSection(
      changelog,
      (h) => h === "0.5.0" || h.startsWith("0.5.0 - "),
    ) ?? changelogSection(changelog, (h) => h === "Unreleased");
  if (release === undefined) {
    return [
      ...problems,
      "CHANGELOG has neither a 0.5.0 nor an Unreleased section",
    ];
  }
  const body = release.body;
  const headings = ["Added", "Security", "Changed", "Removed"];
  if (cdataFixed) headings.push("Fixed");
  for (const heading of headings) {
    if (!body.split("\n").some((line) => line.trimEnd() === `### ${heading}`)) {
      problems.push(`CHANGELOG ${release.heading} has no "### ${heading}"`);
    }
  }
  const claims: ReadonlyArray<readonly [string, string]> = [
    ["ftyp", "the 256-byte ftyp cap"],
    ["resolution", "WebP resolution preservation"],
    ["preserves.resolution", "the preserves.resolution literal change"],
    ...REMOVED_CODES.map((code) => [code, `the removed code ${code}`] as const),
  ];
  for (const [needle, description] of claims) {
    if (!body.includes(needle)) {
      problems.push(
        `CHANGELOG ${release.heading} does not name ${description}`,
      );
    }
  }
  const claimsCdata = /cdata/i.test(body);
  if (cdataFixed && !claimsCdata) {
    problems.push(
      `parseXmp refuses CDATA entities typed but CHANGELOG ${release.heading} does not name the CDATA fix`,
    );
  }
  if (!cdataFixed && claimsCdata) {
    problems.push(
      `CHANGELOG ${release.heading} claims a CDATA fix that parseXmp does not have`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 5. No claim that WebP reports resolution false or declines a resolution request.

/** Prose sentences and table rows of a markdown document, whitespace collapsed. */
function claimUnits(doc: string): string[] {
  const units: string[] = [];
  for (const paragraph of doc.split(/\n\s*\n/)) {
    const lines = paragraph.split("\n");
    if (lines.every((line) => line.trimStart().startsWith("|"))) {
      units.push(...lines.map(collapse));
      continue;
    }
    units.push(...collapse(paragraph).split(/(?<=[.!?])\s+/));
  }
  return units;
}

export function checkNoWebpResolutionDecline(
  docs: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [name, doc] of Object.entries(docs)) {
    for (const unit of claimUnits(doc)) {
      if (!/\bwebp\b/i.test(unit)) continue;
      const claimsFalse = /resolution[`:\s]*false/i.test(unit);
      const claimsDecline =
        /declin\w*[^.]*resolution|resolution[^.]*declin/i.test(unit);
      if (claimsFalse || claimsDecline) {
        problems.push(
          `${name} claims a WebP resolution decline: ${unit.slice(0, 120)}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 6. The README quick-start passes every required preservation boolean.

export function checkQuickStart(
  readme: string,
  fields: readonly OptionField[],
): string[] {
  const call = /sanitizeFile\(\{([\s\S]*?)\}\)/.exec(
    sectionText(readme, "## Public API"),
  )?.[1];
  if (call === undefined)
    return ["README quick-start has no sanitizeFile call"];
  const problems: string[] = [];
  for (const field of fields) {
    if (field.optional) continue;
    const passed =
      field.type === "boolean"
        ? new RegExp(`\\b${field.name}:\\s*(true|false)\\b`).test(call)
        : new RegExp(`\\b${field.name}\\b`).test(call);
    if (!passed) {
      problems.push(`quick-start sanitizeFile call omits ${field.name}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

// Synthetic, compliant documents: each negative control reverts one claim of these, so a control
// proves its checker can fail regardless of the live docs' state.
const FIELDS: readonly OptionField[] = [
  { name: "sourcePath", optional: false, type: "string" },
  { name: "preserveOrientation", optional: false, type: "boolean" },
  { name: "preserveResolution", optional: false, type: "boolean" },
  { name: "signal", optional: true, type: "AbortSignal" },
];

const GOOD_README = [
  "# t",
  "",
  "## Formats",
  "",
  "| `format` | Detected by | Media types | Extensions | Removes | Preserves on request |",
  "| --- | --- | --- | --- | --- | --- |",
  "| `webp` | RIFF | `image/webp` | `.webp` | `EXIF` | orientation, ICC profile, timestamps, resolution (`EXIF` IFD0) |",
  "| `png` | sig | `image/png` | `.png` | `EXIF` | orientation, ICC profile, timestamps, resolution (`pHYs`) |",
  "",
  "## Public API",
  "",
  "```ts",
  "const sanitized = await sanitizeFile({",
  '  sourcePath: "a",',
  "  preserveOrientation: true,",
  "  preserveResolution: true,",
  "});",
  "```",
  "",
  "- `SanitizeOptions`: `{ sourcePath, preserveOrientation, preserveResolution, signal? }`",
  "",
  "## Refusals",
  "",
  "`refuses` in `getCapabilities()` advertises the coarse classes a format can decline with.",
  "An actual refusal is a typed `MetadataError` whose `code` is the consumer signal; the class",
  "names are not carried per decline. Every ISOBMFF refusal happens before any destination is",
  "created and is `safe-to-fallback`.",
  "",
  "| Refusal | Meaning |",
  "| --- | --- |",
  "| `malformed-container` | a |",
  "| `image-sequence` | b |",
  "",
].join("\n");

const GOOD_ISOBMFF = [
  "| Public refusal | Internal |",
  "| --- | --- |",
  "| `malformed-container` | `box-framing` |",
  "| `image-sequence` | `sequence-box` |",
  "",
].join("\n");

const REFUSALS = ["malformed-container", "image-sequence"] as const;

const GOOD_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Added",
  "",
  "WebP preserveResolution keeps the resolution tags.",
  "",
  "### Security",
  "",
  "The leading ftyp box is capped at 256 bytes.",
  "",
  "### Changed",
  "",
  "`preserves.resolution` for WebP is now true.",
  "",
  "### Fixed",
  "",
  "An XMP packet with an invalid CDATA numeric entity is refused typed.",
  "",
  "### Removed",
  "",
  "The codes destination-changed and cleanup-failed were removed.",
  "",
  "## 0.4.0",
  "",
  "### Added",
  "",
].join("\n");

describe("docs contract: SanitizeOptions bullet (1)", () => {
  it("equals the exported SanitizeOptions property names", async () => {
    const fields = sanitizeOptionFields(await read(TYPES_PATH));
    expect(fields.map((field) => field.name)).toEqual([
      "sourcePath",
      "destinationPath",
      "preserveOrientation",
      "preserveColorProfile",
      "preserveTimestamps",
      "preserveResolution",
      "signal",
    ]);
    expect(checkSanitizeOptionsBullet(await read(README_PATH), fields)).toEqual(
      [],
    );
  });

  it("negative control: a missing field, a stranger, a reorder or no bullet is red", () => {
    expect(checkSanitizeOptionsBullet(GOOD_README, FIELDS)).toEqual([]);
    expect(
      checkSanitizeOptionsBullet(
        GOOD_README.replace(" preserveResolution,", ""),
        FIELDS,
      ),
    ).toEqual(["SanitizeOptions bullet is missing preserveResolution"]);
    expect(
      checkSanitizeOptionsBullet(
        GOOD_README.replace(" signal? }", " signal?, overwrite }"),
        FIELDS,
      ),
    ).toEqual(["SanitizeOptions bullet lists unknown overwrite"]);
    expect(
      checkSanitizeOptionsBullet(
        GOOD_README.replace(
          "sourcePath, preserveOrientation",
          "preserveOrientation, sourcePath",
        ),
        FIELDS,
      ),
    ).toEqual(["SanitizeOptions bullet lists the fields in another order"]);
    expect(checkSanitizeOptionsBullet("no bullet here", FIELDS)).toEqual([
      "README has no `SanitizeOptions` bullet",
    ]);
  });
});

describe("docs contract: preserves phrases in the format table (2)", () => {
  it("every true key has its phrase in its row and every false key has none", async () => {
    const formats = getCapabilities().formats;
    expect(checkPreservesPhrases(await read(README_PATH), formats)).toEqual([]);
    const webp = formats.find((entry) => entry.format === "webp");
    expect(webp?.preserves).toMatchObject({
      orientation: true,
      colorProfile: true,
      timestamps: true,
      resolution: true,
    });
  });

  it("negative control: a dropped phrase and a phrase for a false key are red", () => {
    const all = {
      orientation: true,
      colorProfile: true,
      timestamps: true,
      resolution: true,
    };
    const formats = [
      { format: "webp", preserves: all },
      { format: "png", preserves: all },
    ];
    expect(checkPreservesPhrases(GOOD_README, formats)).toEqual([]);
    expect(
      checkPreservesPhrases(
        GOOD_README.replace(", resolution (`EXIF` IFD0)", ""),
        formats,
      ),
    ).toEqual([
      'webp row does not name "resolution" though preserves.resolution is true',
    ]);
    expect(
      checkPreservesPhrases(GOOD_README, [
        formats[0] as FormatPreserves,
        { format: "png", preserves: { ...all, resolution: false } },
      ]),
    ).toEqual([
      'png row names "resolution" though preserves.resolution is false',
    ]);
    expect(
      checkPreservesPhrases(GOOD_README, [
        { format: "bmp", preserves: { orientation: true } },
      ]),
    ).toEqual(["README table has no row for bmp"]);
  });
});

describe("docs contract: HEIF refusals and the F-1 wording (3)", () => {
  it("lists every HEIF_REFUSALS member in the README and docs/isobmff.md and states the D-20 wording", async () => {
    expect(
      checkRefusalDocs(
        await read(README_PATH),
        await read(ISOBMFF_PATH),
        HEIF_REFUSALS,
      ),
    ).toEqual([]);
  });

  it("negative control: the restored F-1 sentence, a missing advertisement or a missing row is red", () => {
    expect(checkRefusalDocs(GOOD_README, GOOD_ISOBMFF, REFUSALS)).toEqual([]);
    const restored = `${GOOD_README}\nHEIC and AVIF report these \`refuses\` classes, each returned before any destination is created:\n`;
    expect(checkRefusalDocs(restored, GOOD_ISOBMFF, REFUSALS)).toEqual([
      'README still carries the F-1 overclaim "each returned before any destination is created"',
      'README still carries the F-1 overclaim "report these `refuses` classes"',
    ]);
    expect(
      checkRefusalDocs(
        GOOD_README.replace(
          "advertises the coarse classes a format can decline with",
          "lists classes",
        ),
        GOOD_ISOBMFF,
        REFUSALS,
      ),
    ).toEqual([
      'README does not say "advertises the coarse classes a format can decline with"',
    ]);
    expect(
      checkRefusalDocs(
        GOOD_README,
        GOOD_ISOBMFF.replace("`image-sequence`", "`x`"),
        REFUSALS,
      ),
    ).toEqual(["docs/isobmff.md refusal table is missing image-sequence"]);
    expect(
      checkRefusalDocs(
        GOOD_README.replace("| `malformed-container` | a |", "| `x` | a |"),
        GOOD_ISOBMFF,
        REFUSALS,
      ),
    ).toEqual(["README refusal table is missing malformed-container"]);
  });
});

describe("docs contract: CHANGELOG (4)", () => {
  it("has the package-version section and names the 0.5.0 changes, the CDATA fix exactly when parseXmp has it", async () => {
    const version = (
      JSON.parse(await read(PACKAGE_PATH)) as { version: string }
    ).version;
    expect(
      checkChangelog(await read(CHANGELOG_PATH), version, cdataFixIsPresent()),
    ).toEqual([]);
  });

  it("derives the CDATA fact from parseXmp behaviour", () => {
    expect(typeof cdataFixIsPresent()).toBe("boolean");
  });

  it("negative control: missing entries and headings, a missing version section and both CDATA polarities are red", () => {
    expect(checkChangelog(GOOD_CHANGELOG, "0.4.0", true)).toEqual([]);
    expect(
      checkChangelog(GOOD_CHANGELOG.replaceAll("ftyp", "box"), "0.4.0", true),
    ).toEqual(["CHANGELOG Unreleased does not name the 256-byte ftyp cap"]);
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replaceAll("preserves.resolution", "the capability"),
        "0.4.0",
        true,
      ),
    ).toEqual([
      "CHANGELOG Unreleased does not name the preserves.resolution literal change",
    ]);
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replaceAll("destination-changed", "x"),
        "0.4.0",
        true,
      ),
    ).toEqual([
      "CHANGELOG Unreleased does not name the removed code destination-changed",
    ]);
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replace("### Security", "### Hardening"),
        "0.4.0",
        true,
      ),
    ).toEqual(['CHANGELOG Unreleased has no "### Security"']);
    // Bumped without renaming Unreleased, and a stranger heading.
    expect(checkChangelog(GOOD_CHANGELOG, "0.5.0", true)).toEqual([
      "package version 0.5.0 has no CHANGELOG section but the top section is still Unreleased",
    ]);
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replace("## Unreleased", "## Next"),
        "0.4.0",
        true,
      ),
    ).toEqual([
      'top CHANGELOG section "Next" is neither Unreleased nor 0.4.0',
      "CHANGELOG has neither a 0.5.0 nor an Unreleased section",
    ]);
    expect(checkChangelog("# Changelog\n", "0.4.0", true)).toEqual([
      "CHANGELOG has no section",
    ]);
    // After the bump the undated (or dated) 0.5.0 heading is the section.
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replace("## Unreleased", "## 0.5.0"),
        "0.5.0",
        true,
      ),
    ).toEqual([]);
    expect(
      checkChangelog(
        GOOD_CHANGELOG.replace("## Unreleased", "## 0.5.0 - 2026-11-10"),
        "0.5.0",
        true,
      ),
    ).toEqual([]);
    // Both CDATA polarities: claimed while absent, absent while present.
    const noCdata = GOOD_CHANGELOG.replace(/[^\n]*CDATA[^\n]*\n/, "").replace(
      "### Fixed\n\n",
      "",
    );
    expect(checkChangelog(GOOD_CHANGELOG, "0.4.0", false)).toEqual([
      "CHANGELOG Unreleased claims a CDATA fix that parseXmp does not have",
    ]);
    expect(
      checkChangelog(noCdata.replace("### Fixed\n", ""), "0.4.0", true),
    ).toEqual([
      'CHANGELOG Unreleased has no "### Fixed"',
      "parseXmp refuses CDATA entities typed but CHANGELOG Unreleased does not name the CDATA fix",
    ]);
    expect(
      checkChangelog(noCdata.replace("### Fixed\n", ""), "0.4.0", false),
    ).toEqual([]);
  });
});

describe("docs contract: no WebP resolution decline claim (5)", () => {
  it("docs/capabilities.md and docs/format-admission.md claim neither a false capability nor a decline", async () => {
    expect(
      checkNoWebpResolutionDecline({
        "docs/capabilities.md": await read(CAPABILITIES_PATH),
        "docs/format-admission.md": await read(ADMISSION_PATH),
      }),
    ).toEqual([]);
  });

  it("negative control: each old claim shape is red, the generic and PNG sentences are not", () => {
    expect(
      checkNoWebpResolutionDecline({
        a: "WebP reports `resolution: false`. WebP has no chunk.",
      }),
    ).toHaveLength(1);
    expect(
      checkNoWebpResolutionDecline({
        a: "| Resolution | a format reporting `false` (WebP) declines a `preserveResolution: true` request |",
      }),
    ).toHaveLength(1);
    expect(
      checkNoWebpResolutionDecline({
        a: "PNG can honor it (unlike WebP, which reports `resolution:\nfalse` and declines the request).",
      }),
    ).toHaveLength(1);
    expect(
      checkNoWebpResolutionDecline({
        a: "A request against a format whose capability reports `preserves.resolution: false` declines with `unsupported-feature`.\n\nWebP reports `resolution: true`.",
      }),
    ).toEqual([]);
  });
});

describe("docs contract: README quick-start (6)", () => {
  it("passes every required preservation boolean to sanitizeFile", async () => {
    const fields = sanitizeOptionFields(await read(TYPES_PATH));
    expect(checkQuickStart(await read(README_PATH), fields)).toEqual([]);
  });

  it("negative control: a call without preserveResolution, a renamed field or no call is red", () => {
    expect(checkQuickStart(GOOD_README, FIELDS)).toEqual([]);
    expect(
      checkQuickStart(
        GOOD_README.replace("  preserveResolution: true,\n", ""),
        FIELDS,
      ),
    ).toEqual(["quick-start sanitizeFile call omits preserveResolution"]);
    expect(
      checkQuickStart(GOOD_README.replace("sourcePath: ", "source: "), FIELDS),
    ).toEqual(["quick-start sanitizeFile call omits sourcePath"]);
    expect(
      checkQuickStart(
        GOOD_README.replaceAll("sanitizeFile({", "sanitize({"),
        FIELDS,
      ),
    ).toEqual(["README quick-start has no sanitizeFile call"]);
  });
});
