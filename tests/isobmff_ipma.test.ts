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
import { IPMA_LAYOUTS, parseIpma } from "../src/isobmff/ipma.js";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");

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
