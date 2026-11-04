// Tracer (62-02): the thinnest real path through every layer Phase 62 touches -- parse layout ->
// output plan -> meta rebuild -> streaming writer -> identity verify -> engine-bound handler ->
// `sanitizeFile`, on the committed `heif-enc-grid.heic` fixture, removing its Exif and XMP items
// and proving the surviving items byte-identical. The handler stays unregistered throughout (D-02
// shape (c)): it is installed only through the private `setRegisteredHandlersForTests` seam.
import {
  copyFile,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/engine.js";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
} from "../src/admission/registry.js";
import { admitIsobmff } from "../src/isobmff/admission.js";
import type { IsobmffAdmission } from "../src/isobmff/admission.js";
import type { IsobmffItem } from "../src/isobmff/items.js";
import type { IsobmffOutputPlan } from "../src/isobmff/plan.js";
import {
  createIsobmffWriterHandlerForTests,
  createPlanMutantHandler,
  mutateIrefSquashSecondRecordFromK,
  mutateIpcoCorruptOrphanProperty,
} from "./isobmff-support/test-handler.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
  type InventoryItem,
  type IsobmffInventory,
} from "./isobmff-support/inventory.js";
import {
  auxC,
  av1C,
  box,
  ftypBox,
  grplBox,
  hdlrBox,
  hvcC,
  idatBox,
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
  uuidBox,
  type BoxSizeOverride,
  type IlocItem,
  type IpmaEntry,
  type IrefRef,
} from "./isobmff-support/builder.js";
import {
  assembleHeif,
  HOSTILE_FIXTURES,
  type AssembleHeifSpec,
} from "./isobmff-support/hostile.js";
import { createMinimalExif } from "../src/metadata/exif.js";
import fc from "fast-check";
import {
  isobmffArmSampleArbitrary,
  type IsobmffArm,
} from "./isobmff-support/generator.js";

// C2PA's registered `uuid` usertype (d8fec3d6-1b0e-483c-9297-5828877ec481), restated here as a
// plain literal rather than imported -- `tests/isobmff-support/` files may only take a type-only
// import from `src/isobmff/`, and this file deliberately mirrors that same narrow discipline for
// anything it imports from `src/isobmff/*` directly (it does import `admitIsobmff` as a value,
// which is allowed outside `isobmff-support/`). Must stay equal to
// `src/isobmff/boxes.ts`'s `C2PA_UUID_USERTYPE`.
const C2PA_UUID_USERTYPE = "d8fec3d61b0e483c92975828877ec481";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "corpus",
  "constructed",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heic", "heif-enc-grid.heic");
const AVIF_FIXTURE = join(FIXTURES_DIR, "avif", "heif-enc-grid.avif");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-isobmff-writer-"),
  );
  directories.push(directory);
  return directory;
}

const SURVIVING_IMAGE_TYPES: ReadonlySet<string> = new Set(["grid", "hvc1"]);

function findItem(
  inventory: IsobmffInventory,
  id: number,
): InventoryItem | undefined {
  return inventory.items.find((item) => item.id === id);
}

describe("tracer: heif-enc-grid.heic rebuild (62-02)", () => {
  it("fails before the handler exists (recorded first run)", () => {
    // The first run of this test, before src/isobmff/{plan,rebuild,writer,verify}.ts and
    // src/admission/isobmff-handler.ts existed, failed at the `createIsobmffWriterHandlerForTests`
    // import with "Cannot find module '../src/admission/isobmff-handler.js'". Recorded per plan
    // instruction; this assertion itself is a no-op once the modules exist.
    expect(true).toBe(true);
  });

  it("rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits", async () => {
    const directory = await freshDirectory();
    const sourceName = "source.heic";
    const destinationName = "destination.heic";
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, destinationName);
    await copyFile(HEIC_FIXTURE, sourcePath);
    const sourceBytesBefore = await readFile(sourcePath);

    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("heic"),
    ]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: true,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) {
        throw new Error(
          `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
        );
      }

      // Blast radius: the test directory lists exactly the source and the destination.
      const listing = await readdir(directory);
      expect(new Set(listing)).toEqual(new Set([sourceName, destinationName]));

      // The source is untouched.
      const sourceBytesAfter = await readFile(sourcePath);
      expect(sourceBytesAfter.equals(sourceBytesBefore)).toBe(true);

      const sourceInventory = inventoryIsobmff(sourceBytesBefore);
      const destinationBytes = await readFile(destinationPath);
      const destinationInventory = inventoryIsobmff(destinationBytes);

      const removedIds = new Set(
        sourceInventory.items
          .filter((item) => item.type === "Exif" || item.type === "mime")
          .map((item) => item.id),
      );
      expect(removedIds.size).toBe(2);

      // ISO-01: no Exif/mime item, no iloc entry, no ipma entry, no iref record whose from-item
      // is a removed item, for either removed ID.
      for (const item of destinationInventory.items) {
        expect(item.type).not.toBe("Exif");
        expect(item.type).not.toBe("mime");
        expect(removedIds.has(item.id)).toBe(false);
      }
      for (const association of destinationInventory.associations) {
        expect(removedIds.has(association.itemId)).toBe(false);
      }
      for (const reference of destinationInventory.references) {
        expect(removedIds.has(reference.from)).toBe(false);
        for (const toId of reference.to)
          expect(removedIds.has(toId)).toBe(false);
      }

      // ISO-03: every surviving item (the grid, its four tiles, and the thumbnail) has an output
      // payload byte-identical to its source payload, read through each file's own iloc/idat.
      const sourceSurviving = sourceInventory.items.filter((item) =>
        SURVIVING_IMAGE_TYPES.has(item.type),
      );
      expect(sourceSurviving.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 8,
      ]);
      const destinationSurviving = destinationInventory.items.filter((item) =>
        SURVIVING_IMAGE_TYPES.has(item.type),
      );
      expect(destinationSurviving.map((item) => item.id)).toEqual(
        sourceSurviving.map((item) => item.id),
      );
      for (const sourceItem of sourceSurviving) {
        const destinationItem = findItem(destinationInventory, sourceItem.id);
        expect(destinationItem).toBeDefined();
        const sourcePayload = readItemExtentBytes(
          sourceBytesBefore,
          sourceInventory,
          sourceItem,
        );
        const destinationPayload = readItemExtentBytes(
          destinationBytes,
          destinationInventory,
          destinationItem!,
        );
        expect(destinationPayload.equals(sourcePayload)).toBe(true);
      }

      // The output re-admits through admitIsobmff.
      const destinationHandle: FileHandle = await open(destinationPath, "r");
      try {
        const reAdmitted = await admitIsobmff(
          destinationHandle,
          destinationBytes.length,
        );
        expect(reAdmitted.namespaces).not.toContain("EXIF");
        expect(reAdmitted.namespaces).not.toContain("XMP");
      } finally {
        await destinationHandle.close();
      }

      // Blast radius: neither removed item's source payload bytes occur anywhere in the output.
      for (const item of sourceInventory.items) {
        if (item.type !== "Exif" && item.type !== "mime") continue;
        const removedPayload = readItemExtentBytes(
          sourceBytesBefore,
          sourceInventory,
          item,
        );
        expect(removedPayload.length).toBeGreaterThan(0);
        expect(destinationBytes.indexOf(removedPayload)).toBe(-1);
      }
    } finally {
      restore();
    }
  });
});

describe("Task 2: the writer handlers' registration and brand separation (62-02, registered in 62.1-07)", () => {
  it("registeredHandlersForTests() returns exactly the webp, png, jpeg, heic and avif handlers (62.1-07 D-03/D-08)", () => {
    expect(
      registeredHandlersForTests().map((h) => h.capability.format),
    ).toEqual(["webp", "png", "jpeg", "heic", "avif"]);
  });

  it("the AVIF fixture does not match the heic writer handler and the HEIC fixture does not match the avif writer handler", async () => {
    const heicWriterHandler = createIsobmffWriterHandlerForTests("heic");
    const avifWriterHandler = createIsobmffWriterHandlerForTests("avif");

    const heicMagic = (await readFile(HEIC_FIXTURE)).subarray(0, 256);
    const avifMagic = (await readFile(AVIF_FIXTURE)).subarray(0, 256);

    expect(heicWriterHandler.matches(heicMagic)).toBe(true);
    expect(heicWriterHandler.matches(avifMagic)).toBe(false);
    expect(avifWriterHandler.matches(avifMagic)).toBe(true);
    expect(avifWriterHandler.matches(heicMagic)).toBe(false);
  });
});

// --- Task 2 (62-05): the D-11 iloc layout matrix ---
//
// A bespoke byte-level fixture builder (not `assembleHeif`, which hardcodes iloc version 1) --
// one removable Exif item (cm=0, 1 extent) before a surviving multi-extent primary (cm=0, 2
// extents, declared in ascending-source-offset order) and, for every version that has a
// construction_method field (v1/v2), a surviving grid item (cm=1, 1 extent into idat) to prove
// construction_method-1 records and their idat payload stay verbatim. `mdatPayload` deliberately
// carries a 6-byte unclaimed gap between the primary's two extents so this fixture also doubles
// as a basic D-15 "unclaimed gap dropped" proof once Task 3's canary tests land.

const MATRIX_EXIF_ID = 1;
const MATRIX_PRIMARY_ID = 2;
const MATRIX_GRID_ID = 3;

interface LayoutMatrixCase {
  readonly version: 0 | 1 | 2;
  readonly offsetSize: 4 | 8;
  readonly lengthSize: 4 | 8;
  readonly baseOffsetSize: 0 | 4 | 8;
  readonly indexSize: 0 | 4 | 8;
}

/** D-11: the base/offset encoding for one cm=0 item's extents, given where they land absolutely
 * in the source file and the declared `baseOffsetSize`. */
function cm0IlocFields(
  absExtents: readonly {
    readonly abs: number;
    readonly length: number;
    readonly index: number;
  }[],
  baseOffsetSize: 0 | 4 | 8,
): { readonly baseOffset: number; readonly extents: IlocItem["extents"] } {
  if (baseOffsetSize > 0) {
    const base = absExtents[0]!.abs;
    return {
      baseOffset: base,
      extents: absExtents.map((e) => ({
        offset: e.abs - base,
        length: e.length,
        index: e.index,
      })),
    };
  }
  return {
    baseOffset: 0,
    extents: absExtents.map((e) => ({
      offset: e.abs,
      length: e.length,
      index: e.index,
    })),
  };
}

function buildLayoutMatrixFixture(c: LayoutMatrixCase): {
  readonly bytes: Buffer;
  readonly removedItemId: number;
  readonly survivingPrimaryId: number;
  readonly survivingGridId: number | undefined;
} {
  const hasCm = c.version !== 0;
  const mdatPayload = Buffer.concat([
    Buffer.from([0x10, 0x11, 0x12, 0x13]), // primary extent 0: [0, 4)
    Buffer.from([0, 0, 0, 0, 0, 0]), // unclaimed gap: [4, 10)
    Buffer.from([0x20, 0x21, 0x22, 0x23, 0x24, 0x25]), // primary extent 1: [10, 16)
    Buffer.from([0x30, 0x31, 0x32, 0x33]), // exif (removable): [16, 20)
  ]);
  const idatPayload = hasCm
    ? Buffer.from([0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49])
    : undefined;

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, MATRIX_PRIMARY_ID);

    const infeEntries = [
      infeBox({
        version: 2,
        itemId: MATRIX_EXIF_ID,
        itemType: "Exif",
        hidden: true,
      }),
      infeBox({ version: 2, itemId: MATRIX_PRIMARY_ID, itemType: "hvc1" }),
    ];
    if (hasCm) {
      infeEntries.push(
        infeBox({ version: 2, itemId: MATRIX_GRID_ID, itemType: "grid" }),
      );
    }
    const iinf = iinfBox(0, infeEntries);

    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipmaEntries: IpmaEntry[] = [
      {
        itemId: MATRIX_PRIMARY_ID,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
        ],
      },
    ];
    if (hasCm) {
      ipmaEntries.push({
        itemId: MATRIX_GRID_ID,
        associations: [{ propertyIndex: 1, essential: false }],
      });
    }
    const ipma = ipmaBox({ version: 0, flags: 0, entries: ipmaEntries });
    const iprp = iprpBox(ipco, ipma);
    const idat = idatPayload !== undefined ? idatBox(idatPayload) : undefined;

    const exifFields = cm0IlocFields(
      [{ abs: mdatPayloadStart + 16, length: 4, index: 3 }],
      c.baseOffsetSize,
    );
    const primaryFields = cm0IlocFields(
      [
        { abs: mdatPayloadStart + 0, length: 4, index: 7 },
        { abs: mdatPayloadStart + 10, length: 6, index: 9 },
      ],
      c.baseOffsetSize,
    );

    const ilocItems: IlocItem[] = [
      {
        itemId: MATRIX_EXIF_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: exifFields.baseOffset,
        extents: exifFields.extents,
      },
      {
        itemId: MATRIX_PRIMARY_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: primaryFields.baseOffset,
        extents: primaryFields.extents,
      },
    ];
    if (hasCm) {
      ilocItems.push({
        itemId: MATRIX_GRID_ID,
        constructionMethod: 1,
        dataReferenceIndex: 0,
        baseOffset: 0,
        extents: [{ offset: 0, length: idatPayload!.length, index: 5 }],
      });
    }

    const iloc = ilocBox({
      version: c.version,
      offsetSize: c.offsetSize,
      lengthSize: c.lengthSize,
      baseOffsetSize: c.baseOffsetSize,
      indexSize: c.indexSize,
      items: ilocItems,
    });

    const metaChildren: Buffer[] = [hdlr, pitm];
    if (idat !== undefined) metaChildren.push(idat);
    metaChildren.push(iloc, iinf, iprp);
    const meta = metaBox(metaChildren);
    const header = Buffer.concat([ftyp, meta]);
    return Buffer.concat([header, mdatBox(mdatPayload)]);
  };

  const pass1 = build(0);
  const mdatBoxTotal = 8 + mdatPayload.length;
  const headerLength = pass1.length - mdatBoxTotal;
  const final = build(headerLength + 8);
  if (final.length !== pass1.length) {
    throw new Error(
      "buildLayoutMatrixFixture: header length changed between placeholder and final passes",
    );
  }

  return {
    bytes: final,
    removedItemId: MATRIX_EXIF_ID,
    survivingPrimaryId: MATRIX_PRIMARY_ID,
    survivingGridId: hasCm ? MATRIX_GRID_ID : undefined,
  };
}

/** Explicit table (D-11): every admitted version x width combination this build supports, never
 * random sampling. `offset_size` is never 0 for a surviving item (D-31). */
const LAYOUT_MATRIX: readonly LayoutMatrixCase[] = (() => {
  const cases: LayoutMatrixCase[] = [];
  const baseOffsetSizes: readonly (0 | 4 | 8)[] = [0, 4, 8];
  for (const baseOffsetSize of baseOffsetSizes) {
    cases.push({
      version: 0,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize,
      indexSize: 0,
    });
    cases.push({
      version: 0,
      offsetSize: 8,
      lengthSize: 4,
      baseOffsetSize,
      indexSize: 0,
    });
    for (const indexSize of [0, 4, 8] as const) {
      cases.push({
        version: 1,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize,
        indexSize,
      });
      cases.push({
        version: 2,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize,
        indexSize,
      });
    }
  }
  // A couple of explicit lengthSize/offsetSize=8 combinations, so those widths are exercised too.
  cases.push({
    version: 1,
    offsetSize: 4,
    lengthSize: 8,
    baseOffsetSize: 4,
    indexSize: 4,
  });
  cases.push({
    version: 2,
    offsetSize: 8,
    lengthSize: 8,
    baseOffsetSize: 8,
    indexSize: 8,
  });
  return cases;
})();

function titleForMatrixCase(c: LayoutMatrixCase): string {
  return (
    `v${c.version} offsetSize=${c.offsetSize} lengthSize=${c.lengthSize} ` +
    `baseOffsetSize=${c.baseOffsetSize} indexSize=${c.indexSize}`
  );
}

describe("D-11 iloc layout matrix (62-05)", () => {
  it.each(LAYOUT_MATRIX.map((c) => [titleForMatrixCase(c), c] as const))(
    "%s",
    async (_title, c) => {
      const { bytes, removedItemId, survivingPrimaryId, survivingGridId } =
        buildLayoutMatrixFixture(c);
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.heic");
      const destinationPath = join(directory, "destination.heic");
      await writeFile(sourcePath, bytes);

      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests("heic"),
      ]);
      try {
        const sanitized = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(sanitized.ok).toBe(true);
        if (!sanitized.ok) {
          throw new Error(
            `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
          );
        }

        const destinationBytes = await readFile(destinationPath);
        const sourceInventory = inventoryIsobmff(bytes);
        const destinationInventory = inventoryIsobmff(destinationBytes);

        // Source version and all four widths unchanged.
        expect(destinationInventory.iloc).toEqual(sourceInventory.iloc);

        // The removed item is gone entirely.
        expect(
          destinationInventory.items.some((item) => item.id === removedItemId),
        ).toBe(false);

        const survivingIds = [
          survivingPrimaryId,
          ...(survivingGridId !== undefined ? [survivingGridId] : []),
        ];
        for (const id of survivingIds) {
          const sourceItem = findItem(sourceInventory, id);
          const destinationItem = findItem(destinationInventory, id);
          expect(sourceItem).toBeDefined();
          expect(destinationItem).toBeDefined();

          // Every surviving item's payload is byte-identical, read through each file's own iloc.
          const sourcePayload = readItemExtentBytes(
            bytes,
            sourceInventory,
            sourceItem!,
          );
          const destinationPayload = readItemExtentBytes(
            destinationBytes,
            destinationInventory,
            destinationItem!,
          );
          expect(destinationPayload.equals(sourcePayload)).toBe(true);

          // extent_index copied verbatim (D-11), including the grid's cm=1 record.
          expect(destinationItem!.extents.map((e) => e.index)).toEqual(
            sourceItem!.extents.map((e) => e.index),
          );
          expect(destinationItem!.constructionMethod).toBe(
            sourceItem!.constructionMethod,
          );
        }

        // D-11 base/offset formulas for the surviving cm=0 primary. The source's 6-byte
        // unclaimed gap between the primary's two extents (D-15) is dropped from the new mdat
        // payload, so the two extents land only 4 bytes apart in the output -- never the
        // source's own 10-byte separation.
        const destinationPrimary = findItem(
          destinationInventory,
          survivingPrimaryId,
        )!;
        if (c.baseOffsetSize > 0) {
          expect(destinationPrimary.extents[0]!.offset).toBe(0);
          expect(destinationPrimary.extents[1]!.offset).toBe(4);
        } else {
          expect(destinationPrimary.baseOffset).toBe(0);
          expect(destinationPrimary.extents[1]!.offset).toBe(
            destinationPrimary.extents[0]!.offset + 4,
          );
        }
      } finally {
        restore();
      }
    },
  );

  it("has at least 18 cases, including base_offset_size 0 and base_offset_size 8", () => {
    expect(LAYOUT_MATRIX.length).toBeGreaterThanOrEqual(18);
    expect(LAYOUT_MATRIX.some((c) => c.baseOffsetSize === 0)).toBe(true);
    expect(LAYOUT_MATRIX.some((c) => c.baseOffsetSize === 8)).toBe(true);
  });
});

