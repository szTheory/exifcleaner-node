// src/isobmff/admission.ts coverage (BMF-04): the D3/D5 admission classifier over the validated
// item graph (61-07), proven on both real `heif-enc` fixtures, a hand-built measured-iPhone-shaped
// file, and every D-10a empty/adjacency/direction edge from the amended plan.
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitIsobmff,
  classifyIsobmffModel,
  DECLINE_RULE_ORDER,
  PRESERVED_ITEM_TYPES,
  XMP_CONTENT_TYPES,
} from "../src/isobmff/admission.js";
import { C2PA_UUID_USERTYPE } from "../src/isobmff/boxes.js";
import { IsobmffStructureError } from "../src/isobmff/errors.js";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { createOrientationExif } from "../src/metadata/exif.js";
import {
  auxC,
  colrProf,
  ftypBox,
  grplBox,
  hdlrBox,
  idatBox,
  iinfBox,
  ilocBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  irefBox,
  mdatBox,
  metaBox,
  pitmBox,
  uuidBox,
  type GrplGroup,
  type IrefRef,
} from "./isobmff-support/builder.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "corpus",
  "constructed",
);
const HEIC_PATH = join(FIXTURES_DIR, "heic", "heif-enc-grid.heic");
const AVIF_PATH = join(FIXTURES_DIR, "avif", "heif-enc-grid.avif");

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-isobmff-admission-"),
  );
  cleanupDirectories.push(directory);
  return directory;
}

