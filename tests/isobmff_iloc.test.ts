// src/isobmff/iloc.ts coverage (BMF-01, D1, D-20): the table-driven `iloc` resolver, its full
// v0/v1/v2 x {0,4,8} width matrix, six fully literal hex payloads, precision/malformed/version
// edge cases, and `parseIsobmff` wiring checked against the independent inventory walker on a
// real `heif-enc` fixture.
//
// `encodeIlocForTest` below is a test-local byte writer that shares no code with
// `tests/isobmff-support/builder.ts`'s `ilocBox` (D-20's "builder <-> parser share one author's
// reading of the spec" risk). Every expected value in this file is a hand-written literal or a
// formula written directly in this file -- never read back from `parseIloc`, the builder, or the
// inventory walker (the inventory comparison at the bottom is an additional oracle, not an
// expectation source).
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ILOC_FIELD_WIDTHS,
  ILOC_LAYOUTS,
  parseIloc,
  readSizedUint,
} from "../src/isobmff/iloc.js";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");

type Width = 0 | 4 | 8;
const WIDTHS: readonly Width[] = [0, 4, 8];

// --- Test-local iloc payload writer (D-20: no code shared with tests/isobmff-support/builder.ts) ---

interface EncodeIlocExtent {
  readonly index?: number;
  readonly offset: number;
  readonly length: number;
}

interface EncodeIlocItem {
  readonly itemId: number;
  readonly constructionMethod?: number;
  readonly dataReferenceIndex?: number;
  readonly baseOffset?: number;
  readonly extents: readonly EncodeIlocExtent[];
}

interface EncodeIlocConfig {
  readonly version: 0 | 1 | 2;
  readonly offsetSize: Width;
  readonly lengthSize: Width;
  readonly baseOffsetSize: Width;
  readonly indexSize: Width;
  readonly items: readonly EncodeIlocItem[];
}

function writeWidthValue(value: number, width: Width): Buffer {
  if (width === 0) return Buffer.alloc(0);
  if (width === 4) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

/** The iloc payload *after* the FullBox version/flags (matches `parseIloc`'s own contract). */
function encodeIlocForTest(config: EncodeIlocConfig): Buffer {
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from([
      ((config.offsetSize & 0xf) << 4) | (config.lengthSize & 0xf),
      ((config.baseOffsetSize & 0xf) << 4) | (config.indexSize & 0xf),
    ]),
  );

  const itemCountBuffer = Buffer.alloc(config.version === 2 ? 4 : 2);
  if (config.version === 2)
    itemCountBuffer.writeUInt32BE(config.items.length, 0);
  else itemCountBuffer.writeUInt16BE(config.items.length, 0);
  parts.push(itemCountBuffer);

  for (const item of config.items) {
    const idBuffer = Buffer.alloc(config.version === 2 ? 4 : 2);
    if (config.version === 2) idBuffer.writeUInt32BE(item.itemId, 0);
    else idBuffer.writeUInt16BE(item.itemId, 0);
    parts.push(idBuffer);

    if (config.version !== 0) {
      const cmBuffer = Buffer.alloc(2);
      cmBuffer.writeUInt16BE((item.constructionMethod ?? 0) & 0xf, 0);
      parts.push(cmBuffer);
    }

    const driBuffer = Buffer.alloc(2);
    driBuffer.writeUInt16BE(item.dataReferenceIndex ?? 0, 0);
    parts.push(driBuffer);

    parts.push(writeWidthValue(item.baseOffset ?? 0, config.baseOffsetSize));

    const extentCountBuffer = Buffer.alloc(2);
    extentCountBuffer.writeUInt16BE(item.extents.length, 0);
    parts.push(extentCountBuffer);

    for (const extent of item.extents) {
      if (config.version !== 0 && config.indexSize > 0) {
        parts.push(writeWidthValue(extent.index ?? 0, config.indexSize));
      }
      parts.push(writeWidthValue(extent.offset, config.offsetSize));
      parts.push(writeWidthValue(extent.length, config.lengthSize));
    }
  }

  return Buffer.concat(parts);
}

/** Per-version byte-length formula, written independently of `encodeIlocForTest`'s own loop. */
function expectedIlocLength(config: EncodeIlocConfig): number {
  const itemCountBytes = config.version === 2 ? 4 : 2;
  const itemIdBytes = config.version === 2 ? 4 : 2;
  let total = 2 /* width nibbles */ + itemCountBytes;
  for (const item of config.items) {
    total += itemIdBytes;
    if (config.version !== 0) total += 2; // construction_method
    total += 2; // data_reference_index
    total += config.baseOffsetSize;
    total += 2; // extent_count
    for (let i = 0; i < item.extents.length; i++) {
      if (config.version !== 0 && config.indexSize > 0)
        total += config.indexSize;
      total += config.offsetSize;
      total += config.lengthSize;
    }
  }
  return total;
}

