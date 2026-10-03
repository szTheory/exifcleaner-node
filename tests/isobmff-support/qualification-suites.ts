// Shared HEIC/AVIF qualification suites (62.1-10, D-28): QUA-02's inventory classification and
// QUA-03's property suite with its pure-copy drill. Both brands run the same rules, so the logic
// lives here once and each `tests/qualification/{heic,avif}/{parser,property}.test.ts` is a short
// call.
//
// Independence: every structural fact comes from the independent inventory walker
// (`inventory.ts`) and the closed lists in `docs/isobmff.md` (`spec-lists.ts`). This file never
// imports `src/isobmff/` (the engine under test); `tests/isobmff_isolation.test.ts` enforces it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../dist/index.js";
import type { SanitizeOptions } from "../../src/types.js";
import { createMinimalExif } from "../../src/metadata/exif.js";
import type {
  FormatGenerator,
  PlantedCanary,
} from "../qualification/kit/generators.js";
import {
  loadCorpusRecord,
  materializeRecord,
} from "../qualification/kit/corpus.js";
import { heifFile } from "./builder.js";
import {
  downloadGate,
  firstSurvivingWindow,
  RESIDUE_WINDOW,
  tracerRecords,
} from "./corpus-tracer.js";
import type { IsobmffMetadataKind } from "./generator.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
  type IsobmffInventory,
} from "./inventory.js";
import {
  classifyInventoryAgainstSpec,
  loadIsobmffSpecLists,
  type IsobmffSpecLists,
} from "./spec-lists.js";

/** The fixed seed and sample count every generator leg runs at (D-20). */
export const ISOBMFF_FC_SEED = 460_046;
export const ISOBMFF_FC_RUNS = 200;

export type IsobmffBrand = "heic" | "avif";

export type Preservation = Omit<
  SanitizeOptions,
  "sourcePath" | "destinationPath" | "signal"
>;

export const DEFAULT_PRESERVATION: Preservation = Object.freeze({
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
});

export const ALL_FALSE_PRESERVATION: Preservation = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

export type CorpusSetting = "default" | "all-false";

const CORPUS_SETTINGS: readonly (readonly [CorpusSetting, Preservation])[] = [
  ["default", DEFAULT_PRESERVATION],
  ["all-false", ALL_FALSE_PRESERVATION],
];

export interface IsobmffParserSuiteConfig {
  readonly format: IsobmffBrand;
  readonly extension: string;
  readonly generator: FormatGenerator<IsobmffMetadataKind>;
  /** Records whose default-settings outcome is a measured, pinned refusal (62.1-09). */
  readonly defaultSettingsRefusals: Readonly<
    Record<string, { readonly code: string }>
  >;
}

export type SanitizeOutcome =
  | { readonly ok: true; readonly output: Buffer }
  | { readonly ok: false; readonly code: string };

/** Sanitizes `source` through `sanitize` with `preservation`; returns the output bytes or the
 * refusal code. */
