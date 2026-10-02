// D-13 source item k (62-03): `admitIsobmff` must read orientation and resolution only from the
// first non-emptied Exif item, in `iinf` order, whose `cdsc` reference's to-list contains
// `model.primaryItemId` -- never from an Exif item on an auxiliary image or thumbnail. This closes
// the measured Phase 61 defect at `src/isobmff/admission.ts:463-464` (verified against the
// unmodified module, see the comment on the first test below) and pins the edges D-13 names:
// ordering, thumbnail-only, emptied, and resolution scope. The two committed `heif-enc` fixtures
// are also re-checked so the narrowing leaves their measured k (item 6, RECIPE.md) and entry count
// unchanged.
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
import {
  createMinimalExif,
  createOrientationExif,
} from "../src/metadata/exif.js";
import { sanitizeFile, inspectFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
} from "./isobmff-support/hostile.js";
import { auxC } from "./isobmff-support/builder.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
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
    join(tmpdir(), "exifcleaner-isobmff-minimal-exif-"),
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

/** A 4-byte `exif_tiff_header_offset` of 0, followed directly by a minimal TIFF/Exif payload. */
function exifPayload(tiff: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), tiff]);
}

/** D-03's resolution shape, built from plain x/y integers at denominator 1 (no unit tag). */
function resolutionOf(x: number, y: number) {
  return {
    x: { numerator: x, denominator: 1 },
    y: { numerator: y, denominator: 1 },
  };
}