// --- Task 1: literal v1 payload, hand-written values ---

describe("parseIloc: literal v1 payload with two items", () => {
  it("parses item 1 (cm 0) and item 2 (cm 1), each with one extent", () => {
    const config: EncodeIlocConfig = {
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
          extents: [{ offset: 1000, length: 50 }],
        },
        {
          itemId: 2,
          constructionMethod: 1,
          dataReferenceIndex: 0,
          extents: [{ offset: 2000, length: 60 }],
        },
      ],
    };
    const payload = encodeIlocForTest(config);
    expect(payload.length).toBe(expectedIlocLength(config));

    const table = parseIloc(payload, 1, 0);
    expect(table).toEqual({
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
          extents: [{ index: 0, offset: 1000, length: 50 }],
        },
        {
          itemId: 2,
          constructionMethod: 1,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ index: 0, offset: 2000, length: 60 }],
        },
      ],
    });
  });
});

// --- Task 2: the full v0/v1/v2 x {0,4,8} width matrix ---

// Sentinel values (D-20): OFFSET gets a width-4 and a width-8 variant (the 8-byte variant stays
// below Number.MAX_SAFE_INTEGER -- the unsafe-precision edge is proven separately below, never
// conflated with "this combination must parse"). length/base/index reuse one value across widths
// since they fit comfortably in either.
const OFFSET_SMALL = 0x11223344;
const OFFSET_BIG = 0x0011223344556677;
const LENGTH_VAL = 0x0a0b0c0d;
const BASE_VAL = 0x01020304;
const INDEX_VAL = 0x05060708;

function sentinelFor(
  width: Width,
  small: number,
  big: number,
  bump: number,
): number {
  if (width === 0) return 0;
  return (width === 4 ? small : big) + bump;
}

function runIlocMatrixCase(
  version: 0 | 1 | 2,
  offsetSize: Width,
  lengthSize: Width,
  baseOffsetSize: Width,
  indexSize: Width,
): void {
  const constructionMethod = version === 0 ? 0 : 7;
  const baseOffset = sentinelFor(baseOffsetSize, BASE_VAL, BASE_VAL, 0);
  const extent0 = {
    index: sentinelFor(indexSize, INDEX_VAL, INDEX_VAL, 0),
    offset: sentinelFor(offsetSize, OFFSET_SMALL, OFFSET_BIG, 0),
    length: sentinelFor(lengthSize, LENGTH_VAL, LENGTH_VAL, 0),
  };
  const extent1 = {
    index: sentinelFor(indexSize, INDEX_VAL, INDEX_VAL, 1),
    offset: sentinelFor(offsetSize, OFFSET_SMALL, OFFSET_BIG, 1),
    length: sentinelFor(lengthSize, LENGTH_VAL, LENGTH_VAL, 1),
  };

  const config: EncodeIlocConfig = {
    version,
    offsetSize,
    lengthSize,
    baseOffsetSize,
    indexSize,
    items: [
      {
        itemId: 9,
        constructionMethod,
        dataReferenceIndex: 42,
        baseOffset,
        extents: [
          {
            index: extent0.index,
            offset: extent0.offset,
            length: extent0.length,
          },
          {
            index: extent1.index,
            offset: extent1.offset,
            length: extent1.length,
          },
        ],
      },
    ],
  };

  const payload = encodeIlocForTest(config);
  expect(payload.length).toBe(expectedIlocLength(config));

  const table = parseIloc(payload, version, 0);
  expect(table.version).toBe(version);
  expect(table.offsetSize).toBe(offsetSize);
  expect(table.lengthSize).toBe(lengthSize);
  expect(table.baseOffsetSize).toBe(baseOffsetSize);
  // v0's index_size nibble is reserved/unused -- it is still read into the returned table, but
  // never consulted for extent decoding, so it is not asserted for v0 here.
  if (version !== 0) expect(table.indexSize).toBe(indexSize);

  expect(table.items).toHaveLength(1);
  const item = table.items[0];
  expect(item).toBeDefined();
  expect(item?.itemId).toBe(9);
  expect(item?.constructionMethod).toBe(constructionMethod);
  expect(item?.dataReferenceIndex).toBe(42);
  expect(item?.baseOffset).toBe(baseOffset);
  expect(item?.extents).toEqual([
    {
      index: version === 0 ? 0 : extent0.index,
      offset: extent0.offset,
      length: extent0.length,
    },
    {
      index: version === 0 ? 0 : extent1.index,
      offset: extent1.offset,
      length: extent1.length,
    },
  ]);
}