export async function sanitizeBytes(
  source: Buffer,
  extension: string,
  preservation: Preservation,
  sanitize: typeof sanitizeFile = sanitizeFile,
): Promise<SanitizeOutcome> {
  const directory = await mkdtemp(join(tmpdir(), "isobmff-qualification-"));
  try {
    const sourcePath = join(directory, `source${extension}`);
    const destinationPath = join(directory, `sanitized${extension}`);
    await writeFile(sourcePath, source);
    const result = await sanitize({
      sourcePath,
      destinationPath,
      ...preservation,
    });
    if (!result.ok) return { ok: false, code: result.error.code };
    return { ok: true, output: await readFile(destinationPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fails, naming each type and `label` (record or seed, and source or output), when the
 * inventory of `bytes` holds a type no closed list names. */
export function assertEveryTypeListed(
  bytes: Buffer,
  lists: IsobmffSpecLists,
  label: string,
): void {
  const { unlisted } = classifyInventoryAgainstSpec(
    inventoryIsobmff(bytes),
    lists,
  );
  if (unlisted.length > 0)
    throw new Error(
      `${label}: unlisted type(s) ${unlisted.map((entry) => `${entry.kind}:${entry.type}`).join(", ")}`,
    );
}

/** Strict preserve-only: every output type is listed AND classifies as preserve (an output still
 * holding Exif, mime/XMP, free, skip or a C2PA uuid -- or any decline type -- fails). The rule for
 * all-flags-false outputs. */
export function assertOutputPreserveOnly(
  output: Buffer,
  lists: IsobmffSpecLists,
  label: string,
): void {
  assertOutputPreserveExcept(output, lists, label, false);
}

function assertOutputPreserveExcept(
  output: Buffer,
  lists: IsobmffSpecLists,
  label: string,
  allowExifItem: boolean,
): void {
  assertEveryTypeListed(output, lists, label);
  const { verdicts } = classifyInventoryAgainstSpec(
    inventoryIsobmff(output),
    lists,
  );
  const kept = verdicts.filter(
    (entry) =>
      entry.verdict !== "preserve" &&
      !(allowExifItem && entry.kind === "item" && entry.type === "Exif"),
  );
  if (kept.length > 0)
    throw new Error(
      `${label}: output keeps non-preserve type(s) ${kept.map((entry) => `${entry.kind}:${entry.type} (${entry.verdict})`).join(", ")}`,
    );
}

/** IFD0 tag ids of a TIFF structure, plus whether it chains a next IFD. A bounded, test-local
 * reader (never the engine's `parseExif`); throws on a structure it cannot walk. */
export function readTiffIfd0(tiff: Buffer): {
  readonly tags: readonly number[];
  readonly nextIfd: number;
} {
  if (tiff.length < 8) throw new Error("TIFF header is truncated");
  const order = tiff.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM")
    throw new Error("TIFF byte order is not II or MM");
  const little = order === "II";
  const u16 = (at: number): number =>
    little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number): number =>
    little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (u16(2) !== 42) throw new Error("TIFF magic is not 42");
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) throw new Error("IFD0 is out of bounds");
  const count = u16(ifd);
  const end = ifd + 2 + count * 12;
  if (end + 4 > tiff.length) throw new Error("IFD0 is truncated");
  const tags: number[] = [];
  for (let index = 0; index < count; index += 1)
    tags.push(u16(ifd + 2 + index * 12));
  return { tags, nextIfd: u32(end) };
}

/** The TIFF inside an `Exif` item payload: `exif_tiff_header_offset` (4 bytes) then that many
 * bytes before the header (ISO/IEC 23008-12 Annex A). */
export function exifItemTiff(payload: Buffer): Buffer {
  if (payload.length < 4) throw new Error("Exif item payload is truncated");
  const offset = payload.readUInt32BE(0);
  if (4 + offset > payload.length)
    throw new Error("Exif item header offset is out of bounds");
  return payload.subarray(4 + offset);
}

/**
 * D-13's closed allowed set of minimal-Exif tags, derived from the writer itself rather than
 * copied by hand: the IFD0 tags `createMinimalExif` (src/metadata/exif.ts, "the only tags
 * `createMinimalExif` may ever write") emits when asked for everything it can write. D-13
 * (62-CONTEXT.md, docs/isobmff.md "D-13: minimal Exif item") makes that payload the only Exif an
 * ISOBMFF output may carry.
 */
export const D13_MINIMAL_EXIF_TAGS: ReadonlySet<number> = new Set(
  readTiffIfd0(
    createMinimalExif({
      orientation: 1,
      resolution: {
        x: { numerator: 72, denominator: 1 },
        y: { numerator: 72, denominator: 1 },
        unit: 2,
      },
    }),
  ).tags,
);

function itemPayloads(
  bytes: Buffer,
  inventory: IsobmffInventory,
  type: string,
): readonly { readonly id: number; readonly payload: Buffer }[] {
  return inventory.items
    .filter((item) => item.type === type && item.extents.length > 0)
    .map((item) => ({
      id: item.id,
      payload: readItemExtentBytes(bytes, inventory, item),
    }));
}

/**
 * The one exception to preserve-only for default-settings outputs (maintainer decision
 * 2026-10-03): an `Exif` item may remain only when (i) the source had an Exif item, (ii) it holds
 * no planted canary, (iii) it holds no 32-byte window of any source Exif payload (the ISO-01
 * residue check), and (iv) its parsed tag set is a subset of `D13_MINIMAL_EXIF_TAGS` (no next IFD
 * either). Throws naming the first failed condition.
 */
export function assertKeptExifIsMinimal(
  source: Buffer,
  output: Buffer,
  planted: readonly PlantedCanary<string>[],
  label: string,
): void {
  const outputInventory = inventoryIsobmff(output);
  const kept = outputInventory.items.filter((item) => item.type === "Exif");
  if (kept.length === 0) return;
  const sourceInventory = inventoryIsobmff(source);
  if (!sourceInventory.items.some((item) => item.type === "Exif"))
    throw new Error(
      `${label}: output keeps an Exif item but the source had none`,
    );
  const sourceExif = itemPayloads(source, sourceInventory, "Exif");
  for (const { id, payload } of itemPayloads(output, outputInventory, "Exif")) {
    for (const item of planted) {
      if (payload.includes(Buffer.from(item.canary, "ascii")))
        throw new Error(
          `${label}: kept Exif item ${id} holds the planted ${item.kind} canary`,
        );
    }
    for (const source of sourceExif) {
      const at = firstSurvivingWindow(source.payload, payload);
      if (at !== -1)
        throw new Error(
          `${label}: kept Exif item ${id} holds a ${RESIDUE_WINDOW}-byte window of source Exif item ${source.id} (at ${at})`,
        );
    }
    const { tags, nextIfd } = readTiffIfd0(exifItemTiff(payload));
    const extra = tags.filter((tag) => !D13_MINIMAL_EXIF_TAGS.has(tag));
    if (extra.length > 0 || nextIfd !== 0)
      throw new Error(
        `${label}: kept Exif item ${id} carries tag(s) outside the D-13 set: ${[...extra.map((tag) => `0x${tag.toString(16).padStart(4, "0")}`), ...(nextIfd !== 0 ? ["IFD1"] : [])].join(", ")}`,
      );
  }
}

/**
 * The QUA-02 output rule. All flags false: strictly preserve-only. Default settings: every type
 * listed and preserve, except an `Exif` item that passes `assertKeptExifIsMinimal`.
 */
export function assertOutputRule(
  source: Buffer,
  output: Buffer,
  lists: IsobmffSpecLists,
  setting: CorpusSetting,
  planted: readonly PlantedCanary<string>[],
  label: string,
): void {
  if (setting === "all-false") {
    assertOutputPreserveOnly(output, lists, label);
    return;
  }
  assertOutputPreserveExcept(output, lists, label, true);
  assertKeptExifIsMinimal(source, output, planted, label);
}

/** A little-endian or big-endian TIFF with one IFD0 of `entries` (each value inline when it fits
 * in 4 bytes, otherwise stored after the IFD), for the D-13 red controls. */
export function tiffWithIfd0(
  littleEndian: boolean,
  entries: readonly {
    readonly tag: number;
    readonly type: number;
    readonly count: number;
    readonly value: Buffer;
  }[],
): Buffer {
  const ifdEnd = 8 + 2 + entries.length * 12 + 4;
  const header = Buffer.alloc(ifdEnd);
  const u16 = (value: number, at: number): number =>
    littleEndian
      ? header.writeUInt16LE(value, at)
      : header.writeUInt16BE(value, at);
  const u32 = (value: number, at: number): number =>
    littleEndian
      ? header.writeUInt32LE(value, at)
      : header.writeUInt32BE(value, at);
  header.write(littleEndian ? "II" : "MM", 0, "ascii");
  u16(42, 2);
  u32(8, 4);
  u16(entries.length, 8);
  const tail: Buffer[] = [];
  let tailOffset = ifdEnd;
  for (const [index, entry] of entries.entries()) {
    const at = 10 + index * 12;
    u16(entry.tag, at);
    u16(entry.type, at + 2);
    u32(entry.count, at + 4);
    if (entry.value.length <= 4) entry.value.copy(header, at + 8);
    else {
      u32(tailOffset, at + 8);
      tail.push(entry.value);
      tailOffset += entry.value.length;
    }
  }
  return Buffer.concat([header, ...tail]);
}

/** An `Exif` item payload: `exif_tiff_header_offset` 0, then `tiff`. */
export function exifItemPayload(tiff: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), tiff]);
}

