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
  hvcC,
  ispe,
  pixi,
} from "./isobmff-support/builder.js";
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
      throw new Error(`sanitizeFile failed: ${JSON.stringify(sanitized.error)}`);
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
        "environment failure (code write-failed, \"Native no-replace publication could not " +
        "complete\" -- the compiled native binding does not resolve correctly from a /tmp " +
        "worktree copy, nothing to do with D-16), so the probe called buildIsobmffOutputPlan " +
        "directly on this fixture's admission and scanned the assembled bytes for every \"colr\" " +
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
        const destinationNclx = properties.find(
          (p) => p.colourType === "nclx",
        );
        expect(destinationNclx?.bytes.equals(sourceNclx!.bytes)).toBe(true);

        // Re-admits.
        const { size: destinationSize } = await stat(destinationPath);
        await withHandle(destinationPath, (handle) =>
          admitIsobmff(handle, destinationSize),
        );
      },
    );
  });
});