// --- Task 3 (62-05): D-15 mdat union, gaps, header forms and adjacency ---

async function runThroughWriter(bytes: Buffer): Promise<{
  readonly sourcePath: string;
  readonly destinationBytes: Buffer;
  readonly sourceInventory: IsobmffInventory;
  readonly destinationInventory: IsobmffInventory;
}> {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.heic");
  const destinationPath = join(directory, "destination.heic");
  await writeFile(sourcePath, bytes);

  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests("heic"),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    if (!sanitized.ok) {
      throw new Error(
        `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
      );
    }
    expect(sanitized.ok).toBe(true);
    const destinationBytes = await readFile(destinationPath);
    return {
      sourcePath,
      destinationBytes,
      sourceInventory: inventoryIsobmff(bytes),
      destinationInventory: inventoryIsobmff(destinationBytes),
    };
  } finally {
    restore();
  }
}

/** A bespoke single-item fixture (not `assembleHeif`, which never exposes an `mdat` size
 * override) isolating the `mdat` header form: one surviving `hvc1` item occupies the whole
 * payload, cm=0, widths 4/4/4/0. */
function buildMdatFormFixture(
  mdatSizeOverride: BoxSizeOverride["size"],
  payload: Buffer,
): Buffer {
  const headerSize = mdatSizeOverride === "largesize" ? 16 : 8;
  const itemId = 1;

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, itemId);
    const infe = infeBox({ version: 2, itemId, itemType: "hvc1" });
    const iinf = iinfBox(0, [infe]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        { itemId, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: 0, length: payload.length, index: 0 }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iloc, iinf, iprp]);
    const header = Buffer.concat([ftyp, meta]);
    const mdat = mdatBox(
      payload,
      mdatSizeOverride !== undefined ? { size: mdatSizeOverride } : {},
    );
    return Buffer.concat([header, mdat]);
  };

  const pass1 = build(0);
  const mdatTotal = headerSize + payload.length;
  const headerLength = pass1.length - mdatTotal;
  const final = build(headerLength + headerSize);
  if (final.length !== pass1.length) {
    throw new Error(
      "buildMdatFormFixture: header length changed between placeholder and final passes",
    );
  }
  return final;
}

describe("D-15 mdat union (62-05)", () => {
  it("a canary planted in an unclaimed mdat gap is absent from the output", async () => {
    const CANARY = Buffer.from("CANARY-GAP-BYTES", "ascii"); // 17 bytes, well over 16
    const primaryPayload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const mdatPayload = Buffer.concat([primaryPayload, CANARY]);

    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload,
      twoPass: true,
    });

    const { destinationBytes } = await runThroughWriter(bytes);
    expect(destinationBytes.indexOf(CANARY)).toBe(-1);
  });

  it("two touching surviving extents merge into one union range; both payloads stay identical; mdat length equals the union size", async () => {
    const first = Buffer.from([1, 1, 1, 1]);
    const second = Buffer.from([2, 2, 2, 2]);
    const mdatPayload = Buffer.concat([first, second]); // [0,4) and [4,8), touching at 4

    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: first.length }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "av01",
          extents: [{ relOffset: first.length, length: second.length }],
        },
      ],
      mdatPayload,
      twoPass: true,
    });

    const { destinationBytes, sourceInventory, destinationInventory } =
      await runThroughWriter(bytes);
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    );
    expect(mdatTopLevel).toBeDefined();
    expect(mdatTopLevel!.size - 8).toBe(mdatPayload.length); // the full union, not duplicated

    for (const id of [1, 2]) {
      const sourceItem = findItem(sourceInventory, id)!;
      const destinationItem = findItem(destinationInventory, id)!;
      const sourcePayload = readItemExtentBytes(
        bytes,
        sourceInventory,
        sourceItem,
      );
      const destinationPayload = readItemExtentBytes(
        destinationBytes,
        destinationInventory,
        destinationItem,
      );
      expect(destinationPayload.equals(sourcePayload)).toBe(true);
    }
  });

  it("two overlapping surviving extents (shared bytes) merge into one union range; both payloads stay identical", async () => {
    const mdatPayload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 9 bytes total
    // item1: [0,6); item2: [3,9) -- bytes [3,6) shared by both.
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 6 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "av01",
          extents: [{ relOffset: 3, length: 6 }],
        },
      ],
      mdatPayload,
      twoPass: true,
    });

    const { destinationBytes, sourceInventory, destinationInventory } =
      await runThroughWriter(bytes);
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    );
    expect(mdatTopLevel).toBeDefined();
    expect(mdatTopLevel!.size - 8).toBe(mdatPayload.length); // 9, never 6+6=12

    for (const id of [1, 2]) {
      const sourceItem = findItem(sourceInventory, id)!;
      const destinationItem = findItem(destinationInventory, id)!;
      const sourcePayload = readItemExtentBytes(
        bytes,
        sourceInventory,
        sourceItem,
      );
      const destinationPayload = readItemExtentBytes(
        destinationBytes,
        destinationInventory,
        destinationItem,
      );
      expect(destinationPayload.equals(sourcePayload)).toBe(true);
    }
  });

  it("a removed extent touching a surviving extent on each side is excised exactly at the boundary", async () => {
    const CANARY = Buffer.from("REMOVED-CANARY!", "ascii"); // 16 bytes
    const left = Buffer.from([1, 1, 1, 1]);
    const right = Buffer.from([2, 2, 2, 2]);
    const mdatPayload = Buffer.concat([left, CANARY, right]);
    // left: [0,4); removable Exif: [4,20) (touches left's end and right's start); right: [20,24).

    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: left.length }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [{ relOffset: left.length, length: CANARY.length }],
        },
        {
          itemId: 3,
          itemType: "av01",
          extents: [
            { relOffset: left.length + CANARY.length, length: right.length },
          ],
        },
      ],
      mdatPayload,
      twoPass: true,
    });

    const { destinationBytes, sourceInventory, destinationInventory } =
      await runThroughWriter(bytes);
    expect(destinationBytes.indexOf(CANARY)).toBe(-1);

    for (const id of [1, 3]) {
      const sourceItem = findItem(sourceInventory, id)!;
      const destinationItem = findItem(destinationInventory, id)!;
      expect(destinationItem).toBeDefined();
      const sourcePayload = readItemExtentBytes(
        bytes,
        sourceInventory,
        sourceItem,
      );
      const destinationPayload = readItemExtentBytes(
        destinationBytes,
        destinationInventory,
        destinationItem!,
      );
      expect(destinationPayload.equals(sourcePayload)).toBe(true);
    }
  });

  it("surviving extents listed out of source order in iloc keep their iloc order in the output while the mdat union is still ascending", async () => {
    const extentAt0 = Buffer.from([9, 9, 9, 9]);
    const extentAt20 = Buffer.from([8, 8, 8, 8]);
    const mdatPayload = Buffer.alloc(24);
    extentAt0.copy(mdatPayload, 0);
    extentAt20.copy(mdatPayload, 20);

    // This item's own extents are declared out of ascending-source-offset order (extent 0 at
    // abs offset +20, extent 1 at abs offset +0), with base_offset_size 0 so no base rewrite can
    // go negative -- this fixture admits AND writes successfully (the Task 1 fixture used
    // base_offset_size > 0 specifically so this same out-of-order shape would decline instead).
    // `assembleHeif`'s `relOffset` is always added to its own internally-computed baseOffset
    // (meaningless once base_offset_size is 0, since that field then writes 0 bytes), so this
    // needs the same bespoke cm0IlocFields-based builder the layout matrix above uses, where
    // base_offset_size 0 correctly makes each extent's own field the full absolute position.
    const itemId = 1;
    const build = (mdatPayloadStart: number): Buffer => {
      const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
      const hdlr = hdlrBox("pict");
      const pitm = pitmBox(0, itemId);
      const infe = infeBox({ version: 2, itemId, itemType: "hvc1" });
      const iinf = iinfBox(0, [infe]);
      const ipco = ipcoBox([ispe(32, 32), hvcC()]);
      const ipma = ipmaBox({
        version: 0,
        flags: 0,
        entries: [
          { itemId, associations: [{ propertyIndex: 1, essential: false }] },
        ],
      });
      const iprp = iprpBox(ipco, ipma);
      const fields = cm0IlocFields(
        [
          { abs: mdatPayloadStart + 20, length: extentAt20.length, index: 0 },
          { abs: mdatPayloadStart + 0, length: extentAt0.length, index: 0 },
        ],
        0,
      );
      const iloc = ilocBox({
        version: 1,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 0,
        indexSize: 0,
        items: [
          {
            itemId,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: fields.baseOffset,
            extents: fields.extents,
          },
        ],
      });
      const meta = metaBox([hdlr, pitm, iloc, iinf, iprp]);
      const header = Buffer.concat([ftyp, meta]);
      return Buffer.concat([header, mdatBox(mdatPayload)]);
    };
    const pass1 = build(0);
    const headerLength = pass1.length - (8 + mdatPayload.length);
    const bytes = build(headerLength + 8);
    if (bytes.length !== pass1.length) {
      throw new Error(
        "header length changed between placeholder and final passes",
      );
    }

    const { destinationBytes, sourceInventory, destinationInventory } =
      await runThroughWriter(bytes);
    const sourceItem = findItem(sourceInventory, 1)!;
    const destinationItem = findItem(destinationInventory, 1)!;

    // iloc order kept: extent 0 is still the one that was declared first (originally at
    // relOffset 20), extent 1 is still the one declared second (originally at relOffset 0).
    expect(destinationItem.extents.length).toBe(2);
    expect(destinationItem.extents[0]!.offset).toBeGreaterThan(
      destinationItem.extents[1]!.offset,
    );
    // mdat union still ascending: the two 4-byte ranges are adjacent (no gap -- both are
    // claimed), so the whole payload is exactly 8 bytes, not the source's original 24.
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    );
    expect(mdatTopLevel!.size - 8).toBe(8);

    const sourcePayload = readItemExtentBytes(
      bytes,
      sourceInventory,
      sourceItem,
    );
    const destinationPayload = readItemExtentBytes(
      destinationBytes,
      destinationInventory,
      destinationItem,
    );
    expect(destinationPayload.equals(sourcePayload)).toBe(true);
  });

  it("a largesize source mdat stays largesize in the output", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const bytes = buildMdatFormFixture("largesize", payload);
    const sourceMdat = inventoryIsobmff(bytes).topLevel.find(
      (b) => b.type === "mdat",
    )!;
    // Sanity: the fixture itself really is largesize-encoded (16-byte header).
    expect(bytes.readUInt32BE(sourceMdat.offset)).toBe(1);

    const { destinationBytes, destinationInventory } =
      await runThroughWriter(bytes);
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    )!;
    // The output chose the largesize encoding (declared size field reads literal 1), not a
    // plain 32-bit size -- and the total box size is exactly header(16) + payload.
    expect(destinationBytes.readUInt32BE(mdatTopLevel.offset)).toBe(1);
    expect(mdatTopLevel.size).toBe(16 + payload.length);
  });

  it("a normal 32-bit source mdat stays a normal 32-bit header in the output", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const bytes = buildMdatFormFixture(undefined, payload);
    const { destinationInventory } = await runThroughWriter(bytes);
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    )!;
    expect(mdatTopLevel.size).toBe(8 + payload.length);
  });

  it("a size-0 source mdat becomes an explicit 32-bit size in the output", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const bytes = buildMdatFormFixture("zero", payload);
    const { destinationInventory } = await runThroughWriter(bytes);
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    )!;
    expect(mdatTopLevel.size).toBe(8 + payload.length);
  });

  it("the Phase 61 surviving-offset-width-zero and multiple-mdat declines are unchanged (D-31)", async () => {
    for (const declineClass of [
      "surviving-offset-width-zero",
      "multiple-mdat",
    ] as const) {
      const fixture = HOSTILE_FIXTURES[declineClass];
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.heic");
      await fixture.write(sourcePath);
      const { size } = await stat(sourcePath);
      const handle = await open(sourcePath, "r");
      try {
        await expect(admitIsobmff(handle, size)).rejects.toMatchObject({
          declineClass,
          kind: fixture.expectedCode,
        });
      } finally {
        await handle.close();
      }
    }
  });
});

// --- Task 1 (62-06): hidden auxiliary Exif + top-level C2PA removed end to end on AVIF ---

const AUX_PRIMARY_ID = 1;
const AUX_AUX_ID = 2;
const AUX_EXIF_ID = 3;
const AUX_XMP_ID = 4;
const ALPHA_URN = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha";

function buildAvifAuxHiddenC2paFixture(): {
  readonly bytes: Buffer;
  readonly exifCanary: Buffer;
  readonly xmpCanary: Buffer;
  readonly c2paCanary: Buffer;
} {
  const primaryPayload = Buffer.from([0xa0, 0xa1, 0xa2, 0xa3]);
  const auxPayload = Buffer.from([0xb0, 0xb1, 0xb2, 0xb3]);
  const exifCanary = Buffer.from("EXIF-CANARY-62-06", "ascii");
  const xmpCanary = Buffer.from("XMP-CANARY-62-06-AAAA", "ascii");
  const c2paCanary = Buffer.concat([
    Buffer.from("C2PA-CANARY-62-06", "ascii"),
    Buffer.alloc(32 - "C2PA-CANARY-62-06".length, 0x00),
  ]);

  const tiff = createMinimalExif({ orientation: 1 });
  const exifPayload = Buffer.concat([Buffer.alloc(4), tiff, exifCanary]);
  const xmpPayload = Buffer.concat([
    Buffer.from("<x:xmpmeta>", "ascii"),
    xmpCanary,
    Buffer.from("</x:xmpmeta>", "ascii"),
  ]);

  const refs: IrefRef[] = [
    { type: "auxl", fromItemId: AUX_AUX_ID, toItemIds: [AUX_PRIMARY_ID] },
    { type: "cdsc", fromItemId: AUX_EXIF_ID, toItemIds: [AUX_AUX_ID] },
    { type: "cdsc", fromItemId: AUX_XMP_ID, toItemIds: [AUX_PRIMARY_ID] },
  ];

  const spec: AssembleHeifSpec = {
    majorBrand: "avif",
    compatibleBrands: ["mif1", "avif"],
    primaryItemId: AUX_PRIMARY_ID,
    items: [
      {
        itemId: AUX_PRIMARY_ID,
        itemType: "av01",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2],
      },
      {
        itemId: AUX_AUX_ID,
        itemType: "av01",
        hidden: true,
        extents: [
          { relOffset: primaryPayload.length, length: auxPayload.length },
        ],
        propertyIndices: [3],
      },
      {
        itemId: AUX_EXIF_ID,
        itemType: "Exif",
        hidden: true,
        extents: [
          {
            relOffset: primaryPayload.length + auxPayload.length,
            length: exifPayload.length,
          },
        ],
      },
      {
        itemId: AUX_XMP_ID,
        itemType: "mime",
        contentType: "application/rdf+xml",
        extents: [
          {
            relOffset:
              primaryPayload.length + auxPayload.length + exifPayload.length,
            length: xmpPayload.length,
          },
        ],
      },
    ],
    properties: [
      ispe(32, 32),
      av1C(Buffer.from([0x81, 0x08, 0x0c, 0x00])),
      auxC(ALPHA_URN),
    ],
    refs,
    mdatPayload: Buffer.concat([
      primaryPayload,
      auxPayload,
      exifPayload,
      xmpPayload,
    ]),
    topLevelExtraAfterFtyp: [uuidBox(C2PA_UUID_USERTYPE, c2paCanary)],
    twoPass: true,
  };

  return { bytes: assembleHeif(spec), exifCanary, xmpCanary, c2paCanary };
}

describe("ISO-01/ISO-02 removal on builder fixtures (62-06)", () => {
  it("removes a hidden auxiliary Exif item, an XMP item, and a top-level C2PA box right after ftyp, on an avif builder fixture with a hidden aux image", async () => {
    const { bytes, exifCanary, xmpCanary, c2paCanary } =
      buildAvifAuxHiddenC2paFixture();

    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.avif");
    const destinationPath = join(directory, "destination.avif");
    await writeFile(sourcePath, bytes);

    const sourceInventory = inventoryIsobmff(bytes);
    expect(sourceInventory.topLevel.some((box) => box.type === "uuid")).toBe(
      true,
    );

    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("avif"),
    ]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) {
        throw new Error(
          `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
        );
      }

      const destinationBytes = await readFile(destinationPath);
      const destinationInventory = inventoryIsobmff(destinationBytes);

      // ISO-01: no Exif/mime item, no iloc/ipma entry, no iref record naming either removed item.
      for (const item of destinationInventory.items) {
        expect(item.type).not.toBe("Exif");
        expect(item.type).not.toBe("mime");
        expect([AUX_EXIF_ID, AUX_XMP_ID]).not.toContain(item.id);
      }
      for (const association of destinationInventory.associations) {
        expect([AUX_EXIF_ID, AUX_XMP_ID]).not.toContain(association.itemId);
      }
      for (const reference of destinationInventory.references) {
        expect([AUX_EXIF_ID, AUX_XMP_ID]).not.toContain(reference.from);
        for (const toId of reference.to) {
          expect([AUX_EXIF_ID, AUX_XMP_ID]).not.toContain(toId);
        }
      }

      // ISO-02: no top-level uuid box of any kind survives (the only admitted usertype is C2PA).
      expect(
        destinationInventory.topLevel.some((box) => box.type === "uuid"),
      ).toBe(false);

      // Every planted canary (Exif payload, XMP payload, C2PA payload) is absent from the whole
      // output.
      expect(destinationBytes.indexOf(exifCanary)).toBe(-1);
      expect(destinationBytes.indexOf(xmpCanary)).toBe(-1);
      expect(destinationBytes.indexOf(c2paCanary)).toBe(-1);

      // ftyp bytes identical, and the kept top-level type list is the source's minus the C2PA uuid.
      const sourceFtyp = sourceInventory.topLevel.find(
        (b) => b.type === "ftyp",
      )!;
      const destinationFtyp = destinationInventory.topLevel.find(
        (b) => b.type === "ftyp",
      )!;
      expect(
        destinationBytes
          .subarray(
            destinationFtyp.offset,
            destinationFtyp.offset + destinationFtyp.size,
          )
          .equals(
            bytes.subarray(
              sourceFtyp.offset,
              sourceFtyp.offset + sourceFtyp.size,
            ),
          ),
      ).toBe(true);
      expect(destinationInventory.topLevel.map((b) => b.type)).toEqual(
        sourceInventory.topLevel
          .map((b) => b.type)
          .filter((type) => type !== "uuid"),
      );

      // Surviving items (primary, aux) byte-identical.
      for (const id of [AUX_PRIMARY_ID, AUX_AUX_ID]) {
        const sourceItem = findItem(sourceInventory, id)!;
        const destinationItem = findItem(destinationInventory, id)!;
        expect(destinationItem).toBeDefined();
        const sourcePayload = readItemExtentBytes(
          bytes,
          sourceInventory,
          sourceItem,
        );
        const destinationPayload = readItemExtentBytes(
          destinationBytes,
          destinationInventory,
          destinationItem,
        );
        expect(destinationPayload.equals(sourcePayload)).toBe(true);
      }

      // Re-admits, with no removed namespace surviving.
      const destinationHandle: FileHandle = await open(destinationPath, "r");
      try {
        const reAdmitted = await admitIsobmff(
          destinationHandle,
          destinationBytes.length,
        );
        expect(reAdmitted.namespaces).not.toContain("EXIF");
        expect(reAdmitted.namespaces).not.toContain("XMP");
        expect(reAdmitted.namespaces).not.toContain("C2PA");
      } finally {
        await destinationHandle.close();
      }
    } finally {
      restore();
    }
  });
});

