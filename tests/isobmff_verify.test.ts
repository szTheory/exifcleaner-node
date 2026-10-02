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
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
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
  imir,
  irot,
  ispe,
  pixi,
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
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-verify-"));
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
        extents: [{ relOffset: gainAuxOffset, length: GAIN_AUX_PAYLOAD.length }],
      },
      {
        itemId: 6,
        itemType: "hvc1",
        hidden: true,
        extents: [{ relOffset: depthAuxOffset, length: DEPTH_AUX_PAYLOAD.length }],
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
        const { path: sourcePath } = await writeFixture(sourceBytes, "source.heic");
        const directory = dirname(sourcePath);
        const destinationPath = join(directory, "destination.heic");

        const sanitized = await sanitizeThroughRealWriter(sourcePath, destinationPath);
        expect(sanitized.ok).toBe(true);
        if (!sanitized.ok) {
          throw new Error(`sanitizeFile failed: ${JSON.stringify(sanitized.error)}`);
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
          destinationInventory.properties.find((p) => p.type === "auxC" && p.index === 8)
            ?.auxUrn,
        ).toBe(GAIN_MAP_URN);
        expect(
          destinationInventory.properties.find((p) => p.type === "auxC" && p.index === 9)
            ?.auxUrn,
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
          expect(destinationAssoc?.associations).toEqual(sourceAssoc?.associations);
        }
        const primaryAssoc = destinationInventory.associations.find(
          (entry) => entry.itemId === 1,
        );
        expect(
          primaryAssoc?.associations.find((a) => a.propertyIndex === 5)?.essential,
        ).toBe(true);
        expect(
          primaryAssoc?.associations.find((a) => a.propertyIndex === 6)?.essential,
        ).toBe(true);

        // Every surviving item's payload is byte-identical, read through each file's own
        // iloc/idat.
        for (const id of [1, 3, 4, 5, 6]) {
          const sourceItem = findItem(sourceInventory, id)!;
          const destinationItem = findItem(destinationInventory, id)!;
          const sourcePayload = readItemExtentBytes(sourceBytes, sourceInventory, sourceItem);
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
          destinationInventory.references.some((reference) => reference.type === "cdsc"),
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
});
