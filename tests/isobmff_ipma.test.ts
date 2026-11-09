// src/isobmff/ipma.ts coverage (BMF-01, D1, D-20): the table-driven `ipma` resolver across its
// four version/flags combinations, the 7-bit/15-bit boundary values, version/malformed declines,
// and `parseIsobmff` wiring checked against the independent inventory walker on a real
// `heif-enc` fixture.
//
// Every expected value below is a hand-written literal; no expected value is computed by calling
// `parseIpma`, the builder, or the inventory walker (D-20). The inventory comparison at the
// bottom is an additional oracle, not an expectation source.
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IsobmffStructureError } from "../src/isobmff/errors.js";
import { parseIloc } from "../src/isobmff/iloc.js";
import { IPMA_LAYOUTS, parseIpma } from "../src/isobmff/ipma.js";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "corpus",
  "constructed",
);
const HEIC_PATH = join(FIXTURES_DIR, "heic", "heif-enc-grid.heic");

describe("IPMA_LAYOUTS", () => {
  it("has exactly the four version/flags keys", () => {
    expect(Object.keys(IPMA_LAYOUTS).sort()).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
    ]);
  });

  it("gates item_ID width by version and association width by flags independently (Pitfall 7)", () => {
    expect(IPMA_LAYOUTS["0:0"]).toEqual({
      itemIdBytes: 2,
      associationBytes: 1,
      indexBits: 7,
    });
    expect(IPMA_LAYOUTS["0:1"]).toEqual({
      itemIdBytes: 2,
      associationBytes: 2,
      indexBits: 15,
    });
    expect(IPMA_LAYOUTS["1:0"]).toEqual({
      itemIdBytes: 4,
      associationBytes: 1,
      indexBits: 7,
    });
    expect(IPMA_LAYOUTS["1:1"]).toEqual({
      itemIdBytes: 4,
      associationBytes: 2,
      indexBits: 15,
    });
  });
});

describe("parseIpma: v0 flags=0 (16-bit item_ID, 1-byte association)", () => {
  it("parses indices 1 and 0x7f (boundary), essential set and clear", () => {
    const payload = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x02, // entry_count = 2
      0x00,
      0x01, // item_ID = 1
      0x02, // association_count = 2
      0x01, // index 1, essential clear
      0xff, // index 0x7f, essential set (0x80 | 0x7f)
      0x00,
      0x02, // item_ID = 2
      0x01, // association_count = 1
      0x00, // index 0, essential clear
    ]);

    expect(parseIpma(payload, 0, 0)).toEqual([
      {
        itemId: 1,
        associations: [
          { essential: false, propertyIndex: 1 },
          { essential: true, propertyIndex: 0x7f },
        ],
      },
      {
        itemId: 2,
        associations: [{ essential: false, propertyIndex: 0 }],
      },
    ]);
  });
});

describe("parseIpma: v0 flags=1 (16-bit item_ID, 2-byte association)", () => {
  it("parses indices 0x0080 and 0x7fff (boundary)", () => {
    const payload = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x02, // entry_count = 2
      0x00,
      0x05, // item_ID = 5
      0x01, // association_count = 1
      0x00,
      0x80, // index 0x0080, essential clear
      0x00,
      0x06, // item_ID = 6
      0x01, // association_count = 1
      0xff,
      0xff, // index 0x7fff, essential set
    ]);

    expect(parseIpma(payload, 0, 1)).toEqual([
      {
        itemId: 5,
        associations: [{ essential: false, propertyIndex: 0x0080 }],
      },
      {
        itemId: 6,
        associations: [{ essential: true, propertyIndex: 0x7fff }],
      },
    ]);
  });
});

