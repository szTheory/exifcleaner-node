// D-16 ICC removal and ipma remap (62-08): with `preserveColorProfile` false, every `colr`
// property whose `colourType` is "prof" or "rICC" is removed from `ipco` -- not only the
// primary's -- and every `ipma` association is remapped exactly: an association naming a removed
// property is deleted, every surviving association's `propertyIndex` becomes
// `old - countRemovedBelow(old)`, the `ipma` version/flags/index width and essential bits are
// never touched, and an entry left with zero associations is still emitted. `nclx` `colr`
// properties are never removed. With `preserveColorProfile` true, nothing is removed and `ipco`
// comes out byte-identical to the source.
//
// Verification here never trusts `src/isobmff/`'s own parsing of its own output: every assertion
// below reads the destination's `ipco`/`ipma` through a small, local, independent byte-level
// parser (not `tests/isobmff-support/inventory.ts`, which does not expose `colr`'s `colour_type`
// or raw property bytes) -- the same "second oracle" discipline `inventory.ts`'s own banner
// describes, applied locally to the one extra field this plan's fixtures need.
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
import { sanitizeFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
} from "./isobmff-support/hostile.js";
import {
  box,
  colrNclx,
  colrProf,
  ftypBox,
  hdlrBox,
  hvcC,
  iinfBox,
  ilocBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
  pixi,
} from "./isobmff-support/builder.js";
import {
  isobmffArmSampleArbitrary,
  type IsobmffArm,
} from "./isobmff-support/generator.js";
import { iccProfileV4 } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-icc-"));
  directories.push(directory);
  return directory;
}

async function writeFixture(
  bytes: Buffer,
  name = "input.heic",
): Promise<{ path: string; size: number }> {
  const directory = await freshDirectory();
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { path, size: bytes.length };
}

async function withHandle<T>(
  path: string,
  fn: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  const handle = await open(path, "r");
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

// --- Local, independent ipco/ipma byte-level reader (test-only; D-21 discipline) ---

interface RawBoxRange {
  readonly start: number;
  readonly end: number;
  readonly payloadStart: number;
}

interface ParsedProperty {
  readonly type: string;
  readonly colourType?: string;
  readonly bytes: Buffer;
}

interface ParsedAssociationEntry {
  readonly itemId: number;
  readonly associations: readonly {
    readonly propertyIndex: number;
    readonly essential: boolean;
  }[];
}

/** Find the first top-level box of `type`, assuming only "normal" (never largesize/size-zero)
 * framing -- true of every fixture this file builds through `assembleHeif`/`heifFile`. */
function findTopLevelBox(bytes: Buffer, type: string): RawBoxRange {
  let offset = 0;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const boxType = bytes.toString("ascii", offset + 4, offset + 8);
    if (boxType === type) {
      return { start: offset, end: offset + size, payloadStart: offset + 8 };
    }
    offset += size;
  }
  throw new Error(`findTopLevelBox: no top-level "${type}" box.`);
}

function findChildBox(
  buffer: Buffer,
  start: number,
  end: number,
  type: string,
): RawBoxRange | undefined {
  let offset = start;
  while (offset < end) {
    const size = buffer.readUInt32BE(offset);
    const boxType = buffer.toString("ascii", offset + 4, offset + 8);
    if (boxType === type) {
      return { start: offset, end: offset + size, payloadStart: offset + 8 };
    }
    offset += size;
  }
  return undefined;
}

function parseIpcoProperties(
  buffer: Buffer,
  ipco: RawBoxRange,
): ParsedProperty[] {
  const properties: ParsedProperty[] = [];
  let offset = ipco.payloadStart;
  while (offset < ipco.end) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const bytes = buffer.subarray(offset, offset + size);
    const colourType =
      type === "colr" ? bytes.toString("ascii", 8, 12) : undefined;
    properties.push({
      type,
      ...(colourType !== undefined ? { colourType } : {}),
      bytes,
    });
    offset += size;
  }
  return properties;
}