async function writeFixture(
  bytes: Buffer,
): Promise<{ path: string; size: number }> {
  const directory = await freshDirectory();
  const path = join(directory, "input.heic");
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
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

/** Minimal, structurally-valid XMP RDF payload (parseXmp requires balanced, entity-clean XML). */
function minimalXmp(title: string): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></rdf:Description>` +
      `</rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

/** A 4-byte `exif_tiff_header_offset` of 0, followed directly by a minimal TIFF/Exif payload. */
function exifItemPayload(): Buffer {
  const header = Buffer.alloc(4);
  return Buffer.concat([header, createOrientationExif(1)]);
}

interface ItemSpec {
  readonly itemId: number;
  readonly itemType: string;
  readonly hidden?: boolean;
  readonly contentType?: string;
  readonly contentEncoding?: string;
  /** D-14 regression (61-09): when `true`, writes no content_encoding bytes at all after
   * content_type (ISO/IEC 23008-12 9.2's OPTIONAL field, absent on the real iPhone 13 Pro Max
   * sample's XMP item). */
  readonly omitContentEncoding?: boolean;
  readonly constructionMethod?: number;
  readonly dataReferenceIndex?: number;
  /** cm=0: relative to the mdat payload's own start, resolved to an absolute `baseOffset` by the
   * builder (shared across every cm=0 item, mirroring the real `heif-enc` fixtures' own
   * base_offset-carries-the-absolute-position shape). cm=1: relative to the idat payload. */
  readonly extents: readonly {
    readonly relOffset: number;
    readonly length: number;
  }[];
  readonly propertyIndices?: readonly number[];
}

interface FileSpec {
  readonly majorBrand?: string;
  readonly compatibleBrands?: readonly string[];
  readonly primaryItemId: number;
  readonly items: readonly ItemSpec[];
  readonly properties?: readonly Buffer[];
  readonly refs?: readonly IrefRef[];
  readonly groups?: readonly GrplGroup[];
  readonly idatPayload?: Buffer;
  readonly mdatPayload: Buffer;
  /** Appended between `meta` and `mdat`. */
  readonly topLevelExtra?: readonly Buffer[];
  /** Appended after `mdat` (for the "meta/mdat not last" edge, D-10a's end-of-mdat variant). */
  readonly trailingExtra?: readonly Buffer[];
}

/**
 * Hand-built HEIF/AVIF-shaped file, two-pass (mirrors `builder.ts`'s own `heifFile` trick): an
 * `iloc` field's encoded byte length depends only on the declared widths, never the numeric values
 * stored, so a first pass with a placeholder `baseOffset` of 0 yields the real header length, which
 * is then used to compute every cm=0 item's real (shared) `baseOffset`.
 */
function buildFile(spec: FileSpec): Buffer {
  const assemble = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox(
      spec.majorBrand ?? "heic",
      0,
      spec.compatibleBrands ?? ["mif1", "heic"],
    );
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, spec.primaryItemId);
    const infeEntries = spec.items.map((item) =>
      infeBox({
        version: 2,
        itemId: item.itemId,
        itemType: item.itemType,
        ...(item.hidden !== undefined ? { hidden: item.hidden } : {}),
        ...(item.contentType !== undefined
          ? { contentType: item.contentType }
          : {}),
        ...(item.contentEncoding !== undefined
          ? { contentEncoding: item.contentEncoding }
          : {}),
        ...(item.omitContentEncoding === true
          ? { omitContentEncoding: true }
          : {}),
      }),
    );
    const iinf = iinfBox(0, infeEntries);
    const ipco = ipcoBox(spec.properties ?? []);
    const ipmaEntries = spec.items
      .filter((item) => (item.propertyIndices?.length ?? 0) > 0)
      .map((item) => ({
        itemId: item.itemId,
        associations: (item.propertyIndices ?? []).map((index) => ({
          propertyIndex: index,
          essential: false,
        })),
      }));
    const ipma = ipmaBox({ version: 0, flags: 0, entries: ipmaEntries });
    const iprp = iprpBox(ipco, ipma);
    const idat =
      spec.idatPayload !== undefined ? idatBox(spec.idatPayload) : undefined;
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: spec.items.map((item) => ({
        itemId: item.itemId,
        constructionMethod: item.constructionMethod ?? 0,
        dataReferenceIndex: item.dataReferenceIndex ?? 0,
        baseOffset: (item.constructionMethod ?? 0) === 0 ? mdatPayloadStart : 0,
        extents: item.extents.map((extent) => ({
          offset: extent.relOffset,
          length: extent.length,
        })),
      })),
    });
    const iref =
      spec.refs !== undefined && spec.refs.length > 0
        ? irefBox(0, spec.refs)
        : undefined;
    const grpl =
      spec.groups !== undefined && spec.groups.length > 0
        ? grplBox(spec.groups)
        : undefined;

    const metaChildren = [
      hdlr,
      pitm,
      ...(idat !== undefined ? [idat] : []),
      iloc,
      iinf,
      iprp,
      ...(iref !== undefined ? [iref] : []),
      ...(grpl !== undefined ? [grpl] : []),
    ];
    const meta = metaBox(metaChildren);
    const header = Buffer.concat([ftyp, meta, ...(spec.topLevelExtra ?? [])]);
    const mdat = mdatBox(spec.mdatPayload);
    return Buffer.concat([header, mdat, ...(spec.trailingExtra ?? [])]);
  };

  const pass1 = assemble(0);
  const mdatBoxTotal = 8 + spec.mdatPayload.length;
  const trailingLength = (spec.trailingExtra ?? []).reduce(
    (sum, box) => sum + box.length,
    0,
  );
  const headerLength = pass1.length - mdatBoxTotal - trailingLength;
  const mdatPayloadStart = headerLength + 8;
  const final = assemble(mdatPayloadStart);
  if (final.length !== pass1.length) {
    throw new Error(
      "buildFile: header length changed between placeholder and final passes",
    );
  }
  return final;
}

describe("src/isobmff/admission.ts exports", () => {
  it("exports admitIsobmff, classifyIsobmffModel, DECLINE_RULE_ORDER, PRESERVED_ITEM_TYPES, XMP_CONTENT_TYPES", () => {
    expect(typeof admitIsobmff).toBe("function");
    expect(typeof classifyIsobmffModel).toBe("function");
    expect(DECLINE_RULE_ORDER.length).toBe(10);
    expect(PRESERVED_ITEM_TYPES.has("hvc1")).toBe(true);
    expect(XMP_CONTENT_TYPES).toEqual(["application/rdf+xml"]);
  });
});

