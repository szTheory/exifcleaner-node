// QUA-02 / D-28 (62.1-06): the closed classification lists, parsed from `docs/isobmff.md`'s
// `## Classification lists (QUA-02)` section (the single source), and the classifier that reports
// every type an independent inventory saw that no list names.
//
// Independence (D-19/D-21): this file never imports `src/isobmff/` (the engine under test), the
// builder or the test handler; `tests/isobmff_isolation.test.ts` enforces it. The engine
// agreement lives in `tests/isobmff_spec_lists.test.ts`, a test file allowed to import the engine.
import { readFileSync } from "node:fs";
import type { IsobmffInventory } from "./inventory.js";

export type SpecVerdict = "preserve" | "remove" | "decline";

export type SpecListKind = "top-level" | "meta-child" | "item" | "property";

export interface IsobmffSpecLists {
  readonly topLevel: ReadonlyMap<string, SpecVerdict>;
  readonly metaChildren: ReadonlyMap<string, SpecVerdict>;
  readonly itemTypes: ReadonlyMap<string, SpecVerdict>;
  readonly propertyTypes: ReadonlyMap<string, SpecVerdict>;
}

export interface SpecTypeVerdict {
  readonly kind: SpecListKind;
  readonly type: string;
  readonly verdict: SpecVerdict;
}

export interface SpecUnlistedType {
  readonly kind: SpecListKind;
  readonly type: string;
}

export interface SpecClassification {
  /** One entry per distinct (kind, type) the inventory saw that a list names, sorted. */
  readonly verdicts: readonly SpecTypeVerdict[];
  /** One entry per distinct (kind, type) the inventory saw that no list names, sorted. */
  readonly unlisted: readonly SpecUnlistedType[];
}

export const EMPTY_SPEC_LISTS: IsobmffSpecLists = Object.freeze({
  topLevel: new Map<string, SpecVerdict>(),
  metaChildren: new Map<string, SpecVerdict>(),
  itemTypes: new Map<string, SpecVerdict>(),
  propertyTypes: new Map<string, SpecVerdict>(),
});

const SECTION_HEADING = "## Classification lists (QUA-02)";

/** The four `###` subsections, in the order the doc carries them. */
const LIST_HEADINGS: readonly (readonly [keyof IsobmffSpecLists, string])[] = [
  ["topLevel", "### Top-level boxes"],
  ["metaChildren", "### `meta` children"],
  ["itemTypes", "### Item types"],
  ["propertyTypes", "### `ipco` property types"],
];

const VERDICTS: readonly SpecVerdict[] = ["preserve", "remove", "decline"];

const TABLE_HEADER = /^\|\s*Type\s*\|\s*Verdict\s*\|\s*Basis\s*\|$/u;
const TABLE_DIVIDER = /^\|[\s|:-]+\|$/u;
/** A row: a backticked four-character type (spaces kept), a verdict word, a basis. */
const TABLE_ROW = /^\|\s*`([^`]{4})`\s*\|\s*([^|]*?)\s*\|.*\|$/u;

const DOC_URL = new URL("../../docs/isobmff.md", import.meta.url);

/** The lines of `## Classification lists (QUA-02)` up to the next `## ` heading. */
function sectionLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) {
    throw new Error(`docs/isobmff.md has no "${SECTION_HEADING}" section`);
  }
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^## /u.test(line)) break;
    body.push(line);
  }
  return body;
}

/** The single `| Type | Verdict | Basis |` table under `heading`, before the next `###`. */
function parseTable(
  lines: readonly string[],
  heading: string,
): Map<string, SpecVerdict> {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`${SECTION_HEADING} has no "${heading}" list`);
  }
  const list = new Map<string, SpecVerdict>();
  let sawHeader = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) continue;
    if (TABLE_HEADER.test(line)) {
      if (sawHeader) {
        throw new Error(`"${heading}" carries more than one table`);
      }
      sawHeader = true;
      continue;
    }
    if (TABLE_DIVIDER.test(line)) continue;
    const match = TABLE_ROW.exec(line);
    if (!sawHeader || match === null) {
      throw new Error(`"${heading}" has an unparseable row: ${line}`);
    }
    const type = match[1] ?? "";
    const verdict = match[2] ?? "";
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      throw new Error(
        `"${heading}" row for "${type}" has verdict "${verdict}", not one of ${VERDICTS.join("/")}`,
      );
    }
    if (list.has(type)) {
      throw new Error(`"${heading}" lists "${type}" twice (duplicate type)`);
    }
    list.set(type, verdict as SpecVerdict);
  }
  if (!sawHeader || list.size === 0) {
    throw new Error(`"${heading}" has no | Type | Verdict | Basis | rows`);
  }
  return list;
}

/** Parses the four closed lists out of a `docs/isobmff.md` text. Throws on a missing section or
 * list, a duplicated type within a list, or a verdict outside preserve/remove/decline. */
export function parseIsobmffSpecLists(markdown: string): IsobmffSpecLists {
  const lines = sectionLines(markdown);
  const [topLevel, metaChildren, itemTypes, propertyTypes] = LIST_HEADINGS.map(
    ([, heading]) => parseTable(lines, heading),
  );
  if (
    topLevel === undefined ||
    metaChildren === undefined ||
    itemTypes === undefined ||
    propertyTypes === undefined
  ) {
    throw new Error("spec lists: expected four parsed tables");
  }
  return Object.freeze({ topLevel, metaChildren, itemTypes, propertyTypes });
}

/** Reads `docs/isobmff.md` relative to this module and parses its closed lists. */
export function loadIsobmffSpecLists(): IsobmffSpecLists {
  return parseIsobmffSpecLists(readFileSync(DOC_URL, "utf8"));
}

function compareEntries(
  a: { readonly kind: string; readonly type: string },
  b: { readonly kind: string; readonly type: string },
): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return 0;
}

/**
 * Classifies every distinct type an inventory saw (top-level boxes, `meta` children, item types,
 * `ipco` property types) against `lists`. Order-independent: the result is deduplicated and
 * sorted, so permuting boxes or `iinf` entries never changes it.
 */
export function classifyInventoryAgainstSpec(
  inventory: IsobmffInventory,
  lists: IsobmffSpecLists,
): SpecClassification {
  const seen: readonly (readonly [
    SpecListKind,
    ReadonlyMap<string, SpecVerdict>,
    readonly string[],
  ])[] = [
    ["top-level", lists.topLevel, inventory.topLevel.map((b) => b.type)],
    ["meta-child", lists.metaChildren, inventory.metaChildren],
    ["item", lists.itemTypes, inventory.items.map((item) => item.type)],
    [
      "property",
      lists.propertyTypes,
      inventory.properties.map((property) => property.type),
    ],
  ];
  const verdicts: SpecTypeVerdict[] = [];
  const unlisted: SpecUnlistedType[] = [];
  for (const [kind, list, types] of seen) {
    for (const type of new Set(types)) {
      const verdict = list.get(type);
      if (verdict === undefined) unlisted.push({ kind, type });
      else verdicts.push({ kind, type, verdict });
    }
  }
  return {
    verdicts: verdicts.sort(compareEntries),
    unlisted: unlisted.sort(compareEntries),
  };
}