describe("parseIpma: v1 flags=0 (32-bit item_ID, 1-byte association)", () => {
  it("parses a 32-bit item_ID with the 7-bit association form", () => {
    const payload = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x01, // entry_count = 1
      0x00,
      0x01,
      0x86,
      0xa0, // item_ID = 100000
      0x02, // association_count = 2
      0x00, // index 0, essential clear
      0xff, // index 0x7f, essential set
    ]);

    expect(parseIpma(payload, 1, 0)).toEqual([
      {
        itemId: 100000,
        associations: [
          { essential: false, propertyIndex: 0 },
          { essential: true, propertyIndex: 0x7f },
        ],
      },
    ]);
  });
});

describe("parseIpma: v1 flags=1 (32-bit item_ID, 2-byte association)", () => {
  it("parses a 32-bit item_ID with the 15-bit association form", () => {
    const payload = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x01, // entry_count = 1
      0x00,
      0x00,
      0x00,
      0x03, // item_ID = 3
      0x02, // association_count = 2
      0x00,
      0x01, // index 1, essential clear
      0xff,
      0xff, // index 0x7fff, essential set
    ]);

    expect(parseIpma(payload, 1, 1)).toEqual([
      {
        itemId: 3,
        associations: [
          { essential: false, propertyIndex: 1 },
          { essential: true, propertyIndex: 0x7fff },
        ],
      },
    ]);
  });
});

describe("parseIpma: malformed inputs and version gate", () => {
  it("ipma version 2 declines unsupported-box-version", () => {
    expect(() => parseIpma(Buffer.alloc(4), 2, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "unsupported-box-version",
        kind: "unsupported-format",
      }),
    );
  });

  it("an association_count running past the payload declines box-framing", () => {
    const payload = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x01, // entry_count = 1
      0x00,
      0x01, // item_ID = 1
      0x05, // association_count = 5, but no association bytes follow
    ]);
    expect(() => parseIpma(payload, 0, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });

  it("a truncated entry_count field declines box-framing", () => {
    const payload = Buffer.from([0x00, 0x00]);
    expect(() => parseIpma(payload, 0, 0)).toThrowError(
      expect.objectContaining({
        declineClass: "box-framing",
        kind: "malformed-file",
      }),
    );
  });
});

describe("parseIsobmff model.ipma on heif-enc-grid.heic", () => {
  it("matches the independent inventory walker's associations", async () => {
    const bytes = readFileSync(HEIC_PATH);
    const inventory = inventoryIsobmff(bytes);
    expect(inventory.associations.length).toBeGreaterThan(0);

    const handle = await open(HEIC_PATH, "r");
    try {
      const model = await parseIsobmff(handle, bytes.length);
      expect(model.ipma).toBeDefined();
      const byItemId = new Map(
        (model.ipma ?? []).map((entry) => [entry.itemId, entry]),
      );
      for (const inventoryAssociation of inventory.associations) {
        const parsedEntry = byItemId.get(inventoryAssociation.itemId);
        expect(parsedEntry).toBeDefined();
        expect(parsedEntry?.associations).toEqual(
          inventoryAssociation.associations.map((association) => ({
            essential: association.essential,
            propertyIndex: association.propertyIndex,
          })),
        );
      }
    } finally {
      await handle.close();
    }
  });
});

