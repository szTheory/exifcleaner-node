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
import {
  ftypBox,
  hdlrBox,
  idatBox,
  iinfBox,
  ilocBox,
  infeBox,
  irefBox,
  mdatBox,
  metaBox,
  pitmBox,
} from "./isobmff-support/builder.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
} from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);

const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const HEIC_SHA256 =
  "ae40a80f0a85cd984b9d8b1a2e811e138ac2c8c26f14b77360d62e1e4867bad6";

const AVIF_PATH = join(FIXTURES_DIR, "heif-enc-grid.avif");
const AVIF_SHA256 =
  "682a1e626c4d8db4f7ccf4a2d5058d0104394f7a08d0a70fad3950bed4b0a85e";

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

describe("heif-enc-grid.avif fixture identity", () => {
  it("matches the pinned sha256 and stays under the 10240-byte bound", () => {
    const bytes = readFileSync(AVIF_PATH);
    expect(bytes.length).toBeLessThan(10240);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(AVIF_SHA256);
  });
});

describe("inventoryIsobmff() on heif-enc-grid.avif", () => {
  const bytes = readFileSync(AVIF_PATH);
  const inventory = inventoryIsobmff(bytes);

  it("reports the top-level boxes measured in RECIPE.md", () => {
    expect(inventory.topLevel.map((b) => b.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);
    const mdat = inventory.topLevel.find((b) => b.type === "mdat");
    expect(mdat?.offset).toBe(735);
    expect(mdat?.size).toBe(3262);
  });

  it("reports primaryItemId 1 (the grid item) and iloc widths (4,4,4,0)", () => {
    expect(inventory.primaryItemId).toBe(1);
    expect(inventory.iloc).toEqual({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
    });
  });

  it("reports item 1 as a visible grid item with constructionMethod 1", () => {
    const item1 = inventory.items.find((i) => i.id === 1);
    expect(item1).toMatchObject({
      id: 1,
      type: "grid",
      hidden: false,
      constructionMethod: 1,
    });
  });

  it("reports an av01 tile item type (hidden, constructionMethod 0)", () => {
    const av01Tiles = inventory.items.filter(
      (i) => i.type === "av01" && i.hidden,
    );
    expect(av01Tiles.length).toBeGreaterThanOrEqual(2);
    for (const tile of av01Tiles) {
      expect(tile.constructionMethod).toBe(0);
    }
  });

  it("reports item 6 as a hidden Exif item and item 7 as mime/application-rdf+xml", () => {
    const exifItem = inventory.items.find((i) => i.id === 6);
    expect(exifItem).toMatchObject({
      id: 6,
      type: "Exif",
      hidden: true,
      constructionMethod: 0,
      baseOffset: 0x390,
    });
    expect(exifItem?.extents).toEqual([{ index: 0, offset: 0, length: 178 }]);

    const mimeItem = inventory.items.find((i) => i.id === 7);
    expect(mimeItem).toMatchObject({
      id: 7,
      type: "mime",
      hidden: true,
      contentType: "application/rdf+xml",
      constructionMethod: 0,
      baseOffset: 0x442,
    });
    expect(mimeItem?.extents).toEqual([{ index: 0, offset: 0, length: 2876 }]);
  });

  it("reports item 8 as a visible av01 thumbnail, referenced by a thmb reference", () => {
    const thumbnail = inventory.items.find((i) => i.id === 8);
    expect(thumbnail).toMatchObject({
      id: 8,
      type: "av01",
      hidden: false,
      constructionMethod: 0,
      baseOffset: 0xf7e,
    });
    const thmbRef = inventory.references.find((r) => r.type === "thmb");
    expect(thmbRef).toEqual({ type: "thmb", from: 8, to: [1] });
  });

  it("reports the measured ipco property list (av1C present, not hvcC)", () => {
    expect(inventory.properties.map((p) => p.type)).toEqual([
      "ispe",
      "av1C",
      "colr",
      "ispe",
      "pixi",
      "ispe",
    ]);
  });
});

// Builder-configuration cross-checks (D-20/D-21): the inventory reads back exactly the bytes and
// field widths the builder was configured to produce. Each file below is hand-assembled from the
// builder's low-level box primitives (never `heifFile()`, which only covers the single-item shape
// 61-02 needed) -- the test is the meeting point where builder and inventory may both be imported;
// `inventory.ts` and `builder.ts` themselves must never import each other (isobmff_isolation.test.ts).

/** Build a minimal single-item structural file: ftyp/hdlr/pitm/iinf/iloc(+idat) + mdat. */
function buildSingleItemFile(opts: {
  readonly ilocVersion: 0 | 1 | 2;
  readonly offsetSize: 0 | 4 | 8;
  readonly lengthSize: 0 | 4 | 8;
  readonly baseOffsetSize: 0 | 4 | 8;
  readonly indexSize: 0 | 4 | 8;
  readonly constructionMethod?: number;
  /** Payload chunks placed sequentially in `mdat` (cm 0) or `idat` (cm 1). */
  readonly extentPayloads: readonly Buffer[];
  /** Extra bytes placed before the item's extents, to exercise a non-zero base_offset (Config C). */
  readonly leadingPadding?: Buffer;
}): { readonly bytes: Buffer; readonly idatPayload?: Buffer } {
  const hdlr = hdlrBox("pict");
  const pitm = pitmBox(0, 1);
  const infe = infeBox({ version: 2, itemId: 1, itemType: "test" });
  const iinf = iinfBox(0, [infe]);
  const ftyp = ftypBox("heic", 0, ["mif1"]);
  const constructionMethod = opts.constructionMethod ?? 0;

  if (constructionMethod === 1) {
    const idatPayload = Buffer.concat(opts.extentPayloads);
    const idat = idatBox(idatPayload);
    let runningOffset = 0;
    const extents = opts.extentPayloads.map((payload) => {
      const extent = {
        index: 0,
        offset: runningOffset,
        length: payload.length,
      };
      runningOffset += payload.length;
      return extent;
    });
    const iloc = ilocBox({
      version: opts.ilocVersion,
      offsetSize: opts.offsetSize,
      lengthSize: opts.lengthSize,
      baseOffsetSize: opts.baseOffsetSize,
      indexSize: opts.indexSize,
      items: [
        {
          itemId: 1,
          constructionMethod: 1,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents,
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, idat, iinf, iloc]);
    const mdat = mdatBox(Buffer.alloc(0));
    return { bytes: Buffer.concat([ftyp, meta, mdat]), idatPayload };
  }

  // construction_method 0 (file-relative): a two-pass layout, since `iloc`'s encoded byte length
  // depends only on the declared widths, not the offset values (mirrors `builder.ts`'s `heifFile`).
  const leadingPadding = opts.leadingPadding ?? Buffer.alloc(0);
  const buildIloc = (baseOffset: number, extentOffsets: readonly number[]) =>
    ilocBox({
      version: opts.ilocVersion,
      offsetSize: opts.offsetSize,
      lengthSize: opts.lengthSize,
      baseOffsetSize: opts.baseOffsetSize,
      indexSize: opts.indexSize,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset,
          extents: opts.extentPayloads.map((payload, i) => ({
            index: 0,
            offset: extentOffsets[i] ?? 0,
            length: payload.length,
          })),
        },
      ],
    });

  const placeholderIloc = buildIloc(
    0,
    opts.extentPayloads.map(() => 0),
  );
  const metaPlaceholder = metaBox([hdlr, pitm, iinf, placeholderIloc]);
  const mdatHeaderSize = 8;
  const mdatFileOffset = ftyp.length + metaPlaceholder.length + mdatHeaderSize;

  // When `baseOffsetSize` is 0, the item's `base_offset` field is encoded as zero width (the
  // builder writes no bytes for it, per `writeWidth`), so the absolute file offset MUST be carried
  // entirely in each extent's own `offset` field. When `baseOffsetSize` > 0, the file offset is
  // carried in `base_offset` instead, and each extent's `offset` is relative to it (exercising the
  // base_offset field itself, per Config C).
  const baseOffset = opts.baseOffsetSize === 0 ? 0 : mdatFileOffset;
  const extentOffsetBase =
    opts.baseOffsetSize === 0
      ? mdatFileOffset + leadingPadding.length
      : leadingPadding.length;

  const extentOffsets: number[] = [];
  let runningOffset = extentOffsetBase;
  for (const payload of opts.extentPayloads) {
    extentOffsets.push(runningOffset);
    runningOffset += payload.length;
  }

  const finalIloc = buildIloc(baseOffset, extentOffsets);
  const finalMeta = metaBox([hdlr, pitm, iinf, finalIloc]);
  if (finalMeta.length !== metaPlaceholder.length) {
    throw new Error(
      "buildSingleItemFile: iloc byte length changed between placeholder and final passes",
    );
  }
  const mdatPayload = Buffer.concat([leadingPadding, ...opts.extentPayloads]);
  const mdat = mdatBox(mdatPayload);
  return { bytes: Buffer.concat([ftyp, finalMeta, mdat]) };
}

describe("inventory cross-checks against builder configurations (D-20/D-21)", () => {
  it("Config A: iloc v0 widths (4,4,0) -- cm=0 extent reads back the configured payload", () => {
    const payload = Buffer.from("CONFIG-A-PAYLOAD-BYTES!", "ascii");
    const { bytes } = buildSingleItemFile({
      ilocVersion: 0,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      extentPayloads: [payload],
    });
    const inventory = inventoryIsobmff(bytes);
    expect(inventory.iloc).toEqual({
      version: 0,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
    });
    const item = inventory.items.find((i) => i.id === 1);
    expect(item?.constructionMethod).toBe(0);
    expect(readItemExtentBytes(bytes, inventory, item!)).toEqual(payload);
  });

  it("Config B: iloc v1 widths (4,4,0,0) with an idat item -- cm=1 extent reads back the idat bytes", () => {
    const payload = Buffer.from("IDAT-CM1-PAYLOAD-CHUNK", "ascii");
    const { bytes, idatPayload } = buildSingleItemFile({
      ilocVersion: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      constructionMethod: 1,
      extentPayloads: [payload],
    });
    const inventory = inventoryIsobmff(bytes);
    expect(inventory.iloc?.version).toBe(1);
    expect(inventory.idat).toEqual({
      offset: expect.any(Number),
      length: idatPayload!.length,
    });
    const item = inventory.items.find((i) => i.id === 1);
    expect(item?.constructionMethod).toBe(1);
    expect(readItemExtentBytes(bytes, inventory, item!)).toEqual(payload);
  });

  it("Config C: iloc v1 widths (8,8,4,4) with a non-zero base_offset -- cm=0 extent reads back the payload", () => {
    const padding = Buffer.from("PAD--", "ascii");
    const payload = Buffer.from("CONFIG-C-BASE-OFFSET-PAYLOAD", "ascii");
    const { bytes } = buildSingleItemFile({
      ilocVersion: 1,
      offsetSize: 8,
      lengthSize: 8,
      baseOffsetSize: 4,
      indexSize: 4,
      extentPayloads: [payload],
      leadingPadding: padding,
    });
    const inventory = inventoryIsobmff(bytes);
    expect(inventory.iloc).toEqual({
      version: 1,
      offsetSize: 8,
      lengthSize: 8,
      baseOffsetSize: 4,
      indexSize: 4,
    });
    const item = inventory.items.find((i) => i.id === 1);
    expect(item?.baseOffset).toBeGreaterThan(0);
    expect(item?.extents).toEqual([
      { index: 0, offset: padding.length, length: payload.length },
    ]);
    expect(readItemExtentBytes(bytes, inventory, item!)).toEqual(payload);
  });

  it("Config D: iloc v2 widths (4,8,8,0) with a two-extent item -- extents concatenate in order, skipping a gap", () => {
    const chunk1 = Buffer.from("FIRST-CHUNK-", "ascii");
    const gap = Buffer.from("XXXX", "ascii");
    const chunk2 = Buffer.from("SECOND-CHUNK", "ascii");

    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "test" });
    const iinf = iinfBox(0, [infe]);
    const ftyp = ftypBox("heic", 0, ["mif1"]);

    const buildIloc = (offsets: readonly [number, number]) =>
      ilocBox({
        version: 2,
        offsetSize: 4,
        lengthSize: 8,
        baseOffsetSize: 8,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [
              { index: 0, offset: offsets[0], length: chunk1.length },
              { index: 0, offset: offsets[1], length: chunk2.length },
            ],
          },
        ],
      });

    const placeholderIloc = buildIloc([0, 0]);
    const metaPlaceholder = metaBox([hdlr, pitm, iinf, placeholderIloc]);
    const mdatOffset = ftyp.length + metaPlaceholder.length + 8;
    const chunk1Offset = mdatOffset;
    const chunk2Offset = mdatOffset + chunk1.length + gap.length;
    const finalIloc = buildIloc([chunk1Offset, chunk2Offset]);
    const finalMeta = metaBox([hdlr, pitm, iinf, finalIloc]);
    const mdat = mdatBox(Buffer.concat([chunk1, gap, chunk2]));
    const bytes = Buffer.concat([ftyp, finalMeta, mdat]);

    const inventory = inventoryIsobmff(bytes);
    const item = inventory.items.find((i) => i.id === 1);
    expect(inventory.iloc).toEqual({
      version: 2,
      offsetSize: 4,
      lengthSize: 8,
      baseOffsetSize: 8,
      indexSize: 0,
    });
    expect(item?.extents).toHaveLength(2);
    expect(readItemExtentBytes(bytes, inventory, item!)).toEqual(
      Buffer.concat([chunk1, chunk2]),
    );
  });

  it("Config E: largesize mdat framing -- cm=0 extent inside a largesize-framed mdat reads back correctly", () => {
    const payload = Buffer.from("LARGESIZE-MDAT-PAYLOAD-CONFIG-E", "ascii");
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "test" });
    const iinf = iinfBox(0, [infe]);
    const ftyp = ftypBox("heic", 0, ["mif1"]);

    const buildIloc = (offset: number) =>
      ilocBox({
        version: 0,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 0,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ index: 0, offset, length: payload.length }],
          },
        ],
      });

    const placeholderIloc = buildIloc(0);
    const metaPlaceholder = metaBox([hdlr, pitm, iinf, placeholderIloc]);
    const largesizeMdatHeaderLength = 16; // size(4)=1 + type(4) + largesize(8)
    const mdatOffset =
      ftyp.length + metaPlaceholder.length + largesizeMdatHeaderLength;
    const finalIloc = buildIloc(mdatOffset);
    const finalMeta = metaBox([hdlr, pitm, iinf, finalIloc]);
    const mdat = mdatBox(payload, { size: "largesize" });
    const bytes = Buffer.concat([ftyp, finalMeta, mdat]);

    const inventory = inventoryIsobmff(bytes);
    const mdatBoxEntry = inventory.topLevel.find((b) => b.type === "mdat");
    expect(mdatBoxEntry?.size).toBe(largesizeMdatHeaderLength + payload.length);
    const item = inventory.items.find((i) => i.id === 1);
    expect(readItemExtentBytes(bytes, inventory, item!)).toEqual(payload);
  });
});

