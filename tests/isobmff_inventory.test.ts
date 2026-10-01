// Sha pins and generation-time facts for the real `heif-enc` fixtures (D-22), plus cross-checks
// of the independent inventory walker against builder configurations and the measured iPhone
// sample (D-20/D-21). Every expected value below is copied from
// `tests/isobmff-support/fixtures/RECIPE.md`'s measured facts (heif-info + exiftool -v2 + the
// scratch inspector used to generate the fixtures) -- never computed by calling
// `inventoryIsobmff` itself; the inventory is the thing being checked, not the source of truth.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);

const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const HEIC_SHA256 =
  "ae40a80f0a85cd984b9d8b1a2e811e138ac2c8c26f14b77360d62e1e4867bad6";

describe("heif-enc-grid.heic fixture identity", () => {
  it("matches the pinned sha256 and stays under the 10240-byte bound", () => {
    const bytes = readFileSync(HEIC_PATH);
    expect(bytes.length).toBeLessThan(10240);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(HEIC_SHA256);
  });
});

describe("inventoryIsobmff() on heif-enc-grid.heic", () => {
  const bytes = readFileSync(HEIC_PATH);
  const inventory = inventoryIsobmff(bytes);

  it("reports the top-level boxes measured in RECIPE.md", () => {
    expect(inventory.topLevel.map((b) => b.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);
    const mdat = inventory.topLevel.find((b) => b.type === "mdat");
    expect(mdat).toBeDefined();
    expect(mdat?.offset).toBe(976);
    expect(mdat?.size).toBe(3267);
  });

  it("reports meta children in the measured order", () => {
    expect(inventory.metaChildren).toEqual([
      "hdlr",
      "pitm",
      "idat",
      "iloc",
      "iinf",
      "iprp",
      "iref",
    ]);
  });

  it("reports primaryItemId 1 (the grid item)", () => {
    expect(inventory.primaryItemId).toBe(1);
  });

  it("reports iloc version 1 with widths (4,4,4,0)", () => {
    expect(inventory.iloc).toEqual({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
    });
  });

  it("reports the idat box at the measured offset/length", () => {
    expect(inventory.idat).toEqual({ offset: 95, length: 8 });
  });

  it("reports item 1 as a visible grid item with constructionMethod 1", () => {
    const item1 = inventory.items.find((i) => i.id === 1);
    expect(item1).toMatchObject({
      id: 1,
      type: "grid",
      hidden: false,
      constructionMethod: 1,
      baseOffset: 0,
    });
    expect(item1?.extents).toEqual([{ index: 0, offset: 0, length: 8 }]);
  });

  it("reports at least two hidden tile items (items 2-5, type hvc1)", () => {
    const hiddenTiles = inventory.items.filter(
      (i) => i.hidden && i.type === "hvc1" && i.id >= 2 && i.id <= 5,
    );
    expect(hiddenTiles.length).toBeGreaterThanOrEqual(2);
    for (const tile of hiddenTiles) {
      expect(tile.constructionMethod).toBe(0);
    }
  });

  it("reports item 6 as a hidden Exif item, constructionMethod 0, 178-byte extent", () => {
    const exifItem = inventory.items.find((i) => i.id === 6);
    expect(exifItem).toMatchObject({
      id: 6,
      type: "Exif",
      hidden: true,
      constructionMethod: 0,
      baseOffset: 0x483,
    });
    expect(exifItem?.extents).toEqual([{ index: 0, offset: 0, length: 178 }]);
  });

  it("reports item 7 as a hidden mime/XMP item with content_type application/rdf+xml (D-07)", () => {
    const mimeItem = inventory.items.find((i) => i.id === 7);
    expect(mimeItem).toMatchObject({
      id: 7,
      type: "mime",
      hidden: true,
      contentType: "application/rdf+xml",
      constructionMethod: 0,
      baseOffset: 0x535,
    });
    expect(mimeItem?.extents).toEqual([{ index: 0, offset: 0, length: 2876 }]);
  });

  it("reports item 8 as a visible hvc1 thumbnail, referenced by a thmb reference", () => {
    const thumbnail = inventory.items.find((i) => i.id === 8);
    expect(thumbnail).toMatchObject({
      id: 8,
      type: "hvc1",
      hidden: false,
      constructionMethod: 0,
      baseOffset: 0x1071,
    });
    const thmbRef = inventory.references.find((r) => r.type === "thmb");
    expect(thmbRef).toEqual({ type: "thmb", from: 8, to: [1] });
  });

  it("reports the dimg reference from the grid to its four tiles", () => {
    const dimgRef = inventory.references.find((r) => r.type === "dimg");
    expect(dimgRef).toEqual({ type: "dimg", from: 1, to: [2, 3, 4, 5] });
  });

  it("reports cdsc references from Exif and XMP to the primary (D-08 direction)", () => {
    const cdscRefs = inventory.references.filter((r) => r.type === "cdsc");
    expect(cdscRefs).toEqual(
      expect.arrayContaining([
        { type: "cdsc", from: 6, to: [1] },
        { type: "cdsc", from: 7, to: [1] },
      ]),
    );
  });

  it("reports the measured ipco property list", () => {
    expect(inventory.properties.map((p) => p.type)).toEqual([
      "ispe",
      "hvcC",
      "colr",
      "ispe",
      "pixi",
      "hvcC",
      "clap",
    ]);
  });
});