/** A builder HEIF with one hvc1 primary and, optionally, an Exif item and an XMP item. */
export function controlHeif(
  exifPayload: Buffer | undefined,
  xmpPayload?: Buffer,
): Buffer {
  return heifFile({
    primary: {
      itemId: 1,
      itemType: "hvc1",
      width: 64,
      height: 64,
      payload: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
    },
    ...(exifPayload === undefined
      ? {}
      : { exif: { itemId: 2, payload: exifPayload } }),
    ...(xmpPayload === undefined
      ? {}
      : {
          mime: {
            itemId: 3,
            contentType: "application/rdf+xml",
            payload: xmpPayload,
          },
        }),
  });
}

/** A copy of `lists` with one type dropped from one list (red-control helper). */
function listsWithout(
  lists: IsobmffSpecLists,
  key: keyof IsobmffSpecLists,
  type: string,
): IsobmffSpecLists {
  const reduced = new Map(lists[key]);
  reduced.delete(type);
  return { ...lists, [key]: reduced };
}

/** A top-level box of `type` with `payload` (red-control helper). */
function topLevelBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

// Measured 2026-10-03 on this host (load average ~11): the HEIC 200-sample generator leg (two
// sanitizes per sample) took 3.8 s and the slowest corpus record under 0.1 s. The budgets leave
// room for a loaded CI runner.
const GENERATOR_LEG_TIMEOUT_MS = 120_000;
const CORPUS_RECORD_TIMEOUT_MS = 60_000;