describe("D-13 source item k (62-03)", () => {
  describe("Task 1: aux-Exif orientation must not reach the primary", () => {
    /**
     * Fixture: primary `hvc1` item 1; auxiliary `hvc1` item 2 (an `auxC` property, an `auxl`
     * reference to the primary); Exif item 3 (`cdsc` -> primary, no Orientation tag, carries its
     * own resolution 72x72); Exif item 4 (`cdsc` -> the auxiliary, Orientation 6). Item 3 precedes
     * item 4 in `iinf` order (the `items` array order `assembleHeif` emits in), so item 3 is the
     * only candidate for k under D-13 (the first Exif item whose `cdsc` to-list contains `pitm`).
     */
    function buildAuxExifFixture(): Buffer {
      const primaryPayload = Buffer.from("primary-bytes", "ascii");
      const auxPayload = Buffer.from("aux-bytes", "ascii");
      const exifPrimaryPayload = exifPayload(
        createMinimalExif({ resolution: resolutionOf(72, 72) }),
      );
      const exifAuxPayload = exifPayload(createOrientationExif(6));

      const spec: AssembleHeifSpec = {
        primaryItemId: 1,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: primaryPayload.length }],
          },
          {
            itemId: 2,
            itemType: "hvc1",
            hidden: true,
            propertyIndices: [1],
            extents: [
              { relOffset: primaryPayload.length, length: auxPayload.length },
            ],
          },
          {
            itemId: 3,
            itemType: "Exif",
            hidden: true,
            extents: [
              {
                relOffset: primaryPayload.length + auxPayload.length,
                length: exifPrimaryPayload.length,
              },
            ],
          },
          {
            itemId: 4,
            itemType: "Exif",
            hidden: true,
            extents: [
              {
                relOffset:
                  primaryPayload.length +
                  auxPayload.length +
                  exifPrimaryPayload.length,
                length: exifAuxPayload.length,
              },
            ],
          },
        ],
        properties: [auxC("urn:com:apple:photo:2020:aux:hdrgainmap")],
        refs: [
          { type: "auxl", fromItemId: 2, toItemIds: [1] },
          { type: "cdsc", fromItemId: 3, toItemIds: [1] },
          { type: "cdsc", fromItemId: 4, toItemIds: [2] },
        ],
        mdatPayload: Buffer.concat([
          primaryPayload,
          auxPayload,
          exifPrimaryPayload,
          exifAuxPayload,
        ]),
        twoPass: true,
      };

      return assembleHeif(spec);
    }

    it(
      "recorded RED (first run against the unmodified admission.ts): orientation.status was " +
        "\"valid\" value 6 -- the auxiliary item's Orientation leaked onto the primary's " +
        "admission. Scratch run (git-stashed src/isobmff/admission.ts, this fixture, direct " +
        "admitIsobmff call): " +
        "`{ exifSourceItemId: undefined, orientation: { status: 'valid', value: 6 }, " +
        "sourceResolution: undefined }`. After the fix (same fixture): " +
        "`{ exifSourceItemId: 3, orientation: { status: 'absent' }, sourceResolution: " +
        "{ x: { numerator: 72, denominator: 1 }, y: { numerator: 72, denominator: 1 } } }`. " +
        "This assertion itself only pins the post-fix (GREEN) shape; the RED transcript above is " +
        "the record required by the plan.",
      async () => {
        const bytes = buildAuxExifFixture();
        const { path, size } = await writeFixture(bytes);
        const admission = await withHandle(path, (handle) =>
          admitIsobmff(handle, size),
        );

        expect(admission.exifSourceItemId).toBe(3);
        expect(admission.orientation).toEqual({ status: "absent" });
        expect(admission.sourceResolution).toEqual(resolutionOf(72, 72));
      },
    );

    it(
      "sanitizeFile (writer handler, preserveOrientation true) writes no leaked Orientation tag " +
        "in the output's one minimal Exif item (62-07: the writer now synthesizes minimal Exif at " +
        "k, item 3) -- the aux item's Orientation 6 never reaches k's payload, but k's own " +
        "resolution (72x72) does",
      async () => {
        const bytes = buildAuxExifFixture();
        const { path: sourcePath, size } = await writeFixture(
          bytes,
          "source.heic",
        );
        const directory = dirname(sourcePath);
        const destinationPath = join(directory, "destination.heic");

        const restore = setRegisteredHandlersForTests([
          createIsobmffWriterHandlerForTests("heic"),
        ]);
        try {
          const sanitized = await sanitizeFile({
            sourcePath,
            destinationPath,
            preserveOrientation: true,
            preserveColorProfile: true,
            preserveTimestamps: false,
            preserveResolution: true,
          });
          expect(sanitized.ok).toBe(true);
          if (!sanitized.ok) {
            throw new Error(
              `sanitizeFile failed: ${JSON.stringify(sanitized.error)}`,
            );
          }

          const destinationBytes = await readFile(destinationPath);
          const destinationInventory = inventoryIsobmff(destinationBytes);
          const exifItems = destinationInventory.items.filter(
            (item) => item.type === "Exif",
          );
          expect(exifItems.map((item) => item.id)).toEqual([3]);

          const { size: destinationSize } = await stat(destinationPath);
          const destinationAdmission = await withHandle(
            destinationPath,
            (handle) => admitIsobmff(handle, destinationSize),
          );
          expect(destinationAdmission.exifSourceItemId).toBe(3);
          expect(destinationAdmission.orientation).toEqual({
            status: "absent",
          });
          expect(destinationAdmission.sourceResolution).toEqual(
            resolutionOf(72, 72),
          );

          const sourceAdmission = await withHandle(sourcePath, (handle) =>
            admitIsobmff(handle, size),
          );
          expect(sourceAdmission.orientation).toEqual({ status: "absent" });
        } finally {
          restore();
        }
      },
    );
  });

  describe("Task 2: k selection edges", () => {
    it("ordering: two Exif items both cdsc -> pitm; k is the first in iinf order", async () => {
      const primaryPayload = Buffer.from("primary", "ascii");
      const payloadA = exifPayload(
        createMinimalExif({
          orientation: 3,
          resolution: resolutionOf(300, 300),
        }),
      );
      const payloadB = exifPayload(
        createMinimalExif({ orientation: 8, resolution: resolutionOf(96, 96) }),
      );

      function buildOrdered(firstIsA: boolean): AssembleHeifSpec {
        const first = firstIsA ? payloadA : payloadB;
        const second = firstIsA ? payloadB : payloadA;
        const firstId = firstIsA ? 2 : 3;
        const secondId = firstIsA ? 3 : 2;
        return {
          primaryItemId: 1,
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              extents: [{ relOffset: 0, length: primaryPayload.length }],
            },
            {
              itemId: firstId,
              itemType: "Exif",
              hidden: true,
              extents: [
                { relOffset: primaryPayload.length, length: first.length },
              ],
            },
            {
              itemId: secondId,
              itemType: "Exif",
              hidden: true,
              extents: [
                {
                  relOffset: primaryPayload.length + first.length,
                  length: second.length,
                },
              ],
            },
          ],
          refs: [
            { type: "cdsc", fromItemId: 2, toItemIds: [1] },
            { type: "cdsc", fromItemId: 3, toItemIds: [1] },
          ],
          mdatPayload: Buffer.concat([primaryPayload, first, second]),
          twoPass: true,
        };
      }

      {
        const bytes = assembleHeif(buildOrdered(true));
        const { path, size } = await writeFixture(bytes, "a-first.heic");
        const admission = await withHandle(path, (handle) =>
          admitIsobmff(handle, size),
        );
        expect(admission.exifSourceItemId).toBe(2);
        expect(admission.orientation).toEqual({ status: "valid", value: 3 });
        expect(admission.sourceResolution).toEqual(resolutionOf(300, 300));
      }

      {
        const bytes = assembleHeif(buildOrdered(false));
        const { path, size } = await writeFixture(bytes, "b-first.heic");
        const admission = await withHandle(path, (handle) =>
          admitIsobmff(handle, size),
        );
        expect(admission.exifSourceItemId).toBe(3);
        expect(admission.orientation).toEqual({ status: "valid", value: 8 });
        expect(admission.sourceResolution).toEqual(resolutionOf(96, 96));
      }
    });

    it("thumbnail-only: an Exif item cdsc -> the thumbnail only is never k", async () => {
      const primaryPayload = Buffer.from("primary", "ascii");
      const thumbPayload = Buffer.from("thumb", "ascii");
      const exifThumb = exifPayload(createOrientationExif(6));

      const spec: AssembleHeifSpec = {
        primaryItemId: 1,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: primaryPayload.length }],
          },
          {
            itemId: 2,
            itemType: "hvc1",
            extents: [
              { relOffset: primaryPayload.length, length: thumbPayload.length },
            ],
          },
          {
            itemId: 3,
            itemType: "Exif",
            hidden: true,
            extents: [
              {
                relOffset: primaryPayload.length + thumbPayload.length,
                length: exifThumb.length,
              },
            ],
          },
        ],
        refs: [
          { type: "thmb", fromItemId: 2, toItemIds: [1] },
          { type: "cdsc", fromItemId: 3, toItemIds: [2] },
        ],
        mdatPayload: Buffer.concat([primaryPayload, thumbPayload, exifThumb]),
        twoPass: true,
      };

      const bytes = assembleHeif(spec);
      const { path, size } = await writeFixture(bytes);
      const admission = await withHandle(path, (handle) =>
        admitIsobmff(handle, size),
      );

      expect(admission.exifSourceItemId).toBeUndefined();
      expect(admission.orientation).toEqual({ status: "absent" });
      expect(admission.sourceResolution).toBeUndefined();
    });

    it("emptied: the only Exif item, emptied (zero-length extent), has exifSourceItemId undefined", async () => {
      const primaryPayload = Buffer.from("primary", "ascii");

      const spec: AssembleHeifSpec = {
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
            extents: [{ relOffset: primaryPayload.length, length: 0 }],
          },
        ],
        refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
        mdatPayload: primaryPayload,
        twoPass: true,
      };

      const bytes = assembleHeif(spec);
      const { path, size } = await writeFixture(bytes);
      const admission = await withHandle(path, (handle) =>
        admitIsobmff(handle, size),
      );

      expect(admission.exifSourceItemId).toBeUndefined();
      expect(admission.orientation).toEqual({ status: "absent" });
    });

    it(
      "resolution scope: primary Exif without resolution, aux Exif with resolution -> " +
        "sourceResolution and resolutionNamespace stay undefined",
      async () => {
        const primaryPayload = Buffer.from("primary", "ascii");
        const auxPayload = Buffer.from("aux", "ascii");
        const exifPrimaryPayload = exifPayload(createOrientationExif(1));
        const exifAuxPayload = exifPayload(
          createMinimalExif({ resolution: resolutionOf(300, 300) }),
        );

        const spec: AssembleHeifSpec = {
          primaryItemId: 1,
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              extents: [{ relOffset: 0, length: primaryPayload.length }],
            },
            {
              itemId: 2,
              itemType: "hvc1",
              hidden: true,
              propertyIndices: [1],
              extents: [
                { relOffset: primaryPayload.length, length: auxPayload.length },
              ],
            },
            {
              itemId: 3,
              itemType: "Exif",
              hidden: true,
              extents: [
                {
                  relOffset: primaryPayload.length + auxPayload.length,
                  length: exifPrimaryPayload.length,
                },
              ],
            },
            {
              itemId: 4,
              itemType: "Exif",
              hidden: true,
              extents: [
                {
                  relOffset:
                    primaryPayload.length +
                    auxPayload.length +
                    exifPrimaryPayload.length,
                  length: exifAuxPayload.length,
                },
              ],
            },
          ],
          properties: [auxC("urn:com:apple:photo:2020:aux:hdrgainmap")],
          refs: [
            { type: "auxl", fromItemId: 2, toItemIds: [1] },
            { type: "cdsc", fromItemId: 3, toItemIds: [1] },
            { type: "cdsc", fromItemId: 4, toItemIds: [2] },
          ],
          mdatPayload: Buffer.concat([
            primaryPayload,
            auxPayload,
            exifPrimaryPayload,
            exifAuxPayload,
          ]),
          twoPass: true,
        };

        const bytes = assembleHeif(spec);
        const { path, size } = await writeFixture(bytes);
        const admission = await withHandle(path, (handle) =>
          admitIsobmff(handle, size),
        );

        expect(admission.exifSourceItemId).toBe(3);
        expect(admission.orientation).toEqual({ status: "valid", value: 1 });
        expect(admission.sourceResolution).toBeUndefined();
        expect(admission.resolutionNamespace).toBeUndefined();
      },
    );

    describe("committed heif-enc fixtures: k, orientation and entries unchanged", () => {
      it.each([
        ["heic", HEIC_FIXTURE],
        ["avif", AVIF_FIXTURE],
      ] as const)(
        "%s: exifSourceItemId is 6 and inspectFile entries are unchanged",
        async (brand, fixturePath) => {
          const fixtureBytes = await readFile(fixturePath);
          const admission = await withHandle(fixturePath, (handle) =>
            admitIsobmff(handle, fixtureBytes.length),
          );

          // Measured (RECIPE.md): both fixtures' only Exif item is id 6, with a `cdsc` reference to
          // the primary (item 1). Orientation 1, XResolution/YResolution 72/1 (measured via a
          // scratch admitIsobmff run on this plan's unmodified-at-the-time admission.ts, recorded in
          // the SUMMARY).
          expect(admission.exifSourceItemId).toBe(6);
          expect(admission.orientation).toEqual({ status: "valid", value: 1 });
          expect(admission.sourceResolution).toEqual(resolutionOf(72, 72));

          // inspectFile's entry count is unaffected by the k narrowing: `entries.push(...found.entries)`
          // runs unconditionally for every non-emptied Exif/mime item, regardless of which one is k.
          // Measured at 62-02 HEAD (before this plan's admission.ts edit): 9 entries for both fixtures.
          const restore = setRegisteredHandlersForTests([
            createIsobmffWriterHandlerForTests(brand),
          ]);
          try {
            const inspected = await inspectFile(fixturePath);
            expect(inspected.ok).toBe(true);
            if (!inspected.ok) {
              throw new Error(
                `inspectFile failed: ${JSON.stringify(inspected.error)}`,
              );
            }
            expect(inspected.value.entries.length).toBe(9);
          } finally {
            restore();
          }
        },
      );
    });
  });
});

