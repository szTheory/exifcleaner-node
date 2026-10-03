// src/isobmff/items.ts coverage (BMF-04/BMF-05, D1, D-21): the validated item graph
// (`iinf`/`iloc`/`iref`/`ipco`/`ipma`/`pitm`/`grpl`/`idat`/`colr`), proven against the
// independent inventory walker (`tests/isobmff-support/inventory.ts`) on real `heif-enc`
// fixtures and against hand-built structural cases for the AVIF brand, `colr` extraction and
// every graph-validity decline. Task 3 proves `parseIsobmff` never reads `mdat`'s payload.
import { mkdtemp, open, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { buildItemModel } from "../src/isobmff/items.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";
import {
  auxC,
  box,
  colrNclx,
  colrProf,
  ftypBox,
  fullBox,
  grplBox,
  hdlrBox,
  hvcC,
  iinfBox,
  ilocBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  irefBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
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
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-items-"));
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

async function parseFixtureBytes(bytes: Buffer) {
  const { path, size } = await writeFixture(bytes);
  const handle = await open(path, "r");
  try {
    return await parseIsobmff(handle, size);
  } finally {
    await handle.close();
  }
}

/** Compare `parseIsobmff`'s item graph against the independent inventory walker's own view of
 * the same bytes, field by field (D-21). */
async function expectModelMatchesInventory(path: string): Promise<void> {
  const bytes = readFileSync(path);
  const inventory = inventoryIsobmff(bytes);
  expect(inventory.items.length).toBeGreaterThan(0);

  const handle = await open(path, "r");
  try {
    const model = await parseIsobmff(handle, bytes.length);

    expect(model.primaryItemId).toBe(inventory.primaryItemId);
    expect(model.items.map((item) => item.id)).toEqual(
      inventory.items.map((item) => item.id),
    );

    const modelByItemId = new Map(model.items.map((item) => [item.id, item]));
    for (const inventoryItem of inventory.items) {
      const modelItem = modelByItemId.get(inventoryItem.id);
      expect(modelItem).toBeDefined();
      expect(modelItem?.type).toBe(inventoryItem.type);
      expect(modelItem?.hidden).toBe(inventoryItem.hidden);
      expect(modelItem?.constructionMethod).toBe(
        inventoryItem.constructionMethod,
      );
      expect(modelItem?.dataReferenceIndex).toBe(
        inventoryItem.dataReferenceIndex,
      );
      expect(modelItem?.baseOffset).toBe(inventoryItem.baseOffset);
      expect(modelItem?.extents).toEqual(inventoryItem.extents);
      if (inventoryItem.contentType !== undefined) {
        expect(modelItem?.contentType).toBe(inventoryItem.contentType);
      }
    }

    expect(
      model.references.map((reference) => ({
        type: reference.type,
        from: reference.fromItemId,
        to: reference.toItemIds,
      })),
    ).toEqual(
      inventory.references.map((reference) => ({
        type: reference.type,
        from: reference.from,
        to: reference.to,
      })),
    );

    expect(
      model.properties.map((property) => ({
        index: property.index,
        type: property.type,
      })),
    ).toEqual(
      inventory.properties.map((property) => ({
        index: property.index,
        type: property.type,
      })),
    );
    for (const inventoryProperty of inventory.properties) {
      if (inventoryProperty.auxUrn !== undefined) {
        const modelProperty = model.properties.find(
          (property) => property.index === inventoryProperty.index,
        );
        expect(modelProperty?.auxUrn).toBe(inventoryProperty.auxUrn);
      }
    }

    for (const inventoryAssociation of inventory.associations) {
      const modelItem = modelByItemId.get(inventoryAssociation.itemId);
      expect(
        modelItem?.properties.map((association) => ({
          propertyIndex: association.index,
          essential: association.essential,
        })),
      ).toEqual(inventoryAssociation.associations);
    }
  } finally {
    await handle.close();
  }
}

// --- Task 1: item graph from the real heif-enc HEIC, matching the inventory end to end ---

describe("buildItemModel exports (acceptance: items.ts exports buildItemModel and the four types)", () => {
  it("buildItemModel is a function", () => {
    expect(typeof buildItemModel).toBe("function");
  });
});

describe("parseIsobmff item graph on heif-enc-grid.heic", () => {
  it("matches the independent inventory walker's items, references, properties and associations", async () => {
    await expectModelMatchesInventory(HEIC_PATH);
  });

  it("exposes the primary item's colr colour type via properties, with no colorProfile for an nclx primary", async () => {
    const bytes = readFileSync(HEIC_PATH);
    const handle = await open(HEIC_PATH, "r");
    try {
      const model = await parseIsobmff(handle, bytes.length);
      const colr = model.properties.find(
        (property) => property.type === "colr",
      );
      expect(colr?.colourType).toBe("nclx");
      expect(model.colorProfile).toBeUndefined();
      expect(model.idatRange).toEqual({ offset: 59, length: 8 });
      expect(model.handlerType).toBe("pict");
    } finally {
      await handle.close();
    }
  });
});

// --- Task 2: AVIF oracle, colr extraction, builder configurations, and graph-validity declines ---

describe("parseIsobmff item graph on heif-enc-grid.avif", () => {
  it("matches the independent inventory walker's items, references, properties and associations", async () => {
    await expectModelMatchesInventory(AVIF_PATH);
  });
});

/** A minimal, structurally-valid one-item meta: hdlr(pict), pitm, iinf[infe], iprp[ipco,ipma],
 * iloc. Each test overrides exactly the piece under test via the optional parameters. */
function buildMinimalFile(options: {
  readonly itemType?: string;
  readonly ipcoProperties?: readonly Buffer[];
  readonly ipmaAssociations?: readonly {
    readonly propertyIndex: number;
    readonly essential: boolean;
  }[];
  readonly extraMetaChildren?: readonly Buffer[];
  readonly hdlrType?: string;
  readonly pitmVersion?: 0 | 1;
  readonly pitmItemId?: number;
  readonly infeVersion?: 0 | 1 | 2 | 3;
  readonly iinfVersion?: 0 | 1;
  readonly ilocVersion?: 0 | 1 | 2;
  readonly omitHdlr?: boolean;
  readonly omitPitm?: boolean;
  readonly omitIinf?: boolean;
  readonly omitIloc?: boolean;
}): Buffer {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const hdlr = hdlrBox(options.hdlrType ?? "pict");
  const pitm = pitmBox(options.pitmVersion ?? 0, options.pitmItemId ?? 1);
  const infe = infeBox({
    version: options.infeVersion ?? 2,
    itemId: 1,
    itemType: options.itemType ?? "hvc1",
  });
  const iinf = iinfBox(options.iinfVersion ?? 0, [infe]);
  const ipco = ipcoBox(options.ipcoProperties ?? [ispe(32, 32), hvcC()]);
  const ipma = ipmaBox({
    version: 0,
    flags: 0,
    entries: [
      {
        itemId: 1,
        associations: options.ipmaAssociations ?? [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: true },
        ],
      },
    ],
  });
  const iprp = iprpBox(ipco, ipma);
  const iloc = ilocBox({
    version: options.ilocVersion ?? 0,
    offsetSize: 4,
    lengthSize: 4,
    baseOffsetSize: 0,
    indexSize: 0,
    items: [
      {
        itemId: 1,
        dataReferenceIndex: 0,
        baseOffset: 0,
        extents: [{ offset: 0, length: 4 }],
      },
    ],
  });

  const children: Buffer[] = [];
  if (options.omitHdlr !== true) children.push(hdlr);
  if (options.omitPitm !== true) children.push(pitm);
  if (options.omitIinf !== true) children.push(iinf);
  children.push(iprp);
  if (options.omitIloc !== true) children.push(iloc);
  if (options.extraMetaChildren !== undefined) {
    children.push(...options.extraMetaChildren);
  }

  const meta = metaBox(children);
  const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
  return Buffer.concat([ftyp, meta, mdat]);
}

async function expectDecline(
  file: Buffer,
  declineClass: string,
  kind: string,
): Promise<void> {
  await expect(parseFixtureBytes(file)).rejects.toMatchObject({
    declineClass,
    kind,
  });
}

describe("colr extraction (D-12)", () => {
  it("colr prof on the primary item sets colorProfile to the exact ICC bytes", async () => {
    const iccBytes = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const file = buildMinimalFile({
      ipcoProperties: [ispe(32, 32), hvcC(), colrProf(iccBytes)],
      ipmaAssociations: [
        { propertyIndex: 1, essential: false },
        { propertyIndex: 3, essential: false },
      ],
    });
    const model = await parseFixtureBytes(file);
    expect(model.colorProfile).toEqual(iccBytes);
  });

  it("colr nclx on the primary item leaves colorProfile undefined", async () => {
    const file = buildMinimalFile({
      ipcoProperties: [ispe(32, 32), hvcC(), colrNclx(1, 13, 6, true)],
      ipmaAssociations: [
        { propertyIndex: 1, essential: false },
        { propertyIndex: 3, essential: false },
      ],
    });
    const model = await parseFixtureBytes(file);
    expect(model.colorProfile).toBeUndefined();
  });

  it("no colr property at all leaves colorProfile undefined", async () => {
    const file = buildMinimalFile({});
    const model = await parseFixtureBytes(file);
    expect(model.colorProfile).toBeUndefined();
  });
});

describe("auxC URN round-trip", () => {
  it("reads back urn:com:apple:photo:2020:aux:hdrgainmap exactly", async () => {
    const urn = "urn:com:apple:photo:2020:aux:hdrgainmap";
    const file = buildMinimalFile({
      ipcoProperties: [ispe(32, 32), hvcC(), auxC(urn)],
    });
    const model = await parseFixtureBytes(file);
    const auxProperty = model.properties.find(
      (property) => property.type === "auxC",
    );
    expect(auxProperty?.auxUrn).toBe(urn);
  });
});

describe("grpl entity groups", () => {
  it("an altr group's members are recorded as { type, groupId, entityIds }", async () => {
    const file = buildMinimalFile({
      extraMetaChildren: [
        grplBox([{ type: "altr", groupId: 42, entityIds: [1] }]),
      ],
    });
    const model = await parseFixtureBytes(file);
    expect(model.groups).toEqual([
      { type: "altr", groupId: 42, entityIds: [1] },
    ]);
  });
});

describe("item order follows iinf order (BMF-04)", () => {
  it("model order equals iinf order even when iloc and ipma list items differently", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe1 = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infe2 = infeBox({ version: 2, itemId: 2, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe1, infe2]); // iinf order: 1, 2
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        // ipma order: 2, 1 -- deliberately reversed from iinf order.
        {
          itemId: 2,
          associations: [{ propertyIndex: 1, essential: false }],
        },
        {
          itemId: 1,
          associations: [{ propertyIndex: 2, essential: true }],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
      version: 0,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      items: [
        // iloc order: 2, 1 -- also reversed from iinf order.
        {
          itemId: 2,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ offset: 0, length: 4 }],
        },
        {
          itemId: 1,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ offset: 4, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const file = Buffer.concat([ftyp, meta, mdat]);

    const model = await parseFixtureBytes(file);
    expect(model.items.map((item) => item.id)).toEqual([1, 2]);
  });
});

describe("meta validity declines", () => {
  it("hdlr other than pict declines meta-handler-not-pict", async () => {
    await expectDecline(
      buildMinimalFile({ hdlrType: "vide" }),
      "meta-handler-not-pict",
      "unsupported-format",
    );
  });

  it('a meta child "abcd" declines unknown-meta-child', async () => {
    await expectDecline(
      buildMinimalFile({ extraMetaChildren: [box("abcd", Buffer.alloc(4))] }),
      "unknown-meta-child",
      "unsupported-format",
    );
  });

  it("infe v1 declines unsupported-box-version", async () => {
    await expectDecline(
      buildMinimalFile({ infeVersion: 1 }),
      "unsupported-box-version",
      "unsupported-format",
    );
  });

  it("iinf v2 declines unsupported-box-version", async () => {
    // iinfBox's type signature only admits 0 | 1; build the version-2 header directly.
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const countAndChildren = Buffer.concat([Buffer.from([0, 0, 0, 1]), infe]);
    const iinfV2 = fullBox("iinf", 2, 0, countAndChildren);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [{ propertyIndex: 1, essential: false }],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinfV2, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "unsupported-box-version",
      "unsupported-format",
    );
  });

  it("iref v2 declines unsupported-box-version", async () => {
    // irefBox's type signature only admits 0 | 1; build the version-2 header directly.
    const file = buildMinimalFile({
      extraMetaChildren: [
        fullBox(
          "iref",
          2,
          0,
          box(
            "dimg",
            Buffer.concat([Buffer.from([0, 1]), Buffer.from([0, 0])]),
          ),
        ),
      ],
    });
    await expectDecline(file, "unsupported-box-version", "unsupported-format");
  });

  it("pitm v2 declines unsupported-box-version", async () => {
    // pitmBox's type signature only admits 0 | 1; build the version-2 header directly.
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitmV2 = fullBox("pitm", 2, 0, Buffer.from([0, 1]));
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [{ propertyIndex: 1, essential: false }],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitmV2, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "unsupported-box-version",
      "unsupported-format",
    );
  });

  it("an unknown ipco property type (clap) is kept as an opaque range, not declined", async () => {
    const file = buildMinimalFile({
      ipcoProperties: [ispe(32, 32), hvcC(), box("clap", Buffer.alloc(16))],
      ipmaAssociations: [
        { propertyIndex: 1, essential: false },
        { propertyIndex: 3, essential: false },
      ],
    });
    const model = await parseFixtureBytes(file);
    const clap = model.properties.find((property) => property.type === "clap");
    expect(clap).toBeDefined();
    expect(clap?.auxUrn).toBeUndefined();
    expect(clap?.colourType).toBeUndefined();
  });
});