/**
 * QUA-02 / D-28: classifies, against the closed spec lists, every top-level box, `meta` child,
 * item and property type in the source AND the native output (default settings and all flags
 * false) of every corpus record of `config.format` (refused records: source only) and of 200
 * generator samples at the fixed seed. Any unlisted type fails naming the type, the record or
 * seed, and source or output; outputs follow `assertOutputRule` (all flags false: preserve-only;
 * default settings: preserve, or an Exif item passing `assertKeptExifIsMinimal`).
 */
export function defineIsobmffParserSuite(
  config: IsobmffParserSuiteConfig,
): void {
  const FORMAT = config.format.toUpperCase();
  describe(`${FORMAT} inventory classification (QUA-02)`, () => {
    const lists = loadIsobmffSpecLists();
    const records = tracerRecords(config.format);

    it(`covers every ${FORMAT} corpus record`, () => {
      expect(records.length).toBeGreaterThan(0);
    });

    for (const record of records) {
      const gate = downloadGate(record);
      if (gate.kind === "fail") {
        it(`${record.id}: download-only record needs the fetch cache in CI`, () => {
          throw new Error(gate.reason);
        });
        continue;
      }
      if (gate.kind === "skip") {
        console.warn(`skipping ${gate.reason}`);
        it.skip(`${record.id}: download-only (no local fetch cache)`, () => {});
        continue;
      }
      const refused = record.outcome.status === "refused";
      it(
        refused
          ? `${record.id}: every source type is listed (refused record, source only)`
          : `${record.id}: every source type is listed; outputs follow the output rule (all flags false: preserve-only; default: preserve or the D-13 minimal Exif)`,
        async () => {
          const source = await materializeRecord(
            await loadCorpusRecord(record.id),
          );
          assertEveryTypeListed(source, lists, `${record.id} source`);
          if (refused) return;
          for (const [setting, preservation] of CORPUS_SETTINGS) {
            const outcome = await sanitizeBytes(
              source,
              config.extension,
              preservation,
            );
            if (!outcome.ok) {
              // Only a pinned default-settings refusal (62.1-09) may stand in for an output.
              const pinned =
                setting === "default"
                  ? config.defaultSettingsRefusals[record.id]
                  : undefined;
              if (pinned === undefined || pinned.code !== outcome.code)
                throw new Error(
                  `${record.id} output (${setting}): unexpected refusal ${outcome.code}`,
                );
              continue;
            }
            assertOutputRule(
              source,
              outcome.output,
              lists,
              setting,
              [],
              `${record.id} output (${setting})`,
            );
          }
        },
        CORPUS_RECORD_TIMEOUT_MS,
      );
    }

    it(
      `every source and output type of ${ISOBMFF_FC_RUNS} generator samples at seed ${ISOBMFF_FC_SEED} is listed; outputs follow the output rule`,
      async () => {
        const samples = fc.sample(config.generator.arbitrary(), {
          seed: ISOBMFF_FC_SEED,
          numRuns: ISOBMFF_FC_RUNS,
        });
        expect(samples).toHaveLength(ISOBMFF_FC_RUNS);
        for (const [index, sample] of samples.entries()) {
          const label = `seed ${ISOBMFF_FC_SEED} sample ${index}`;
          assertEveryTypeListed(sample.bytes, lists, `${label} source`);
          for (const [setting, preservation] of CORPUS_SETTINGS) {
            const outcome = await sanitizeBytes(
              sample.bytes,
              config.extension,
              preservation,
            );
            if (!outcome.ok)
              throw new Error(
                `${label} output (${setting}): unexpected refusal ${outcome.code}`,
              );
            assertOutputRule(
              sample.bytes,
              outcome.output,
              lists,
              setting,
              sample.planted,
              `${label} output (${setting})`,
            );
          }
        }
      },
      GENERATOR_LEG_TIMEOUT_MS,
    );

    describe("red controls", () => {
      const [firstSample] = fc.sample(config.generator.arbitrary(), {
        seed: ISOBMFF_FC_SEED,
        numRuns: 1,
      });
      if (firstSample === undefined) throw new Error("generator gave nothing");

      it("an output with a planted Exif item fails the output rule, naming item:Exif", () => {
        // The generator source plants an Exif and an XMP item: offered as an output, it is the
        // synthetic output with a planted Exif item.
        expect(() =>
          assertOutputRule(
            firstSample.bytes,
            firstSample.bytes,
            lists,
            "all-false",
            firstSample.planted,
            "planted output",
          ),
        ).toThrow(
          /planted output: output keeps non-preserve type\(s\) .*item:Exif \(remove\)/u,
        );
        expect(() =>
          assertOutputRule(
            firstSample.bytes,
            firstSample.bytes,
            lists,
            "default",
            firstSample.planted,
            "planted output",
          ),
        ).toThrow(/planted output: output keeps non-preserve type\(s\)/u);
      });

      describe("D-13 kept-Exif exception (default settings only)", () => {
        const make = Buffer.from("GSD6210 control camera\0\0", "ascii");
        const orientationBe = Buffer.from([0x00, 0x06, 0x00, 0x00]);
        const sourceExif = exifItemPayload(
          tiffWithIfd0(false, [
            { tag: 0x010f, type: 2, count: make.length, value: make },
            { tag: 0x0112, type: 3, count: 1, value: orientationBe },
          ]),
        );
        const xmpCanary: PlantedCanary<string> = {
          kind: "XMP",
          canary: `EXIFCLEANER-CANARY-XMP-${"5a".repeat(16)}`,
        };
        const xmp = Buffer.from(
          `<x:xmpmeta><rdf:Description>${xmpCanary.canary}</rdf:Description></x:xmpmeta>`,
          "utf8",
        );
        const source = controlHeif(sourceExif, xmp);
        const minimal = exifItemPayload(createMinimalExif({ orientation: 6 }));
        const rule =
          (
            exifPayload: Buffer,
            setting: CorpusSetting = "default",
            from: Buffer = source,
          ) =>
          (): void =>
            assertOutputRule(
              from,
              controlHeif(exifPayload),
              lists,
              setting,
              [xmpCanary],
              "control output",
            );

        it("the D-13 set is the writer's own IFD0 tags and includes Orientation", () => {
          expect(D13_MINIMAL_EXIF_TAGS.has(0x0112)).toBe(true);
          expect(D13_MINIMAL_EXIF_TAGS.has(0x0131)).toBe(false);
        });

        it("positive: a minimal Exif (Orientation only) passes under default settings", () => {
          expect(rule(minimal)).not.toThrow();
        });

        it("an Exif item adding a tag outside the D-13 set fails", () => {
          const extra = exifItemPayload(
            tiffWithIfd0(true, [
              {
                tag: 0x0112,
                type: 3,
                count: 1,
                value: Buffer.from([0x06, 0x00, 0x00, 0x00]),
              },
              {
                tag: 0x0131,
                type: 2,
                count: 4,
                value: Buffer.from("gsd\0", "ascii"),
              },
            ]),
          );
          expect(rule(extra)).toThrow(
            "control output: kept Exif item 2 carries tag(s) outside the D-13 set: 0x0131",
          );
        });

        it("a kept Exif carrying a 32-byte window of the source Exif fails", () => {
          const window = sourceExif.subarray(30, 30 + RESIDUE_WINDOW);
          expect(rule(Buffer.concat([minimal, window]))).toThrow(
            /control output: kept Exif item 2 holds a 32-byte window of source Exif item 2/u,
          );
        });

        it("a kept Exif holding a planted canary fails", () => {
          const withCanary = Buffer.concat([
            minimal,
            Buffer.from(xmpCanary.canary, "ascii"),
          ]);
          expect(rule(withCanary)).toThrow(
            "control output: kept Exif item 2 holds the planted XMP canary",
          );
        });

        it("a kept Exif when the source had none fails", () => {
          expect(rule(minimal, "default", controlHeif(undefined, xmp))).toThrow(
            "control output: output keeps an Exif item but the source had none",
          );
        });

        it("under all flags false, even a minimal Exif fails", () => {
          expect(rule(minimal, "all-false")).toThrow(
            "control output: output keeps non-preserve type(s) item:Exif (remove)",
          );
        });
      });

      it("a real output with a free box appended fails the output rule, naming top-level:free", async () => {
        const outcome = await sanitizeBytes(
          firstSample.bytes,
          config.extension,
          ALL_FALSE_PRESERVATION,
        );
        if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
        assertOutputPreserveOnly(outcome.output, lists, "clean output");
        const padded = Buffer.concat([
          outcome.output,
          topLevelBox("free", Buffer.alloc(4)),
        ]);
        expect(() =>
          assertOutputPreserveOnly(padded, lists, "padded output"),
        ).toThrow(
          /padded output: output keeps non-preserve type\(s\) top-level:free \(remove\)/u,
        );
      });

      it("an unlisted type fails naming the type, the seed and the side", () => {
        expect(() =>
          assertEveryTypeListed(
            firstSample.bytes,
            listsWithout(lists, "propertyTypes", "ispe"),
            `seed ${ISOBMFF_FC_SEED} sample 0 source`,
          ),
        ).toThrow(
          `seed ${ISOBMFF_FC_SEED} sample 0 source: unlisted type(s) property:ispe`,
        );
      });
    });
  });
}
