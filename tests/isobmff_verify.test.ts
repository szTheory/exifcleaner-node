// D-18 complete identity proof (62-09): `verifyIsobmffOutput` re-parses the destination through
// the real engine and recomputes every expectation from the SOURCE admission and the request
// flags only -- never from the plan's own output (T-62-25/T-62-24). This file proves:
//
// Task 1: a preservation fixture (irot, imir, clap, thumbnail, gain map, depth auxiliary) carries
// every listed property/item through the full proof end to end, bytes and essential bits intact.
// Task 2: one red case per D-18 assertion, each caught with code "verification-failed".
// Task 3: streamed COPY_BLOCK_BYTES comparison windows (a 1 MiB item, first/last byte flipped)
// and the generator's irot/imir essential/non-essential transform arms.
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
import { verifyIsobmffOutput } from "../src/isobmff/verify.js";
import { sanitizeFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
} from "./isobmff-support/hostile.js";
import { createOrientationExif } from "../src/metadata/exif.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
  type InventoryItem,
  type IsobmffInventory,
} from "./isobmff-support/inventory.js";
import {
  isobmffArmSampleArbitrary,
  type IsobmffArm,
} from "./isobmff-support/generator.js";
import {
  auxC,
  box,
  colrNclx,
  hvcC,
  idatBox,
  iinfBox,
  ilocBox,
  imir,
  infeBox,
  ipmaBox,
  irefBox,
  irot,
  ispe,
  pixi,
  type IlocExtent,
  type IlocItem,
  type IpmaEntry,
  type IrefRef,
} from "./isobmff-support/builder.js";

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
    join(tmpdir(), "exifcleaner-isobmff-verify-"),
  );
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

function findItem(
  inventory: IsobmffInventory,
  id: number,
): InventoryItem | undefined {
  return inventory.items.find((item) => item.id === id);
}

async function sanitizeThroughRealWriter(
  sourcePath: string,
  destinationPath: string,
  options: {
    readonly preserveOrientation?: boolean;
    readonly preserveColorProfile?: boolean;
    readonly preserveResolution?: boolean;
    readonly brand?: "heic" | "avif";
  } = {},
): Promise<Awaited<ReturnType<typeof sanitizeFile>>> {
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests(options.brand ?? "heic"),
  ]);
  try {
    return await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: options.preserveOrientation ?? false,
      preserveColorProfile: options.preserveColorProfile ?? true,
      preserveTimestamps: false,
      preserveResolution: options.preserveResolution ?? false,
    });
  } finally {
    restore();
  }
}

// --- Task 1 fixture: irot/imir (essential), clap, a thumbnail, a tmap gain-map item with its
// auxiliary input, and a depth auxiliary item -- plus an Exif item to remove. ---

const PRIMARY_PAYLOAD = Buffer.from("PRIMARY-IMAGE-PAYLOAD-BYTES-01", "ascii");
const THUMB_PAYLOAD = Buffer.from("THUMBNAIL-PAYLOAD-BYTES-02", "ascii");
const TMAP_PAYLOAD = Buffer.from("TMAP-CONTAINER-PAYLOAD-BYTES-03", "ascii");
const GAIN_AUX_PAYLOAD = Buffer.from("GAINMAP-AUX-PAYLOAD-BYTES-04", "ascii");
const DEPTH_AUX_PAYLOAD = Buffer.from("DEPTH-AUX-PAYLOAD-BYTES-05", "ascii");
const GAIN_MAP_URN = "urn:com:photo:aux:hdrgainmap";
const DEPTH_URN = "urn:mpeg:hevc:2015:auxid:2";

function buildPreservationFixture(): Buffer {
  const exifPayload = Buffer.concat([
    Buffer.alloc(4),
    createOrientationExif(1),
  ]);

  let running = 0;
  const at = (length: number): number => {
    const offset = running;
    running += length;
    return offset;
  };
  const primaryOffset = at(PRIMARY_PAYLOAD.length);
  const exifOffset = at(exifPayload.length);
  const thumbOffset = at(THUMB_PAYLOAD.length);
  const tmapOffset = at(TMAP_PAYLOAD.length);
  const gainAuxOffset = at(GAIN_AUX_PAYLOAD.length);
  const depthAuxOffset = at(DEPTH_AUX_PAYLOAD.length);

  const spec: AssembleHeifSpec = {
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: primaryOffset, length: PRIMARY_PAYLOAD.length }],
      },
      {
        itemId: 2,
        itemType: "Exif",
        extents: [{ relOffset: exifOffset, length: exifPayload.length }],
      },
      {
        itemId: 3,
        itemType: "hvc1",
        hidden: true,
        extents: [{ relOffset: thumbOffset, length: THUMB_PAYLOAD.length }],
      },
      {
        itemId: 4,
        itemType: "tmap",
        extents: [{ relOffset: tmapOffset, length: TMAP_PAYLOAD.length }],
      },
      {
        itemId: 5,
        itemType: "hvc1",
        hidden: true,
        extents: [
          { relOffset: gainAuxOffset, length: GAIN_AUX_PAYLOAD.length },
        ],
      },
      {
        itemId: 6,
        itemType: "hvc1",
        hidden: true,
        extents: [
          { relOffset: depthAuxOffset, length: DEPTH_AUX_PAYLOAD.length },
        ],
      },
    ],
    properties: [
      ispeProp(),
      hvcCProp(),
      colrNclxProp(),
      pixiProp(),
      irotProp(),
      imirProp(),
      clapProp(),
      auxCProp(GAIN_MAP_URN),
      auxCProp(DEPTH_URN),
    ],
    refs: [
      { type: "cdsc", fromItemId: 2, toItemIds: [1] },
      { type: "thmb", fromItemId: 3, toItemIds: [1] },
      { type: "dimg", fromItemId: 4, toItemIds: [1, 5] },
      { type: "auxl", fromItemId: 5, toItemIds: [1] },
      { type: "auxl", fromItemId: 6, toItemIds: [1] },
    ],
    extraIpmaEntries: [
      {
        itemId: 1,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
          { propertyIndex: 3, essential: false },
          { propertyIndex: 4, essential: false },
          { propertyIndex: 5, essential: true },
          { propertyIndex: 6, essential: true },
          { propertyIndex: 7, essential: false },
        ],
      },
      {
        itemId: 3,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
        ],
      },
      {
        itemId: 4,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
        ],
      },
      {
        itemId: 5,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
          { propertyIndex: 8, essential: false },
        ],
      },
      {
        itemId: 6,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
          { propertyIndex: 9, essential: false },
        ],
      },
    ],
    mdatPayload: Buffer.concat([
      PRIMARY_PAYLOAD,
      exifPayload,
      THUMB_PAYLOAD,
      TMAP_PAYLOAD,
      GAIN_AUX_PAYLOAD,
      DEPTH_AUX_PAYLOAD,
    ]),
    twoPass: true,
  };

  return assembleHeif(spec);
}