// --- D-14 regression (61-09, orchestrator-added): 61-08 fixed parseInfe's mime branch to treat
// content_encoding as OPTIONAL (ISO/IEC 23008-12 9.2), matching the real iPhone 13 Pro Max
// sample's XMP item (item 52), whose infe payload ends exactly at content_type's own terminator.
// No prior committed test covered the absent case: every heif-enc/builder fixture wrote an
// explicit empty content_encoding (one NUL byte). `omitContentEncoding` (tests/isobmff-support/
// builder.ts) writes nothing at all after content_type, proving the absent shape independently of
// the explicit-empty shape.
describe("D-14 regression: mime infe with absent content_encoding (61-09, orchestrator-added)", () => {
  function buildFileWithMimeItem(options: {
    readonly omitContentEncoding?: boolean;
    readonly contentEncoding?: string;
  }): Buffer {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const primaryPayload = Buffer.from([1, 2, 3, 4]);
    const xmpPayload = Buffer.from(
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
        `<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title></rdf:Description>` +
        `</rdf:RDF></x:xmpmeta>`,
      "utf8",
    );
    const infePrimary = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infeMime = infeBox({
      version: 2,
      itemId: 2,
      itemType: "mime",
      contentType: "application/rdf+xml",
      hidden: true,
      ...(options.omitContentEncoding === true
        ? { omitContentEncoding: true }
        : {}),
      ...(options.contentEncoding !== undefined
        ? { contentEncoding: options.contentEncoding }
        : {}),
    });
    const iinf = iinfBox(0, [infePrimary, infeMime]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: true },
          ],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [
            { offset: primaryPayload.length, length: xmpPayload.length },
          ],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.concat([primaryPayload, xmpPayload]));
    return Buffer.concat([ftyp, meta, mdat]);
  }

  it("parses with contentEncoding undefined when content_encoding is entirely absent", async () => {
    const file = buildFileWithMimeItem({ omitContentEncoding: true });
    const model = await parseFixtureBytes(file);
    const mimeItem = model.items.find((item) => item.id === 2);
    expect(mimeItem).toBeDefined();
    expect(mimeItem?.contentType).toBe("application/rdf+xml");
    expect(mimeItem?.contentEncoding).toBeUndefined();
  });

  it("parses the explicit-empty-string shape identically for comparison (contentEncoding '')", async () => {
    const file = buildFileWithMimeItem({ contentEncoding: "" });
    const model = await parseFixtureBytes(file);
    const mimeItem = model.items.find((item) => item.id === 2);
    expect(mimeItem).toBeDefined();
    expect(mimeItem?.contentType).toBe("application/rdf+xml");
    expect(mimeItem?.contentEncoding).toBe("");
  });
});