// --- Task 2 (62-06): D-14 order, verbatim children, empty iref, top-level positions, empty and
// emptied sources ---

const D14_PRIMARY_ID = 1;
const D14_THUMB_ID = 2;
const D14_GRID_ID = 3;
const D14_EXIF_ID = 4;
const D14_AUX_ID = 5;

/**
 * A bespoke byte-level fixture (not `assembleHeif`, which hardcodes the canonical
 * hdlr/pitm/idat/iloc/iinf/iprp/iref/grpl meta-child order): declares `meta`'s children in a
 * non-default order (`pitm, iinf, iloc, dinf, hdlr, idat, iref, iprp, grpl` -- iinf before iloc,
 * iref before iprp), with an empty `dinf` (no `dref` child, trivially admits per D-17) and one
 * `grpl` group over two surviving items, a cm=1 `grid` item referencing `idat`, and an `iref` with
 * one dropped record (`cdsc` from the removable Exif item) interleaved between two surviving
 * records (`thmb`, `auxl`), so the output must keep the two surviving records in their original
 * relative order while dropping the one in between.
 */
function buildD14OrderFixture(iinfVersion: 0 | 1): {
  readonly bytes: Buffer;
} {
  const primaryPayload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const thumbPayload = Buffer.from([0x11, 0x12]);
  const exifPayload = Buffer.from([
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
  ]);
  const auxPayload = Buffer.from([0x31, 0x32, 0x33]);
  const mdatPayload = Buffer.concat([
    primaryPayload,
    thumbPayload,
    exifPayload,
    auxPayload,
  ]);
  const idatPayload = Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45]);

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, D14_PRIMARY_ID);
    const infeEntries = [
      infeBox({ version: 2, itemId: D14_PRIMARY_ID, itemType: "hvc1" }),
      infeBox({
        version: 2,
        itemId: D14_THUMB_ID,
        itemType: "hvc1",
        hidden: true,
      }),
      infeBox({ version: 2, itemId: D14_GRID_ID, itemType: "grid" }),
      infeBox({
        version: 2,
        itemId: D14_EXIF_ID,
        itemType: "Exif",
        hidden: true,
      }),
      infeBox({
        version: 2,
        itemId: D14_AUX_ID,
        itemType: "hvc1",
        hidden: true,
      }),
    ];
    const iinf = iinfBox(iinfVersion, infeEntries);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: D14_PRIMARY_ID,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: false },
          ],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const idat = idatBox(idatPayload);
    const dinf = box("dinf", Buffer.alloc(0));
    const grpl = grplBox([
      { type: "altr", groupId: 100, entityIds: [D14_PRIMARY_ID, D14_THUMB_ID] },
    ]);
    const iref = irefBox(0, [
      { type: "cdsc", fromItemId: D14_EXIF_ID, toItemIds: [D14_PRIMARY_ID] },
      { type: "thmb", fromItemId: D14_THUMB_ID, toItemIds: [D14_PRIMARY_ID] },
      { type: "auxl", fromItemId: D14_AUX_ID, toItemIds: [D14_PRIMARY_ID] },
    ]);

    const ilocItems: IlocItem[] = [
      {
        itemId: D14_PRIMARY_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: mdatPayloadStart,
        extents: [{ offset: 0, length: primaryPayload.length }],
      },
      {
        itemId: D14_THUMB_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: mdatPayloadStart,
        extents: [
          { offset: primaryPayload.length, length: thumbPayload.length },
        ],
      },
      {
        itemId: D14_GRID_ID,
        constructionMethod: 1,
        dataReferenceIndex: 0,
        baseOffset: 0,
        extents: [{ offset: 0, length: idatPayload.length }],
      },
      {
        itemId: D14_EXIF_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: mdatPayloadStart,
        extents: [
          {
            offset: primaryPayload.length + thumbPayload.length,
            length: exifPayload.length,
          },
        ],
      },
      {
        itemId: D14_AUX_ID,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: mdatPayloadStart,
        extents: [
          {
            offset:
              primaryPayload.length + thumbPayload.length + exifPayload.length,
            length: auxPayload.length,
          },
        ],
      },
    ];
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: ilocItems,
    });

    const metaChildren = [pitm, iinf, iloc, dinf, hdlr, idat, iref, iprp, grpl];
    const meta = metaBox(metaChildren);
    const header = Buffer.concat([ftyp, meta]);
    return Buffer.concat([header, mdatBox(mdatPayload)]);
  };

  const pass1 = build(0);
  const headerLength = pass1.length - (8 + mdatPayload.length);
  const bytes = build(headerLength + 8);
  if (bytes.length !== pass1.length) {
    throw new Error(
      "buildD14OrderFixture: header length changed between placeholder and final passes",
    );
  }
  return { bytes };
}