// 62-07, Task 1 tracer: the writer half of D-13. `createMinimalExif`/`computeIsobmffMinimalExifTags`
// now actually synthesize and write the minimal Exif item, at k's own id, at the mdat tail -- the
// admission-side k selection above (62-03) only ever read values; nothing was written until now.
describe("D-13 minimal Exif writer (62-07)", () => {
  it.each([
    ["heic", HEIC_FIXTURE],
    ["avif", AVIF_FIXTURE],
  ] as const)(
    "%s: default settings (preserveOrientation/preserveResolution true) write exactly one " +
      "minimal Exif item at k's own id (6), carrying the source's own Orientation (1) and " +
      "resolution (72x72), with the source's Make/Model canaries absent from the whole output, " +
      "the payload's first four bytes zero, and the item's single extent ending at the mdat " +
      "payload end",
    async (brand, fixturePath) => {
      const directory = await freshDirectory();
      const sourcePath = join(directory, `source.${brand}`);
      await writeFile(sourcePath, await readFile(fixturePath));
      const destinationPath = join(directory, `destination.${brand}`);

      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests(brand),
      ]);
      try {
        const sanitized = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: true,
          preserveColorProfile: true,
          preserveTimestamps: true,
          preserveResolution: true,
        });
        expect(sanitized.ok).toBe(true);
        if (!sanitized.ok) {
          throw new Error(`sanitizeFile failed: ${JSON.stringify(sanitized.error)}`);
        }

        const destinationBytes = await readFile(destinationPath);
        const inventory = inventoryIsobmff(destinationBytes);

        const exifItems = inventory.items.filter((item) => item.type === "Exif");
        expect(exifItems.map((item) => item.id)).toEqual([6]);
        const exifItem = exifItems[0]!;
        expect(exifItem.constructionMethod).toBe(0);
        expect(exifItem.extents.length).toBe(1);

        const payload = readItemExtentBytes(destinationBytes, inventory, exifItem);
        expect(payload.readUInt32BE(0)).toBe(0);
        const expectedPayload = Buffer.concat([
          Buffer.alloc(4),
          createMinimalExif({ orientation: 1, resolution: resolutionOf(72, 72) }),
        ]);
        expect(payload.equals(expectedPayload)).toBe(true);

        // The item's single extent ends exactly at the mdat payload end.
        const mdatBox = inventory.topLevel.find((box) => box.type === "mdat");
        expect(mdatBox).toBeDefined();
        const extent = exifItem.extents[0]!;
        const extentEnd = exifItem.baseOffset + extent.offset + extent.length;
        expect(extentEnd).toBe(mdatBox!.offset + mdatBox!.size);

        // No canary string anywhere in the output.
        expect(destinationBytes.includes("ExifCleanerFixture")).toBe(false);
        expect(destinationBytes.includes("GridTile")).toBe(false);

        // Re-admits, and the destination's own admission agrees with the fixture's own source
        // values (never a leaked or re-derived value).
        const { size: destinationSize } = await stat(destinationPath);
        const destinationAdmission = await withHandle(destinationPath, (handle) =>
          admitIsobmff(handle, destinationSize),
        );
        expect(destinationAdmission.exifSourceItemId).toBe(6);
        expect(destinationAdmission.orientation).toEqual({ status: "valid", value: 1 });
        expect(destinationAdmission.sourceResolution).toEqual(resolutionOf(72, 72));
      } finally {
        restore();
      }
    },
  );
});