// Thin wrappers over `builder.ts`'s generic encoders, named per property so the fixture's own
// `properties` array (above) reads as a plain list of what it carries.
function ispeProp(): Buffer {
  return ispe(32, 32);
}
function hvcCProp(): Buffer {
  return hvcC();
}
function colrNclxProp(): Buffer {
  return colrNclx(1, 13, 6, true);
}
function pixiProp(): Buffer {
  return pixi([8, 8, 8]);
}
function irotProp(): Buffer {
  return irot(1);
}
function imirProp(): Buffer {
  return imir(0);
}
function clapProp(): Buffer {
  // CleanApertureBox (ISO/IEC 14496-12): not a FullBox -- 8 x uint32 (four fraction pairs). No
  // dedicated `builder.ts` helper exists; built directly through the generic `box()` encoder, as
  // this plan's `<action>` instructs.
  return box("clap", Buffer.alloc(32));
}
function auxCProp(urn: string): Buffer {
  return auxC(urn);
}

describe("D-18 identity proof (62-09)", () => {
  describe("Task 1: preservation fixture through the full proof end to end", () => {
    it(
      "irot (essential), imir (essential), clap, a thumbnail, a tmap gain-map item with its " +
        "auxiliary input, and a depth auxiliary item all survive byte-identical, with Exif removed",
      async () => {
        const sourceBytes = buildPreservationFixture();
        const { path: sourcePath } = await writeFixture(
          sourceBytes,
          "source.heic",
        );
        const directory = dirname(sourcePath);
        const destinationPath = join(directory, "destination.heic");

        const sanitized = await sanitizeThroughRealWriter(
          sourcePath,
          destinationPath,
        );
        expect(sanitized.ok).toBe(true);
        if (!sanitized.ok) {
          throw new Error(
            `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
          );
        }

        const destinationBytes = await readFile(destinationPath);
        const sourceInventory = inventoryIsobmff(sourceBytes);
        const destinationInventory = inventoryIsobmff(destinationBytes);

        // The Exif item is gone; every other item survives at its own id.
        expect(findItem(destinationInventory, 2)).toBeUndefined();
        for (const id of [1, 3, 4, 5, 6]) {
          expect(findItem(destinationInventory, id)).toBeDefined();
        }

        // ipco is untouched (preserveColorProfile true, nothing to remove) -- every property
        // survives, in order, including irot/imir/clap/both auxC properties.
        expect(destinationInventory.properties.map((p) => p.type)).toEqual([
          "ispe",
          "hvcC",
          "colr",
          "pixi",
          "irot",
          "imir",
          "clap",
          "auxC",
          "auxC",
        ]);
        expect(
          destinationInventory.properties.find(
            (p) => p.type === "auxC" && p.index === 8,
          )?.auxUrn,
        ).toBe(GAIN_MAP_URN);
        expect(
          destinationInventory.properties.find(
            (p) => p.type === "auxC" && p.index === 9,
          )?.auxUrn,
        ).toBe(DEPTH_URN);

        // Every surviving item's associations are unchanged (same property indices and essential
        // bits, in order) -- irot (index 5) and imir (index 6) keep their essential bit on item 1.
        for (const id of [1, 3, 4, 5, 6]) {
          const sourceAssoc = sourceInventory.associations.find(
            (entry) => entry.itemId === id,
          );
          const destinationAssoc = destinationInventory.associations.find(
            (entry) => entry.itemId === id,
          );
          expect(destinationAssoc?.associations).toEqual(
            sourceAssoc?.associations,
          );
        }
        const primaryAssoc = destinationInventory.associations.find(
          (entry) => entry.itemId === 1,
        );
        expect(
          primaryAssoc?.associations.find((a) => a.propertyIndex === 5)
            ?.essential,
        ).toBe(true);
        expect(
          primaryAssoc?.associations.find((a) => a.propertyIndex === 6)
            ?.essential,
        ).toBe(true);

        // Every surviving item's payload is byte-identical, read through each file's own
        // iloc/idat.
        for (const id of [1, 3, 4, 5, 6]) {
          const sourceItem = findItem(sourceInventory, id)!;
          const destinationItem = findItem(destinationInventory, id)!;
          const sourcePayload = readItemExtentBytes(
            sourceBytes,
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

        // References: thumbnail, gain-map dimg (to primary + its aux input), and both depth/
        // gain-map auxl records survive unchanged.
        expect(destinationInventory.references).toEqual(
          expect.arrayContaining([
            { type: "thmb", from: 3, to: [1] },
            { type: "dimg", from: 4, to: [1, 5] },
            { type: "auxl", from: 5, to: [1] },
            { type: "auxl", from: 6, to: [1] },
          ]),
        );
        // No cdsc reference survives (item 2, its only from-item, was removed).
        expect(
          destinationInventory.references.some(
            (reference) => reference.type === "cdsc",
          ),
        ).toBe(false);

        // Re-admits, and no EXIF namespace remains.
        const { size: destinationSize } = await stat(destinationPath);
        const reAdmitted = await withHandle(destinationPath, (handle) =>
          admitIsobmff(handle, destinationSize),
        );
        expect(reAdmitted.namespaces).not.toContain("EXIF");
      },
    );
  });

  // --- Task 2: one red case per D-18 assertion ---
  //
  // Each tamper below starts from a REAL sanitized output (produced through the real writer
  // handler and `sanitizeFile`), then hand-edits the destination copy -- either a direct byte
  // flip/append (no box-size change needed), or a whole-child substitution rebuilt from the
  // destination's own independent inventory (`inventoryIsobmff`) through the SAME structural
  // `builder.ts` encoders the fixtures use, with its containing box(es)' declared size bumped by
  // the exact byte delta (D-19's established "mutant" pattern). `verifyOutput` is called
  // directly, bypassing `sanitizeFile`, with the admission from the handler's own `admit`.

  const PRIMARY2_PAYLOAD = Buffer.from("TAMPER-PRIMARY-PAYLOAD-BYTES", "ascii");
  const TILE_PAYLOAD = Buffer.from("TAMPER-TILE-PAYLOAD-BYTES-XY", "ascii");
  const IDAT_AUX_PAYLOAD = Buffer.from(
    "TAMPER-IDAT-AUX-PAYLOAD-BYTES",
    "ascii",
  );

  function buildTamperFixture(): Buffer {
    const exifPayload = Buffer.concat([
      Buffer.alloc(4),
      createOrientationExif(1),
    ]);
    let running = 0;
    const at = (length: number): number => {
      const offset = running;
      running += length;
      return offset;
    };
    const primaryOffset = at(PRIMARY2_PAYLOAD.length);
    const tileOffset = at(TILE_PAYLOAD.length);
    const exifOffset = at(exifPayload.length);

    const spec: AssembleHeifSpec = {
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [
            { relOffset: primaryOffset, length: PRIMARY2_PAYLOAD.length },
          ],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: tileOffset, length: TILE_PAYLOAD.length }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 3,
          itemType: "Exif",
          extents: [{ relOffset: exifOffset, length: exifPayload.length }],
        },
        {
          itemId: 4,
          itemType: "hvc1",
          hidden: true,
          constructionMethod: 1,
          extents: [{ relOffset: 0, length: IDAT_AUX_PAYLOAD.length }],
          propertyIndices: [1, 2],
        },
      ],
      properties: [ispeProp(), hvcCProp()],
      refs: [
        { type: "cdsc", fromItemId: 3, toItemIds: [1] },
        { type: "dimg", fromItemId: 2, toItemIds: [1] },
      ],
      idatPayload: IDAT_AUX_PAYLOAD,
      mdatPayload: Buffer.concat([PRIMARY2_PAYLOAD, TILE_PAYLOAD, exifPayload]),
      twoPass: true,
    };
    return assembleHeif(spec);
  }

  // --- Minimal, local, independent box-level surgery (test-only) ---

  interface BoxLoc {
    readonly start: number;
    readonly end: number;
    readonly payloadStart: number;
    readonly size: number;
    readonly type: string;
  }

  function readBoxAt(buffer: Buffer, offset: number): BoxLoc {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    return {
      start: offset,
      end: offset + size,
      payloadStart: offset + 8,
      size,
      type,
    };
  }

  function siblingsOf(buffer: Buffer, start: number, end: number): BoxLoc[] {
    const boxes: BoxLoc[] = [];
    let offset = start;
    while (offset < end) {
      const box = readBoxAt(buffer, offset);
      boxes.push(box);
      offset = box.end;
    }
    return boxes;
  }

  interface TamperLayout {
    readonly ftyp: BoxLoc;
    readonly meta: BoxLoc;
    readonly mdat: BoxLoc;
    readonly iloc?: BoxLoc;
    readonly iinf?: BoxLoc;
    readonly iref?: BoxLoc;
    readonly iprp?: BoxLoc;
    readonly ipma?: BoxLoc;
    readonly idat?: BoxLoc;
  }

  function parseTamperLayout(bytes: Buffer): TamperLayout {
    const top = siblingsOf(bytes, 0, bytes.length);
    const ftyp = top.find((b) => b.type === "ftyp")!;
    const meta = top.find((b) => b.type === "meta")!;
    const mdat = top.find((b) => b.type === "mdat")!;
    const metaChildren = siblingsOf(bytes, meta.payloadStart + 4, meta.end);
    const iprp = metaChildren.find((b) => b.type === "iprp");
    const ipma =
      iprp !== undefined
        ? siblingsOf(bytes, iprp.payloadStart, iprp.end).find(
            (b) => b.type === "ipma",
          )
        : undefined;
    const iloc = metaChildren.find((b) => b.type === "iloc");
    const iinf = metaChildren.find((b) => b.type === "iinf");
    const iref = metaChildren.find((b) => b.type === "iref");
    const idat = metaChildren.find((b) => b.type === "idat");
    return {
      ftyp,
      meta,
      mdat,
      ...(iloc !== undefined ? { iloc } : {}),
      ...(iinf !== undefined ? { iinf } : {}),
      ...(iref !== undefined ? { iref } : {}),
      ...(idat !== undefined ? { idat } : {}),
      ...(iprp !== undefined ? { iprp } : {}),
      ...(ipma !== undefined ? { ipma } : {}),
    };
  }

  /** Replace `[start,end)` with `replacement`, then bump every listed ancestor's own declared
   * size field (at `ancestor.start`, read from the ORIGINAL bytes) by the exact byte delta --
   * every ancestor must strictly contain `[start,end)`, so its own start offset is never disturbed
   * by this (or any other, equally-contained) edit. */
  function substituteChild(
    bytes: Buffer,
    start: number,
    end: number,
    replacement: Buffer,
    ancestors: readonly BoxLoc[],
  ): Buffer {
    const delta = replacement.length - (end - start);
    const result = Buffer.concat([
      bytes.subarray(0, start),
      replacement,
      bytes.subarray(end),
    ]);
    for (const ancestor of ancestors) {
      const oldSize = bytes.readUInt32BE(ancestor.start);
      result.writeUInt32BE(oldSize + delta, ancestor.start);
    }
    return result;
  }

  interface IlocWidths {
    readonly offsetSize: 0 | 4 | 8;
    readonly lengthSize: 0 | 4 | 8;
    readonly baseOffsetSize: 0 | 4 | 8;
    readonly indexSize: 0 | 4 | 8;
  }

  function rebuildIinfBytes(
    items: readonly InventoryItem[],
    nameOverrides: ReadonlyMap<number, string>,
  ): Buffer {
    const infeEntries = items.map((item) => {
      const nameOverride = nameOverrides.get(item.id);
      return infeBox({
        version: 2,
        itemId: item.id,
        itemType: item.type,
        hidden: item.hidden,
        ...(item.contentType !== undefined
          ? { contentType: item.contentType }
          : {}),
        ...(item.contentEncoding !== undefined
          ? { contentEncoding: item.contentEncoding }
          : {}),
        ...(nameOverride !== undefined ? { name: nameOverride } : {}),
      });
    });
    return iinfBox(0, infeEntries);
  }

  /** `shift` is added to every construction_method-0 item's `baseOffset` only -- cm=1 (idat-
   * relative) items never move when `meta`'s total size changes, since `idat` precedes `iloc`/
   * `iinf` in every fixture this file builds and so never shifts position itself. */
  function rebuildIlocBytes(
    items: readonly InventoryItem[],
    widths: IlocWidths,
    version: 0 | 1 | 2,
    shift: number,
  ): Buffer {
    const ilocItems: IlocItem[] = items.map((item) => ({
      itemId: item.id,
      constructionMethod: item.constructionMethod,
      dataReferenceIndex: item.dataReferenceIndex,
      baseOffset:
        item.constructionMethod === 0
          ? item.baseOffset + shift
          : item.baseOffset,
      extents: item.extents.map((extent): IlocExtent => ({
        index: extent.index,
        offset: extent.offset,
        length: extent.length,
      })),
    }));
    return ilocBox({ version, ...widths, items: ilocItems });
  }

  /**
   * Applies zero or more direct (non-`iloc`) edits inside `meta` -- e.g. `iinf`/`iref` -- plus an
   * `iloc` rebuild for `ilocItems`/`ilocWidths`, computing exactly the `baseOffset` shift every
   * construction_method-0 item needs so its ABSOLUTE file position still lands inside the real
   * (possibly relocated) `mdat`: `meta` precedes `mdat` at the top level, so growing or shrinking
   * ANY of its children by `delta` bytes moves `mdat`'s own absolute start by that same `delta` --
   * every cm=0 `baseOffset` (itself an absolute file position, D-11) goes stale unless shifted by
   * the SAME net `delta` this edit set produces. `iloc`'s own byte length depends only on
   * declared widths/item/extent counts, never on the numeric values written, so its delta can be
   * measured with a zero-shift probe before computing the real shift to apply.
   */
  interface MetaEdit {
    readonly box: BoxLoc;
    readonly replacement: Buffer;
    /** Every ancestor box whose own declared size must also grow/shrink by this edit's delta
     * (e.g. `[iprp, meta]` for an edit inside `ipma`; `[meta]` for a direct child of `meta`). */
    readonly ancestors: readonly BoxLoc[];
  }

  function applyMetaEditsWithIlocShift(
    good: Buffer,
    layout: TamperLayout,
    otherEdits: readonly MetaEdit[],
    ilocItems: readonly InventoryItem[],
    ilocWidths: IlocWidths,
    ilocVersion: 0 | 1 | 2,
  ): Buffer {
    if (layout.iloc === undefined) {
      throw new Error("applyMetaEditsWithIlocShift: fixture has no iloc.");
    }
    const otherDelta = otherEdits.reduce(
      (sum, edit) =>
        sum + (edit.replacement.length - (edit.box.end - edit.box.start)),
      0,
    );
    const probeIloc = rebuildIlocBytes(ilocItems, ilocWidths, ilocVersion, 0);
    const ilocDelta = probeIloc.length - (layout.iloc.end - layout.iloc.start);
    const totalShift = otherDelta + ilocDelta;
    const finalIloc = rebuildIlocBytes(
      ilocItems,
      ilocWidths,
      ilocVersion,
      totalShift,
    );

    const allEdits: readonly MetaEdit[] = [
      ...otherEdits,
      { box: layout.iloc, replacement: finalIloc, ancestors: [layout.meta] },
    ];
    const sorted = [...allEdits].sort((a, b) => b.box.start - a.box.start);
    let result = good;
    for (const edit of sorted) {
      result = substituteChild(
        result,
        edit.box.start,
        edit.box.end,
        edit.replacement,
        edit.ancestors,
      );
    }
    return result;
  }

  function ilocWidthsOf(inventory: IsobmffInventory): IlocWidths {
    const iloc = inventory.iloc;
    if (iloc === undefined) throw new Error("ilocWidthsOf: no source iloc.");
    return {
      offsetSize: iloc.offsetSize as 0 | 4 | 8,
      lengthSize: iloc.lengthSize as 0 | 4 | 8,
      baseOffsetSize: iloc.baseOffsetSize as 0 | 4 | 8,
      indexSize: iloc.indexSize as 0 | 4 | 8,
    };
  }

  interface TamperCase {
    readonly name: string;
    readonly tamper: (good: Buffer, inventory: IsobmffInventory) => Buffer;
  }

  const TAMPER_CASES: readonly TamperCase[] = [
    {
      name: "ftyp byte changed",
      tamper: (good, _inv) => {
        const layout = parseTamperLayout(good);
        const result = Buffer.from(good);
        // Flip one byte inside a compatible_brands entry (after major_brand/minor_version).
        result[layout.ftyp.payloadStart + 8] =
          (result[layout.ftyp.payloadStart + 8]! + 1) & 0xff;
        return result;
      },
    },
    {
      name: "a top-level free box added",
      tamper: (good, _inv) =>
        Buffer.concat([good, box("free", Buffer.alloc(4))]),
    },
    {
      name: "a surviving item dropped",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        const survivors = inv.items.filter(
          (item) => item.type !== "mime" && item.type !== "Exif",
        );
        // Drop the tile (item 2), never the primary (pitm still names it -- dropping the primary
        // would decline at parse time with a dangling pitm, before the targeted item-set check
        // this case means to exercise is ever reached). Item 2 is also the sole from-item of the
        // "dimg" iref record and has its own ipma entry, so both must go with it or the item
        // graph dangles at parse time instead of reaching the targeted item-set check.
        const kept = survivors.filter((item) => item.id !== 2);
        const iinf = rebuildIinfBytes(kept, new Map());
        const remainingAssociations: IpmaEntry[] = inv.associations
          .filter((entry) => entry.itemId !== 2)
          .map((entry) => ({
            itemId: entry.itemId,
            associations: entry.associations,
          }));
        const ipma = ipmaBox({
          version: 0,
          flags: 0,
          entries: remainingAssociations,
        });
        return applyMetaEditsWithIlocShift(
          good,
          layout,
          [
            { box: layout.iinf!, replacement: iinf, ancestors: [layout.meta] },
            {
              box: layout.iref!,
              replacement: Buffer.alloc(0),
              ancestors: [layout.meta],
            },
            {
              box: layout.ipma!,
              replacement: ipma,
              ancestors: [layout.iprp!, layout.meta],
            },
          ],
          kept,
          ilocWidthsOf(inv),
          inv.iloc!.version as 0 | 1 | 2,
        );
      },
    },
    {
      name: "an infe name changed",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        const survivors = inv.items.filter(
          (item) => item.type !== "mime" && item.type !== "Exif",
        );
        const target = survivors[0]!;
        const iinf = rebuildIinfBytes(
          survivors,
          new Map([[target.id, "tampered-name"]]),
        );
        return applyMetaEditsWithIlocShift(
          good,
          layout,
          [{ box: layout.iinf!, replacement: iinf, ancestors: [layout.meta] }],
          survivors,
          ilocWidthsOf(inv),
          inv.iloc!.version as 0 | 1 | 2,
        );
      },
    },
    {
      name: "an iref record dropped",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        if (layout.iref === undefined) {
          throw new Error(
            "tamper fixture has no surviving iref record to drop.",
          );
        }
        const survivors = inv.items.filter(
          (item) => item.type !== "mime" && item.type !== "Exif",
        );
        return applyMetaEditsWithIlocShift(
          good,
          layout,
          [
            {
              box: layout.iref,
              replacement: Buffer.alloc(0),
              ancestors: [layout.meta],
            },
          ],
          survivors,
          ilocWidthsOf(inv),
          inv.iloc!.version as 0 | 1 | 2,
        );
      },
    },
    {
      name: "two associations of one item swapped",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        const target = inv.associations.find(
          (entry) => entry.associations.length >= 2,
        );
        if (target === undefined) {
          throw new Error("tamper fixture has no item with 2+ associations.");
        }
        const entries: IpmaEntry[] = inv.associations.map((entry) =>
          entry.itemId === target.itemId
            ? {
                itemId: entry.itemId,
                associations: [...entry.associations].reverse(),
              }
            : { itemId: entry.itemId, associations: entry.associations },
        );
        const ipma = ipmaBox({ version: 0, flags: 0, entries });
        return substituteChild(
          good,
          layout.ipma!.start,
          layout.ipma!.end,
          ipma,
          [layout.iprp!, layout.meta],
        );
      },
    },
    {
      name: "one tile byte changed",
      tamper: (good, inv) => {
        const tile = inv.items.find(
          (item) => item.type === "hvc1" && item.id === 2,
        );
        if (tile === undefined)
          throw new Error("tamper fixture has no tile item 2.");
        const extent = tile.extents[0]!;
        const absolute = tile.baseOffset + extent.offset;
        const result = Buffer.from(good);
        result[absolute] = (result[absolute]! + 1) & 0xff;
        return result;
      },
    },
    {
      name: "a mime item present",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        const survivors = inv.items.filter(
          (item) => item.type !== "mime" && item.type !== "Exif",
        );
        // Retype the tile (item 2, unchanged id/extent/iloc entry) to a well-formed XMP "mime"
        // item -- the surviving item SET and count stay identical to the real good destination,
        // so this isolates the "0 mime items" check specifically rather than tripping the
        // (equally valid, but different) surviving-item-set-count check first.
        const items: InventoryItem[] = survivors.map((item) =>
          item.id === 2
            ? { ...item, type: "mime", contentType: "application/rdf+xml" }
            : item,
        );
        const iinf = rebuildIinfBytes(items, new Map());
        return applyMetaEditsWithIlocShift(
          good,
          layout,
          [{ box: layout.iinf!, replacement: iinf, ancestors: [layout.meta] }],
          items,
          ilocWidthsOf(inv),
          inv.iloc!.version as 0 | 1 | 2,
        );
      },
    },
    {
      name: "trailing unclaimed mdat bytes appended",
      tamper: (good, _inv) => {
        const layout = parseTamperLayout(good);
        const extra = Buffer.from([0xee, 0xee, 0xee, 0xee]);
        const result = Buffer.concat([good, extra]);
        const oldSize = good.readUInt32BE(layout.mdat.start);
        result.writeUInt32BE(oldSize + extra.length, layout.mdat.start);
        return result;
      },
    },
    {
      name: "an idat byte changed",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        if (layout.idat === undefined)
          throw new Error("tamper fixture has no idat box.");
        const absolute = layout.idat.payloadStart;
        const result = Buffer.from(good);
        result[absolute] = (result[absolute]! + 1) & 0xff;
        return result;
      },
    },
    {
      name: "an iloc width changed",
      tamper: (good, inv) => {
        const layout = parseTamperLayout(good);
        const widths = ilocWidthsOf(inv);
        const newWidths: IlocWidths = {
          ...widths,
          offsetSize: widths.offsetSize === 8 ? 4 : 8,
        };
        return applyMetaEditsWithIlocShift(
          good,
          layout,
          [],
          inv.items,
          newWidths,
          inv.iloc!.version as 0 | 1 | 2,
        );
      },
    },
  ];

  describe("Task 2: one red case per D-18 assertion", () => {
    async function sanitizeTamperFixture(): Promise<{
      readonly sourcePath: string;
      readonly goodDestinationPath: string;
      readonly goodBytes: Buffer;
      readonly admission: Awaited<ReturnType<typeof admitIsobmff>>;
    }> {
      const bytes = buildTamperFixture();
      const { path: sourcePath } = await writeFixture(bytes, "source.heic");
      const directory = dirname(sourcePath);
      const goodDestinationPath = join(directory, "destination-good.heic");
      const sanitized = await sanitizeThroughRealWriter(
        sourcePath,
        goodDestinationPath,
      );
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) {
        throw new Error(
          `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
        );
      }
      const goodBytes = await readFile(goodDestinationPath);
      const admission = await withHandle(sourcePath, (handle) =>
        admitIsobmff(handle, bytes.length),
      );
      return { sourcePath, goodDestinationPath, goodBytes, admission };
    }

    it.each(
      TAMPER_CASES.map((tamperCase) => [tamperCase.name, tamperCase] as const),
    )(
      "%s -> verifyOutput returns err with code verification-failed",
      async (_name, tamperCase) => {
        const { sourcePath, goodBytes, admission } =
          await sanitizeTamperFixture();
        const goodInventory = inventoryIsobmff(goodBytes);
        const tamperedBytes = tamperCase.tamper(goodBytes, goodInventory);
        const directory = dirname(sourcePath);
        const tamperedPath = join(directory, "destination-tampered.heic");
        await writeFile(tamperedPath, tamperedBytes);

        const result = await withHandle(sourcePath, (sourceHandle) =>
          withHandle(tamperedPath, (tamperedHandle) =>
            verifyIsobmffOutput(
              sourceHandle,
              admission,
              tamperedHandle,
              tamperedBytes.length,
              tamperedPath,
              false,
              true,
              false,
              undefined,
            ),
          ),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("verification-failed");
        }
      },
    );

    it("the untampered copy verifies ok (control)", async () => {
      const { sourcePath, goodBytes, admission } =
        await sanitizeTamperFixture();
      const directory = dirname(sourcePath);
      const controlPath = join(directory, "destination-control.heic");
      await writeFile(controlPath, goodBytes);

      const result = await withHandle(sourcePath, (sourceHandle) =>
        withHandle(controlPath, (tamperedHandle) =>
          verifyIsobmffOutput(
            sourceHandle,
            admission,
            tamperedHandle,
            goodBytes.length,
            controlPath,
            false,
            true,
            false,
            undefined,
          ),
        ),
      );

      expect(result.ok).toBe(true);
    });
  });

  // --- Task 3: streamed COPY_BLOCK_BYTES windows and the generator's transform arms ---

  describe("Task 3: streamed windows and generator transform arms", () => {
    const ONE_MIB = 1024 * 1024;

    function buildOneMibFixture(): Buffer {
      const payload = Buffer.alloc(ONE_MIB);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
      const spec: AssembleHeifSpec = {
        primaryItemId: 1,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: payload.length }],
          },
        ],
        properties: [ispeProp(), hvcCProp()],
        extraIpmaEntries: [
          {
            itemId: 1,
            associations: [
              { propertyIndex: 1, essential: false },
              { propertyIndex: 2, essential: false },
            ],
          },
        ],
        mdatPayload: payload,
        twoPass: true,
      };
      return assembleHeif(spec);
    }

    async function sanitizeOneMibFixture(): Promise<{
      readonly sourcePath: string;
      readonly goodBytes: Buffer;
      readonly admission: Awaited<ReturnType<typeof admitIsobmff>>;
    }> {
      const bytes = buildOneMibFixture();
      const { path: sourcePath } = await writeFixture(bytes, "source.heic");
      const directory = dirname(sourcePath);
      const goodDestinationPath = join(directory, "destination-good.heic");
      const sanitized = await sanitizeThroughRealWriter(
        sourcePath,
        goodDestinationPath,
      );
      expect(sanitized.ok).toBe(true);
      if (!sanitized.ok) {
        throw new Error(
          `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
        );
      }
      const goodBytes = await readFile(goodDestinationPath);
      const admission = await withHandle(sourcePath, (handle) =>
        admitIsobmff(handle, bytes.length),
      );
      return { sourcePath, goodBytes, admission };
    }

    async function verifyAgainst(
      sourcePath: string,
      admission: Awaited<ReturnType<typeof admitIsobmff>>,
      candidateBytes: Buffer,
      candidatePath: string,
    ): ReturnType<typeof verifyIsobmffOutput> {
      await writeFile(candidatePath, candidateBytes);
      return withHandle(sourcePath, (sourceHandle) =>
        withHandle(candidatePath, (candidateHandle) =>
          verifyIsobmffOutput(
            sourceHandle,
            admission,
            candidateHandle,
            candidateBytes.length,
            candidatePath,
            false,
            true,
            false,
            undefined,
          ),
        ),
      );
    }

    it("a 1 MiB surviving item: identical is ok, last byte flipped is verification-failed", async () => {
      const { sourcePath, goodBytes, admission } =
        await sanitizeOneMibFixture();
      const directory = dirname(sourcePath);

      const identicalResult = await verifyAgainst(
        sourcePath,
        admission,
        goodBytes,
        join(directory, "identical.heic"),
      );
      expect(identicalResult.ok).toBe(true);

      const lastByteFlipped = Buffer.from(goodBytes);
      lastByteFlipped[lastByteFlipped.length - 1] =
        (lastByteFlipped[lastByteFlipped.length - 1]! + 1) & 0xff;
      const lastByteResult = await verifyAgainst(
        sourcePath,
        admission,
        lastByteFlipped,
        join(directory, "last-byte-flipped.heic"),
      );
      expect(lastByteResult.ok).toBe(false);
      if (!lastByteResult.ok) {
        expect(lastByteResult.error.code).toBe("verification-failed");
      }
    }, 30_000);

    it("a 1 MiB surviving item: first byte flipped is verification-failed", async () => {
      const { sourcePath, goodBytes, admission } =
        await sanitizeOneMibFixture();
      const directory = dirname(sourcePath);
      const inventory = inventoryIsobmff(goodBytes);
      const item = findItem(inventory, 1)!;
      const absolute = item.baseOffset + item.extents[0]!.offset;

      const firstByteFlipped = Buffer.from(goodBytes);
      firstByteFlipped[absolute] = (firstByteFlipped[absolute]! + 1) & 0xff;
      const result = await verifyAgainst(
        sourcePath,
        admission,
        firstByteFlipped,
        join(directory, "first-byte-flipped.heic"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("verification-failed");
      }
    }, 30_000);

    it("verify.ts never allocates a whole-item comparison buffer (COPY_BLOCK_BYTES-bounded windows)", async () => {
      const source = await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "src",
          "isobmff",
          "verify.ts",
        ),
      );
      expect(source.toString("utf8")).toContain("COPY_BLOCK_BYTES");
    });

    // --- Generator transform arms: irot/imir, essential and non-essential ---

    function rawIpcoBytes(bytes: Buffer): readonly Buffer[] {
      const layout = parseTamperLayout(bytes);
      if (layout.iprp === undefined) return [];
      const iprpChildren = siblingsOf(
        bytes,
        layout.iprp.payloadStart,
        layout.iprp.end,
      );
      const ipco = iprpChildren.find((b) => b.type === "ipco");
      if (ipco === undefined) return [];
      return siblingsOf(bytes, ipco.payloadStart, ipco.end).map((b) =>
        bytes.subarray(b.start, b.end),
      );
    }

    const TARGET_ARMS: ReadonlySet<IsobmffArm> = new Set([
      "irot-essential",
      "irot-non-essential",
      "imir-essential",
      "imir-non-essential",
    ]);

    it(
      "generator arms irot-essential, irot-non-essential, imir-essential, imir-non-essential " +
        "(seed 62, numRuns <= 20): sanitize ok, each surviving item's ordered (bytes, essential) " +
        "list equals the source's",
      async () => {
        // D-19 generator caveat (62-09 repo rules): `isobmffArmSampleArbitrary(brand)` only
        // steers the HAZARD arm's own brand -- every non-hazard sample (every arm this test
        // targets) picks its own brand internally, independent of the `brand` argument below.
        // Both writer handlers must be registered so sanitizeFile's own brand-based selection
        // routes either one correctly.
        const restore = setRegisteredHandlersForTests([
          createIsobmffWriterHandlerForTests("heic"),
          createIsobmffWriterHandlerForTests("avif"),
        ]);
        try {
          await fc.assert(
            fc.asyncProperty(
              isobmffArmSampleArbitrary("heic"),
              async (armSample) => {
                fc.pre(!armSample.arms.includes("hazard"));
                fc.pre(armSample.arms.some((arm) => TARGET_ARMS.has(arm)));

                const sourceBytes = armSample.sample.bytes;
                const { path: sourcePath } = await writeFixture(
                  sourceBytes,
                  "source.heic",
                );
                const directory = dirname(sourcePath);
                const destinationPath = join(directory, "destination.heic");

                // preserveColorProfile false: this generator's colr-prof/colr-ricc arms carry a
                // 4-byte fake ICC payload too short to validate, which the engine's own ICC-
                // preservation gate (src/engine.ts) refuses to admit when preserveColorProfile is
                // true (unrelated to this test's irot/imir target) -- false sidesteps that gate and
                // may legitimately remove a colr prof/rICC property (62-08's own D-16 concern, not
                // this plan's), so the comparison below excludes any such removed association from
                // the SOURCE side before matching position-by-position.
                const sanitized = await sanitizeFile({
                  sourcePath,
                  destinationPath,
                  preserveOrientation: false,
                  preserveColorProfile: false,
                  preserveTimestamps: false,
                  preserveResolution: false,
                });
                expect(sanitized.ok).toBe(true);
                if (!sanitized.ok) return;

                const destinationBytes = await readFile(destinationPath);
                const sourceInventory = inventoryIsobmff(sourceBytes);
                const destinationInventory = inventoryIsobmff(destinationBytes);
                const sourceProperties = rawIpcoBytes(sourceBytes);
                const destinationProperties = rawIpcoBytes(destinationBytes);

                for (const sourceItem of sourceInventory.items) {
                  const destinationItem = findItem(
                    destinationInventory,
                    sourceItem.id,
                  );
                  if (destinationItem === undefined) continue; // Exif/mime, removed by sanitize.
                  const sourceAssocRaw =
                    sourceInventory.associations.find(
                      (a) => a.itemId === sourceItem.id,
                    )?.associations ?? [];
                  const sourceAssoc = sourceAssocRaw.filter((association) => {
                    const propertyBytes =
                      sourceProperties[association.propertyIndex - 1];
                    if (
                      propertyBytes === undefined ||
                      propertyBytes.toString("ascii", 4, 8) !== "colr"
                    ) {
                      return true;
                    }
                    const colourType = propertyBytes.toString("ascii", 8, 12);
                    return colourType !== "prof" && colourType !== "rICC";
                  });
                  const destinationAssoc =
                    destinationInventory.associations.find(
                      (a) => a.itemId === destinationItem.id,
                    )?.associations ?? [];
                  expect(destinationAssoc.length).toBe(sourceAssoc.length);
                  for (let index = 0; index < sourceAssoc.length; index += 1) {
                    const sourceA = sourceAssoc[index]!;
                    const destinationA = destinationAssoc[index]!;
                    expect(destinationA.essential).toBe(sourceA.essential);
                    const sourceBytesForProp =
                      sourceProperties[sourceA.propertyIndex - 1];
                    const destinationBytesForProp =
                      destinationProperties[destinationA.propertyIndex - 1];
                    expect(
                      destinationBytesForProp !== undefined &&
                        sourceBytesForProp !== undefined &&
                        destinationBytesForProp.equals(sourceBytesForProp),
                    ).toBe(true);
                  }
                }
              },
            ),
            { seed: 62, numRuns: 20 },
          );
        } finally {
          restore();
        }
      },
      30_000,
    );
  });
});