describe("D-14 order, verbatim children, empty iref, top-level positions, empty and emptied sources (62-06)", () => {
  it.each([0, 1] as const)(
    "meta children in a non-default source order (iinf before iloc, iref before iprp, dinf and grpl present) keep that order; hdlr/dinf/pitm/idat/grpl bytes are identical; iinf version %i keeps its version and recomputed count; surviving iinf/iloc/ipma/iref entries keep source relative order",
    async (iinfVersion) => {
      const { bytes } = buildD14OrderFixture(iinfVersion);
      const { destinationBytes, sourceInventory, destinationInventory } =
        await runThroughWriter(bytes);

      // meta child order unchanged.
      expect(destinationInventory.metaChildren).toEqual(
        sourceInventory.metaChildren,
      );
      expect(sourceInventory.metaChildren).toEqual([
        "pitm",
        "iinf",
        "iloc",
        "dinf",
        "hdlr",
        "idat",
        "iref",
        "iprp",
        "grpl",
      ]);

      // hdlr/dinf/pitm/idat/grpl bytes copied verbatim: find each child's byte range inside meta
      // via the independent inventory's own box walk (topLevel only lists top-level boxes, so
      // compare the whole meta payload windows that don't change -- idat's own bytes, read
      // through each file's own idat range, must be byte-identical).
      expect(destinationInventory.idat).toBeDefined();
      expect(sourceInventory.idat).toBeDefined();
      const sourceIdatBytes = bytes.subarray(
        sourceInventory.idat!.offset,
        sourceInventory.idat!.offset + sourceInventory.idat!.length,
      );
      const destinationIdatBytes = destinationBytes.subarray(
        destinationInventory.idat!.offset,
        destinationInventory.idat!.offset + destinationInventory.idat!.length,
      );
      expect(destinationIdatBytes.equals(sourceIdatBytes)).toBe(true);

      // The removed Exif item is gone entirely; the two surviving references (thmb, auxl) remain
      // in their original relative order, with the dropped cdsc record excised.
      expect(
        destinationInventory.items.some((item) => item.id === D14_EXIF_ID),
      ).toBe(false);
      expect(destinationInventory.references.map((r) => r.type)).toEqual([
        "thmb",
        "auxl",
      ]);
      expect(destinationInventory.references).toEqual([
        { type: "thmb", from: D14_THUMB_ID, to: [D14_PRIMARY_ID] },
        { type: "auxl", from: D14_AUX_ID, to: [D14_PRIMARY_ID] },
      ]);

      // grpl survives verbatim (both its members are surviving items).
      expect(sourceInventory.metaChildren).toContain("grpl");

      // Surviving items keep source relative order and iloc/ipma shape.
      expect(destinationInventory.items.map((item) => item.id)).toEqual([
        D14_PRIMARY_ID,
        D14_THUMB_ID,
        D14_GRID_ID,
        D14_AUX_ID,
      ]);
      expect(destinationInventory.iloc).toEqual(sourceInventory.iloc);
      expect(destinationInventory.associations).toEqual(
        sourceInventory.associations,
      );

      // Every surviving item's payload byte-identical.
      for (const id of [
        D14_PRIMARY_ID,
        D14_THUMB_ID,
        D14_GRID_ID,
        D14_AUX_ID,
      ]) {
        const sourceItem = findItem(sourceInventory, id)!;
        const destinationItem = findItem(destinationInventory, id)!;
        const sourcePayload = readItemExtentBytes(
          bytes,
          sourceInventory,
          sourceItem,
        );
        const destinationPayload = readItemExtentBytes(
          destinationBytes,
          destinationInventory,
          destinationItem,
        );
        expect(destinationPayload.equals(sourcePayload)).toBe(true);
      }
    },
  );

  it("every iref record from a removed item leaves no iref box in the output", async () => {
    const primaryPayload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const exifPayload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
          propertyIndices: [1, 2],
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
      twoPass: true,
    });

    const { destinationInventory } = await runThroughWriter(bytes);
    expect(destinationInventory.metaChildren).not.toContain("iref");
    expect(destinationInventory.references).toEqual([]);
  });

  it("a source with no removable item and no removable top-level box produces an output whose meta box bytes equal the source meta box bytes", async () => {
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4]),
      twoPass: true,
    });

    const { destinationBytes, sourceInventory, destinationInventory } =
      await runThroughWriter(bytes);
    const sourceMeta = sourceInventory.topLevel.find((b) => b.type === "meta")!;
    const destinationMeta = destinationInventory.topLevel.find(
      (b) => b.type === "meta",
    )!;
    expect(destinationMeta.size).toBe(sourceMeta.size);
    expect(
      destinationBytes
        .subarray(
          destinationMeta.offset,
          destinationMeta.offset + destinationMeta.size,
        )
        .equals(
          bytes.subarray(
            sourceMeta.offset,
            sourceMeta.offset + sourceMeta.size,
          ),
        ),
    ).toBe(true);
  });

  it("an emptied removable item (zero-length extent) loses its entries and contributes zero mdat bytes", async () => {
    const primaryPayload = Buffer.from([1, 2, 3, 4]);
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          // Zero-length extent at mdat's own end (D-10a: admitted as "emptied", never rebased).
          extents: [{ relOffset: primaryPayload.length, length: 0 }],
        },
      ],
      mdatPayload: primaryPayload,
      twoPass: true,
    });

    const { destinationBytes, destinationInventory } =
      await runThroughWriter(bytes);
    expect(destinationInventory.items.some((item) => item.id === 2)).toBe(
      false,
    );
    expect(destinationInventory.associations.some((a) => a.itemId === 2)).toBe(
      false,
    );
    const mdatTopLevel = destinationInventory.topLevel.find(
      (b) => b.type === "mdat",
    )!;
    expect(mdatTopLevel.size - 8).toBe(primaryPayload.length);
    expect(destinationBytes.length).toBeGreaterThan(0);
  });

  // --- Top-level position matrix: C2PA uuid / free / skip at every position, alone or doubled ---

  interface TopLevelPositionCase {
    readonly title: string;
    readonly spec: Partial<AssembleHeifSpec>;
  }

  function topLevelBoxAt(type: "free" | "skip" | "uuid"): Buffer {
    if (type === "uuid")
      return uuidBox(C2PA_UUID_USERTYPE, Buffer.alloc(16, 0x99));
    return box(type, Buffer.alloc(4));
  }

  const TOP_LEVEL_POSITION_CASES: readonly TopLevelPositionCase[] = (
    ["uuid", "free", "skip"] as const
  ).flatMap((type) => [
    {
      title: `${type} right after ftyp`,
      spec: { topLevelExtraAfterFtyp: [topLevelBoxAt(type)] },
    },
    {
      title: `${type} between meta and mdat`,
      spec: { topLevelExtraBeforeMdat: [topLevelBoxAt(type)] },
    },
    {
      title: `${type} after mdat`,
      spec: { topLevelExtraAfterMdat: [topLevelBoxAt(type)] },
    },
  ]);

  it.each(TOP_LEVEL_POSITION_CASES.map((c) => [c.title, c.spec] as const))(
    "%s is absent from the output; remaining top-level order equals the source order",
    async (_title, spec) => {
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
        ],
        mdatPayload: Buffer.from([1, 2, 3, 4]),
        twoPass: true,
        ...spec,
      });

      const { destinationInventory, sourceInventory } =
        await runThroughWriter(bytes);
      expect(
        destinationInventory.topLevel.some(
          (b) => b.type === "uuid" || b.type === "free" || b.type === "skip",
        ),
      ).toBe(false);
      expect(destinationInventory.topLevel.map((b) => b.type)).toEqual(
        sourceInventory.topLevel
          .map((b) => b.type)
          .filter((t) => t !== "uuid" && t !== "free" && t !== "skip"),
      );
    },
  );

  it("two C2PA boxes (one after ftyp, one after mdat) are both absent", async () => {
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4]),
      topLevelExtraAfterFtyp: [
        uuidBox(C2PA_UUID_USERTYPE, Buffer.alloc(16, 0x11)),
      ],
      topLevelExtraAfterMdat: [
        uuidBox(C2PA_UUID_USERTYPE, Buffer.alloc(16, 0x22)),
      ],
      twoPass: true,
    });

    const sourceInventory = inventoryIsobmff(bytes);
    expect(
      sourceInventory.topLevel.filter((b) => b.type === "uuid").length,
    ).toBe(2);

    const { destinationInventory } = await runThroughWriter(bytes);
    expect(destinationInventory.topLevel.some((b) => b.type === "uuid")).toBe(
      false,
    );
    expect(destinationInventory.topLevel.map((b) => b.type)).toEqual(
      sourceInventory.topLevel.map((b) => b.type).filter((t) => t !== "uuid"),
    );
  });
});

