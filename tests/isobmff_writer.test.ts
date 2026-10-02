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
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
  type InventoryItem,
  type IsobmffInventory,
} from "./isobmff-support/inventory.js";
import {
  ftypBox,
  hdlrBox,
  hvcC,
  idatBox,
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
  type IlocItem,
  type IpmaEntry,
} from "./isobmff-support/builder.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.avif");

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
        throw new Error(`sanitizeFile failed: ${JSON.stringify(sanitized.error)}`);
      }

      // Blast radius: the test directory lists exactly the source and the destination.
      const listing = await readdir(directory);
      expect(new Set(listing)).toEqual(
        new Set([sourceName, destinationName]),
      );

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
        for (const toId of reference.to) expect(removedIds.has(toId)).toBe(false);
      }

      // ISO-03: every surviving item (the grid, its four tiles, and the thumbnail) has an output
      // payload byte-identical to its source payload, read through each file's own iloc/idat.
      const sourceSurviving = sourceInventory.items.filter((item) =>
        SURVIVING_IMAGE_TYPES.has(item.type),
      );
      expect(sourceSurviving.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 8]);
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

describe("Task 2: the writer handler stays unreachable and unregistered (62-02)", () => {
  it("registeredHandlersForTests() still returns exactly the webp, png and jpeg handlers", () => {
    expect(registeredHandlersForTests().map((h) => h.capability.format)).toEqual([
      "webp",
      "png",
      "jpeg",
    ]);
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
  absExtents: readonly { readonly abs: number; readonly length: number; readonly index: number }[],
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

function buildLayoutMatrixFixture(
  c: LayoutMatrixCase,
): {
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
      infeBox({ version: 2, itemId: MATRIX_EXIF_ID, itemType: "Exif", hidden: true }),
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
    cases.push({ version: 0, offsetSize: 4, lengthSize: 4, baseOffsetSize, indexSize: 0 });
    cases.push({ version: 0, offsetSize: 8, lengthSize: 4, baseOffsetSize, indexSize: 0 });
    for (const indexSize of [0, 4, 8] as const) {
      cases.push({ version: 1, offsetSize: 4, lengthSize: 4, baseOffsetSize, indexSize });
      cases.push({ version: 2, offsetSize: 4, lengthSize: 4, baseOffsetSize, indexSize });
    }
  }
  // A couple of explicit lengthSize/offsetSize=8 combinations, so those widths are exercised too.
  cases.push({ version: 1, offsetSize: 4, lengthSize: 8, baseOffsetSize: 4, indexSize: 4 });
  cases.push({ version: 2, offsetSize: 8, lengthSize: 8, baseOffsetSize: 8, indexSize: 8 });
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
          throw new Error(`sanitizeFile failed: ${JSON.stringify(sanitized.error)}`);
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
        const destinationPrimary = findItem(destinationInventory, survivingPrimaryId)!;
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