describe("admitIsobmff on real heif-enc fixtures (Task 1 tracer, Task 2)", () => {
  it("admits heif-enc-grid.heic with the measured Exif/XMP removable ids and real entries", async () => {
    const admission = await withHandle(HEIC_PATH, (handle) =>
      admitIsobmff(handle, 4243),
    );
    expect(admission.classification.removableItemIds).toEqual([6, 7]);
    expect(admission.classification.emptiedItemIds).toEqual([]);
    expect(admission.classification.survivingItemIds).toEqual([
      1, 2, 3, 4, 5, 8,
    ]);
    expect(admission.namespaces).toContain("EXIF");
    expect(admission.namespaces).toContain("XMP");
    expect(
      admission.entries.some(
        (entry) =>
          entry.name === "Make" && entry.value === "ExifCleanerFixture",
      ),
    ).toBe(true);
  });

  it("admits heif-enc-grid.avif with the measured Exif/XMP removable ids", async () => {
    const admission = await withHandle(AVIF_PATH, (handle) =>
      admitIsobmff(handle, 3997),
    );
    expect(admission.classification.removableItemIds).toEqual([6, 7]);
    expect(admission.classification.emptiedItemIds).toEqual([]);
    expect(admission.classification.survivingItemIds).toEqual([
      1, 2, 3, 4, 5, 8,
    ]);
    expect(admission.namespaces).toContain("EXIF");
    expect(admission.namespaces).toContain("XMP");
  });
});

describe("the measured iPhone shape (builder, D-08/D-09)", () => {
  it("admits a grid-in-idat primary with hidden tiles, a thumbnail, an hdrgainmap auxl, and cdsc-from-item Exif/XMP", async () => {
    const idatPayload = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]); // grid descriptor bytes (opaque)
    const tilePayload = Buffer.from("tile-bytes", "ascii");
    const thumbPayload = Buffer.from("thumb-bytes", "ascii");
    const exifPayload = exifItemPayload();
    const xmpPayload = minimalXmp("iPhone shape");

    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "grid",
          constructionMethod: 1,
          extents: [{ relOffset: 0, length: idatPayload.length }],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          hidden: true,
          extents: [{ relOffset: 0, length: tilePayload.length }],
        },
        {
          itemId: 3,
          itemType: "hvc1",
          hidden: false,
          extents: [
            {
              relOffset: tilePayload.length,
              length: thumbPayload.length,
            },
          ],
        },
        {
          itemId: 4,
          itemType: "hvc1",
          hidden: true,
          propertyIndices: [1],
          extents: [
            {
              relOffset: tilePayload.length + thumbPayload.length,
              length: tilePayload.length,
            },
          ],
        },
        {
          itemId: 5,
          itemType: "Exif",
          hidden: true,
          extents: [
            {
              relOffset: 2 * tilePayload.length + thumbPayload.length,
              length: exifPayload.length,
            },
          ],
        },
        {
          itemId: 6,
          itemType: "mime",
          hidden: true,
          contentType: "application/rdf+xml",
          contentEncoding: "",
          extents: [
            {
              relOffset:
                2 * tilePayload.length +
                thumbPayload.length +
                exifPayload.length,
              length: xmpPayload.length,
            },
          ],
        },
      ],
      // auxC property (index 1), carrying the Apple HDR gain-map URN.
      properties: [auxC("urn:com:apple:photo:2020:aux:hdrgainmap")],
      refs: [
        { type: "dimg", fromItemId: 1, toItemIds: [2] },
        { type: "thmb", fromItemId: 3, toItemIds: [1] },
        { type: "auxl", fromItemId: 4, toItemIds: [1] },
        { type: "cdsc", fromItemId: 5, toItemIds: [1] },
        { type: "cdsc", fromItemId: 6, toItemIds: [1] },
      ],
      idatPayload,
      mdatPayload: Buffer.concat([
        tilePayload,
        thumbPayload,
        tilePayload,
        exifPayload,
        xmpPayload,
      ]),
    };

    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );

    expect(admission.classification.survivingItemIds).toEqual([1, 2, 3, 4]);
    expect(admission.classification.removableItemIds).toEqual([5, 6]);
    expect(admission.classification.emptiedItemIds).toEqual([]);
    expect(admission.namespaces).toContain("EXIF");
    expect(admission.namespaces).toContain("XMP");
  });
});