describe("iloc width matrix (D-20): v0 x offset/length/base", () => {
  for (const offsetSize of WIDTHS) {
    for (const lengthSize of WIDTHS) {
      for (const baseOffsetSize of WIDTHS) {
        it(`iloc v0 offset=${offsetSize} length=${lengthSize} base=${baseOffsetSize}`, () => {
          runIlocMatrixCase(0, offsetSize, lengthSize, baseOffsetSize, 0);
        });
      }
    }
  }
});

for (const version of [1, 2] as const) {
  describe(`iloc width matrix (D-20): v${version} x offset/length/base/index`, () => {
    for (const offsetSize of WIDTHS) {
      for (const lengthSize of WIDTHS) {
        for (const baseOffsetSize of WIDTHS) {
          for (const indexSize of WIDTHS) {
            it(`iloc v${version} offset=${offsetSize} length=${lengthSize} base=${baseOffsetSize} index=${indexSize}`, () => {
              runIlocMatrixCase(
                version,
                offsetSize,
                lengthSize,
                baseOffsetSize,
                indexSize,
              );
            });
          }
        }
      }
    }
  });
}

// --- Six fully literal hex payloads (two per version, one with every width 8) ---

describe("iloc literal hex payloads (D-20)", () => {
  it("v0-A: offset=4 length=4 base=4, one item one extent", () => {
    const payload = Buffer.from([
      0x44,
      0x40, // width nibbles: offset=4 length=4 | base=4 index=0(ignored)
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01, // item_ID = 1
      0x00,
      0x00, // data_reference_index = 0
      0x01,
      0x02,
      0x03,
      0x04, // base_offset = 0x01020304
      0x00,
      0x01, // extent_count = 1
      0x11,
      0x22,
      0x33,
      0x44, // extent_offset = 0x11223344
      0x0a,
      0x0b,
      0x0c,
      0x0d, // extent_length = 0x0a0b0c0d
    ]);
    expect(payload.length).toBe(22);

    expect(parseIloc(payload, 0, 0)).toEqual({
      version: 0,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: 0x01020304,
          extents: [{ index: 0, offset: 0x11223344, length: 0x0a0b0c0d }],
        },
      ],
    });
  });

  it("v0-B: offset=8 length=0 base=0, zero-width fields report 0", () => {
    const payload = Buffer.from([
      0x80,
      0x00, // offset=8 length=0 | base=0 index=0
      0x00,
      0x01, // item_count = 1
      0x00,
      0x07, // item_ID = 7
      0x00,
      0x02, // data_reference_index = 2
      0x00,
      0x01, // extent_count = 1
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x11,
      0x22,
      0x33, // extent_offset = 0x112233
    ]);
    expect(payload.length).toBe(18);

    expect(parseIloc(payload, 0, 0)).toEqual({
      version: 0,
      offsetSize: 8,
      lengthSize: 0,
      baseOffsetSize: 0,
      indexSize: 0,
      items: [
        {
          itemId: 7,
          constructionMethod: 0,
          dataReferenceIndex: 2,
          baseOffset: 0,
          extents: [{ index: 0, offset: 0x112233, length: 0 }],
        },
      ],
    });
  });

  it("v1-A: offset=4 length=4 base=0 index=0 (the measured iPhone widths)", () => {
    const payload = Buffer.from([
      0x44,
      0x00, // offset=4 length=4 | base=0 index=0
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01, // item_ID = 1
      0x00,
      0x01, // construction_method = 1
      0x00,
      0x00, // data_reference_index = 0
      0x00,
      0x01, // extent_count = 1
      0x11,
      0x22,
      0x33,
      0x44, // extent_offset = 0x11223344
      0x0a,
      0x0b,
      0x0c,
      0x0d, // extent_length = 0x0a0b0c0d
    ]);
    expect(payload.length).toBe(20);

    expect(parseIloc(payload, 1, 0)).toEqual({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 1,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ index: 0, offset: 0x11223344, length: 0x0a0b0c0d }],
        },
      ],
    });
  });

  it("v1-B: mixed widths (offset=8 length=4 base=4 index=4) per field, distinct values", () => {
    const payload = Buffer.from([
      0x84,
      0x44, // offset=8 length=4 | base=4 index=4
      0x00,
      0x01, // item_count = 1
      0x00,
      0x02, // item_ID = 2
      0x00,
      0x02, // construction_method = 2
      0x00,
      0x05, // data_reference_index = 5
      0x01,
      0x02,
      0x03,
      0x04, // base_offset = 0x01020304
      0x00,
      0x01, // extent_count = 1
      0x05,
      0x06,
      0x07,
      0x08, // extent_index = 0x05060708
      0x00,
      0x11,
      0x22,
      0x33,
      0x44,
      0x55,
      0x66,
      0x77, // extent_offset = 0x0011223344556677
      0x0a,
      0x0b,
      0x0c,
      0x0d, // extent_length = 0x0a0b0c0d
    ]);
    expect(payload.length).toBe(32);

    expect(parseIloc(payload, 1, 0)).toEqual({
      version: 1,
      offsetSize: 8,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 4,
      items: [
        {
          itemId: 2,
          constructionMethod: 2,
          dataReferenceIndex: 5,
          baseOffset: 0x01020304,
          extents: [
            {
              index: 0x05060708,
              offset: 0x0011223344556677,
              length: 0x0a0b0c0d,
            },
          ],
        },
      ],
    });
  });

  it("v2-A: offset=4 length=4 base=0 index=0, 32-bit item_count/item_ID", () => {
    const payload = Buffer.from([
      0x44,
      0x00, // offset=4 length=4 | base=0 index=0
      0x00,
      0x00,
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01,
      0x86,
      0xa0, // item_ID = 100000
      0x00,
      0x00, // construction_method = 0
      0x00,
      0x00, // data_reference_index = 0
      0x00,
      0x01, // extent_count = 1
      0x11,
      0x22,
      0x33,
      0x44, // extent_offset = 0x11223344
      0x0a,
      0x0b,
      0x0c,
      0x0d, // extent_length = 0x0a0b0c0d
    ]);
    expect(payload.length).toBe(24);

    expect(parseIloc(payload, 2, 0)).toEqual({
      version: 2,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      items: [
        {
          itemId: 100000,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ index: 0, offset: 0x11223344, length: 0x0a0b0c0d }],
        },
      ],
    });
  });

  it("v2-B: every width is 8", () => {
    const payload = Buffer.from([
      0x88,
      0x88, // offset=8 length=8 | base=8 index=8
      0x00,
      0x00,
      0x00,
      0x01, // item_count = 1
      0x00,
      0x00,
      0x00,
      0x03, // item_ID = 3
      0x00,
      0x03, // construction_method = 3
      0x00,
      0x09, // data_reference_index = 9
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07, // base_offset = 0x0001020304050607
      0x00,
      0x01, // extent_count = 1
      0x00,
      0x00,
      0x00,
      0x00,
      0x05,
      0x06,
      0x07,
      0x08, // extent_index = 0x05060708
      0x00,
      0x11,
      0x22,
      0x33,
      0x44,
      0x55,
      0x66,
      0x77, // extent_offset = 0x0011223344556677
      0x00,
      0x00,
      0x00,
      0x00,
      0x0a,
      0x0b,
      0x0c,
      0x0d, // extent_length = 0x0a0b0c0d
    ]);
    expect(payload.length).toBe(48);

    expect(parseIloc(payload, 2, 0)).toEqual({
      version: 2,
      offsetSize: 8,
      lengthSize: 8,
      baseOffsetSize: 8,
      indexSize: 8,
      items: [
        {
          itemId: 3,
          constructionMethod: 3,
          dataReferenceIndex: 9,
          baseOffset: 0x0001020304050607,
          extents: [
            {
              index: 0x05060708,
              offset: 0x0011223344556677,
              length: 0x0a0b0c0d,
            },
          ],
        },
      ],
    });
  });
});