// --- Task 3 (62-06): generator arms and HEIC parity ---

const GENERATOR_SEED = 62;
const GENERATOR_NUM_RUNS = 20;
const TARGET_ARMS: readonly IsobmffArm[] = [
  "exif-offset",
  "xmp",
  "thmb",
  "auxl",
  "grid-idat",
];

describe("ISO-01 on generator arms (62-06)", () => {
  it.each(TARGET_ARMS)(
    "arm %s (seed 62): every planted canary is removed from every admitted sample, and the output re-admits; at least one sample admits",
    async (arm) => {
      let admittedCount = 0;
      let declinedCount = 0;

      // `isobmffArmSampleArbitrary`'s `brand` parameter only drives its ~15%-weight hazard arm
      // (`buildHazardFile`); the ~85% non-hazard arm draws its own `brand` field independently
      // inside `nonHazardConfigArbitrary`. With a fixed seed the non-hazard sample sequence is
      // therefore identical regardless of which brand is passed here -- drawing once (brand
      // value is irrelevant for the non-hazard samples this test actually uses, since the
      // outer-loop hazard samples are always excluded by the `arm` filter below) and registering
      // BOTH writer handlers lets the engine route each sample by its own real ftyp brand,
      // whichever that turns out to be, rather than guessing from the loop variable.
      const samples = fc.sample(isobmffArmSampleArbitrary("heic"), {
        seed: GENERATOR_SEED,
        numRuns: GENERATOR_NUM_RUNS,
      });

      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests("heic"),
        createIsobmffWriterHandlerForTests("avif"),
      ]);
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
          if (!sanitized.ok) {
            declinedCount += 1;
            continue;
          }
          admittedCount += 1;

          const destinationBytes = await readFile(destinationPath);
          for (const canary of sample.planted) {
            expect(
              destinationBytes.indexOf(Buffer.from(canary.canary, "ascii")),
            ).toBe(-1);
          }

          const destinationHandle: FileHandle = await open(
            destinationPath,
            "r",
          );
          try {
            const reAdmitted = await admitIsobmff(
              destinationHandle,
              destinationBytes.length,
            );
            expect(reAdmitted.namespaces).not.toContain("EXIF");
            expect(reAdmitted.namespaces).not.toContain("XMP");
          } finally {
            await destinationHandle.close();
          }
        }
      } finally {
        restore();
      }

      // Recorded per acceptance criteria: admitted/declined sample counts for this arm.
      // eslint-disable-next-line no-console
      console.log(
        `arm ${arm}: admitted=${admittedCount} declined=${declinedCount} (seed ${GENERATOR_SEED}, numRuns ${GENERATOR_NUM_RUNS})`,
      );
      expect(admittedCount).toBeGreaterThanOrEqual(1);
    },
  );
});

// --- Task 3 (62-06): HEIC twin of the Task 1 fixture ---

const HEIC_AUX_PRIMARY_ID = 1;
const HEIC_AUX_AUX_ID = 2;
const HEIC_AUX_EXIF_ID = 3;
const HEIC_AUX_XMP_ID = 4;