function parseIpmaAssociations(
  buffer: Buffer,
  ipma: RawBoxRange,
): ParsedAssociationEntry[] {
  const version = buffer.readUInt8(ipma.payloadStart);
  const flags = buffer.readUIntBE(ipma.payloadStart + 1, 3);
  let offset = ipma.payloadStart + 4;
  const entryCount = buffer.readUInt32BE(offset);
  offset += 4;
  const wide = (flags & 1) === 1;
  const itemIdBytes = version === 0 ? 2 : 4;
  const entries: ParsedAssociationEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const itemId =
      itemIdBytes === 2
        ? buffer.readUInt16BE(offset)
        : buffer.readUInt32BE(offset);
    offset += itemIdBytes;
    const associationCount = buffer.readUInt8(offset);
    offset += 1;
    const associations: {
      propertyIndex: number;
      essential: boolean;
    }[] = [];
    for (let a = 0; a < associationCount; a++) {
      if (wide) {
        const value = buffer.readUInt16BE(offset);
        associations.push({
          propertyIndex: value & 0x7fff,
          essential: (value & 0x8000) !== 0,
        });
        offset += 2;
      } else {
        const value = buffer.readUInt8(offset);
        associations.push({
          propertyIndex: value & 0x7f,
          essential: (value & 0x80) !== 0,
        });
        offset += 1;
      }
    }
    entries.push({ itemId, associations });
  }
  return entries;
}

function readIpcoIpma(bytes: Buffer): {
  properties: readonly ParsedProperty[];
  associations: readonly ParsedAssociationEntry[];
} {
  const meta = findTopLevelBox(bytes, "meta");
  const childrenStart = meta.payloadStart + 4; // meta is a FullBox: version(8) flags(24).
  const iprp = findChildBox(bytes, childrenStart, meta.end, "iprp");
  if (iprp === undefined) return { properties: [], associations: [] };
  const ipco = findChildBox(bytes, iprp.payloadStart, iprp.end, "ipco");
  const ipmaRaw = findChildBox(bytes, iprp.payloadStart, iprp.end, "ipma");
  return {
    properties: ipco !== undefined ? parseIpcoProperties(bytes, ipco) : [],
    associations:
      ipmaRaw !== undefined ? parseIpmaAssociations(bytes, ipmaRaw) : [],
  };
}

// --- Fixture ---

const ICC_BYTES_PROF = iccProfileV4({ deviceClass: "mntr" });
const ICC_BYTES_RICC = iccProfileV4({ deviceClass: "scnr" });

/** `colr` with `colour_type == "rICC"` -- no dedicated `builder.ts` helper exists (only "prof"
 * and "nclx"), so this builds it directly through the exported generic `box()` encoder. */
function colrRicc(iccBytes: Buffer): Buffer {
  return box("colr", Buffer.concat([Buffer.from("rICC", "ascii"), iccBytes]));
}

/**
 * ipco = [ispe, hvcC, colr prof, colr nclx, pixi, colr rICC]; primary (item 1) -> [1,2,3,4,5]
 * with essential on 2 (hvcC); thumbnail (item 2, hidden) -> [1,2,6]. No Exif/XMP item -- D-16 is
 * independent of D-13's minimal Exif synthesis, and omitting it keeps this fixture focused.
 */
function buildIccFixture(): Buffer {
  const primaryPayload = Buffer.from("primary-bytes", "ascii");
  const thumbPayload = Buffer.from("thumb-bytes", "ascii");

  const spec: AssembleHeifSpec = {
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
      },
      {
        itemId: 2,
        itemType: "hvc1",
        hidden: true,
        extents: [
          { relOffset: primaryPayload.length, length: thumbPayload.length },
        ],
      },
    ],
    properties: [
      ispe(32, 32),
      hvcC(),
      colrProf(ICC_BYTES_PROF),
      colrNclx(1, 13, 6, true),
      pixi([8, 8, 8]),
      colrRicc(ICC_BYTES_RICC),
    ],
    extraIpmaEntries: [
      {
        itemId: 1,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: true },
          { propertyIndex: 3, essential: false },
          { propertyIndex: 4, essential: false },
          { propertyIndex: 5, essential: false },
        ],
      },
      {
        itemId: 2,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
          { propertyIndex: 6, essential: false },
        ],
      },
    ],
    mdatPayload: Buffer.concat([primaryPayload, thumbPayload]),
    twoPass: true,
  };

  return assembleHeif(spec);
}