describe("inventory iref direction cross-check (D-08)", () => {
  it("reports a cdsc reference from the Exif item to the primary exactly as configured", () => {
    const ftyp = ftypBox("heic", 0, ["mif1"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const primaryInfe = infeBox({ version: 2, itemId: 1, itemType: "test" });
    const exifInfe = infeBox({ version: 2, itemId: 2, itemType: "Exif" });
    const iinf = iinfBox(0, [primaryInfe, exifInfe]);
    const iref = irefBox(0, [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }]);

    const buildIloc = (offsets: readonly [number, number]) =>
      ilocBox({
        version: 0,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 0,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ index: 0, offset: offsets[0], length: 4 }],
          },
          {
            itemId: 2,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ index: 0, offset: offsets[1], length: 4 }],
          },
        ],
      });

    const placeholderIloc = buildIloc([0, 0]);
    const metaPlaceholder = metaBox([hdlr, pitm, iinf, placeholderIloc, iref]);
    const mdatOffset = ftyp.length + metaPlaceholder.length + 8;
    const finalIloc = buildIloc([mdatOffset, mdatOffset + 4]);
    const finalMeta = metaBox([hdlr, pitm, iinf, finalIloc, iref]);
    const mdat = mdatBox(Buffer.from("ABCDEFGH", "ascii"));
    const bytes = Buffer.concat([ftyp, finalMeta, mdat]);

    const inventory = inventoryIsobmff(bytes);
    const cdsc = inventory.references.find((r) => r.type === "cdsc");
    expect(cdsc).toEqual({ type: "cdsc", from: 2, to: [1] });
  });
});