describe("D-14 regression: mime infe with absent content_encoding (61-09, orchestrator-added)", () => {
  it("admits the XMP item (removable, non-emptied) exactly like the explicit-empty-string shape", async () => {
    const primaryPayload = Buffer.from([1, 2, 3, 4]);
    const xmpPayload = minimalXmp("absent-content-encoding");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          itemType: "mime",
          hidden: true,
          contentType: "application/rdf+xml",
          omitContentEncoding: true,
          extents: [
            { relOffset: primaryPayload.length, length: xmpPayload.length },
          ],
        },
      ],
      mdatPayload: Buffer.concat([primaryPayload, xmpPayload]),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );

    expect(admission.classification.survivingItemIds).toEqual([1]);
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.emptiedItemIds).toEqual([]);
    expect(admission.namespaces).toContain("XMP");
  });
});

describe("D-10a: empty extents and extent_count 0 (amended)", () => {
  async function buildEmptyExif(options: {
    readonly relOffset: number;
    readonly mdatLength: number;
    readonly trailingExtra?: readonly Buffer[];
  }): Promise<{ path: string; size: number }> {
    const survivingPayload = Buffer.from("surviving-tile-bytes", "ascii");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: survivingPayload.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [{ relOffset: options.relOffset, length: 0 }],
        },
      ],
      mdatPayload: Buffer.concat([
        survivingPayload,
        Buffer.alloc(Math.max(0, options.mdatLength - survivingPayload.length)),
      ]),
      ...(options.trailingExtra !== undefined
        ? { trailingExtra: options.trailingExtra }
        : {}),
    };
    const bytes = buildFile(spec);
    return writeFixture(bytes);
  }

  it("admits a removable zero-length extent at offset == file size (EOF variant), listed in emptiedItemIds", async () => {
    // Choose relOffset == mdatPayload length so the absolute offset lands exactly at the end of
    // mdat, which (with no trailing boxes) is also the file's own end.
    const mdatLength = 32;
    const { path, size } = await buildEmptyExif({
      relOffset: mdatLength,
      mdatLength,
    });
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.emptiedItemIds).toEqual([2]);
  });

  it("admits a removable zero-length extent at offset == end of mdat, with a trailing free box after it (end-of-mdat variant)", async () => {
    const mdatLength = 32;
    const freeBox = Buffer.concat([
      Buffer.from([0, 0, 0, 8]),
      Buffer.from("free", "ascii"),
    ]);
    const { path, size } = await buildEmptyExif({
      relOffset: mdatLength,
      mdatLength,
      trailingExtra: [freeBox],
    });
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.emptiedItemIds).toEqual([2]);
  });

  it("admits a removable zero-length extent mid-mdat, followed by a surviving tile (measured ExifTool in-place shape)", async () => {
    const mdatLength = 64;
    // mid-mdat: strictly between 0 and mdatLength, with the surviving tile occupying [0, N).
    const { path, size } = await buildEmptyExif({ relOffset: 20, mdatLength });
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.emptiedItemIds).toEqual([2]);
    expect(admission.classification.survivingItemIds).toEqual([1]);
  });

  it("declines extent-outside-mdat for a removable zero-length extent beyond mdat end and not equal to file size", async () => {
    const mdatLength = 32;
    const { path, size } = await buildEmptyExif({
      relOffset: mdatLength + 1000,
      mdatLength,
    });
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({
      declineClass: "extent-outside-mdat",
    });
  });

  it("admits a removable item with extent_count 0 as emptied", async () => {
    const survivingPayload = Buffer.from("surviving-tile-bytes", "ascii");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: survivingPayload.length }],
        },
        { itemId: 2, itemType: "Exif", hidden: true, extents: [] },
      ],
      mdatPayload: survivingPayload,
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.emptiedItemIds).toEqual([2]);
  });

  it("declines surviving-zero-length-extent for a surviving item with a zero-length extent", async () => {
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        { itemId: 1, itemType: "hvc1", extents: [{ relOffset: 0, length: 0 }] },
      ],
      mdatPayload: Buffer.alloc(8),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({ declineClass: "surviving-zero-length-extent" });
  });

  it("declines surviving-zero-length-extent for a surviving item with extent_count 0", async () => {
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [{ itemId: 1, itemType: "hvc1", extents: [] }],
      mdatPayload: Buffer.alloc(0),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({ declineClass: "surviving-zero-length-extent" });
  });
});