// --- Precision edge cases (BMF-05): 8-byte values above Number.MAX_SAFE_INTEGER decline ---

describe("iloc precision edge (BMF-05)", () => {
  it("an 8-byte offset of exactly 2^53 declines extent-outside-mdat", () => {
    const payload = Buffer.from([
      0x84,
      0x00, // offset=8 length=4 | base=0 index=0
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01, // item_ID = 1
      0x00,
      0x00, // construction_method = 0
      0x00,
      0x00, // data_reference_index = 0
      0x00,
      0x01, // extent_count = 1
      0x00,
      0x20,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // extent_offset = 2^53
      0x00,
      0x00,
      0x00,
      0x01, // extent_length = 1
    ]);
    expect(() => parseIloc(payload, 1, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "extent-outside-mdat",
        kind: "malformed-file",
      }),
    );
  });

  it("an 8-byte offset of exactly 2^53 - 1 (Number.MAX_SAFE_INTEGER) parses exactly", () => {
    const payload = Buffer.from([
      0x84,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x1f,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff, // extent_offset = 2^53 - 1
      0x00,
      0x00,
      0x00,
      0x01,
    ]);
    const table = parseIloc(payload, 1, 0);
    expect(table.items[0]?.extents[0]?.offset).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("an 8-byte length above Number.MAX_SAFE_INTEGER declines the same way", () => {
    const payload = Buffer.from([
      0x48,
      0x00, // offset=4 length=8 | base=0 index=0
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01, // item_ID = 1
      0x00,
      0x00, // construction_method = 0
      0x00,
      0x00, // data_reference_index = 0
      0x00,
      0x01, // extent_count = 1
      0x00,
      0x00,
      0x00,
      0x01, // extent_offset = 1
      0x00,
      0x20,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // extent_length = 2^53
    ]);
    expect(() => parseIloc(payload, 1, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "extent-outside-mdat",
        kind: "malformed-file",
      }),
    );
  });
});