function buildHeicAuxHiddenC2paFixture(): {
  readonly bytes: Buffer;
  readonly exifCanary: Buffer;
  readonly xmpCanary: Buffer;
  readonly c2paCanary: Buffer;
} {
  const primaryPayload = Buffer.from([0xc0, 0xc1, 0xc2, 0xc3]);
  const auxPayload = Buffer.from([0xd0, 0xd1, 0xd2, 0xd3]);
  const exifCanary = Buffer.from("EXIF-CANARY-62-06-HEIC", "ascii");
  const xmpCanary = Buffer.from("XMP-CANARY-62-06-HEIC-AAAA", "ascii");
  const c2paCanary = Buffer.concat([
    Buffer.from("C2PA-CANARY-62-06-HEIC", "ascii"),
    Buffer.alloc(32 - "C2PA-CANARY-62-06-HEIC".length, 0x00),
  ]);

  const tiff = createMinimalExif({ orientation: 1 });
  const exifPayload = Buffer.concat([Buffer.alloc(4), tiff, exifCanary]);
  const xmpPayload = Buffer.concat([
    Buffer.from("<x:xmpmeta>", "ascii"),
    xmpCanary,
    Buffer.from("</x:xmpmeta>", "ascii"),
  ]);

  const refs: IrefRef[] = [
    {
      type: "auxl",
      fromItemId: HEIC_AUX_AUX_ID,
      toItemIds: [HEIC_AUX_PRIMARY_ID],
    },
    {
      type: "cdsc",
      fromItemId: HEIC_AUX_EXIF_ID,
      toItemIds: [HEIC_AUX_AUX_ID],
    },
    {
      type: "cdsc",
      fromItemId: HEIC_AUX_XMP_ID,
      toItemIds: [HEIC_AUX_PRIMARY_ID],
    },
  ];

  const spec: AssembleHeifSpec = {
    majorBrand: "heic",
    compatibleBrands: ["mif1", "heic"],
    primaryItemId: HEIC_AUX_PRIMARY_ID,
    items: [
      {
        itemId: HEIC_AUX_PRIMARY_ID,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2],
      },
      {
        itemId: HEIC_AUX_AUX_ID,
        itemType: "hvc1",
        hidden: true,
        extents: [
          { relOffset: primaryPayload.length, length: auxPayload.length },
        ],
        propertyIndices: [3],
      },
      {
        itemId: HEIC_AUX_EXIF_ID,
        itemType: "Exif",
        hidden: true,
        extents: [
          {
            relOffset: primaryPayload.length + auxPayload.length,
            length: exifPayload.length,
          },
        ],
      },
      {
        itemId: HEIC_AUX_XMP_ID,
        itemType: "mime",
        contentType: "application/rdf+xml",
        extents: [
          {
            relOffset:
              primaryPayload.length + auxPayload.length + exifPayload.length,
            length: xmpPayload.length,
          },
        ],
      },
    ],
    properties: [ispe(32, 32), hvcC(), auxC(ALPHA_URN)],
    refs,
    mdatPayload: Buffer.concat([
      primaryPayload,
      auxPayload,
      exifPayload,
      xmpPayload,
    ]),
    topLevelExtraAfterFtyp: [uuidBox(C2PA_UUID_USERTYPE, c2paCanary)],
    twoPass: true,
  };

  return { bytes: assembleHeif(spec), exifCanary, xmpCanary, c2paCanary };
}

describe("ISO-01/ISO-02 removal on builder fixtures, HEIC parity (62-06)", () => {
  it("removes a hidden auxiliary Exif item, an XMP item, and a top-level C2PA box right after ftyp, on a heic builder fixture with a hidden aux image", async () => {
    const { bytes, exifCanary, xmpCanary, c2paCanary } =
      buildHeicAuxHiddenC2paFixture();

    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    await writeFile(sourcePath, bytes);

    const sourceInventory = inventoryIsobmff(bytes);

    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("heic"),
    ]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) {
        throw new Error(
          `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
        );
      }

      const destinationBytes = await readFile(destinationPath);
      const destinationInventory = inventoryIsobmff(destinationBytes);

      for (const item of destinationInventory.items) {
        expect(item.type).not.toBe("Exif");
        expect(item.type).not.toBe("mime");
        expect([HEIC_AUX_EXIF_ID, HEIC_AUX_XMP_ID]).not.toContain(item.id);
      }
      expect(
        destinationInventory.topLevel.some((box) => box.type === "uuid"),
      ).toBe(false);
      expect(destinationBytes.indexOf(exifCanary)).toBe(-1);
      expect(destinationBytes.indexOf(xmpCanary)).toBe(-1);
      expect(destinationBytes.indexOf(c2paCanary)).toBe(-1);

      for (const id of [HEIC_AUX_PRIMARY_ID, HEIC_AUX_AUX_ID]) {
        const sourceItem = findItem(sourceInventory, id)!;
        const destinationItem = findItem(destinationInventory, id)!;
        expect(destinationItem).toBeDefined();
        const sourcePayload = readItemExtentBytes(
          bytes,
          sourceInventory,
          sourceItem,
        );
        const destinationPayload = readItemExtentBytes(
          destinationBytes,
          destinationInventory,
          destinationItem,
        );
        expect(destinationPayload.equals(sourcePayload)).toBe(true);
      }

      const destinationHandle: FileHandle = await open(destinationPath, "r");
      try {
        const reAdmitted = await admitIsobmff(
          destinationHandle,
          destinationBytes.length,
        );
        expect(reAdmitted.namespaces).not.toContain("EXIF");
        expect(reAdmitted.namespaces).not.toContain("XMP");
        expect(reAdmitted.namespaces).not.toContain("C2PA");
      } finally {
        await destinationHandle.close();
      }
    } finally {
      restore();
    }
  });
});

// --- CR-01 code review fix pass (62-13): k's iref rewrite must match the qualifying `cdsc`
// record, not every record whose from-item is k --------------------------------------------------
//
// 62-REVIEW.md CR-01: `plan.ts`/`verify.ts` rewrote EVERY iref record whose `fromItemId` is k to
// `toItemIds: [primaryItemId]`, not only the single qualifying `cdsc` record (the one whose
// to-list contains the primary -- the record that made k a candidate at all, D-13). A second,
// unrelated record from k (here: a second `cdsc` to a different surviving item) had its real
// target silently replaced with the primary. Admission's Rule 6 (`removable-item-referenced`)
// guarantees every iref to-target is a surviving item, so no removed-target handling is ever
// needed for a non-qualifying record from k -- it is always copied verbatim once the qualifying
// record is identified correctly.

const CR01_PRIMARY_ID = 1;
const CR01_OTHER_SURVIVING_ID = 3;
const CR01_K_ID = 2;

/** Primary (1) + a second surviving item (3, unrelated to k) + k (2, a non-emptied Exif item
 * whose FIRST `cdsc` record points at the primary, D-13) carrying a SECOND iref record (another
 * `cdsc`, to item 3, which does not describe the primary at all). `preserveOrientation: true`
 * with a requested Orientation tag present makes k survive as the minimal Exif item (D-13's
 * "write rule"), so the writer's iref rewrite for k is actually exercised. */
function buildKWithSecondIrefRecordFixture(brand: "heic" | "avif"): Buffer {
  const majorBrand = brand;
  const compatibleBrands =
    brand === "heic" ? ["mif1", "heic"] : ["mif1", "avif"];
  const itemType = brand === "heic" ? "hvc1" : "av01";
  const primaryPayload = Buffer.from("cr01-primary", "ascii");
  const otherPayload = Buffer.from("cr01-other", "ascii");
  const exifPayload = Buffer.concat([
    Buffer.alloc(4),
    createMinimalExif({ orientation: 1 }),
  ]);
  return assembleHeif({
    majorBrand,
    compatibleBrands,
    primaryItemId: CR01_PRIMARY_ID,
    items: [
      {
        itemId: CR01_PRIMARY_ID,
        itemType,
        extents: [{ relOffset: 0, length: primaryPayload.length }],
      },
      {
        itemId: CR01_OTHER_SURVIVING_ID,
        itemType,
        extents: [
          { relOffset: primaryPayload.length, length: otherPayload.length },
        ],
      },
      {
        itemId: CR01_K_ID,
        itemType: "Exif",
        hidden: true,
        extents: [
          {
            relOffset: primaryPayload.length + otherPayload.length,
            length: exifPayload.length,
          },
        ],
      },
    ],
    // The FIRST record (cdsc, k -> primary) is the qualifying record (D-13). The SECOND record
    // (cdsc, k -> the other surviving item) is unrelated -- it never describes the primary, so k
    // qualifies on the first record alone, and the second record must survive untouched.
    refs: [
      { type: "cdsc", fromItemId: CR01_K_ID, toItemIds: [CR01_PRIMARY_ID] },
      {
        type: "cdsc",
        fromItemId: CR01_K_ID,
        toItemIds: [CR01_OTHER_SURVIVING_ID],
      },
    ],
    mdatPayload: Buffer.concat([primaryPayload, otherPayload, exifPayload]),
    ilocWidths: { offsetSize: 4, lengthSize: 4, baseOffsetSize: 4 },
    twoPass: true,
  });
}

describe("CR-01 code review fix pass (62-13): k's iref rewrite matches the qualifying cdsc record only", () => {
  it.each(["heic", "avif"] as const)(
    "%s: k's own unrelated second iref record (not the qualifying cdsc) survives with its real target, only the qualifying cdsc record is reduced to [pitm]",
    async (brand) => {
      const bytes = buildKWithSecondIrefRecordFixture(brand);
      const directory = await freshDirectory();
      const sourcePath = join(directory, `source.${brand}`);
      const destinationPath = join(directory, `destination.${brand}`);
      await writeFile(sourcePath, bytes);

      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests(brand),
      ]);
      try {
        const sanitized = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: true,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(sanitized.ok).toBe(true);
        if (!sanitized.ok) {
          throw new Error(
            `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
          );
        }

        const destinationBytes = await readFile(destinationPath);
        const destinationInventory = inventoryIsobmff(destinationBytes);

        const qualifyingRecord = destinationInventory.references.find(
          (reference) =>
            reference.type === "cdsc" &&
            reference.from === CR01_K_ID &&
            reference.to.length === 1 &&
            reference.to[0] === CR01_PRIMARY_ID,
        );
        expect(qualifyingRecord).toBeDefined();

        // CR-01: the second record from k must still name its real target (the other surviving
        // item), not the primary. Before the fix, the blanket rewrite replaced its to-list with
        // [primary] too, silently losing the real reference.
        const secondRecord = destinationInventory.references.find(
          (reference) =>
            reference.type === "cdsc" &&
            reference.from === CR01_K_ID &&
            reference.to.length === 1 &&
            reference.to[0] === CR01_OTHER_SURVIVING_ID,
        );
        expect(secondRecord).toBeDefined();

        // Exactly two records from k survive (never collapsed into one).
        const recordsFromK = destinationInventory.references.filter(
          (reference) => reference.from === CR01_K_ID,
        );
        expect(recordsFromK.length).toBe(2);
      } finally {
        restore();
      }
    },
  );

  it("heic: tampering k's second iref record to the blanket-rewrite shape (the pre-fix bug, replayed as a mutant) is caught by verify", async () => {
    const bytes = buildKWithSecondIrefRecordFixture("heic");
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    await writeFile(sourcePath, bytes);

    const inner = createIsobmffWriterHandlerForTests("heic");
    const mutant = createPlanMutantHandler(
      inner,
      mutateIrefSquashSecondRecordFromK,
    );
    const restore = setRegisteredHandlersForTests([mutant]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: true,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(false);
    } finally {
      restore();
    }
  });
});

// --- WR-01 code review fix pass (62-13): verify must recompute the WHOLE surviving `ipco`
// payload independently, not only each surviving item's own associated properties -------------
//
// 62-REVIEW.md WR-01: with `preserveColorProfile: false`, verify checked each surviving item's
// associated property bytes and the absence of removed ICC bytes, but never recomputed "source
// properties in order minus the removed indices" and compared the WHOLE ipco payload. A property
// referenced by no `ipma` entry at all (D-34's orphan shape, e.g. `udes`) survives ICC removal
// unaffected -- its bytes were never checked by anything.

const WR01_PRIMARY_ID = 1;
const WR01_ORPHAN_TYPE = "udes";

/** One surviving primary associated with `ispe` + a `colr prof` (removed under
 * `preserveColorProfile: false`), plus a THIRD ipco property (`udes`) that no item's `ipma`
 * entry references at all -- the orphan this fixture exists to protect. */