// --- Plan 67-46 Task 0b: truncation at the item_ID and association_count of an entry ----------
//
// With `entry_count` = 1 and the payload ending exactly where (or one byte before) the named
// field starts, the typed `box-framing` refusal is the only thing standing between the input and
// the raw RangeError of the Buffer read that follows each bounds check. Only the refusal's class
// and kind are asserted, never its wording.
describe("parseIpma: an entry truncated at item_ID or association_count declines box-framing", () => {
  const expectFramingRefusal = (
    payload: Buffer,
    version: number,
    flags: number,
  ): void => {
    let actual: unknown;
    try {
      parseIpma(payload, version, flags);
    } catch (error) {
      actual = error;
    }
    expect(actual).toBeInstanceOf(IsobmffStructureError);
    expect(actual).toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  };
  const entryCountOne = [0x00, 0x00, 0x00, 0x01];

  it("parses the complete one-entry payloads for both item_ID widths", () => {
    expect(
      parseIpma(Buffer.from([...entryCountOne, 0x00, 0x07, 0x01, 0x81]), 0, 0),
    ).toEqual([
      { itemId: 7, associations: [{ essential: true, propertyIndex: 1 }] },
    ]);
    expect(
      parseIpma(
        Buffer.from([...entryCountOne, 0x00, 0x00, 0x00, 0x07, 0x01, 0x81]),
        1,
        0,
      ),
    ).toEqual([
      { itemId: 7, associations: [{ essential: true, propertyIndex: 1 }] },
    ]);
  });

  it("declines when item_ID is absent or one byte short (16-bit and 32-bit)", () => {
    expectFramingRefusal(Buffer.from(entryCountOne), 0, 0);
    expectFramingRefusal(Buffer.from([...entryCountOne, 0x00]), 0, 0);
    expectFramingRefusal(Buffer.from(entryCountOne), 1, 0);
    expectFramingRefusal(
      Buffer.from([...entryCountOne, 0x00, 0x00, 0x00]),
      1,
      0,
    );
  });

  it("declines when association_count is absent after a complete item_ID (16-bit and 32-bit)", () => {
    expectFramingRefusal(Buffer.from([...entryCountOne, 0x00, 0x07]), 0, 0);
    expectFramingRefusal(
      Buffer.from([...entryCountOne, 0x00, 0x00, 0x00, 0x07]),
      1,
      1,
    );
  });
});