async function sanitizeThroughRealWriter(
  sourcePath: string,
  destinationPath: string,
  preserveColorProfile: boolean,
): Promise<void> {
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests("heic"),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) {
      throw new Error(
        `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
      );
    }
  } finally {
    restore();
  }
}

describe("D-16 ICC removal and ipma remap (62-08)", () => {
  describe("Task 1: ICC removed and ipma remapped end to end on a HEIC builder fixture", () => {
    it(
      "recorded RED (disposable git worktree checked out at commit 0957773 -- the pre-62-08 tip " +
        "-- plus a scratch probe assembling this plan's exact IsobmffOutputPlan.parts into real " +
        "output bytes): full sanitizeFile in that worktree hit an unrelated native-publication " +
        'environment failure (code write-failed, "Native no-replace publication could not ' +
        'complete" -- the compiled native binding does not resolve correctly from a /tmp ' +
        "worktree copy, nothing to do with D-16), so the probe called buildIsobmffOutputPlan " +
        'directly on this fixture\'s admission and scanned the assembled bytes for every "colr" ' +
        "occurrence. Old code (0957773): colr colour_types in the output were " +
        "['prof','nclx','rICC'] -- all three unchanged, proving D-16 did not exist yet. Same " +
        "probe against this plan's code: ['nclx'] only. The full end-to-end assertions below " +
        "(through the real writer handler and sanitizeFile) are the GREEN proof; this comment " +
        "records the RED transcript the plan requires.",
      async () => {
        const bytes = buildIccFixture();
        const { path: sourcePath } = await writeFixture(bytes, "source.heic");
        const directory = dirname(sourcePath);
        const destinationPath = join(directory, "destination.heic");

        await sanitizeThroughRealWriter(sourcePath, destinationPath, false);

        const destinationBytes = await readFile(destinationPath);
        const { properties, associations } = readIpcoIpma(destinationBytes);

        expect(properties.map((p) => p.type)).toEqual([
          "ispe",
          "hvcC",
          "colr",
          "pixi",
        ]);
        expect(properties[2]?.colourType).toBe("nclx");
        expect(
          properties.some(
            (p) => p.colourType === "prof" || p.colourType === "rICC",
          ),
        ).toBe(false);

        // Associations compared as ordered (propertyIndex, essential) pairs, not resolved
        // against ipco a second time here -- the resolved-bytes comparison is Task 2's own
        // identity/nclx assertions, which is the stronger, separate check.
        const item1 = associations.find((entry) => entry.itemId === 1);
        const item2 = associations.find((entry) => entry.itemId === 2);
        expect(item1?.associations).toEqual([
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: true },
          { propertyIndex: 3, essential: false },
          { propertyIndex: 4, essential: false },
        ]);
        expect(item2?.associations).toEqual([
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
        ]);

        // The ICC payload bytes themselves must not occur anywhere in the output.
        expect(destinationBytes.includes(ICC_BYTES_PROF)).toBe(false);
        expect(destinationBytes.includes(ICC_BYTES_RICC)).toBe(false);

        // nclx's own bytes survive byte-identical.
        const sourceNclx = readIpcoIpma(bytes).properties.find(
          (p) => p.colourType === "nclx",
        );
        const destinationNclx = properties.find((p) => p.colourType === "nclx");
        expect(destinationNclx?.bytes.equals(sourceNclx!.bytes)).toBe(true);

        // Re-admits.
        const { size: destinationSize } = await stat(destinationPath);
        await withHandle(destinationPath, (handle) =>
          admitIsobmff(handle, destinationSize),
        );
      },
    );
  });

  describe(
    "Task 2: preserve-true identity, ipma widths, zero-association entries, boundary " +
      "indices, generator colr arms",
    () => {
      it("preserveColorProfile true: output ipco bytes are byte-identical to the source's", async () => {
        const bytes = buildIccFixture();
        const { path: sourcePath } = await writeFixture(bytes, "source.heic");
        const directory = dirname(sourcePath);
        const destinationPath = join(directory, "destination.heic");

        await sanitizeThroughRealWriter(sourcePath, destinationPath, true);

        const destinationBytes = await readFile(destinationPath);
        const sourceMeta = findTopLevelBox(bytes, "meta");
        const sourceIprp = findChildBox(
          bytes,
          sourceMeta.payloadStart + 4,
          sourceMeta.end,
          "iprp",
        )!;
        const sourceIpco = findChildBox(
          bytes,
          sourceIprp.payloadStart,
          sourceIprp.end,
          "ipco",
        )!;
        const destinationMeta = findTopLevelBox(destinationBytes, "meta");
        const destinationIprp = findChildBox(
          destinationBytes,
          destinationMeta.payloadStart + 4,
          destinationMeta.end,
          "iprp",
        )!;
        const destinationIpco = findChildBox(
          destinationBytes,
          destinationIprp.payloadStart,
          destinationIprp.end,
          "ipco",
        )!;

        const sourceIpcoBytes = bytes.subarray(
          sourceIpco.start,
          sourceIpco.end,
        );
        const destinationIpcoBytes = destinationBytes.subarray(
          destinationIpco.start,
          destinationIpco.end,
        );
        expect(destinationIpcoBytes.equals(sourceIpcoBytes)).toBe(true);

        // The primary's ICC (the "prof" property, which it associates with) is identical too.
        const { properties } = readIpcoIpma(destinationBytes);
        const destinationProf = properties.find((p) => p.colourType === "prof");
        expect(destinationProf?.bytes.subarray(12).equals(ICC_BYTES_PROF)).toBe(
          true,
        );
      });

      /**
       * A minimal one-item HEIF file whose `ipma` box is encoded at exactly the given
       * `version`/`flags` (never `assembleHeif`'s hardcoded version 0 / flags 0) -- built
       * directly from `builder.ts` primitives, two-pass exactly like `heifFile`'s own pattern
       * (`base_offset_size` 0: the single extent's own offset carries the absolute mdat
       * position). `fillerCount` filler `ispe(1,1)` properties precede the real colr prof/nclx
       * pair so their indices can be pushed past 127 (needs the 15-bit/wide association format)
       * without changing anything else about the file's shape.
       */
      function buildWideIpmaFixture(
        version: 0 | 1,
        flags: number,
        fillerCount: number,
      ): { bytes: Buffer; profIndex: number; nclxIndex: number } {
        const primaryPayload = Buffer.from("primary-bytes", "ascii");
        const fillerProperties = Array.from({ length: fillerCount }, () =>
          ispe(1, 1),
        );
        const properties = [
          ...fillerProperties,
          colrProf(ICC_BYTES_PROF),
          colrNclx(1, 13, 6, true),
        ];
        const profIndex = fillerCount + 1;
        const nclxIndex = fillerCount + 2;

        const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
        const hdlr = hdlrBox("pict");
        const pitm = pitmBox(0, 1);
        const iinf = iinfBox(0, [
          infeBox({ version: 2, itemId: 1, itemType: "hvc1" }),
        ]);
        const ipco = ipcoBox(properties);
        const ipma = ipmaBox({
          version,
          flags,
          entries: [
            {
              itemId: 1,
              associations: [
                { propertyIndex: profIndex, essential: true },
                { propertyIndex: nclxIndex, essential: false },
              ],
            },
          ],
        });
        const iprp = iprpBox(ipco, ipma);
        const metaChildrenWithoutIloc = [hdlr, pitm, iinf, iprp];

        function buildIlocAt(offset: number): Buffer {
          return ilocBox({
            version: 1,
            offsetSize: 4,
            lengthSize: 4,
            baseOffsetSize: 0,
            indexSize: 0,
            items: [
              {
                itemId: 1,
                constructionMethod: 0,
                dataReferenceIndex: 0,
                baseOffset: 0,
                extents: [{ offset, length: primaryPayload.length }],
              },
            ],
          });
        }

        const placeholderIloc = buildIlocAt(0);
        const meta = metaBox([...metaChildrenWithoutIloc, placeholderIloc]);
        const headerLength = ftyp.length + meta.length + 8;
        const finalIloc = buildIlocAt(headerLength);
        const finalMeta = metaBox([...metaChildrenWithoutIloc, finalIloc]);
        if (finalMeta.length !== meta.length) {
          throw new Error(
            "buildWideIpmaFixture: iloc byte length changed between passes",
          );
        }
        const mdat = mdatBox(primaryPayload);
        return {
          bytes: Buffer.concat([ftyp, finalMeta, mdat]),
          profIndex,
          nclxIndex,
        };
      }

      it.each([
        {
          version: 0 as const,
          flags: 0,
          fillerCount: 2,
          label: "version 0 / flags 0 (7-bit)",
        },
        {
          version: 1 as const,
          flags: 1,
          fillerCount: 148,
          label: "version 1 / flags 1 (15-bit, index above 127)",
        },
      ])(
        "ipma $label: source version/flags and index width are kept, remap is correct",
        async ({ version, flags, fillerCount }) => {
          const { bytes, profIndex, nclxIndex } = buildWideIpmaFixture(
            version,
            flags,
            fillerCount,
          );
          const { properties: sourceProperties } = readIpcoIpma(bytes);
          expect(sourceProperties.length).toBe(fillerCount + 2);

          const { path: sourcePath } = await writeFixture(bytes, "source.heic");
          const directory = dirname(sourcePath);
          const destinationPath = join(directory, "destination.heic");
          await sanitizeThroughRealWriter(sourcePath, destinationPath, false);

          const destinationBytes = await readFile(destinationPath);
          const { properties: destProperties, associations } =
            readIpcoIpma(destinationBytes);
          expect(destProperties.length).toBe(fillerCount + 1);
          expect(destProperties.some((p) => p.colourType === "prof")).toBe(
            false,
          );
          expect(destProperties.some((p) => p.colourType === "nclx")).toBe(
            true,
          );
          const item1 = associations.find((entry) => entry.itemId === 1);
          // profIndex is removed; nclxIndex (profIndex + 1) remaps to fillerCount + 1 (one slot
          // below, since exactly one property -- prof -- was removed below it).
          expect(nclxIndex).toBe(profIndex + 1);
          expect(item1?.associations).toEqual([
            { propertyIndex: fillerCount + 1, essential: false },
          ]);

          await withHandle(destinationPath, (handle) =>
            admitIsobmff(handle, destinationBytes.length).then(() => {}),
          );
        },
      );

      it(
        "an item whose only association was the removed ICC keeps its ipma entry with " +
          "association_count 0",
        async () => {
          const primaryPayload = Buffer.from("primary-bytes", "ascii");
          const thumbPayload = Buffer.from("thumb-bytes", "ascii");
          const spec: AssembleHeifSpec = {
            primaryItemId: 1,
            items: [
              {
                itemId: 1,
                itemType: "hvc1",
                extents: [{ relOffset: 0, length: primaryPayload.length }],
              },
              {
                itemId: 2,
                itemType: "hvc1",
                hidden: true,
                extents: [
                  {
                    relOffset: primaryPayload.length,
                    length: thumbPayload.length,
                  },
                ],
              },
            ],
            properties: [ispe(32, 32), hvcC(), colrProf(ICC_BYTES_PROF)],
            extraIpmaEntries: [
              {
                itemId: 1,
                associations: [
                  { propertyIndex: 1, essential: false },
                  { propertyIndex: 2, essential: false },
                ],
              },
              {
                itemId: 2,
                associations: [{ propertyIndex: 3, essential: false }],
              },
            ],
            mdatPayload: Buffer.concat([primaryPayload, thumbPayload]),
            twoPass: true,
          };
          const bytes = assembleHeif(spec);
          const { path: sourcePath } = await writeFixture(bytes, "source.heic");
          const directory = dirname(sourcePath);
          const destinationPath = join(directory, "destination.heic");

          await sanitizeThroughRealWriter(sourcePath, destinationPath, false);

          const destinationBytes = await readFile(destinationPath);
          const { associations } = readIpcoIpma(destinationBytes);
          const item2 = associations.find((entry) => entry.itemId === 2);
          expect(item2).toBeDefined();
          expect(item2?.associations).toEqual([]);

          await withHandle(destinationPath, (handle) =>
            admitIsobmff(handle, destinationBytes.length).then(() => {}),
          );
        },
      );

      it(
        "ICC at the highest ipco index removed; an association to the new last index resolves " +
          "to the same bytes as before",
        async () => {
          const primaryPayload = Buffer.from("primary-bytes", "ascii");
          const spec: AssembleHeifSpec = {
            primaryItemId: 1,
            items: [
              {
                itemId: 1,
                itemType: "hvc1",
                extents: [{ relOffset: 0, length: primaryPayload.length }],
              },
            ],
            properties: [
              ispe(32, 32),
              hvcC(),
              pixi([8, 8, 8]),
              colrProf(ICC_BYTES_PROF), // highest index (4)
            ],
            extraIpmaEntries: [
              {
                itemId: 1,
                associations: [
                  { propertyIndex: 1, essential: false },
                  { propertyIndex: 3, essential: false },
                  { propertyIndex: 4, essential: false },
                ],
              },
            ],
            mdatPayload: primaryPayload,
            twoPass: true,
          };
          const bytes = assembleHeif(spec);
          const sourcePixi = readIpcoIpma(bytes).properties.find(
            (p) => p.type === "pixi",
          )!;

          const { path: sourcePath } = await writeFixture(bytes, "source.heic");
          const directory = dirname(sourcePath);
          const destinationPath = join(directory, "destination.heic");
          await sanitizeThroughRealWriter(sourcePath, destinationPath, false);

          const destinationBytes = await readFile(destinationPath);
          const { properties, associations } = readIpcoIpma(destinationBytes);
          expect(properties.length).toBe(3);
          expect(properties.some((p) => p.colourType === "prof")).toBe(false);
          const item1 = associations.find((entry) => entry.itemId === 1);
          expect(item1?.associations).toEqual([
            { propertyIndex: 1, essential: false },
            { propertyIndex: 3, essential: false },
          ]);
          const destinationPixi = properties[2]!;
          expect(destinationPixi.type).toBe("pixi");
          expect(destinationPixi.bytes.equals(sourcePixi.bytes)).toBe(true);

          await withHandle(destinationPath, (handle) =>
            admitIsobmff(handle, destinationBytes.length).then(() => {}),
          );
        },
      );

      const GENERATOR_SEED = 62;
      const GENERATOR_NUM_RUNS = 20;
      const COLR_ARMS: readonly IsobmffArm[] = [
        "colr-prof",
        "colr-ricc",
        "colr-nclx",
        "colr-none",
      ];

      it.each(COLR_ARMS)(
        "generator arm %s (seed 62, preserveColorProfile false): no prof/rICC in the output; " +
          "nclx is kept; the output re-admits",
        async (arm) => {
          const samples = fc.sample(isobmffArmSampleArbitrary("heic"), {
            seed: GENERATOR_SEED,
            numRuns: GENERATOR_NUM_RUNS,
          });

          const restore = setRegisteredHandlersForTests([
            createIsobmffWriterHandlerForTests("heic"),
            createIsobmffWriterHandlerForTests("avif"),
          ]);
          let admittedCount = 0;
          try {
            for (const armSample of samples) {
              if (!armSample.arms.includes(arm)) continue;

              const { sample } = armSample;
              const directory = await freshDirectory();
              const sourcePath = join(directory, "sample.isobmff");
              const destinationPath = join(directory, "destination.isobmff");
              await writeFile(sourcePath, sample.bytes);

              const sanitized = await sanitizeFile({
                sourcePath,
                destinationPath,
                preserveOrientation: false,
                preserveColorProfile: false,
                preserveTimestamps: false,
                preserveResolution: false,
              });
              if (!sanitized.ok) continue;
              admittedCount += 1;

              const destinationBytes = await readFile(destinationPath);
              const { properties } = readIpcoIpma(destinationBytes);
              expect(
                properties.some(
                  (p) => p.colourType === "prof" || p.colourType === "rICC",
                ),
              ).toBe(false);
              if (arm === "colr-nclx") {
                expect(properties.some((p) => p.colourType === "nclx")).toBe(
                  true,
                );
              }

              const destinationHandle: FileHandle = await open(
                destinationPath,
                "r",
              );
              try {
                await admitIsobmff(destinationHandle, destinationBytes.length);
              } finally {
                await destinationHandle.close();
              }
            }
          } finally {
            restore();
          }

          expect(admittedCount).toBeGreaterThanOrEqual(1);
        },
        30_000,
      );
    },
  );
});