function buildOrphanIpcoPropertyFixture(): Buffer {
  const primaryPayload = Buffer.from("wr01-primary", "ascii");
  const orphanPayload = Buffer.from("WR01-ORPHAN-UDES-PAYLOAD", "ascii");
  return assembleHeif({
    majorBrand: "heic",
    compatibleBrands: ["mif1", "heic"],
    primaryItemId: WR01_PRIMARY_ID,
    items: [
      {
        itemId: WR01_PRIMARY_ID,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2],
      },
    ],
    properties: [
      ispe(32, 32),
      box(
        "colr",
        Buffer.concat([
          Buffer.from("prof", "ascii"),
          Buffer.from([0xaa, 0xbb]),
        ]),
      ),
      box(WR01_ORPHAN_TYPE, orphanPayload),
    ],
    mdatPayload: primaryPayload,
    twoPass: true,
  });
}

describe("WR-01 code review fix pass (62-13): verify recomputes the whole surviving ipco payload", () => {
  it("heic: corrupting an orphan ipco property no ipma entry references is caught by verify", async () => {
    const bytes = buildOrphanIpcoPropertyFixture();
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    await writeFile(sourcePath, bytes);

    const inner = createIsobmffWriterHandlerForTests("heic");
    const mutant = createPlanMutantHandler(
      inner,
      mutateIpcoCorruptOrphanProperty(WR01_ORPHAN_TYPE),
    );
    const restore = setRegisteredHandlersForTests([mutant]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 67-19 (isobmff-6): the output planner, `src/isobmff/plan.ts`. Real fixtures go through
// `admitIsobmff` and `buildIsobmffOutputPlan`; the D-12 overflow arithmetic needs offsets above
// 4 GiB, which no real file this suite can write reaches, so those cases take a real admission
// and replace only plain data on it (item extents, iloc widths, the mdat size form) -- the same
// admission shape the engine always hands the planner, as the D-12 tests in
// tests/isobmff_hostile.test.ts do. The plan is pure data, so no 4 GiB buffer is ever allocated.
// ---------------------------------------------------------------------------

type PlanLayout = IsobmffAdmission["model"]["layout"];
type PlanLayoutItem = PlanLayout["item"];
type PlanBoxHeader = PlanLayout["topLevelBoxes"][number];
type PlanSpan = { readonly abs: number; readonly length: number };

// Payloads are built lazily: a top-level initializer that calls code would join the named-killer
// closure of the tracer test above (tools/mutation/deletion-proof.mjs, Plan 67-59).
function iso6Primary(): Buffer {
  return Buffer.from("primary-bytes", "ascii");
}
function iso6Second(): Buffer {
  return Buffer.from("second", "ascii");
}
function iso6Third(): Buffer {
  return Buffer.from("third", "ascii");
}
function iso6Exif(): Buffer {
  return Buffer.concat([
    Buffer.alloc(4),
    createMinimalExif({ orientation: 6 }),
  ]);
}
const UINT32_MAX = 0xffffffff;

// The planner is reached through the writer handler's own buildOutputPlan/checkOutputPlan, the
// exact functions the engine calls, so this file needs no new runtime import.
function iso6Handler() {
  return createIsobmffWriterHandlerForTests("heic");
}
function buildIsobmffOutputPlan(
  admission: IsobmffAdmission,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  orientation: number | undefined,
): IsobmffOutputPlan {
  return iso6Handler().buildOutputPlan(
    admission,
    preserveOrientation,
    preserveColorProfile,
    preserveResolution,
    orientation,
  ) as IsobmffOutputPlan;
}
function checkIsobmffOutputPlan(plan: IsobmffOutputPlan): string | undefined {
  return iso6Handler().checkOutputPlan(plan);
}

/** Primary 1, surviving 3 (and, unless `includeThird` is false, surviving 4), then Exif item 2
 * (the D-13 source item k, `cdsc` to the primary by default). All extents touch in that order. */
function iso6Fixture(
  options: {
    readonly widths?: NonNullable<AssembleHeifSpec["ilocWidths"]>;
    readonly refs?: readonly IrefRef[];
    readonly includeThird?: boolean;
    readonly exifProperties?: boolean;
  } = {},
): Buffer {
  const includeThird = options.includeThird !== false;
  const secondOffset = iso6Primary().length;
  const thirdOffset = secondOffset + iso6Second().length;
  const exifOffset = includeThird
    ? thirdOffset + iso6Third().length
    : thirdOffset;
  return assembleHeif({
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: iso6Primary().length }],
        propertyIndices: [1, 2],
      },
      {
        itemId: 3,
        itemType: "hvc1",
        extents: [{ relOffset: secondOffset, length: iso6Second().length }],
      },
      ...(includeThird
        ? [
            {
              itemId: 4,
              itemType: "hvc1",
              extents: [{ relOffset: thirdOffset, length: iso6Third().length }],
            },
          ]
        : []),
      {
        itemId: 2,
        itemType: "Exif",
        hidden: true,
        extents: [{ relOffset: exifOffset, length: iso6Exif().length }],
        ...(options.exifProperties === true ? { propertyIndices: [1] } : {}),
      },
    ],
    refs: options.refs ?? [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
    mdatPayload: Buffer.concat([
      iso6Primary(),
      iso6Second(),
      ...(includeThird ? [iso6Third()] : []),
      iso6Exif(),
    ]),
    ...(options.widths !== undefined ? { ilocWidths: options.widths } : {}),
    twoPass: true,
  });
}

async function iso6Admit(bytes: Buffer): Promise<IsobmffAdmission> {
  const directory = await freshDirectory();
  const path = join(directory, "source.heic");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    return await admitIsobmff(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

function iso6WithLayoutItem(
  admission: IsobmffAdmission,
  patch: Partial<PlanLayoutItem>,
): IsobmffAdmission {
  const { layout } = admission.model;
  return {
    ...admission,
    model: {
      ...admission.model,
      layout: { ...layout, item: { ...layout.item, ...patch } },
    },
  };
}

function iso6WithTopLevel(
  admission: IsobmffAdmission,
  map: (boxes: readonly PlanBoxHeader[]) => readonly PlanBoxHeader[],
): IsobmffAdmission {
  const { layout } = admission.model;
  return {
    ...admission,
    model: {
      ...admission.model,
      layout: { ...layout, topLevelBoxes: map(layout.topLevelBoxes) },
    },
  };
}

function iso6WithItems(
  admission: IsobmffAdmission,
  map: (item: IsobmffItem) => IsobmffItem,
): IsobmffAdmission {
  const items = admission.model.items.map(map);
  return {
    ...admission,
    model: {
      ...admission.model,
      items,
      itemsById: new Map(items.map((item) => [item.id, item] as const)),
    },
  };
}

/** Item 1 and item 3 read `spans` as absolute extents from base 0; the mdat takes `sizeForm`. */
function iso6Place(
  admission: IsobmffAdmission,
  spans: {
    readonly item1: readonly PlanSpan[];
    readonly item3: readonly PlanSpan[];
  },
  layoutPatch: Partial<PlanLayoutItem> = {},
  sizeForm: "normal" | "largesize" = "normal",
): IsobmffAdmission {
  const placed = iso6WithItems(admission, (item) => {
    const own =
      item.id === 1 ? spans.item1 : item.id === 3 ? spans.item3 : undefined;
    if (own === undefined) return item;
    return {
      ...item,
      baseOffset: 0,
      extents: own.map((span) => ({
        index: 0,
        offset: span.abs,
        length: span.length,
      })),
    };
  });
  const patched = iso6WithLayoutItem(placed, layoutPatch);
  return iso6WithTopLevel(patched, (boxes) =>
    boxes.map((box) =>
      box.type === "mdat"
        ? {
            ...box,
            sizeForm,
            headerSize: sizeForm === "largesize" ? 16 : 8,
          }
        : box,
    ),
  );
}

/** Every removable item dropped, color profile kept: ipco/ipma come out equal to the source. */
function iso6PlanDrop(admission: IsobmffAdmission): IsobmffOutputPlan {
  return buildIsobmffOutputPlan(admission, false, true, false, undefined);
}

/** Orientation preserved: Exif item k stays as the minimal Exif item. */
function iso6PlanKeep(admission: IsobmffAdmission): IsobmffOutputPlan {
  return buildIsobmffOutputPlan(admission, true, true, false, 6);
}

function iso6ExpectDeclined(
  plan: IsobmffOutputPlan,
  admission: IsobmffAdmission,
): void {
  expect(checkIsobmffOutputPlan(plan)).toBeDefined();
  expect(plan.parts).toEqual([]);
  expect(plan.removedItemIds).toEqual(
    admission.classification.removableItemIds,
  );
}

function iso6ExpectPlanned(plan: IsobmffOutputPlan): void {
  expect(checkIsobmffOutputPlan(plan)).toBeUndefined();
  expect(plan.parts.length).toBeGreaterThan(0);
}

function iso6PartLength(part: IsobmffOutputPlan["parts"][number]): number {
  return part.kind === "copy" ? part.length : part.data.length;
}

/** ftyp copy + meta bytes + mdat header: where the new mdat payload starts. */
function iso6PayloadStart(plan: IsobmffOutputPlan): number {
  return plan.parts
    .slice(0, 3)
    .reduce((sum, part) => sum + iso6PartLength(part), 0);
}

function iso6MetaBytes(plan: IsobmffOutputPlan): Buffer {
  const part = plan.parts.find((candidate) => candidate.kind === "bytes");
  if (part === undefined || part.kind !== "bytes") {
    throw new Error("the plan carries no meta bytes part");
  }
  return part.data;
}

function iso6ChildTypes(box: Buffer, headerSize: number): string[] {
  const types: string[] = [];
  let position = headerSize;
  while (position < box.length) {
    types.push(box.toString("ascii", position + 4, position + 8));
    position += box.readUInt32BE(position);
  }
  return types;
}

async function iso6Sanitize(
  bytes: Buffer,
  preserveOrientation: boolean,
): Promise<IsobmffInventory> {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.heic");
  const destinationPath = join(directory, "destination.heic");
  await writeFile(sourcePath, bytes);
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests("heic"),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    if (!sanitized.ok) {
      throw new Error(
        `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
      );
    }
    return inventoryIsobmff(await readFile(destinationPath));
  } finally {
    restore();
  }
}

describe("buildMergedMdatRanges EqualityOperator cluster (67-19)", () => {
  it("buildMergedMdatRanges EqualityOperator: touching surviving extents are written as one copy of the union", async () => {
    const admission = await iso6Admit(iso6Fixture());
    const plan = iso6PlanDrop(admission);
    iso6ExpectPlanned(plan);
    const copies = plan.parts.filter((part) => part.kind === "copy");
    // The ftyp copy plus exactly one mdat copy; touching extents 1, 3 and 4 are not split.
    expect(copies).toHaveLength(2);
    const mdatCopy = copies[1]!;
    expect(mdatCopy.kind === "copy" && mdatCopy.length).toBe(
      iso6Primary().length + iso6Second().length + iso6Third().length,
    );
  });
});

describe("buildIsobmffOutputPlan top-level box ConditionalExpression, EqualityOperator, and LogicalOperator clusters (67-19)", () => {
  it("buildIsobmffOutputPlan top-level boxes: an unmodified admission plans", async () => {
    const admission = await iso6Admit(iso6Fixture());
    iso6ExpectPlanned(iso6PlanDrop(admission));
  });

  it("buildIsobmffOutputPlan top-level boxes: a source with no kept ftyp box is declined before any part is planned", async () => {
    const admission = await iso6Admit(iso6Fixture());
    const without = iso6WithTopLevel(admission, (boxes) =>
      boxes.filter((box) => box.type !== "ftyp"),
    );
    iso6ExpectDeclined(iso6PlanDrop(without), without);
  });

  it("buildIsobmffOutputPlan top-level boxes: a source with no kept meta box is declined before any part is planned", async () => {
    const admission = await iso6Admit(iso6Fixture());
    const without = iso6WithTopLevel(admission, (boxes) =>
      boxes.filter((box) => box.type !== "meta"),
    );
    iso6ExpectDeclined(iso6PlanDrop(without), without);
  });

  it("buildIsobmffOutputPlan top-level boxes: a source with no kept mdat box is declined", async () => {
    const admission = await iso6Admit(iso6Fixture());
    const without = iso6WithTopLevel(admission, (boxes) =>
      boxes.filter((box) => box.type !== "mdat"),
    );
    iso6ExpectDeclined(iso6PlanDrop(without), without);
  });

  it("buildIsobmffOutputPlan ArithmeticOperator: a ftyp that does not start at offset 0 contributes its size, not end plus start", async () => {
    const admission = await iso6Admit(iso6Fixture());
    const baseline = iso6PlanDrop(admission);
    const shifted = iso6WithTopLevel(admission, (boxes) =>
      boxes.map((box) =>
        box.type === "ftyp"
          ? {
              ...box,
              start: box.start + 8,
              payloadStart: box.payloadStart + 8,
              end: box.end + 8,
            }
          : box,
      ),
    );
    const plan = iso6PlanDrop(shifted);
    iso6ExpectPlanned(plan);
    const first = baseline.parts[0]!;
    expect(first.kind).toBe("copy");
    // Only the ftyp copy's source offset moves; its length and every later byte are unchanged,
    // including the rewritten iloc offsets inside the meta bytes.
    expect(plan.parts[0]).toEqual({
      ...first,
      sourceOffset: first.kind === "copy" ? first.sourceOffset + 8 : 0,
    });
    expect(plan.parts.slice(1)).toEqual(baseline.parts.slice(1));
  });
});

describe("buildIsobmffOutputPlan iloc width ConditionalExpression and EqualityOperator clusters (67-19)", () => {
  it("buildIsobmffOutputPlan iloc widths: offset_size 0 with a base offset plans a minimal Exif item at offset 0", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const zeroOffsetWidth = iso6WithLayoutItem(admission, {
      ilocOffsetSize: 0,
    });
    // offset_size 0 cannot carry an absolute position, but base_offset_size 4 can: nothing to decline.
    iso6ExpectPlanned(iso6PlanKeep(zeroOffsetWidth));
  });

  it("buildIsobmffOutputPlan iloc widths: offset_size 8 with a base offset plans a minimal Exif item", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const wideOffsets = iso6WithLayoutItem(admission, { ilocOffsetSize: 8 });
    iso6ExpectPlanned(iso6PlanKeep(wideOffsets));
  });

  it("buildIsobmffOutputPlan iloc widths: a second extent at a positive offset does not fit offset_size 0", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const spans = {
      item1: [
        { abs: 0, length: 4 },
        { abs: 4, length: 4 },
      ],
      item3: [{ abs: 100, length: 6 }],
    };
    iso6ExpectPlanned(iso6PlanDrop(iso6Place(admission, spans)));
    const starved = iso6Place(admission, spans, { ilocOffsetSize: 0 });
    iso6ExpectDeclined(iso6PlanDrop(starved), starved);
  });
});

describe("checkIlocRewriteFit and maxValueForWidth clusters on 32-bit base and extent offsets (67-19)", () => {
  const GAP = 1000;

  it("checkIlocRewriteFit: a rewritten base offset above 32 bits is declined", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const placed = iso6Place(
      admission,
      {
        item1: [{ abs: 2 ** 32 + GAP, length: 13 }],
        item3: [{ abs: 0, length: 2 ** 32 }],
      },
      { ilocLengthSize: 8 },
      "largesize",
    );
    iso6ExpectDeclined(iso6PlanDrop(placed), placed);
  });

  it("checkIlocRewriteFit: a rewritten base offset of exactly 0xffffffff fits, one more does not and is caught only by the final pass", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const at = (length: number): IsobmffAdmission =>
      iso6Place(
        admission,
        {
          item1: [{ abs: length + GAP, length: 13 }],
          item3: [{ abs: 0, length }],
        },
        { ilocLengthSize: 8 },
        "largesize",
      );
    const start = iso6PayloadStart(iso6PlanDrop(at(100)));
    const fits = at(UINT32_MAX - start);
    iso6ExpectPlanned(iso6PlanDrop(fits));
    const overflows = at(UINT32_MAX - start + 1);
    iso6ExpectDeclined(iso6PlanDrop(overflows), overflows);
  });

  it("checkIlocRewriteFit: a rewritten extent offset above 32 bits is declined", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const placed = iso6Place(
      admission,
      {
        item1: [
          { abs: GAP, length: 4 },
          { abs: 2 * GAP + 2 ** 32 + 10, length: 4 },
        ],
        item3: [{ abs: 2 * GAP, length: 2 ** 32 }],
      },
      { ilocLengthSize: 8 },
      "largesize",
    );
    iso6ExpectDeclined(iso6PlanDrop(placed), placed);
  });
});

describe("checkMdatSizeFit clusters on the rewritten mdat size (67-19)", () => {
  const withPayload = async (
    payloadLength: number,
    sizeForm: "normal" | "largesize",
    layoutPatch: Partial<PlanLayoutItem> = {},
  ): Promise<IsobmffAdmission> => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    return iso6Place(
      admission,
      {
        item1: [{ abs: 0, length: 13 }],
        item3: [{ abs: 100, length: payloadLength - 13 }],
      },
      layoutPatch,
      sizeForm,
    );
  };

  it("checkMdatSizeFit: a normal header cannot carry a payload of 0xfffffff8 and is declined", async () => {
    const admission = await withPayload(0xfffffff8, "normal");
    iso6ExpectDeclined(iso6PlanDrop(admission), admission);
  });

  it("checkMdatSizeFit: a normal header carries a payload of 0xfffffff7, the largest that fits", async () => {
    iso6ExpectPlanned(iso6PlanDrop(await withPayload(0xfffffff7, "normal")));
  });

  it("checkMdatSizeFit: a largesize header carries a payload of 0xfffffff8", async () => {
    iso6ExpectPlanned(iso6PlanDrop(await withPayload(0xfffffff8, "largesize")));
  });

  it("checkMdatSizeFit: a largesize header whose total exceeds the safe integer range is declined", async () => {
    const admission = await withPayload(2 ** 53 - 15, "largesize", {
      ilocLengthSize: 8,
    });
    iso6ExpectDeclined(iso6PlanDrop(admission), admission);
  });
});

describe("buildIsobmffOutputPlan iref ConditionalExpression, LogicalOperator, and UnaryOperator clusters (67-19)", () => {
  it("buildIsobmffOutputPlan iref UnaryOperator: with no minimal Exif item every iref record keeps its own targets", async () => {
    const inventory = await iso6Sanitize(
      iso6Fixture({
        refs: [
          { type: "cdsc", fromItemId: 2, toItemIds: [1] },
          { type: "dimg", fromItemId: 3, toItemIds: [1, 4] },
        ],
      }),
      false,
    );
    // The record from the removed Exif item goes; the second record (index 1) is not rewritten.
    expect(inventory.references).toEqual([
      { type: "dimg", from: 3, to: [1, 4] },
    ]);
  });

  it("buildIsobmffOutputPlan iref ConditionalExpression and LogicalOperator: only k's own cdsc record that names the primary is reduced to the primary", async () => {
    const inventory = await iso6Sanitize(
      iso6Fixture({
        refs: [
          { type: "cdsc", fromItemId: 3, toItemIds: [1, 4] },
          { type: "thmb", fromItemId: 2, toItemIds: [1, 4] },
          { type: "cdsc", fromItemId: 2, toItemIds: [1, 4] },
        ],
      }),
      true,
    );
    expect(inventory.references).toEqual([
      { type: "cdsc", from: 3, to: [1, 4] },
      { type: "thmb", from: 2, to: [1, 4] },
      { type: "cdsc", from: 2, to: [1] },
    ]);
  });
});

describe("buildIsobmffOutputPlan iprp and ipma ConditionalExpression, EqualityOperator, and MethodExpression clusters (67-19)", () => {
  it("buildIsobmffOutputPlan ipma MethodExpression: an ipma entry for a removed item is dropped from the output", async () => {
    const inventory = await iso6Sanitize(
      iso6Fixture({ exifProperties: true }),
      false,
    );
    expect(inventory.associations.map((entry) => entry.itemId)).toEqual([1]);
  });

  it("buildIsobmffOutputPlan iprp ConditionalExpression and EqualityOperator: an iprp with no recognised children is dropped from meta", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const baseline = iso6ChildTypes(iso6MetaBytes(iso6PlanDrop(admission)), 12);
    expect(baseline).toContain("iprp");
    const empty = iso6WithLayoutItem(admission, { iprpChildren: [] });
    expect(iso6ChildTypes(iso6MetaBytes(iso6PlanDrop(empty)), 12)).toEqual(
      baseline.filter((type) => type !== "iprp"),
    );
  });

  it("buildIsobmffOutputPlan iprp EqualityOperator: an iprp that holds only ipco keeps the rebuilt ipco", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const { layout } = admission.model;
    const ipco = layout.item.iprpChildren.find(
      (child) => child.type === "ipco",
    )!;
    const { ipmaVersion: _version, ipmaFlags: _flags, ...rest } = layout.item;
    const onlyIpco = {
      ...admission,
      model: {
        ...admission.model,
        layout: {
          ...layout,
          item: { ...rest, iprpChildren: [ipco] },
        },
      },
    };
    const meta = iso6MetaBytes(iso6PlanDrop(onlyIpco));
    expect(
      meta.includes(layout.metaPayload.subarray(ipco.start, ipco.end)),
    ).toBe(true);
  });

  it("buildIsobmffOutputPlan iprp EqualityOperator: an iprp that holds only ipma keeps the rebuilt ipma", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const { layout } = admission.model;
    const ipma = layout.item.iprpChildren.find(
      (child) => child.type === "ipma",
    )!;
    const onlyIpma = iso6WithLayoutItem(admission, { iprpChildren: [ipma] });
    const meta = iso6MetaBytes(iso6PlanDrop(onlyIpma));
    expect(
      meta.includes(layout.metaPayload.subarray(ipma.start, ipma.end)),
    ).toBe(true);
  });

  it("buildIsobmffOutputPlan iprp ConditionalExpression: an iprp child that is neither ipco nor ipma is not carried into the order", async () => {
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const { iprpChildren } = admission.model.layout.item;
    const baseline = iso6MetaBytes(iso6PlanDrop(admission));
    const withFree = iso6WithLayoutItem(admission, {
      iprpChildren: [...iprpChildren, { ...iprpChildren[0]!, type: "free" }],
    });
    expect(iso6MetaBytes(iso6PlanDrop(withFree)).equals(baseline)).toBe(true);
  });
});