// --- Malformed widths, unsupported version, truncation, and the item_count floor check ---

describe("iloc malformed inputs and version gate", () => {
  it("a width nibble of 2 (outside {0,4,8}) declines box-framing", () => {
    expect(ILOC_FIELD_WIDTHS.has(2)).toBe(false);
    const payload = Buffer.from([0x24, 0x00, 0x00, 0x00]); // offset_size nibble = 2
    expect(() => parseIloc(payload, 0, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });

  it("iloc version 3 declines unsupported-box-version", () => {
    expect(ILOC_LAYOUTS[0]).toBeDefined();
    expect(() => parseIloc(Buffer.alloc(4), 3, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "unsupported-box-version",
        kind: "unsupported-format",
      }),
    );
  });

  it("a truncated item table declines box-framing", () => {
    const payload = Buffer.from([
      0x44,
      0x00, // offset=4 length=4 | base=0 index=0
      0x00,
      0x01, // item_count = 1
      0x00,
      0x01, // item_ID = 1 -- then nothing: missing data_reference_index onward
    ]);
    expect(() => parseIloc(payload, 0, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });

  it("item_count 0xffffffff with a 20-byte payload declines box-framing before allocating", () => {
    const payload = Buffer.concat([
      Buffer.from([0x44, 0x00, 0xff, 0xff, 0xff, 0xff]),
      Buffer.alloc(14),
    ]);
    expect(payload.length).toBe(20);
    expect(() => parseIloc(payload, 2, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });
});

// --- readSizedUint unit coverage ---

describe("readSizedUint", () => {
  it("width 0 returns 0 without reading any bytes", () => {
    expect(readSizedUint(Buffer.alloc(0), 0, 0)).toBe(0);
  });

  it("width 4 reads a big-endian uint32", () => {
    const buffer = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    expect(readSizedUint(buffer, 0, 4)).toBe(0x11223344);
  });

  it("width 8 reads a big-endian uint64 within safe-integer range", () => {
    const buffer = Buffer.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    ]);
    expect(readSizedUint(buffer, 0, 8)).toBe(0x0011223344556677);
  });

  it("an unsupported width (not 0, 4, or 8) declines box-framing", () => {
    expect(() => readSizedUint(Buffer.alloc(3), 0, 3)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });
});

// --- parseIsobmff wiring: model.iloc matches the independent inventory walker (D-21 oracle) ---

describe("parseIsobmff model.iloc on heif-enc-grid.heic", () => {
  it("matches the independent inventory walker's items and extents", async () => {
    const bytes = readFileSync(HEIC_PATH);
    const inventory = inventoryIsobmff(bytes);
    expect(inventory.items.length).toBeGreaterThan(0);

    const handle = await open(HEIC_PATH, "r");
    try {
      const model = await parseIsobmff(handle, bytes.length);
      expect(model.iloc).toBeDefined();
      const byItemId = new Map(
        (model.iloc?.items ?? []).map((item) => [item.itemId, item]),
      );
      for (const inventoryItem of inventory.items) {
        const parsedItem = byItemId.get(inventoryItem.id);
        expect(parsedItem).toBeDefined();
        expect(parsedItem?.constructionMethod).toBe(
          inventoryItem.constructionMethod,
        );
        expect(parsedItem?.dataReferenceIndex).toBe(
          inventoryItem.dataReferenceIndex,
        );
        expect(parsedItem?.baseOffset).toBe(inventoryItem.baseOffset);
        expect(parsedItem?.extents).toEqual(inventoryItem.extents);
      }
    } finally {
      await handle.close();
    }
  });
});