describe("BMF-03/BMF-04 adjacency and overlap edges", () => {
  function overlapSpec(removableEnd: number): FileSpec {
    const mdatPayload = Buffer.alloc(200, 1);
    return {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 150, length: 50 }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [{ relOffset: 100, length: removableEnd - 100 }],
        },
      ],
      mdatPayload,
    };
  }

  it("admits a removable extent ending exactly where a surviving extent begins (adjacency)", async () => {
    const bytes = buildFile(overlapSpec(150));
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
    expect(admission.classification.survivingItemIds).toEqual([1]);
  });

  it("declines removable-extent-overlap when the removable extent overlaps the surviving extent by one byte", async () => {
    const bytes = buildFile(overlapSpec(151));
    const { path, size } = await writeFixture(bytes);
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({ declineClass: "removable-extent-overlap" });
  });

  it("admits two surviving extents that overlap each other", async () => {
    const mdatPayload = Buffer.alloc(100, 1);
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 50 }],
        },
        {
          itemId: 2,
          itemType: "av01",
          extents: [{ relOffset: 10, length: 50 }],
        },
      ],
      mdatPayload,
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.survivingItemIds).toEqual([1, 2]);
  });
});

describe("D-08: removable-item-referenced direction", () => {
  it("admits a removable Exif item that is the cdsc from-item to the primary", async () => {
    const primaryPayload = Buffer.from("primary", "ascii");
    const exifPayload = exifItemPayload();
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [
            { relOffset: primaryPayload.length, length: exifPayload.length },
          ],
        },
      ],
      refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
      mdatPayload: Buffer.concat([primaryPayload, exifPayload]),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableItemIds).toEqual([2]);
  });

  it("declines removable-item-referenced when a removable Exif item is an iref to-target", async () => {
    const primaryPayload = Buffer.from("primary", "ascii");
    const exifPayload = exifItemPayload();
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [
            { relOffset: primaryPayload.length, length: exifPayload.length },
          ],
        },
      ],
      refs: [{ type: "cdsc", fromItemId: 1, toItemIds: [2] }],
      mdatPayload: Buffer.concat([primaryPayload, exifPayload]),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({ declineClass: "removable-item-referenced" });
  });
});

