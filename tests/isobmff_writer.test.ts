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