describe("item-graph validity declines (BMF-04)", () => {
  it("missing hdlr declines item-graph-invalid", async () => {
    await expectDecline(
      buildMinimalFile({ omitHdlr: true }),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("missing pitm declines item-graph-invalid", async () => {
    await expectDecline(
      buildMinimalFile({ omitPitm: true }),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("missing iinf declines item-graph-invalid", async () => {
    await expectDecline(
      buildMinimalFile({ omitIinf: true }),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("missing iloc declines item-graph-invalid", async () => {
    await expectDecline(
      buildMinimalFile({ omitIloc: true }),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("a pitm naming an undeclared item declines item-graph-invalid", async () => {
    await expectDecline(
      buildMinimalFile({ pitmItemId: 99 }),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("an iloc entry for an undeclared item declines item-graph-invalid", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
        {
          itemId: 99, // undeclared in iinf
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ offset: 0, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  // WR-02 (code review 2026-10-01): the reverse direction of the check above -- an item declared
  // in iinf with NO corresponding iloc entry at all (distinct from an iloc entry with
  // extent_count 0, D-10a's legitimate "admitted, emptied" shape) must decline item-graph-invalid,
  // not silently default to `extents: []` and resolve to "admitted, pre-emptied" with no error.
  it("an iinf item with no corresponding iloc entry at all declines item-graph-invalid", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe1 = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infe2 = infeBox({
      version: 2,
      itemId: 2,
      itemType: "Exif",
      hidden: true,
    });
    const iinf = iinfBox(0, [infe1, infe2]); // item 2 declared, no matching iloc entry below
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
        // item 2 (Exif) is intentionally absent here.
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("an iinf item with an iloc entry whose extent_count is 0 still admits as emptied (D-10a, not WR-02)", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe1 = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infe2 = infeBox({
      version: 2,
      itemId: 2,
      itemType: "Exif",
      hidden: true,
    });
    const iinf = iinfBox(0, [infe1, infe2]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
        {
          itemId: 2,
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [], // a *present* iloc entry, extent_count 0 -- not WR-02's missing-entry shape
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const model = await parseFixtureBytes(Buffer.concat([ftyp, meta, mdat]));
    const exifItem = model.itemsById.get(2);
    expect(exifItem?.extents).toEqual([]);
  });

  it("an iref naming an undeclared item declines item-graph-invalid", async () => {
    const file = buildMinimalFile({
      extraMetaChildren: [
        irefBox(0, [{ type: "cdsc", fromItemId: 1, toItemIds: [99] }]),
      ],
    });
    await expectDecline(file, "item-graph-invalid", "malformed-file");
  });

  it("a duplicate item_ID in iinf declines item-graph-invalid", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe1 = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infe2 = infeBox({ version: 2, itemId: 1, itemType: "hvc1" }); // duplicate
    const iinf = iinfBox(0, [infe1, infe2]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("a duplicate item_ID in iloc declines item-graph-invalid", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
        {
          itemId: 1, // duplicate
          dataReferenceIndex: 0,
          baseOffset: 0,
          extents: [{ offset: 4, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "item-graph-invalid",
      "malformed-file",
    );
  });

  it("a duplicate item_ID in ipma declines item-graph-invalid", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infe = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId: 1, associations: [{ propertyIndex: 1, essential: false }] },
        { itemId: 1, associations: [{ propertyIndex: 2, essential: true }] }, // duplicate
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
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
          extents: [{ offset: 0, length: 4 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    await expectDecline(
      Buffer.concat([ftyp, meta, mdat]),
      "item-graph-invalid",
      "malformed-file",
    );
  });
});

// --- Task 3: mdat is never read during parsing (read-log proof) ---

interface ReadLogEntry {
  readonly position: number;
  readonly length: number;
}

function loggingHandle(real: FileHandle): {
  handle: FileHandle;
  log: ReadLogEntry[];
} {
  const log: ReadLogEntry[] = [];
  const handle = {
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      log.push({ position, length });
      return real.read(buffer, offset, length, position);
    },
    close: () => real.close(),
  } as unknown as FileHandle;
  return { handle, log };
}

describe("parseIsobmff never reads the mdat payload (BMF-05)", () => {
  it("a 1 GiB sparse mdat with Exif/XMP items at its start and the primary item at its end parses, reading only ftyp/meta/headers", async () => {
    const exifPayload = Buffer.alloc(32, 1);
    const xmpPayload = Buffer.alloc(32, 2);
    const primaryPayload = Buffer.alloc(16, 3);

    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infePrimary = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infeExif = infeBox({ version: 2, itemId: 2, itemType: "Exif" });
    const infeXmp = infeBox({
      version: 2,
      itemId: 3,
      itemType: "mime",
      contentType: "application/rdf+xml",
    });
    const iinf = iinfBox(0, [infePrimary, infeExif, infeXmp]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: true },
          ],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);

    // Pass 1: placeholder offsets (0) to learn iloc's encoded byte length.
    function buildIlocAt(
      exifOffset: number,
      xmpOffset: number,
      primaryOffset: number,
    ) {
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
            extents: [{ offset: primaryOffset, length: primaryPayload.length }],
          },
          {
            itemId: 2,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ offset: exifOffset, length: exifPayload.length }],
          },
          {
            itemId: 3,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ offset: xmpOffset, length: xmpPayload.length }],
          },
        ],
      });
    }
    const placeholderIloc = buildIlocAt(0, 0, 0);
    const placeholderMeta = metaBox([hdlr, pitm, iinf, iprp, placeholderIloc]);

    const mdatHeaderSize = 8;
    const mdatPayloadStart =
      ftyp.length + placeholderMeta.length + mdatHeaderSize;
    const exifOffset = mdatPayloadStart; // Exif/XMP items "at its start"
    const xmpOffset = exifOffset + exifPayload.length;
    const mdatPayloadSize = 1024 * 1024 * 1024; // 1 GiB
    const primaryOffset = mdatPayloadSize - primaryPayload.length; // primary item "at its end"

    const finalIloc = buildIlocAt(exifOffset, xmpOffset, primaryOffset);
    const finalMeta = metaBox([hdlr, pitm, iinf, iprp, finalIloc]);
    expect(finalMeta.length).toBe(placeholderMeta.length);

    const totalSize =
      ftyp.length + finalMeta.length + mdatHeaderSize + mdatPayloadSize;

    const directory = await freshDirectory();
    const path = join(directory, "sparse.heic");
    const writeHandle = await open(path, "w+");
    try {
      await writeHandle.write(ftyp, 0, ftyp.length, 0);
      await writeHandle.write(finalMeta, 0, finalMeta.length, ftyp.length);
      const mdatHeader = Buffer.alloc(8);
      mdatHeader.writeUInt32BE(8 + mdatPayloadSize, 0);
      mdatHeader.write("mdat", 4, 4, "ascii");
      await writeHandle.write(mdatHeader, 0, 8, ftyp.length + finalMeta.length);
      // Write the Exif/XMP payloads near the start of mdat and the primary payload at its end,
      // then truncate to the full 1 GiB so the rest stays a sparse hole.
      await writeHandle.write(exifPayload, 0, exifPayload.length, exifOffset);
      await writeHandle.write(xmpPayload, 0, xmpPayload.length, xmpOffset);
      await writeHandle.write(
        primaryPayload,
        0,
        primaryPayload.length,
        mdatPayloadStart + primaryOffset,
      );
      await writeHandle.truncate(totalSize);
    } finally {
      await writeHandle.close();
    }

    const metaSizeBound = ftyp.length + finalMeta.length + 4096;

    const real = await open(path, "r");
    const { handle, log } = loggingHandle(real);
    try {
      const model = await parseIsobmff(handle, totalSize);
      expect(model.items.length).toBe(3);
      expect(model.mdatRanges).toEqual([
        { offset: mdatPayloadStart, length: mdatPayloadSize },
      ]);

      let totalBytesRead = 0;
      for (const entry of log) {
        totalBytesRead += entry.length;
        const inFtypOrMeta =
          entry.position + entry.length <= ftyp.length + finalMeta.length;
        const inTopLevelHeaderWindow = entry.length <= 16;
        expect(inFtypOrMeta || inTopLevelHeaderWindow).toBe(true);
      }
      expect(totalBytesRead).toBeLessThan(metaSizeBound);
    } finally {
      await handle.close();
    }
  });
});