describe("top-level C2PA uuid and colr colour profile", () => {
  it("admits a top-level C2PA uuid, lists it in removableTopLevel, and reports the C2PA namespace", async () => {
    const primaryPayload = Buffer.from("primary", "ascii");
    const c2paBox = uuidBox(C2PA_UUID_USERTYPE, Buffer.from("jumbf", "ascii"));
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
      ],
      topLevelExtra: [c2paBox],
      mdatPayload: primaryPayload,
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.removableTopLevel.length).toBe(1);
    expect(admission.namespaces).toContain("C2PA");
  });

  it("sets admission.colorProfile to the exact colr prof ICC bytes on the primary item", async () => {
    const iccBytes = Buffer.from("fake-icc-bytes", "ascii");
    const primaryPayload = Buffer.from("primary", "ascii");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          propertyIndices: [1],
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
      ],
      properties: [colrProf(iccBytes)],
      mdatPayload: primaryPayload,
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.colorProfile).toEqual(iccBytes);
    expect(admission.namespaces).toContain("ICC");
  });
});

describe("tmap and iden item types (BMF-04 positives)", () => {
  it("admits a primary hvc1 item alongside a tmap and an iden item", async () => {
    const primaryPayload = Buffer.from("primary", "ascii");
    const tmapPayload = Buffer.from("tmap", "ascii");
    const idenPayload = Buffer.from("iden", "ascii");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          itemType: "tmap",
          extents: [
            { relOffset: primaryPayload.length, length: tmapPayload.length },
          ],
        },
        {
          itemId: 3,
          itemType: "iden",
          extents: [
            {
              relOffset: primaryPayload.length + tmapPayload.length,
              length: idenPayload.length,
            },
          ],
        },
      ],
      mdatPayload: Buffer.concat([primaryPayload, tmapPayload, idenPayload]),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.survivingItemIds).toEqual([1, 2, 3]);
  });

  it("admits a two-extent surviving hvc1 item", async () => {
    const part1 = Buffer.from("part-one", "ascii");
    const part2 = Buffer.from("part-two", "ascii");
    const spec: FileSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [
            { relOffset: 0, length: part1.length },
            { relOffset: part1.length, length: part2.length },
          ],
        },
      ],
      mdatPayload: Buffer.concat([part1, part2]),
    };
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.survivingItemIds).toEqual([1]);
  });
});

describe("classifyIsobmffModel direct unit coverage (BMF-03 ordering)", () => {
  async function buildModel(spec: FileSpec) {
    const bytes = buildFile(spec);
    const { path, size } = await writeFixture(bytes);
    return withHandle(path, async (handle) => ({
      model: await parseIsobmff(handle, size),
      size,
    }));
  }

  it("declines unknown-item-type for an unrecognized item type", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "junk",
          extents: [{ relOffset: 0, length: payload.length }],
        },
      ],
      mdatPayload: payload,
    });
    expect(() => classifyIsobmffModel(model, size)).toThrow(
      IsobmffStructureError,
    );
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(IsobmffStructureError);
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "unknown-item-type",
      );
    }
  });

  it("declines unknown-item-type for a mime item with an unmeasured content type", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "mime",
          contentType: "application/xmp+xml",
          contentEncoding: "",
          extents: [{ relOffset: 0, length: payload.length }],
        },
      ],
      mdatPayload: payload,
    });
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "unknown-item-type",
      );
    }
  });

  it("declines unknown-item-type for a mime item carrying a content_encoding", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "mime",
          contentType: "application/rdf+xml",
          contentEncoding: "gzip",
          extents: [{ relOffset: 0, length: payload.length }],
        },
      ],
      mdatPayload: payload,
    });
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "unknown-item-type",
      );
    }
  });

  it("declines construction-method-2 for any item declaring it", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          constructionMethod: 2,
          extents: [{ relOffset: 0, length: payload.length }],
        },
      ],
      mdatPayload: payload,
    });
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "construction-method-2",
      );
    }
  });

  it("declines external-data-reference for a non-zero data_reference_index", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          dataReferenceIndex: 1,
          extents: [{ relOffset: 0, length: payload.length }],
        },
      ],
      mdatPayload: payload,
    });
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "external-data-reference",
      );
    }
  });

  it("declines removable-item-in-idat for a removable item with construction_method 1", async () => {
    const payload = Buffer.from("x", "ascii");
    const { model, size } = await buildModel({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: payload.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          constructionMethod: 1,
          extents: [{ relOffset: 0, length: 4 }],
        },
      ],
      idatPayload: Buffer.alloc(4),
      mdatPayload: payload,
    });
    try {
      classifyIsobmffModel(model, size);
      expect.fail("expected classifyIsobmffModel to throw");
    } catch (cause) {
      expect((cause as IsobmffStructureError).declineClass).toBe(
        "removable-item-in-idat",
      );
    }
  });
});