// --- Plan 67-46 Task 0b: a later iloc item truncated at exactly one field ---------------------
//
// Every `ensureBytes` call of `parseIloc`'s per-item loop is redundant for the first item (the
// `item_count * minimum item bytes` floor check already guarantees those bytes), so each call is
// observable only when a LATER item runs out of bytes at that field. The first item below carries
// three extents so the floor check passes for any truncation of the second item. Removing any one
// call turns the typed `box-framing` refusal into the raw RangeError of the Buffer read that
// follows it. Only the refusal's class and kind are asserted, never its wording.
//
// These tests live in this file and not in `tests/isobmff_iloc.test.ts` (the sealed isobmff-3
// report fixtures pin that file's exact bytes) or `tests/isobmff_items.test.ts` (its import block
// is part of the readCString named-killer closure).
describe("parseIloc: a later item truncated at one field declines box-framing", () => {
  interface IlocCut {
    readonly field: string;
    /** Byte offset of the field inside the second item (hand-written for the configuration). */
    readonly at: number;
    readonly width: number;
  }
  interface IlocShape {
    readonly version: 0 | 1 | 2;
    readonly width: 4 | 8;
    readonly index: boolean;
  }

  /** The iloc payload after the FullBox version/flags: a hand-rolled writer for this file only.
   * Every offset, length and index field is `width` bytes; absent fields are not written. */
  const writeIloc = (
    shape: IlocShape,
    items: readonly { id: number; extents: number }[],
  ): Buffer => {
    const idBytes = shape.version === 2 ? 4 : 2;
    const number = (value: number, bytes: number): Buffer => {
      const buffer = Buffer.alloc(bytes);
      buffer.writeUIntBE(value, bytes - Math.min(bytes, 6), Math.min(bytes, 6));
      return buffer;
    };
    const parts: Buffer[] = [
      // offset_size/length_size nibbles, then base_offset_size/index_size nibbles
      Buffer.from([
        (shape.width << 4) | shape.width,
        (shape.width << 4) | (shape.index ? shape.width : 0),
      ]),
      number(items.length, idBytes),
    ];
    for (const item of items) {
      parts.push(number(item.id, idBytes));
      if (shape.version !== 0) parts.push(number(0, 2)); // construction_method
      parts.push(number(0, 2)); // data_reference_index
      parts.push(number(0, shape.width)); // base_offset
      parts.push(number(item.extents, 2)); // extent_count
      for (let extent = 0; extent < item.extents; extent += 1) {
        if (shape.index) parts.push(number(0, shape.width)); // extent_index
        parts.push(number(20 + extent, shape.width)); // extent_offset
        parts.push(number(5, shape.width)); // extent_length
      }
    }
    return Buffer.concat(parts);
  };
  const expectFramingRefusal = (payload: Buffer, version: number): void => {
    let actual: unknown;
    try {
      parseIloc(payload, version, 0);
    } catch (error) {
      actual = error;
    }
    expect(actual).toBeInstanceOf(IsobmffStructureError);
    expect(actual).toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  };

  const configurations: readonly {
    readonly label: string;
    readonly shape: IlocShape;
    /** Length of everything before the second item (header, count, the first item). */
    readonly secondItemStart: number;
    readonly cuts: readonly IlocCut[];
  }[] = [
    {
      label: "v0, 4-byte offset/length/base, no index",
      shape: { version: 0, width: 4, index: false },
      // 2 nibbles + 2 count + first item (2 id + 2 dri + 4 base + 2 count + 3 x 8 extents)
      secondItemStart: 2 + 2 + (2 + 2 + 4 + 2 + 24),
      cuts: [
        { field: "item_ID", at: 0, width: 2 },
        { field: "data_reference_index", at: 2, width: 2 },
        { field: "base_offset", at: 4, width: 4 },
        { field: "extent_count", at: 8, width: 2 },
        { field: "extent_offset", at: 10, width: 4 },
        { field: "extent_length", at: 14, width: 4 },
      ],
    },
    {
      label: "v1, 4-byte offset/length/base/index",
      shape: { version: 1, width: 4, index: true },
      // 2 nibbles + 2 count + first item (2 id + 2 cm + 2 dri + 4 base + 2 count + 3 x 12)
      secondItemStart: 2 + 2 + (2 + 2 + 2 + 4 + 2 + 36),
      cuts: [
        { field: "item_ID", at: 0, width: 2 },
        { field: "construction_method", at: 2, width: 2 },
        { field: "data_reference_index", at: 4, width: 2 },
        { field: "base_offset", at: 6, width: 4 },
        { field: "extent_count", at: 10, width: 2 },
        { field: "extent_index", at: 12, width: 4 },
        { field: "extent_offset", at: 16, width: 4 },
        { field: "extent_length", at: 20, width: 4 },
      ],
    },
    {
      label: "v2, 8-byte offset/length/base/index",
      shape: { version: 2, width: 8, index: true },
      // 2 nibbles + 4 count + first item (4 id + 2 cm + 2 dri + 8 base + 2 count + 3 x 24)
      secondItemStart: 2 + 4 + (4 + 2 + 2 + 8 + 2 + 72),
      cuts: [
        { field: "item_ID", at: 0, width: 4 },
        { field: "construction_method", at: 4, width: 2 },
        { field: "data_reference_index", at: 6, width: 2 },
        { field: "base_offset", at: 8, width: 8 },
        { field: "extent_count", at: 16, width: 2 },
        { field: "extent_index", at: 18, width: 8 },
        { field: "extent_offset", at: 26, width: 8 },
        { field: "extent_length", at: 34, width: 8 },
      ],
    },
  ];

  for (const { label, shape, secondItemStart, cuts } of configurations) {
    describe(label, () => {
      const full = writeIloc(shape, [
        { id: 1, extents: 3 },
        { id: 2, extents: 1 },
      ]);

      it("parses the untruncated two-item payload", () => {
        const table = parseIloc(full, shape.version, 0);
        expect(table.items.map((item) => item.itemId)).toEqual([1, 2]);
        expect(table.items[1]?.extents).toEqual([
          { index: 0, offset: 20, length: 5 },
        ]);
      });

      for (const { field, at, width } of cuts) {
        it(`${field} absent at its first byte`, () => {
          expectFramingRefusal(
            full.subarray(0, secondItemStart + at),
            shape.version,
          );
        });
        it(`${field} one byte short`, () => {
          expectFramingRefusal(
            full.subarray(0, secondItemStart + at + width - 1),
            shape.version,
          );
        });
      }
    });
  }
});