// WR-01 (code review 2026-10-01): `item.baseOffset` and `extent.offset` are each independently
// validated by `readSizedUint` (iloc.ts) to be at most `Number.MAX_SAFE_INTEGER`, but their *sum*
// was not checked -- a lossy `Number` cast risk this module's own precision discipline forbids
// (iloc.ts's own 8-byte `readSizedUint` branch declines rather than casting lossily). This
// bespoke builder (not `buildFile`, which hardcodes 4-byte iloc widths) constructs a minimal,
// otherwise-valid single-item file with 8-byte `iloc` offset/base_offset widths so `baseOffset`
// can be set to exactly `Number.MAX_SAFE_INTEGER` -- individually safe, per readSizedUint -- while
// `extent.offset` is a small, also individually-safe value whose *sum* exceeds safe-integer
// precision.
describe("WR-01: offset-sum precision guard in admission.ts", () => {
  function buildWideOffsetFile(
    baseOffset: number,
    extentOffset: number,
  ): Buffer {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const iloc = ilocBox({
      version: 1,
      offsetSize: 8,
      lengthSize: 4,
      baseOffsetSize: 8,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset,
          extents: [{ offset: extentOffset, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iloc]);
    return Buffer.concat([ftyp, meta]);
  }

  it("declines extent-outside-mdat when baseOffset + extent.offset exceeds Number.MAX_SAFE_INTEGER, though each is individually safe", async () => {
    const baseOffset = Number.MAX_SAFE_INTEGER;
    const extentOffset = 10;
    expect(Number.isSafeInteger(baseOffset)).toBe(true);
    expect(Number.isSafeInteger(extentOffset)).toBe(true);
    expect(Number.isSafeInteger(baseOffset + extentOffset)).toBe(false);

    const bytes = buildWideOffsetFile(baseOffset, extentOffset);
    const { path, size } = await writeFixture(bytes);
    await expect(
      withHandle(path, (handle) => admitIsobmff(handle, size)),
    ).rejects.toMatchObject({
      declineClass: "extent-outside-mdat",
      kind: "malformed-file",
      message: expect.stringContaining("exceeds safe integer precision"),
    });
  });

  it("admits the same shape when baseOffset + extent.offset stays within safe-integer precision (negative control)", async () => {
    // Same 8-byte iloc widths, but an mdat payload actually backing the (safe-sum) extent --
    // proves the precision guard itself, not merely "any 8-byte-width file declines".
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const buildHeader = (mdatPayloadStart: number): Buffer => {
      const iloc = ilocBox({
        version: 1,
        offsetSize: 8,
        lengthSize: 4,
        baseOffsetSize: 8,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: mdatPayloadStart,
            extents: [{ offset: 0, length: 4 }],
          },
        ],
      });
      const meta = metaBox([hdlr, pitm, iinf, iloc]);
      return Buffer.concat([ftyp, meta]);
    };
    const headerOnly = buildHeader(0);
    const mdatPayloadStart = headerOnly.length + 8;
    const header = buildHeader(mdatPayloadStart);
    expect(header.length).toBe(headerOnly.length);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const bytes = Buffer.concat([header, mdat]);

    const { path, size } = await writeFixture(bytes);
    const admission = await withHandle(path, (handle) =>
      admitIsobmff(handle, size),
    );
    expect(admission.classification.survivingItemIds).toEqual([1]);
  });
});
