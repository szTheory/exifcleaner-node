// Hostile ISOBMFF/HEIF fixture catalog coverage (BMF-03, D-14): walks every `IsobmffDeclineClass`
// against its one catalog fixture, proves the D3 variants and D5 non-C2PA-uuid variant outside
// that catalog, pins `DECLINE_RULE_ORDER` determinism when several classes could apply, and covers
// the empty-input edges (zero items, no meta). `tests/isobmff-support/hostile.ts` is the one
// support module allowed a type-only import of `IsobmffDeclineClass` from `src/isobmff/errors.js`
// (see tests/isobmff_isolation.test.ts); this test file itself imports `src/isobmff/` freely.
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitIsobmff,
  type IsobmffAdmission,
} from "../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../src/isobmff/brand.js";
import type { BoxHeader } from "../src/isobmff/boxes.js";
import type { IsobmffItem } from "../src/isobmff/items.js";
import type { IsobmffOutputPlan } from "../src/isobmff/plan.js";
import {
  rebuildIinf,
  rebuildIloc,
  rebuildIref,
} from "../src/isobmff/rebuild.js";
import { COPY_BLOCK_BYTES } from "../src/io/copy-range.js";
import { inspectFile, sanitizeFile } from "../src/engine.js";
import {
  jpegHandler,
  type JpegAdmission,
  type JpegOutputPlan,
} from "../src/admission/jpeg-handler.js";
import {
  isJpegSignature,
  JpegStructureError,
  parseJpeg,
} from "../src/jpeg/parser.js";
import {
  ICC_SEGMENT_IDENTIFIER,
  reassembleIccSegments,
} from "../src/jpeg/icc.js";
import {
  MAX_PROFILE_BYTES,
  validateIccForPreservation,
} from "../src/metadata/icc_admission.js";
import {
  JPEG_MAX_EXTENDED_XMP_BYTES,
  JPEG_MAX_FILE_BYTES,
  JPEG_MAX_ICC_SEGMENTS,
  classifyAppPayload,
  classifyMarker,
  isAppMarker,
  isRestartMarker,
  type AppSegmentKind,
  type JpegRefusal,
  type MarkerClassification,
} from "../src/jpeg/markers.js";
import { classifyFallback } from "../src/fallback.js";
import { verifyIsobmffOutput } from "../src/isobmff/verify.js";
import { writeIsobmffOutput } from "../src/isobmff/writer.js";
import type { MetadataEntry, Result } from "../src/types.js";
import { classifyTrailerClasses } from "../src/jpeg/trailer.js";
import { reassembleExtendedXmp } from "../src/jpeg/xmp.js";
import {
  buildIsobmffOutputPlan,
  checkIsobmffOutputPlan,
} from "../src/isobmff/plan.js";
import {
  createMinimalExif,
  createOrientationExif,
  inBounds,
  parseExif,
  readIfd0Resolution,
} from "../src/metadata/exif.js";
import { parseIcc } from "../src/metadata/icc.js";
import { parseXmp, xmpOrientation } from "../src/metadata/xmp.js";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
} from "../src/admission/registry.js";
import {
  DECLINE_CLASS_TO_KIND,
  ISOBMFF_DECLINE_CLASSES,
  type IsobmffDeclineClass,
} from "../src/isobmff/errors.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
  type HostileItemSpec,
  box,
  fullBox,
  HOSTILE_FIXTURES,
  NON_C2PA_UUID_USERTYPE,
  uuidBox,
} from "./isobmff-support/hostile.js";
import {
  createIsobmffTestHandler,
  createIsobmffWriterCountingHandlerForTests,
  createIsobmffWriterHandlerForTests,
} from "./isobmff-support/test-handler.js";
import {
  inventoryIsobmff,
  type IsobmffInventory,
} from "./isobmff-support/inventory.js";
import {
  XMP_ITXT_KEYWORD,
  exifWithArtist,
  exifWithOrientation,
  iccProfileV2,
  iccProfileV4,
  jpegAdobe,
  jpegExif,
  minimalJpeg,
  pngIccp,
  pngItxt,
  pngWithChunksBefore,
} from "./fixtures.js";
import {
  appSegment,
  appendTrailer,
  iccSegments,
  jpegExifOrientationPayload,
  jpegExifResolutionPayload,
  spliceSegments,
} from "./qualification/jpeg/fixtures.js";
import {
  colrNclx,
  colrProf,
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
  type IrefRef,
} from "./isobmff-support/builder.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function freshPath(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-isobmff-hostile-"),
  );
  cleanupDirectories.push(directory);
  return join(directory, "input.heic");
}

async function admitAtPath(path: string) {
  const { size } = await stat(path);
  const handle = await open(path, "r");
  try {
    return await admitIsobmff(handle, size);
  } finally {
    await handle.close();
  }
}

async function expectAdmissionDecline(
  path: string,
  declineClass: IsobmffDeclineClass,
  expectedCode: string,
): Promise<void> {
  await expect(admitAtPath(path)).rejects.toMatchObject({
    declineClass,
    kind: expectedCode,
  });
  expect(DECLINE_CLASS_TO_KIND[declineClass]).toBe(expectedCode);
}

/**
 * D-17 (62-04): proves a hostile fixture declines through the REAL engine before any write --
 * `admitIsobmff` directly, then `sanitizeFile` with the 61 counting test handler (D-16 pattern):
 * `admit` called exactly once, every write-side counter stays 0, the directory holds only the
 * untouched source, and the source bytes are byte-identical to before the run.
 */
async function expectFullyDeclinedBeforeWrite(
  path: string,
  declineClass: IsobmffDeclineClass,
  expectedCode: "unsupported-format" | "unsafe-structure" | "malformed-file",
): Promise<void> {
  await expectAdmissionDecline(path, declineClass, expectedCode);

  const directory = dirname(path);
  const sourceName = basename(path);
  const sourceBytes = await readFile(path);
  const destinationPath = join(directory, "destination.bin");

  const { handler, counters } = createIsobmffTestHandler();
  const restore = setRegisteredHandlersForTests([
    // Prepended, not appended: since 62.1-07 registered the real heic/avif handlers, an
    // appended stub would never be selected for an ISOBMFF file (first match wins).
    handler,
    ...registeredHandlersForTests(),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath: path,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(sanitized.ok).toBe(false);
    if (sanitized.ok) throw new Error("unreachable");
    expect(sanitized.error).toMatchObject({
      code: expectedCode,
      phase: "admission",
      nativeWrite: "not-started",
    });

    expect(counters.admit).toBe(1);
    expect(counters.buildOutputPlan).toBe(0);
    expect(counters.checkOutputPlan).toBe(0);
    expect(counters.writeOutput).toBe(0);
    expect(counters.verifyOutput).toBe(0);

    const listing = await readdir(directory);
    expect(listing).toEqual([sourceName]);

    const sourceAfter = await readFile(path);
    expect(sourceAfter.equals(sourceBytes)).toBe(true);
  } finally {
    restore();
  }
}

/**
 * 62-05 (D-12): proves a `"plan"`-stage hostile fixture (currently `offset-rewrite-overflow`
 * only) admits cleanly through `admitIsobmff`, then declines one stage later -- inside
 * `checkOutputPlan`, through the REAL writer handler (a plan-stage decline can only be observed
 * by actually running the real planning logic, never the admission-only counting stub) --
 * strictly before any byte is written.
 */
async function expectFullyDeclinedAtPlanStage(
  path: string,
  declineClass: IsobmffDeclineClass,
  expectedCode: "unsupported-format" | "unsafe-structure" | "malformed-file",
): Promise<void> {
  const admitted = await admitAtPath(path);
  expect(admitted.namespaces).toBeDefined();

  const directory = dirname(path);
  const sourceName = basename(path);
  const sourceBytes = await readFile(path);
  const destinationPath = join(directory, "destination.bin");

  const { handler, counters } =
    createIsobmffWriterCountingHandlerForTests("heic");
  const restore = setRegisteredHandlersForTests([handler]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath: path,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(sanitized.ok).toBe(false);
    if (sanitized.ok) throw new Error("unreachable");
    expect(sanitized.error).toMatchObject({
      code: expectedCode,
      phase: "admission",
      nativeWrite: "not-started",
    });
    expect((sanitized.error as { detail: string }).detail).toContain(
      declineClass,
    );

    expect(counters.admit).toBe(1);
    expect(counters.buildOutputPlan).toBe(1);
    expect(counters.checkOutputPlan).toBe(1);
    expect(counters.writeOutput).toBe(0);
    expect(counters.verifyOutput).toBe(0);

    const listing = await readdir(directory);
    expect(listing).toEqual([sourceName]);

    const sourceAfter = await readFile(path);
    expect(sourceAfter.equals(sourceBytes)).toBe(true);
  } finally {
    restore();
  }
}

/**
 * D-09(b) (62-12): proves a `"handler"`-stage hostile fixture (currently `brand-mismatch` only)
 * -- a structurally valid, fully admittable file of the OTHER brand -- is accepted by `matches`
 * only for its own (correct) brand's handler, and declines with `brand-mismatch` when the
 * MISMATCHED handler's `admit` is called directly on it (never through `sanitizeFile`/
 * `selectHandler`, since `matches` on the mismatched handler already returns false for it; this
 * simulates a file swapped between selection and admission). `buildOutputPlan`/`checkOutputPlan`/
 * `writeOutput`/`verifyOutput` are never reached.
 */
async function expectDeclinedAtHandlerAdmit(
  path: string,
  declineClass: IsobmffDeclineClass,
  expectedCode: "unsupported-format" | "unsafe-structure" | "malformed-file",
): Promise<void> {
  const { size } = await stat(path);
  const handle = await open(path, "r");
  try {
    const { handler, counters } =
      createIsobmffWriterCountingHandlerForTests("heic");
    await expect(handler.admit(handle, size)).rejects.toMatchObject({
      declineClass,
      kind: expectedCode,
    });
    expect(counters.admit).toBe(1);
    expect(counters.buildOutputPlan).toBe(0);
    expect(counters.checkOutputPlan).toBe(0);
    expect(counters.writeOutput).toBe(0);
    expect(counters.verifyOutput).toBe(0);
  } finally {
    await handle.close();
  }
}

describe("HOSTILE_FIXTURES catalog shape (D-14)", () => {
  it("has exactly one fixture per IsobmffDeclineClass (key set matches ISOBMFF_DECLINE_CLASSES)", () => {
    const catalogKeys = Object.keys(HOSTILE_FIXTURES).sort();
    const declineClasses = [...ISOBMFF_DECLINE_CLASSES].sort();
    expect(catalogKeys).toEqual(declineClasses);
  });
});

describe.each(ISOBMFF_DECLINE_CLASSES)(
  "HOSTILE_FIXTURES[%s]",
  (declineClass) => {
    const fixture = HOSTILE_FIXTURES[declineClass];

    it(`declines ${declineClass} with code ${fixture.expectedCode}`, async () => {
      const path = await freshPath();
      await fixture.write(path);

      if (fixture.stage === "selection") {
        const bytes = await readFile(path);
        expect(classifyIsobmffBrand(bytes.subarray(0, 256))).toBe("decline");
      }

      if (fixture.stage === "plan") {
        await expectFullyDeclinedAtPlanStage(
          path,
          declineClass,
          fixture.expectedCode,
        );
        return;
      }

      if (fixture.stage === "handler") {
        // D-09(b): the fixture itself is a valid, fully admittable file of the OTHER brand --
        // admitIsobmff directly on it must resolve, never reject.
        const admitted = await admitAtPath(path);
        expect(admitted.namespaces).toBeDefined();
        await expectDeclinedAtHandlerAdmit(
          path,
          declineClass,
          fixture.expectedCode,
        );
        return;
      }

      await expectAdmissionDecline(path, declineClass, fixture.expectedCode);
    });
  },
);

describe("D3 variants outside the one-per-class catalog (same class, different shape)", () => {
  describe("unknown-item-type variants", () => {
    it("a uri item declines unknown-item-type", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "uri ",
            extents: [{ relOffset: 0, length: 4 }],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "unknown-item-type",
        "unsupported-format",
      );
    });

    it("a mime item with content type text/plain declines unknown-item-type", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "mime",
            contentType: "text/plain",
            extents: [{ relOffset: 0, length: 4 }],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "unknown-item-type",
        "unsupported-format",
      );
    });

    it("a mime item with content type application/xmp+xml declines unknown-item-type (D-07, unmeasured)", async () => {
      // planner-discipline-allow: application/xmp+xml
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "mime",
            contentType: "application/xmp+xml",
            extents: [{ relOffset: 0, length: 4 }],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "unknown-item-type",
        "unsupported-format",
      );
    });

    it("a mime item carrying a content_encoding (deflate) declines unknown-item-type", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "mime",
            contentType: "application/rdf+xml",
            contentEncoding: "deflate",
            extents: [{ relOffset: 0, length: 4 }],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "unknown-item-type",
        "unsupported-format",
      );
    });
  });

  describe("removable-item-referenced variants", () => {
    it("an Exif item as an iref cdsc to-target declines removable-item-referenced", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "Exif",
            hidden: true,
            extents: [{ relOffset: 0, length: 8 }],
          },
        ],
        refs: [{ type: "cdsc", fromItemId: 1, toItemIds: [2] }],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "removable-item-referenced",
        "unsafe-structure",
      );
    });

    it("an Exif item as the pitm primary item declines removable-item-referenced", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        primaryItemId: 2,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "Exif",
            hidden: true,
            extents: [{ relOffset: 0, length: 8 }],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "removable-item-referenced",
        "unsafe-structure",
      );
    });

    it("an Exif item as a grpl member declines removable-item-referenced", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "Exif",
            hidden: true,
            extents: [{ relOffset: 0, length: 8 }],
          },
        ],
        groups: [{ type: "altr", groupId: 1, entityIds: [2] }],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "removable-item-referenced",
        "unsafe-structure",
      );
    });
  });

  describe("top-level-box-not-allowed variant", () => {
    it("a non-C2PA uuid declines top-level-box-not-allowed", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        topLevelExtraBeforeMdat: [
          uuidBox(NON_C2PA_UUID_USERTYPE, Buffer.from([1, 2, 3, 4])),
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "top-level-box-not-allowed",
        "unsupported-format",
      );
    });
  });
});

async function writeFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
}

describe("D-17 graph-integrity declines (62-04)", () => {
  it("an ipma entry for an undeclared item (item_ID 99) declines item-graph-invalid end to end, zero writes", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({
      // twoPass: a realistic (non-placeholder) baseOffset so the only deviation from a
      // structurally valid file is the dangling ipma item_ID -- without this, the single-pass
      // default's placeholder baseOffset 0 would make item 1's own extent look like it falls
      // outside mdat, declining for an unrelated reason before the ipma check is ever reached.
      twoPass: true,
      extraIpmaEntries: [
        { itemId: 99, associations: [{ propertyIndex: 1, essential: false }] },
      ],
    });
    await writeFile(path, bytes);
    await expectFullyDeclinedBeforeWrite(
      path,
      "item-graph-invalid",
      "malformed-file",
    );
  });

  describe("ipma property index boundaries", () => {
    it("property index 0 declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [0],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });

    it("property index equal to the ipco count (2) admits", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [2],
          },
        ],
        // twoPass: a realistic baseOffset so this "admits" case isn't accidentally caught by
        // extent-outside-mdat from the single-pass default's placeholder offset (see the Task 1
        // fixture's own comment above).
        twoPass: true,
      });
      await writeFile(path, bytes);
      const admission = await admitAtPath(path);
      expect(admission).toBeDefined();
    });

    it("property index equal to the ipco count + 1 (3) declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [3],
          },
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });
  });

  it("a grpl entity_id (77) not declared in iinf declines item-graph-invalid", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({
      groups: [{ type: "altr", groupId: 1, entityIds: [77] }],
    });
    await writeFile(path, bytes);
    await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
  });

  describe("duplicated meta child types", () => {
    const duplicateCases: readonly {
      readonly name: string;
      readonly spec: Parameters<typeof assembleHeif>[0];
    }[] = [
      { name: "hdlr", spec: { extraMetaChildren: [hdlrBox("pict")] } },
      { name: "pitm", spec: { extraMetaChildren: [pitmBox(0, 1)] } },
      { name: "iinf", spec: { extraMetaChildren: [iinfBox(0, [])] } },
      {
        name: "iloc",
        spec: {
          extraMetaChildren: [
            ilocBox({
              version: 1,
              offsetSize: 4,
              lengthSize: 4,
              baseOffsetSize: 4,
              indexSize: 0,
              items: [],
            }),
          ],
        },
      },
      {
        name: "iref",
        spec: {
          refs: [{ type: "thmb", fromItemId: 1, toItemIds: [1] }],
          extraMetaChildren: [irefBox(0, [])],
        },
      },
      {
        name: "idat",
        spec: {
          idatPayload: Buffer.alloc(4),
          extraMetaChildren: [idatBox(Buffer.alloc(4))],
        },
      },
      {
        name: "grpl",
        spec: {
          groups: [{ type: "altr", groupId: 1, entityIds: [1] }],
          extraMetaChildren: [
            grplBox([{ type: "altr", groupId: 2, entityIds: [1] }]),
          ],
        },
      },
      {
        name: "dinf",
        spec: {
          extraMetaChildren: [
            box("dinf", Buffer.alloc(0)),
            box("dinf", Buffer.alloc(0)),
          ],
        },
      },
    ];

    it.each(duplicateCases)(
      "a duplicated $name meta child declines item-graph-invalid",
      async ({ spec }) => {
        const path = await freshPath();
        const bytes = assembleHeif(spec);
        await writeFile(path, bytes);
        await expectAdmissionDecline(
          path,
          "item-graph-invalid",
          "malformed-file",
        );
      },
    );
  });

  describe("duplicated ipco/ipma inside iprp", () => {
    /** Builds a minimal structurally-valid HEIF with an extra box appended inside `iprp`,
     * alongside the one real `ipco`/`ipma` pair -- `assembleHeif` always builds `iprp` as
     * exactly one `ipco` + one `ipma`, so this bespoke assembler (same shape, D-19 independence
     * preserved: only `./builder.js` functions) is needed to express a second one. */
    function buildWithExtraIprpChild(extraChild: Buffer): Buffer {
      const mdatPayload = Buffer.from([1, 2, 3, 4]);
      const build = (mdatPayloadStart: number): Buffer => {
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
            {
              itemId: 1,
              associations: [
                { propertyIndex: 1, essential: false },
                { propertyIndex: 2, essential: true },
              ],
            },
          ],
        });
        const iprp = box("iprp", Buffer.concat([ipco, ipma, extraChild]));
        const iloc = ilocBox({
          version: 1,
          offsetSize: 4,
          lengthSize: 4,
          baseOffsetSize: 4,
          indexSize: 0,
          items: [
            {
              itemId: 1,
              constructionMethod: 0,
              dataReferenceIndex: 0,
              baseOffset: mdatPayloadStart,
              extents: [{ offset: 0, length: mdatPayload.length }],
            },
          ],
        });
        const meta = metaBox([hdlr, pitm, iinf, iloc, iprp]);
        const header = Buffer.concat([ftyp, meta]);
        const mdat = mdatBox(mdatPayload);
        return Buffer.concat([header, mdat]);
      };
      const pass1 = build(0);
      const mdatBoxTotal = 8 + mdatPayload.length;
      const headerLength = pass1.length - mdatBoxTotal;
      const final = build(headerLength + 8);
      if (final.length !== pass1.length) {
        throw new Error(
          "buildWithExtraIprpChild: header length changed between placeholder and final passes",
        );
      }
      return final;
    }

    it("a second ipco inside iprp declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = buildWithExtraIprpChild(ipcoBox([ispe(10, 10)]));
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });

    it("a second ipma inside iprp declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = buildWithExtraIprpChild(
        ipmaBox({ version: 0, flags: 0, entries: [] }),
      );
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });
  });

  describe("dinf/dref self-contained rule (D-17, inferred)", () => {
    function urlEntry(
      flags: number,
      trailing: Buffer = Buffer.alloc(0),
    ): Buffer {
      return fullBox("url ", 0, flags, trailing);
    }
    function urnEntry(flags: number): Buffer {
      const payload = Buffer.concat([
        Buffer.from("name\0", "ascii"),
        Buffer.from("location\0", "ascii"),
      ]);
      return fullBox("urn ", 0, flags, payload);
    }
    function drefWith(entries: readonly Buffer[]): Buffer {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(entries.length, 0);
      return fullBox("dref", 0, 0, Buffer.concat([count, ...entries]));
    }
    function dinfWith(dref: Buffer): Buffer {
      return box("dinf", dref);
    }

    it("a urn entry declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        extraMetaChildren: [dinfWith(drefWith([urnEntry(1)]))],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });

    it("a url entry with flags 0 (not self-contained) declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        extraMetaChildren: [dinfWith(drefWith([urlEntry(0)]))],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });

    it("a url entry with flags 1 plus trailing location bytes declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        extraMetaChildren: [
          dinfWith(drefWith([urlEntry(1, Buffer.from("loc\0", "ascii"))])),
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(
        path,
        "item-graph-invalid",
        "malformed-file",
      );
    });

    it("no dinf at all admits", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({ twoPass: true });
      await writeFile(path, bytes);
      const admission = await admitAtPath(path);
      expect(admission).toBeDefined();
    });

    it("a dref with zero entries admits", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        twoPass: true,
        extraMetaChildren: [dinfWith(drefWith([]))],
      });
      await writeFile(path, bytes);
      const admission = await admitAtPath(path);
      expect(admission).toBeDefined();
    });

    it("a dref holding one self-contained url entry (flags 1, no location) admits", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        twoPass: true,
        extraMetaChildren: [dinfWith(drefWith([urlEntry(1)]))],
      });
      await writeFile(path, bytes);
      const admission = await admitAtPath(path);
      expect(admission).toBeDefined();
    });
  });
});

describe("decline ordering and empty input (BMF-03 edges)", () => {
  it("unknown-item-type and a removable/surviving overlap: unknown-item-type wins on five consecutive runs (rule 2 before rule 10)", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 8 }],
          propertyIndices: [1, 2],
        },
        { itemId: 2, itemType: "zzzz", extents: [{ relOffset: 0, length: 4 }] },
        {
          itemId: 3,
          itemType: "Exif",
          hidden: true,
          extents: [{ relOffset: 4, length: 8 }],
        },
      ],
    });
    await writeFile(path, bytes);

    for (let run = 0; run < 5; run += 1) {
      const { size } = await stat(path);
      const handle = await open(path, "r");
      try {
        await expect(admitIsobmff(handle, size)).rejects.toMatchObject({
          declineClass: "unknown-item-type",
          kind: "unsupported-format",
        });
      } finally {
        await handle.close();
      }
    }
  });

  it("box-framing and a later item-level issue: box-framing wins (parse-time, before admission rules ever run)", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        { itemId: 2, itemType: "zzzz", extents: [{ relOffset: 0, length: 4 }] },
      ],
      extraMetaChildren: [box("free", Buffer.alloc(0), { size: 7 })],
    });
    await writeFile(path, bytes);
    await expectAdmissionDecline(path, "box-framing", "malformed-file");
  });

  it("two unknown item types: the decline names the first in iinf order", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        { itemId: 2, itemType: "zzzz", extents: [{ relOffset: 0, length: 4 }] },
        { itemId: 3, itemType: "yyyy", extents: [{ relOffset: 0, length: 4 }] },
      ],
    });
    await writeFile(path, bytes);
    const { size } = await stat(path);
    const handle = await open(path, "r");
    try {
      await expect(admitIsobmff(handle, size)).rejects.toMatchObject({
        declineClass: "unknown-item-type",
        message: expect.stringContaining("Item 2"),
      });
    } finally {
      await handle.close();
    }
  });

  it("a meta with zero items (empty iinf/iloc) and a pitm declines item-graph-invalid", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({ primaryItemId: 1, items: [] });
    await writeFile(path, bytes);
    await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
  });

  it("a file with no top-level meta box declines item-graph-invalid", async () => {
    const path = await freshPath();
    const bytes = assembleHeif({});
    // Strip everything from the real meta box onward -- ftyp only, no meta, no mdat.
    const ftypOnly = bytes.subarray(0, ftypLength(bytes));
    await writeFile(path, ftypOnly);
    await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
  });
});

/** Reads just the declared size of the leading `ftyp` box (bytes 0..4, big-endian uint32). */
function ftypLength(bytes: Buffer): number {
  return bytes.readUInt32BE(0);
}

// 62-07, Task 3: D-12's width-zero decline for a required minimal Exif item.
//
// Finding (documented here, and in the SUMMARY, rather than silently worked around): a real file
// admitted through `admitIsobmff` can never actually reach this decline. `offsetSize === 0` always
// declines earlier via the existing `surviving-offset-width-zero` rule (the primary item is always
// `kind === "surviving"` and construction_method 0, per `removable-item-referenced`/D3) --
// confirmed by the catalog's own `HOSTILE_FIXTURES["surviving-offset-width-zero"]` entry.
// `lengthSize === 0` was measured here (scratch run, same `assembleHeif` shape as below) to decline
// earlier too, via `surviving-zero-length-extent`: `readSizedUint(width=0)` returns a literal 0 for
// every item unconditionally (`src/isobmff/iloc.ts`), so a global `length_size` of 0 makes the
// primary's own (surviving) extent read as zero-length, which rule 8 already declines before rule
// 9/10 or any plan-stage code ever runs. There is no admittable shape where only the *rewrite*
// (not the source's own surviving-item reads) is width-starved.
//
// So these two tests call `buildIsobmffOutputPlan`/`checkIsobmffOutputPlan` directly against a
// real `admitIsobmff` result (on a fixture with ordinary, non-zero widths) whose `layout.item`
// width fields are overridden afterward -- the same `IsobmffAdmission` shape the engine always
// hands the planner, just assembled to reach a state no real file's own admission can produce.
// This still proves the exact code path `checkOutputPlan` (called from `src/engine.ts` strictly
// before `writeOutput`) exercises.
describe("D-12 minimal Exif location (62-07)", () => {
  const PRIMARY_PAYLOAD = Buffer.from("primary-bytes", "ascii");

  async function admittedSingleExifFixture(): Promise<IsobmffAdmission> {
    const exifTiff = createOrientationExif(6);
    const exifPayload = Buffer.concat([Buffer.alloc(4), exifTiff]);
    const bytes = assembleHeif({
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: PRIMARY_PAYLOAD.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [
            { relOffset: PRIMARY_PAYLOAD.length, length: exifPayload.length },
          ],
        },
      ],
      refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
      mdatPayload: Buffer.concat([PRIMARY_PAYLOAD, exifPayload]),
      twoPass: true,
    });
    const path = await freshPath();
    await writeFile(path, bytes);
    const admission = await admitAtPath(path);
    expect(admission.exifSourceItemId).toBe(2);
    expect(admission.orientation).toEqual({ status: "valid", value: 6 });
    return admission;
  }

  function withIlocWidths(
    admission: IsobmffAdmission,
    widths: {
      readonly ilocOffsetSize?: number;
      readonly ilocBaseOffsetSize?: number;
      readonly ilocLengthSize?: number;
    },
  ): IsobmffAdmission {
    return {
      ...admission,
      model: {
        ...admission.model,
        layout: {
          ...admission.model.layout,
          item: { ...admission.model.layout.item, ...widths },
        },
      },
    };
  }

  it("length_size 0, default settings: declines offset-rewrite-overflow before any write; the same source with preserve flags false plans ok", async () => {
    const admission = await admittedSingleExifFixture();
    const starved = withIlocWidths(admission, { ilocLengthSize: 0 });

    const declinedPlan = buildIsobmffOutputPlan(starved, true, true, true, 6);
    expect(declinedPlan.declineReason).toContain("offset-rewrite-overflow");
    expect(checkIsobmffOutputPlan(declinedPlan)).toBe(
      declinedPlan.declineReason,
    );

    const okPlan = buildIsobmffOutputPlan(
      starved,
      false,
      true,
      false,
      undefined,
    );
    expect(okPlan.declineReason).toBeUndefined();
    expect(checkIsobmffOutputPlan(okPlan)).toBeUndefined();
  });

  // The plan's "offset_size 0 and base_offset_size 0" bullet is intentionally not pinned as its
  // own test, per the plan's own fallback ("keep only the length_size 0 case" when the classifier
  // already declines every such source): measured here (not merely inferred), setting both widths
  // to 0 on `admittedSingleExifFixture()`'s admission and calling `buildIsobmffOutputPlan` directly
  // declines with `offset-rewrite-overflow` under BOTH preserve-true and preserve-false -- but the
  // preserve-false decline is for the *primary* item's own ordinary rewrite (it is `surviving`,
  // construction_method 0, and needs a real nonzero absolute position regardless of any Exif
  // item), not for the minimal Exif item specifically. `offsetSize === 0` is incompatible with
  // rewriting any cm=0 item's position at all, Exif or not, so there is no source shape (real or
  // hand-assembled) where this width combination clears the "ordinary" rewrite but fails only the
  // minimal-Exif-specific one. The `length_size 0` test above is the one case where the two are
  // actually distinguishable (length has no bearing on the ordinary position rewrite at all).
});

// ---------------------------------------------------------------------------
// Plan 67-19 (isobmff-6): the output planner, `src/isobmff/plan.ts`. Real fixtures go through
// `admitIsobmff` and `buildIsobmffOutputPlan`; the D-12 overflow arithmetic needs offsets above
// 4 GiB, which no real file this suite can write reaches, so those cases take a real admission
// and replace only plain data on it (item extents, iloc widths, the mdat size form) -- the same
// admission shape the engine always hands the planner, as the D-12 tests in
// tests/isobmff_hostile.test.ts do. The plan is pure data, so no 4 GiB buffer is ever allocated.
// These tests live here, not in tests/isobmff_writer.test.ts: that file's top-level hooks and
// generated suites make every declaration in it "unsupported" to the phase-local verifier, so a
// killer declared there could never be proven by name.
// ---------------------------------------------------------------------------

type PlanLayout = IsobmffAdmission["model"]["layout"];
type PlanLayoutItem = PlanLayout["item"];
type PlanBoxHeader = PlanLayout["topLevelBoxes"][number];
type PlanSpan = { readonly abs: number; readonly length: number };

const UINT32_MAX = 0xffffffff;

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
  return Buffer.concat([Buffer.alloc(4), createOrientationExif(6)]);
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
  const path = await freshPath();
  await writeFile(path, bytes);
  return admitAtPath(path);
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
  const sourcePath = await freshPath();
  const destinationPath = join(dirname(sourcePath), "destination.heic");
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

describe("mapAbsoluteOffset EqualityOperator cluster (67-19)", () => {
  it("mapAbsoluteOffset EqualityOperator: a zero-length extent maps to its own range end instead of falling outside every range", async () => {
    // Admission refuses a surviving zero-length extent (rule 8), so this takes a real admission
    // and replaces item 1's extent with an empty one: the planner's merged range [100, 100) must
    // still contain its own start, because the range end is inclusive.
    const admission = await iso6Admit(iso6Fixture({ includeThird: false }));
    const placed = iso6Place(admission, {
      item1: [{ abs: 100, length: 0 }],
      item3: [{ abs: 200, length: 6 }],
    });
    iso6ExpectPlanned(iso6PlanDrop(placed));
  });
});

// ---------------------------------------------------------------------------
// Plan 67-20 (isobmff-7): the byte encoders in `src/isobmff/rebuild.ts`. `rebuildIloc`,
// `rebuildIinf` and `rebuildIref` are exported pure transforms, so each case calls one directly
// with plain data and compares the exact encoded bytes against a hand-written hex layout (the
// ISO/IEC 14496-12 field order, one space per field), never against another call of the same
// function. Widths and versions the product fixtures never produce (an `iinf` version 1, an
// `iref` version 0, a version 0 `iloc` with a non-zero reserved index nibble) are the cases that
// separate the mutants.
// ---------------------------------------------------------------------------

function rebuildItem(patch: Partial<IsobmffItem> = {}): IsobmffItem {
  return {
    id: 1,
    type: "hvc1",
    name: "",
    hidden: false,
    constructionMethod: 0,
    dataReferenceIndex: 0,
    baseOffset: 0,
    extents: [{ index: 0, offset: 0x10, length: 0x20 }],
    properties: [],
    ...patch,
  };
}

/** Spaces in `layout` only separate fields for the reader; the bytes are the hex digits. */
function expectBytes(actual: Buffer, layout: string): void {
  expect(actual.toString("hex")).toBe(layout.replace(/ /g, ""));
}

describe("rebuild.ts encoders (67-20, isobmff-7)", () => {
  it("hasIndexField ConditionalExpression: a version 0 iloc never carries the extent index field even when the reserved index nibble is set", () => {
    // version 0, offset/length widths 4, base width 0, reserved nibble 4. Per item: item_ID(16)
    // data_reference_index(16) extent_count(16) then offset(32) length(32); no
    // construction_method and no extent_index.
    const item = rebuildItem({
      extents: [{ index: 0x0a0b0c0d, offset: 0x10, length: 0x20 }],
    });
    expectBytes(
      rebuildIloc(0, 4, 4, 0, 4, [item], new Map()),
      "0000001e 696c6f63 00 000000  4404 0001  0001 0000 0001  00000010 00000020",
    );
  });

  it("hasIndexField ConditionalExpression: version 1 and 2 carry construction_method and write an extent index only for a non-zero index size", () => {
    const item = rebuildItem({
      constructionMethod: 1,
      extents: [{ index: 7, offset: 0x10, length: 0x20 }],
    });
    // version 1, index size 4: construction_method(16) follows item_ID(16); extent_index(32)
    // precedes each extent offset
    expectBytes(
      rebuildIloc(1, 4, 4, 0, 4, [item], new Map()),
      "00000024 696c6f63 01 000000  4404 0001  0001 0001 0000 0001  00000007 00000010 00000020",
    );
    // version 2, index size 0: 32-bit item_count and item_ID, and no extent_index bytes at all
    expectBytes(
      rebuildIloc(2, 4, 4, 0, 0, [item], new Map()),
      "00000024 696c6f63 02 000000  4400 00000001  00000001 0001 0000 0001  00000010 00000020",
    );
  });

  it("writeSizedUint ConditionalExpression: an iloc field width other than 0, 4 or 8 is refused instead of written as 8 bytes", () => {
    const item = rebuildItem();
    expect(() => rebuildIloc(0, 2, 4, 0, 0, [item], new Map())).toThrow();
    expect(() => rebuildIloc(0, 4, 3, 0, 0, [item], new Map())).toThrow();
    expect(() => rebuildIloc(0, 4, 4, 1, 0, [item], new Map())).toThrow();
    // width 8 is 8 big-endian bytes, width 0 is none
    expectBytes(
      rebuildIloc(0, 8, 4, 0, 0, [item], new Map()),
      "00000022 696c6f63 00 000000  8400 0001  0001 0000 0001  0000000000000010 00000020",
    );
  });

  it("rebuildIloc CallExpression: the data_reference_index of each item is copied into its entry", () => {
    expectBytes(
      rebuildIloc(
        1,
        4,
        4,
        0,
        0,
        [rebuildItem({ dataReferenceIndex: 0x0304 })],
        new Map(),
      ),
      "00000020 696c6f63 01 000000  4400 0001  0001 0000 0304 0001  00000010 00000020",
    );
  });

  it("rebuildIinf ConditionalExpression: a version 1 iinf carries a 32-bit entry_count and version 0 a 16-bit one", () => {
    // the surviving infe is bytes 1..3 of the meta payload
    const source = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const ranges = new Map<number, BoxHeader>([
      [
        7,
        {
          type: "infe",
          start: 1,
          headerSize: 8,
          size: 2,
          payloadStart: 1,
          end: 3,
          sizeForm: "normal",
        },
      ],
    ]);
    expectBytes(
      rebuildIinf(source, 1, [7], ranges),
      "00000012 69696e66 01 000000  00000001  bbcc",
    );
    expectBytes(
      rebuildIinf(source, 0, [7], ranges),
      "00000010 69696e66 00 000000  0001  bbcc",
    );
  });

  it("rebuildIref ConditionalExpression and CallExpression: version 1 writes 32-bit item ids and version 0 writes 16-bit ones", () => {
    const references = [{ type: "cdsc", fromItemId: 5, toItemIds: [1, 2] }];
    expectBytes(
      rebuildIref(1, references),
      "00000022 69726566 01 000000  00000016 63647363 00000005 0002 00000001 00000002",
    );
    expectBytes(
      rebuildIref(0, references),
      "0000001c 69726566 00 000000  00000010 63647363 0005 0002 0001 0002",
    );
  });
});

// --- verify.ts clusters (67-21, isobmff-8) ---
//
// Every scenario drives the shipped `verifyIsobmffOutput` against a source file and a destination
// file on disk. Fake handles wrap the real ones: a hook can abort a signal or report a short read
// (`bytesRead` one below the requested length) while the buffer still holds the correct bytes, so
// a comparison that ignores the short read would still see equal bytes and report success.

function withReadHook(
  handle: FileHandle,
  hook: (length: number, position: number) => number,
): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === "read") {
        return async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const reduction = hook(length, position);
          const result = await target.read(buffer, offset, length, position);
          return {
            bytesRead: Math.max(0, result.bytesRead - reduction),
            buffer: result.buffer,
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

interface VerifyPairOptions {
  readonly signal?: AbortSignal;
  readonly preserveColorProfile?: boolean;
  readonly preserveOrientation?: boolean;
  readonly expectedOrientation?: number;
  readonly wrapSource?: (handle: FileHandle) => FileHandle;
  readonly wrapDestination?: (handle: FileHandle) => FileHandle;
  /** Hand-assembles the admission after it was read from the source, before it is verified. */
  readonly adjustAdmission?: (admission: IsobmffAdmission) => void;
}

async function verifyPair(
  sourceBytes: Buffer,
  destinationBytes: Buffer,
  options: VerifyPairOptions = {},
): Promise<Result<void>> {
  const sourcePath = await freshPath();
  const destinationPath = join(dirname(sourcePath), "destination.heic");
  await writeFile(sourcePath, sourceBytes);
  await writeFile(destinationPath, destinationBytes);
  const sourceHandle = await open(sourcePath, "r");
  const destinationHandle = await open(destinationPath, "r");
  try {
    const admission = await admitIsobmff(sourceHandle, sourceBytes.length);
    options.adjustAdmission?.(admission);
    return await verifyIsobmffOutput(
      options.wrapSource?.(sourceHandle) ?? sourceHandle,
      admission,
      options.wrapDestination?.(destinationHandle) ?? destinationHandle,
      destinationBytes.length,
      destinationPath,
      options.preserveOrientation ?? false,
      options.preserveColorProfile ?? true,
      false,
      options.expectedOrientation,
      options.signal,
    );
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
  }
}

async function sanitizeBytesThroughWriter(
  sourceBytes: Buffer,
  preserveColorProfile: boolean,
): Promise<Buffer> {
  const sourcePath = await freshPath();
  const destinationPath = join(dirname(sourcePath), "sanitized.heic");
  await writeFile(sourcePath, sourceBytes);
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests("heic"),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(sanitized.ok).toBe(true);
  } finally {
    restore();
  }
  return readFile(destinationPath);
}

function expectVerificationFailed(result: Result<void>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("verification-failed");
}

/** One surviving `hvc1` item whose only extent is `payload`, in a file with nothing to remove, so
 * a byte-identical copy of the file is a correct sanitized output. */
function plainItemFile(payload: Buffer): Buffer {
  return assembleHeif({
    twoPass: true,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: payload.length }],
        propertyIndices: [1, 2],
      },
    ],
    mdatPayload: payload,
  });
}

function smallPayload(): Buffer {
  return Buffer.from([1, 2, 3, 4]);
}

describe("verify.ts rangesEqual and readWholeFile clusters (67-21, isobmff-8)", () => {
  it("rangesEqual ConditionalExpression: an abort raised while a range is compared stops the next comparison with the aborted code", async () => {
    const file = plainItemFile(smallPayload());
    const control = await verifyPair(file, Buffer.from(file));
    expect(control.ok).toBe(true);

    const controller = new AbortController();
    const result = await verifyPair(file, Buffer.from(file), {
      signal: controller.signal,
      wrapSource: (handle) =>
        withReadHook(handle, () => {
          controller.abort();
          return 0;
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
  });

  it("rangesEqual ConditionalExpression and LogicalOperator: a short read on the source side alone, and on the destination side alone, fails verification", async () => {
    const file = plainItemFile(smallPayload());
    expect((await verifyPair(file, Buffer.from(file))).ok).toBe(true);

    expectVerificationFailed(
      await verifyPair(file, Buffer.from(file), {
        wrapSource: (handle) => withReadHook(handle, () => 1),
      }),
    );

    // the destination is also read while it is parsed, before the first source read: only reads
    // after the comparison started are shortened
    let comparing = false;
    expectVerificationFailed(
      await verifyPair(file, Buffer.from(file), {
        wrapSource: (handle) =>
          withReadHook(handle, () => {
            comparing = true;
            return 0;
          }),
        wrapDestination: (handle) =>
          withReadHook(handle, () => (comparing ? 1 : 0)),
      }),
    );
  });

  it("rangesEqual ArithmeticOperator: an item longer than one copy window and not a multiple of it verifies without reading past its end", async () => {
    const payload = Buffer.from(
      Array.from({ length: COPY_BLOCK_BYTES + 5 }, (_, index) => index % 251),
    );
    const file = plainItemFile(payload);
    expect((await verifyPair(file, Buffer.from(file))).ok).toBe(true);

    const flipped = Buffer.from(file);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    expectVerificationFailed(await verifyPair(file, flipped));
  });

  it("rangesEqual MethodExpression: comparison windows never exceed the compared range or one copy window", async () => {
    const original = Buffer.allocUnsafe;
    const sizes: number[] = [];
    const spy = vi
      .spyOn(Buffer, "allocUnsafe")
      .mockImplementation((size: number) => {
        sizes.push(size);
        return original.call(Buffer, size);
      });
    try {
      const small = plainItemFile(smallPayload());
      expect((await verifyPair(small, Buffer.from(small))).ok).toBe(true);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThan(COPY_BLOCK_BYTES);

      sizes.length = 0;
      const large = plainItemFile(Buffer.alloc(COPY_BLOCK_BYTES + 5, 7));
      expect((await verifyPair(large, Buffer.from(large))).ok).toBe(true);
      expect(sizes).toContain(COPY_BLOCK_BYTES);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(COPY_BLOCK_BYTES);
    } finally {
      spy.mockRestore();
    }
  });
});

/** A source whose only removable thing is a `colr` ICC property, plus an `hdlr` whose name field is
 * `iccLength` filler bytes (the parser never reads it, so a test can overwrite it freely). */
function iccSourceFile(icc: Buffer): Buffer {
  return assembleHeif({
    twoPass: true,
    properties: [ispe(32, 32), hvcC(), colrProf(icc)],
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: 4 }],
        propertyIndices: [1, 2, 3],
      },
    ],
    omitHdlr: true,
    extraMetaChildren: [hdlrBox("pict", "x".repeat(icc.length))],
  });
}

describe("verify.ts colr ICC scan clusters (67-21, isobmff-8)", () => {
  it("readWholeFile ConditionalExpression, BlockStatement and CallExpression: a short read of the whole destination fails the removed ICC scan", async () => {
    const source = iccSourceFile(iccProfileV4());
    const destination = await sanitizeBytesThroughWriter(source, false);
    const options = { preserveColorProfile: false } as const;
    expect((await verifyPair(source, destination, options)).ok).toBe(true);

    expectVerificationFailed(
      await verifyPair(source, destination, {
        ...options,
        wrapDestination: (handle) =>
          withReadHook(handle, (length) =>
            length === destination.length ? 1 : 0,
          ),
      }),
    );
  });

  it("colrIccPayloadBytes ArithmeticOperator: removed ICC payload bytes found anywhere in the destination fail verification", async () => {
    const icc = iccProfileV4();
    const source = iccSourceFile(icc);
    const destination = await sanitizeBytesThroughWriter(source, false);
    const options = { preserveColorProfile: false } as const;
    expect((await verifyPair(source, destination, options)).ok).toBe(true);

    const nameAt = destination.indexOf(Buffer.alloc(icc.length, 0x78));
    expect(nameAt).toBeGreaterThan(0);

    // the same bytes of the destination overwritten with other filler still verify
    const benign = Buffer.from(destination);
    Buffer.alloc(icc.length, 0x79).copy(benign, nameAt);
    expect((await verifyPair(source, benign, options)).ok).toBe(true);

    // the removed profile bytes, copied into the parsed-but-unchecked hdlr name field, are found
    const leaked = Buffer.from(destination);
    icc.copy(leaked, nameAt);
    expectVerificationFailed(await verifyPair(source, leaked, options));
  });
});

describe("verify.ts removedColrPropertyIndices cluster (67-21, isobmff-8)", () => {
  it("removedColrPropertyIndices ConditionalExpression: a property that is not a colr box is never treated as a removed ICC property", async () => {
    const file = plainItemFile(smallPayload());
    const options = { preserveColorProfile: false } as const;
    expect((await verifyPair(file, Buffer.from(file), options)).ok).toBe(true);

    // The parser sets colourType only on colr properties, so this admission is hand-assembled:
    // property 2 (the hvcC box both files keep and item 1 is associated with) claims an ICC
    // colour type. A property that is not a colr box must not drop that association from the
    // expected side, so the byte-identical copy still verifies.
    const result = await verifyPair(file, Buffer.from(file), {
      ...options,
      adjustAdmission: (admission) => {
        Object.assign(admission.model.properties[1]!, { colourType: "prof" });
      },
    });
    expect(result.ok).toBe(true);
  });
});

/** Item 1 is a file-relative payload in `mdat`; item 2 is an `idat` item whose iloc record carries
 * `item2Base` and `item2Offset`. The iloc box is placed directly before `idat` and item 2 is its
 * last record, so the bytes just before the `idat` payload are item 2's extent fields. */
function idatOffsetFile(item2Base: number, item2Offset: number): Buffer {
  const build = (mdatStart: number): Buffer => {
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatStart,
          extents: [{ offset: 0, length: 4 }],
        },
        {
          itemId: 2,
          constructionMethod: 1,
          dataReferenceIndex: 0,
          baseOffset: item2Base,
          extents: [{ offset: item2Offset, length: 4 }],
        },
      ],
    });
    const association = (itemId: number) => ({
      itemId,
      associations: [
        { propertyIndex: 1, essential: false },
        { propertyIndex: 2, essential: false },
      ],
    });
    const meta = metaBox([
      hdlrBox("pict"),
      pitmBox(0, 1),
      iloc,
      idatBox(Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWX", "ascii")),
      iinfBox(0, [
        infeBox({ version: 2, itemId: 1, itemType: "hvc1" }),
        infeBox({ version: 2, itemId: 2, itemType: "hvc1", hidden: true }),
      ]),
      iprpBox(
        ipcoBox([ispe(32, 32), hvcC()]),
        ipmaBox({
          version: 0,
          flags: 0,
          entries: [association(1), association(2)],
        }),
      ),
    ]);
    return Buffer.concat([
      ftypBox("heic", 0, ["mif1", "heic"]),
      meta,
      mdatBox(Buffer.from([1, 2, 3, 4])),
    ]);
  };
  // iloc's encoded length depends only on the field widths, so a placeholder pass measures the
  // header; the 4-byte mdat payload is the last thing in the file
  return build(build(0).length - 4);
}

describe("verify.ts resolveAbsoluteOffset ArithmeticOperator cluster (67-21, isobmff-8)", () => {
  it("resolveAbsoluteOffset ArithmeticOperator: an idat item is located by idat start plus base_offset plus extent_offset, however the destination splits them", async () => {
    // source: base_offset 1 and extent_offset 1; destination: base_offset 0 and extent_offset 2.
    // Both name idat bytes 2..5 ("CDEF"); every other combination of the three terms reads
    // different bytes in the two files.
    const source = idatOffsetFile(1, 1);
    const destination = idatOffsetFile(0, 2);
    expect((await verifyPair(source, destination)).ok).toBe(true);

    // control: the idat bytes themselves are compared, so a destination that points at other
    // idat bytes does not verify
    expectVerificationFailed(await verifyPair(source, idatOffsetFile(0, 3)));
  });
});

// --- verify.ts and writer.ts clusters (67-22, isobmff-9) ---
//
// `vwFile` assembles a small, structurally valid still-image file with the knobs these scenarios
// vary one at a time (iloc version and field widths, item order, primary item, top-level order,
// data reference). Every scenario hands `verifyPair` a source file and a destination that differs
// from it in exactly one dimension, after proving the byte-identical control verifies, so a
// verification failure is attributable to the one check under test.

type VwWidth = 0 | 4 | 8;

interface VwItem {
  readonly id: number;
  readonly payload: Buffer;
  readonly dataReferenceIndex?: number;
}

interface VwSpec {
  readonly primary?: number;
  readonly ilocVersion?: 0 | 1 | 2;
  readonly offsetSize?: VwWidth;
  readonly lengthSize?: VwWidth;
  readonly baseOffsetSize?: VwWidth;
  readonly indexSize?: VwWidth;
  readonly items?: readonly VwItem[];
  readonly mdatFirst?: boolean;
}

function vwDefaultItems(): readonly VwItem[] {
  return [
    { id: 1, payload: Buffer.from([1, 2, 3, 4]) },
    { id: 2, payload: Buffer.from([5, 6, 7, 8, 9]) },
  ];
}

function vwFile(spec: VwSpec = {}): Buffer {
  const items = spec.items ?? vwDefaultItems();
  const baseOffsetSize = spec.baseOffsetSize ?? 4;
  const payload = Buffer.concat(items.map((item) => item.payload));
  const build = (payloadStart: number): Buffer => {
    let relative = 0;
    const ilocItems = items.map((item) => {
      const rel = relative;
      relative += item.payload.length;
      return {
        itemId: item.id,
        constructionMethod: 0,
        dataReferenceIndex: item.dataReferenceIndex ?? 0,
        baseOffset: baseOffsetSize === 0 ? 0 : payloadStart,
        extents: [
          {
            offset: baseOffsetSize === 0 ? payloadStart + rel : rel,
            length: item.payload.length,
          },
        ],
      };
    });
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const meta = metaBox([
      hdlrBox("pict"),
      pitmBox(0, spec.primary ?? items[0]!.id),
      ilocBox({
        version: spec.ilocVersion ?? 1,
        offsetSize: spec.offsetSize ?? 4,
        lengthSize: spec.lengthSize ?? 4,
        baseOffsetSize,
        indexSize: spec.indexSize ?? 0,
        items: ilocItems,
      }),
      iinfBox(
        0,
        items.map((item) =>
          infeBox({ version: 2, itemId: item.id, itemType: "hvc1" }),
        ),
      ),
      iprpBox(
        ipcoBox([ispe(32, 32), hvcC()]),
        ipmaBox({
          version: 0,
          flags: 0,
          entries: items.map((item) => ({
            itemId: item.id,
            associations: [
              { propertyIndex: 1, essential: false },
              { propertyIndex: 2, essential: false },
            ],
          })),
        }),
      ),
    ]);
    const mdat = mdatBox(payload);
    return spec.mdatFirst === true
      ? Buffer.concat([ftyp, mdat, meta])
      : Buffer.concat([ftyp, meta, mdat]);
  };
  const probe = build(0);
  const payloadStart =
    spec.mdatFirst === true
      ? ftypBox("heic", 0, ["mif1", "heic"]).length + 8
      : probe.length - payload.length;
  return build(payloadStart);
}

async function expectVwTamperFails(
  source: VwSpec,
  destination: VwSpec,
): Promise<void> {
  // control: the byte-identical copy of the source is a correct output
  expect((await verifyPair(vwFile(source), vwFile(source))).ok).toBe(true);
  expectVerificationFailed(
    await verifyPair(vwFile(source), vwFile(destination)),
  );
}

describe("verify.ts verifyIsobmffOutput destination header checks (67-22, isobmff-9)", () => {
  it("verifyIsobmffOutput ConditionalExpression: a signal aborted before the destination is re-parsed is reported with the aborted code", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = vwFile();
    const result = await verifyPair(file, Buffer.from(file), {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aborted");
  });

  it("verifyIsobmffOutput CallExpression: a destination the admission rules decline fails verification", async () => {
    // item 2 names an external data reference in the destination only; nothing else the verifier
    // compares differs, so only the destination's own admission check can refuse it
    const declined: VwSpec = {
      items: [
        vwDefaultItems()[0]!,
        { ...vwDefaultItems()[1]!, dataReferenceIndex: 1 },
      ],
    };
    await expectVwTamperFails({}, declined);
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: a destination whose primary item id differs fails verification", async () => {
    await expectVwTamperFails({ primary: 1 }, { primary: 2 });
  });

  it("verifyIsobmffOutput ConditionalExpression: an iloc version, length size, base offset size or index size that differs from the source's fails verification", async () => {
    // each field changes alone; the offset size is pinned by an earlier suite
    await expectVwTamperFails({ ilocVersion: 1 }, { ilocVersion: 0 });
    await expectVwTamperFails({ lengthSize: 4 }, { lengthSize: 8 });
    await expectVwTamperFails({ baseOffsetSize: 4 }, { baseOffsetSize: 0 });
    await expectVwTamperFails({ indexSize: 0 }, { indexSize: 4 });
  });

  it("verifyIsobmffOutput ConditionalExpression, MethodExpression and ArrowFunction: the same top-level boxes in another order fail verification", async () => {
    // same box count, same ftyp bytes, same items and bytes: only the order of meta and mdat differs
    await expectVwTamperFails({}, { mdatFirst: true });
  });

  it("verifyIsobmffOutput ConditionalExpression: the source's ftyp is the box found by type, not whichever box comes first", async () => {
    // hand-assembled admission: a synthetic leading `free` header that the type filter drops, so
    // the type lists still match and only the type lookup separates ftyp from the first box
    const file = vwFile();
    const control = await verifyPair(file, Buffer.from(file), {
      adjustAdmission: (admission) => {
        const boxes = admission.model.layout.topLevelBoxes as BoxHeader[];
        boxes.unshift({
          ...boxes[0]!,
          type: "free",
          start: boxes[0]!.start + 4,
          end: boxes[0]!.end + 4,
        });
      },
    });
    expect(control.ok).toBe(true);
  });
});

// --- verify.ts item set and Exif item checks (67-22, isobmff-9) ---
//
// The source admission is hand-patched in exactly one expectation (the way `## 67-21` did for
// `removedColrPropertyIndices`), or the destination differs from the source in exactly one record,
// after the unpatched control is shown to verify. `vxFile` is the source/destination assembler:
// item 1 is the primary `hvc1` payload and item 2 is the Exif item `k` whose payload is `kPayload`.

function vxPrimary(): Buffer {
  return Buffer.from([1, 2, 3, 4]);
}

function vxMinimalExifPayload(orientation = 1): Buffer {
  return Buffer.concat([Buffer.alloc(4), createMinimalExif({ orientation })]);
}

function vxFile(
  kPayload: Buffer = vxMinimalExifPayload(),
  over: Partial<AssembleHeifSpec> = {},
  kOver: Partial<HostileItemSpec> = {},
): Buffer {
  return assembleHeif({
    twoPass: true,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: 4 }],
        propertyIndices: [1, 2],
      },
      {
        itemId: 2,
        itemType: "Exif",
        extents: [{ relOffset: 4, length: kPayload.length }],
        ...kOver,
      },
    ],
    refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
    mdatPayload: Buffer.concat([vxPrimary(), kPayload]),
    ...over,
  });
}

const VX_KEEP_K = {
  preserveOrientation: true,
  expectedOrientation: 1,
} as const;

/** Verifies the source against the byte-identical destination with the admission patched, and the
 * unpatched admission against the same pair as the control. */
async function expectPatchedAdmissionFails(
  file: Buffer,
  patch: (admission: IsobmffAdmission) => void,
  options: VerifyPairOptions = {},
): Promise<void> {
  expect((await verifyPair(file, Buffer.from(file), options)).ok).toBe(true);
  expectVerificationFailed(
    await verifyPair(file, Buffer.from(file), {
      ...options,
      adjustAdmission: patch,
    }),
  );
}

describe("verify.ts verifyIsobmffOutput surviving item set and Exif item count (67-22, isobmff-9)", () => {
  const threeItems = (): Buffer =>
    vwFile({
      items: [
        ...vwDefaultItems(),
        { id: 3, payload: Buffer.from([10, 11, 12]) },
      ],
    });

  it("verifyIsobmffOutput ConditionalExpression, LogicalOperator, MethodExpression, ArrowFunction and BlockStatement: the surviving item ids in another order fail verification", async () => {
    await expectPatchedAdmissionFails(threeItems(), (admission) => {
      (admission.model.items as IsobmffItem[]).reverse();
    });
  });

  it("verifyIsobmffOutput ConditionalExpression: a destination item the plan removes fails verification", async () => {
    await expectPatchedAdmissionFails(threeItems(), (admission) => {
      (admission.classification.removableItemIds as number[]).push(3);
    });
  });

  it("verifyIsobmffOutput ConditionalExpression, StringLiteral and BlockStatement: a mime item that remains in the destination fails verification", async () => {
    const mimeFile = (itemType: string): Buffer =>
      assembleHeif({
        twoPass: true,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType,
            ...(itemType === "mime"
              ? { contentType: "application/rdf+xml" }
              : {}),
            extents: [{ relOffset: 4, length: 5 }],
          },
        ],
        mdatPayload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      });
    // the plan keeps every item, so only the mime rule can refuse the file
    const keepAll = (admission: IsobmffAdmission): void => {
      (admission.classification.removableItemIds as number[]).length = 0;
    };
    const control = mimeFile("hvc1");
    expect(
      (
        await verifyPair(control, Buffer.from(control), {
          adjustAdmission: keepAll,
        })
      ).ok,
    ).toBe(true);
    const withMime = mimeFile("mime");
    expectVerificationFailed(
      await verifyPair(withMime, Buffer.from(withMime), {
        adjustAdmission: keepAll,
      }),
    );
  });

  it("verifyIsobmffOutput ConditionalExpression: an Exif item that is not the kept item fails verification", async () => {
    const exifPayload = Buffer.concat([
      Buffer.alloc(4),
      createOrientationExif(1),
    ]);
    // the plan keeps every item and no minimal Exif item is wanted
    const keepAll = (admission: IsobmffAdmission): void => {
      (admission.classification.removableItemIds as number[]).length = 0;
    };
    const control = vxFile(exifPayload, { refs: [] }, { itemType: "hvc1" });
    expect(
      (
        await verifyPair(control, Buffer.from(control), {
          adjustAdmission: keepAll,
        })
      ).ok,
    ).toBe(true);
    const file = vxFile(exifPayload, { refs: [] });
    expectVerificationFailed(
      await verifyPair(file, Buffer.from(file), { adjustAdmission: keepAll }),
    );
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: a kept item id whose destination item is not an Exif item fails verification", async () => {
    const source = vxFile(
      Buffer.concat([Buffer.alloc(4), createOrientationExif(6)]),
    );
    const destination = (itemType: string): Buffer =>
      vxFile(vxMinimalExifPayload(), {}, { itemType });
    const control = await verifyPair(source, destination("Exif"), VX_KEEP_K);
    expect(control.ok).toBe(true);
    expectVerificationFailed(
      await verifyPair(source, destination("hvc1"), VX_KEEP_K),
    );
  });
});

describe("verify.ts verifyIsobmffOutput kept Exif item checks (67-22, isobmff-9)", () => {
  const withThirdItem = (
    kPayload: Buffer,
    refs: readonly IrefRef[],
    kOver: Partial<HostileItemSpec> = {},
  ): Buffer =>
    vxFile(
      kPayload,
      {
        refs,
        items: [
          {
            itemId: 1,
            itemType: "hvc1",
            extents: [{ relOffset: 0, length: 4 }],
            propertyIndices: [1, 2],
          },
          {
            itemId: 2,
            itemType: "Exif",
            extents: [{ relOffset: 4, length: kPayload.length }],
            ...kOver,
          },
          {
            itemId: 3,
            itemType: "hvc1",
            extents: [{ relOffset: 4 + kPayload.length, length: 2 }],
            propertyIndices: [1, 2],
          },
        ],
        mdatPayload: Buffer.concat([
          vxPrimary(),
          kPayload,
          Buffer.from([7, 8]),
        ]),
      },
      kOver,
    );

  const verifyKept = async (file: Buffer): Promise<Result<void>> =>
    verifyPair(file, Buffer.from(file), VX_KEEP_K);

  it("verifyIsobmffOutput ConditionalExpression and LogicalOperator: only a cdsc record from the kept item that reduces to the primary item counts toward the single qualifying record", async () => {
    // three decoys that each fail exactly one of the four qualifying conditions: another record
    // type from k, a cdsc record from another item, and a cdsc record from k with two targets
    const file = withThirdItem(vxMinimalExifPayload(), [
      { type: "cdsc", fromItemId: 2, toItemIds: [1] },
      { type: "auxl", fromItemId: 2, toItemIds: [1] },
      { type: "cdsc", fromItemId: 3, toItemIds: [1] },
      { type: "cdsc", fromItemId: 2, toItemIds: [1, 3] },
    ]);
    expect((await verifyKept(file)).ok).toBe(true);
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: two cdsc records from the kept item that reduce to the primary item fail verification", async () => {
    const file = (refs: readonly IrefRef[]): Buffer =>
      vxFile(vxMinimalExifPayload(), { refs });
    const one: IrefRef = { type: "cdsc", fromItemId: 2, toItemIds: [1] };
    expect((await verifyKept(file([one]))).ok).toBe(true);
    expectVerificationFailed(await verifyKept(file([one, one])));
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: a kept Exif item that carries an ipma entry fails verification", async () => {
    expect((await verifyKept(vxFile())).ok).toBe(true);
    expectVerificationFailed(
      await verifyKept(
        vxFile(vxMinimalExifPayload(), {}, { propertyIndices: [1] }),
      ),
    );
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: a kept Exif item with a second extent fails verification", async () => {
    const payload = vxMinimalExifPayload();
    const file = vxFile(
      payload,
      {},
      {
        extents: [
          { relOffset: 4, length: payload.length },
          { relOffset: 4, length: 0 },
        ],
      },
    );
    expectVerificationFailed(await verifyKept(file));
  });

  it("verifyIsobmffOutput ConditionalExpression, LogicalOperator and BlockStatement: a kept Exif payload that differs, or that is read short, fails verification", async () => {
    const source = vxFile();
    expect((await verifyPair(source, vxFile(), VX_KEEP_K)).ok).toBe(true);

    // same length, other orientation: only the byte comparison can tell
    expectVerificationFailed(
      await verifyPair(source, vxFile(vxMinimalExifPayload(3)), VX_KEEP_K),
    );

    // right bytes, but the read reports one byte too few
    const payloadLength = vxMinimalExifPayload().length;
    expectVerificationFailed(
      await verifyPair(source, vxFile(), {
        ...VX_KEEP_K,
        wrapDestination: (handle) =>
          withReadHook(handle, (length) => (length === payloadLength ? 1 : 0)),
      }),
    );
  });
});

describe("verify.ts verifyIsobmffOutput surviving item records (67-22, isobmff-9)", () => {
  it("verifyIsobmffOutput ConditionalExpression: a surviving item whose infe type, name, hidden flag, content type or content encoding differs fails verification", async () => {
    const patches: Record<string, Partial<IsobmffItem>> = {
      type: { type: "av01" },
      name: { name: "other" },
      hidden: { hidden: true },
      contentType: { contentType: "text/plain" },
      contentEncoding: { contentEncoding: "gzip" },
    };
    for (const patch of Object.values(patches)) {
      await expectPatchedAdmissionFails(vwFile(), (admission) => {
        Object.assign(admission.model.itemsById.get(1)!, patch);
      });
    }
  });

  const threeProps = (): Buffer[] => [ispe(32, 32), hvcC(), ispe(16, 16)];
  const assocFile = (spec: Partial<AssembleHeifSpec>): Buffer =>
    assembleHeif({
      twoPass: true,
      properties: threeProps(),
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 4, length: 5 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ...spec,
    });

  it("verifyIsobmffOutput ConditionalExpression: an item that gains a property association fails verification", async () => {
    const source = assocFile({});
    expect((await verifyPair(source, Buffer.from(source))).ok).toBe(true);
    const destination = assocFile({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 4, length: 5 }],
          propertyIndices: [1, 2, 3],
        },
      ],
    });
    expectVerificationFailed(await verifyPair(source, destination));
  });

  it("verifyIsobmffOutput ConditionalExpression: an association whose essential bit differs fails verification", async () => {
    const source = assocFile({});
    const destination = assocFile({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 4, length: 5 }],
        },
      ],
      extraIpmaEntries: [
        {
          itemId: 2,
          associations: [
            { propertyIndex: 1, essential: true },
            { propertyIndex: 2, essential: false },
          ],
        },
      ],
    });
    expectVerificationFailed(await verifyPair(source, destination));
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: an item that gains an extent fails verification", async () => {
    const source = assocFile({});
    // the second extent is the one byte mdat gains, so the covered length still matches
    const destination = assocFile({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [
            { relOffset: 4, length: 5 },
            { relOffset: 9, length: 1 },
          ],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    expectVerificationFailed(await verifyPair(source, destination));
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: an item whose extent is longer than the source's fails verification", async () => {
    const source = assocFile({});
    // the last item grows by one byte and so does mdat, so the covered length still matches
    const destination = assocFile({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 4, length: 6 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    expectVerificationFailed(await verifyPair(source, destination));
  });
});

describe("verify.ts verifyIsobmffOutput iref records (67-22, isobmff-9)", () => {
  const refFile = (refs: readonly IrefRef[]): Buffer =>
    assembleHeif({
      twoPass: true,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 4, length: 3 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 3,
          itemType: "hvc1",
          extents: [{ relOffset: 7, length: 2 }],
          propertyIndices: [1, 2],
        },
      ],
      refs,
      mdatPayload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    });

  const base: IrefRef = { type: "auxl", fromItemId: 2, toItemIds: [1] };

  it("verifyIsobmffOutput ConditionalExpression, LogicalOperator, MethodExpression, ArrowFunction and BlockStatement: an iref record that differs from the source's in one field fails verification", async () => {
    const withTarget: IrefRef = {
      type: "auxl",
      fromItemId: 3,
      toItemIds: [1, 2],
    };
    const source = refFile([base, withTarget]);
    expect((await verifyPair(source, Buffer.from(source))).ok).toBe(true);
    const tampered: Record<string, readonly IrefRef[]> = {
      type: [{ ...base, type: "thmb" }, withTarget],
      from: [{ ...base, fromItemId: 3 }, withTarget],
      targetCount: [{ ...base, toItemIds: [1, 3] }, withTarget],
      targetId: [base, { ...withTarget, toItemIds: [1, 3] }],
    };
    for (const refs of Object.values(tampered)) {
      expectVerificationFailed(await verifyPair(source, refFile(refs)));
    }
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: an extra trailing iref record fails verification", async () => {
    const source = refFile([base]);
    expectVerificationFailed(
      await verifyPair(
        source,
        refFile([base, { type: "thmb", fromItemId: 3, toItemIds: [1] }]),
      ),
    );
  });
});

// --- verify.ts colour, ipco, mdat coverage and idat checks (67-22, isobmff-9) ---

interface VpSpec {
  readonly properties?: readonly Buffer[];
  readonly omitIpco?: boolean;
  readonly ipmaFirst?: boolean;
  readonly ipmaFlags?: 0 | 1;
  readonly propertyIndices?: readonly number[];
}

/** One `hvc1` item; `iprp` can list `ipma` before `ipco`, use wide association indices, or have no
 * `ipco` at all. */
function vpFile(spec: VpSpec = {}): Buffer {
  const payload = Buffer.from([1, 2, 3, 4]);
  const indices = spec.propertyIndices ?? [1, 2];
  const build = (payloadStart: number): Buffer => {
    const ipco = ipcoBox(spec.properties ?? [ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: spec.ipmaFlags ?? 0,
      entries:
        indices.length > 0
          ? [
              {
                itemId: 1,
                associations: indices.map((propertyIndex) => ({
                  propertyIndex,
                  essential: false,
                })),
              },
            ]
          : [],
    });
    const children =
      spec.omitIpco === true
        ? [ipma]
        : spec.ipmaFirst === true
          ? [ipma, ipco]
          : [ipco, ipma];
    const meta = metaBox([
      hdlrBox("pict"),
      pitmBox(0, 1),
      ilocBox({
        version: 1,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 4,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            constructionMethod: 0,
            dataReferenceIndex: 0,
            baseOffset: payloadStart,
            extents: [{ offset: 0, length: payload.length }],
          },
        ],
      }),
      iinfBox(0, [infeBox({ version: 2, itemId: 1, itemType: "hvc1" })]),
      box("iprp", Buffer.concat(children)),
    ]);
    return Buffer.concat([
      ftypBox("heic", 0, ["mif1", "heic"]),
      meta,
      mdatBox(payload),
    ]);
  };
  return build(build(0).length - payload.length);
}

/** `iccSourceFile` with a chosen `colr` colour type; the `hdlr` name is filler of the ICC length. */
function colrTypeFile(colourType: string, icc: Buffer): Buffer {
  return assembleHeif({
    twoPass: true,
    properties: [
      ispe(32, 32),
      hvcC(),
      box("colr", Buffer.concat([Buffer.from(colourType, "ascii"), icc])),
    ],
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: 4 }],
        propertyIndices: [1, 2, 3],
      },
    ],
    omitHdlr: true,
    extraMetaChildren: [hdlrBox("pict", "x".repeat(icc.length))],
  });
}

describe("verify.ts verifyIsobmffOutput nclx and ipco checks (67-22, isobmff-9)", () => {
  const nclxFile = (): Buffer =>
    vpFile({ properties: [ispe(32, 32), hvcC(), colrNclx(1, 13, 6, true)] });

  it("verifyIsobmffOutput ConditionalExpression, LogicalOperator, ArrowFunction and BlockStatement: a kept nclx colr property that is missing or changed fails verification", async () => {
    // the nclx property is an orphan (no item is associated with it), so only the nclx rule sees it
    await expectPatchedAdmissionFails(nclxFile(), (admission) => {
      Object.assign(admission.model, {
        properties: admission.model.properties.filter(
          (property) => property.colourType !== "nclx",
        ),
      });
    });
    await expectPatchedAdmissionFails(nclxFile(), (admission) => {
      const [first, , nclx] = admission.model.properties;
      Object.assign(nclx!, { start: first!.start, end: first!.end });
    });
  });

  it("verifyIsobmffOutput ConditionalExpression: the ipco box is found by type, wherever it sits in iprp", async () => {
    // ipma comes first in both files, and the two ipma boxes differ in encoding only
    const source = vpFile({ ipmaFirst: true });
    const destination = vpFile({ ipmaFirst: true, ipmaFlags: 1 });
    expect((await verifyPair(source, destination)).ok).toBe(true);
    expect(
      (await verifyPair(source, destination, { preserveColorProfile: false }))
        .ok,
    ).toBe(true);
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: an ipco box that appears or disappears fails verification", async () => {
    const withIpco = vpFile({ propertyIndices: [] });
    const withoutIpco = vpFile({ propertyIndices: [], omitIpco: true });
    expect((await verifyPair(withIpco, Buffer.from(withIpco))).ok).toBe(true);
    expectVerificationFailed(await verifyPair(withIpco, withoutIpco));
    expectVerificationFailed(await verifyPair(withoutIpco, withIpco));
  });

  it("verifyIsobmffOutput ConditionalExpression and BlockStatement: ipco bytes that differ in a property no item uses fail verification while the colour profile is preserved", async () => {
    const source = vpFile({ properties: [ispe(32, 32), hvcC(), ispe(8, 8)] });
    const destination = vpFile({
      properties: [ispe(32, 32), hvcC(), ispe(9, 9)],
    });
    expect((await verifyPair(source, Buffer.from(source))).ok).toBe(true);
    expectVerificationFailed(await verifyPair(source, destination));
  });

  it("verifyIsobmffOutput ConditionalExpression, StringLiteral and BlockStatement: a prof or rICC colr property that remains in the destination fails verification", async () => {
    const icc = iccProfileV4();
    const options = { preserveColorProfile: false } as const;
    // the source admission is hand-patched so that it does not know the colr property is an ICC
    // one; the byte-identical destination then differs from a correct output only in that rule
    const unaware = (admission: IsobmffAdmission): void => {
      Object.assign(admission.model.properties[2]!, { colourType: "xxxx" });
    };
    const control = colrTypeFile("xxxx", icc);
    expect(
      (
        await verifyPair(control, Buffer.from(control), {
          ...options,
          adjustAdmission: unaware,
        })
      ).ok,
    ).toBe(true);
    for (const colourType of ["prof", "rICC"]) {
      const file = colrTypeFile(colourType, icc);
      expectVerificationFailed(
        await verifyPair(file, Buffer.from(file), {
          ...options,
          adjustAdmission: unaware,
        }),
      );
    }
  });

  it("verifyIsobmffOutput ConditionalExpression and StringLiteral: removed rICC payload bytes found anywhere in the destination fail verification", async () => {
    const icc = iccProfileV4();
    const source = colrTypeFile("rICC", icc);
    const destination = await sanitizeBytesThroughWriter(source, false);
    const options = { preserveColorProfile: false } as const;
    expect((await verifyPair(source, destination, options)).ok).toBe(true);
    const leaked = Buffer.from(destination);
    icc.copy(leaked, destination.indexOf(Buffer.alloc(icc.length, 0x78)));
    expectVerificationFailed(await verifyPair(source, leaked, options));
  });

  it("verifyIsobmffOutput ConditionalExpression and EqualityOperator: the whole destination is read only when an ICC property was removed, and an empty ICC payload is not searched for", async () => {
    const options = { preserveColorProfile: false } as const;
    // nothing was removed: a short read of the whole file must not matter, because it is not read
    const plain = plainItemFile(smallPayload());
    expect(
      (
        await verifyPair(plain, Buffer.from(plain), {
          ...options,
          wrapDestination: (handle) =>
            withReadHook(handle, (length, position) =>
              length === plain.length && position === 0 ? 1 : 0,
            ),
        })
      ).ok,
    ).toBe(true);

    // an ICC property with no payload bytes: an empty buffer is "found" in every file
    const source = colrTypeFile("prof", Buffer.alloc(0));
    const destination = await sanitizeBytesThroughWriter(source, false);
    expect((await verifyPair(source, destination, options)).ok).toBe(true);
  });
});

describe("verify.ts verifyIsobmffOutput mdat coverage and idat checks (67-22, isobmff-9)", () => {
  it("verifyIsobmffOutput ConditionalExpression, EqualityOperator and MethodExpression: nested and overlapping extents cover the mdat payload exactly once", async () => {
    // [0,20) contains [2,10); [15,25) overlaps the end of [0,20); the union is the 25 byte payload
    const file = assembleHeif({
      twoPass: true,
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: 20 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 2,
          itemType: "hvc1",
          extents: [{ relOffset: 2, length: 8 }],
          propertyIndices: [1, 2],
        },
        {
          itemId: 3,
          itemType: "hvc1",
          extents: [{ relOffset: 15, length: 10 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.alloc(25, 7),
    });
    expect((await verifyPair(file, Buffer.from(file))).ok).toBe(true);
  });

  const idatFile = (idat?: Buffer): Buffer =>
    assembleHeif({
      twoPass: true,
      ...(idat !== undefined ? { idatPayload: idat } : {}),
    });

  it("verifyIsobmffOutput ConditionalExpression, BlockStatement and StringLiteral: an idat box that appears, disappears, changes length or changes bytes fails verification", async () => {
    const source = idatFile(Buffer.from([1, 2, 3, 4]));
    expect((await verifyPair(source, Buffer.from(source))).ok).toBe(true);
    expectVerificationFailed(await verifyPair(source, idatFile()));
    expectVerificationFailed(await verifyPair(idatFile(), source));
    expectVerificationFailed(
      await verifyPair(source, idatFile(Buffer.from([1, 2, 3, 4, 5]))),
    );
    expectVerificationFailed(
      await verifyPair(source, idatFile(Buffer.from([1, 2, 3, 5]))),
    );
  });
});

// --- writer.ts writeAll and writeIsobmffOutput (67-22, isobmff-9) ---
//
// The destination handle is a recording stand-in whose `write` reports whatever the scenario needs,
// so the offsets, lengths and positions the writer asks for are asserted directly.

function recordingHandle(progress: (length: number, call: number) => number): {
  readonly handle: FileHandle;
  readonly calls: [number, number, number][];
} {
  const calls: [number, number, number][] = [];
  const handle = {
    write: async (
      data: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      calls.push([offset, length, position]);
      return { bytesWritten: progress(length, calls.length), buffer: data };
    },
  } as unknown as FileHandle;
  return { handle, calls };
}

function bytesPlan(...parts: Buffer[]): IsobmffOutputPlan {
  return {
    parts: parts.map((data) => ({ kind: "bytes" as const, data })),
    removedItemIds: [],
  };
}

describe("writer.ts writeAll and writeIsobmffOutput clusters (67-22, isobmff-9)", () => {
  const unusedSource = {} as unknown as FileHandle;

  it("writeAll ArithmeticOperator: a write that makes partial progress is continued at the next offset, length and file position", async () => {
    // two bytes per call: the 5-byte part takes three calls, and the next part starts at 5
    const { handle, calls } = recordingHandle((length) => Math.min(2, length));
    await writeIsobmffOutput(
      unusedSource,
      handle,
      bytesPlan(Buffer.from([1, 2, 3, 4, 5]), Buffer.from([6, 7])),
    );
    expect(calls).toEqual([
      [0, 5, 0],
      [2, 3, 2],
      [4, 1, 4],
      [0, 2, 5],
    ]);
  });

  it("writeAll ConditionalExpression: a write that makes no progress fails instead of retrying", async () => {
    // zero progress on the first call, full progress afterwards: only a writer that stops at the
    // first stalled write rejects
    const { handle, calls } = recordingHandle((length, call) =>
      call === 1 ? 0 : length,
    );
    await expect(
      writeIsobmffOutput(
        unusedSource,
        handle,
        bytesPlan(Buffer.from([1, 2, 3])),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("writeIsobmffOutput ConditionalExpression, LogicalOperator and StringLiteral: an aborted signal stops before the next part is written, with the signal's own reason or an AbortError", async () => {
    const reason = new Error("stopped by the caller");
    const controller = new AbortController();
    controller.abort(reason);
    const first = recordingHandle((length) => length);
    await expect(
      writeIsobmffOutput(
        unusedSource,
        first.handle,
        bytesPlan(Buffer.from([1, 2, 3])),
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(first.calls).toHaveLength(0);

    // a signal object that carries no reason
    const second = recordingHandle((length) => length);
    await expect(
      writeIsobmffOutput(
        unusedSource,
        second.handle,
        bytesPlan(Buffer.from([1, 2, 3])),
        { aborted: true } as unknown as AbortSignal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(second.calls).toHaveLength(0);
  });
});

const JH_APP0 = 0xe0;
const JH_APP1 = 0xe1;
const JH_APP14 = 0xee;

async function jhFreshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-jpeg-handler-"));
  cleanupDirectories.push(directory);
  return directory;
}

function jhXmpAppPayload(text: string): Buffer {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"><dc:description>${text}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

interface JhMarkerRange {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

/**
 * A small, test-local JPEG marker walker independent of `src/jpeg/parser.ts`
 * -- used only to assert on marker sequences and byte ranges, never as a
 * production parse.
 */
function jhReadMarkerRanges(bytes: Buffer): JhMarkerRange[] {
  const ranges: JhMarkerRange[] = [];
  let offset = 2; // past SOI
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff)
      throw new Error("expected a marker prefix byte");
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) {
      ranges.push({ marker, start, end: offset });
      break;
    }
    if (marker === 0xda) {
      const length = bytes.readUInt16BE(offset);
      offset += length;
      for (;;) {
        while (bytes[offset] !== 0xff) offset += 1;
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      ranges.push({ marker, start, end: offset });
      continue;
    }
    const length = bytes.readUInt16BE(offset);
    offset += length;
    ranges.push({ marker, start, end: offset });
  }
  return ranges;
}

function jhMarkerSequence(bytes: Buffer): number[] {
  return jhReadMarkerRanges(bytes).map((range) => range.marker);
}

function jhFirstRangeByMarker(
  ranges: readonly JhMarkerRange[],
  marker: number,
): JhMarkerRange | undefined {
  return ranges.find((range) => range.marker === marker);
}

function jhNoPreservation(): {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
} {
  return {
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: false,
  };
}

const JH_APP15 = 0xef;
const JH_DRI = 0xdd;
const JH_XMP_GUID = "ABCD1234ABCD1234ABCD1234ABCD1234";

async function jhWriteSource(source: Buffer): Promise<string> {
  const directory = await jhFreshDirectory();
  const sourcePath = join(directory, "source.jpg");
  await writeFile(sourcePath, source);
  return sourcePath;
}

async function jhInspectBytes(source: Buffer) {
  const result = await inspectFile(await jhWriteSource(source));
  if (!result.ok)
    throw new Error(`inspectFile failed with ${result.error.code}`);
  return result.value;
}

interface JhPreservationFlags {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
}

async function jhSanitizeBytes(
  source: Buffer,
  options: Partial<JhPreservationFlags> = {},
) {
  const directory = await jhFreshDirectory();
  const sourcePath = join(directory, "source.jpg");
  const destinationPath = join(directory, "destination.jpg");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...jhNoPreservation(),
    ...options,
  });
  return { result, sourcePath, destinationPath };
}

async function jhAdmitBytes(source: Buffer) {
  const handle = await open(await jhWriteSource(source), "r");
  try {
    return await jpegHandler.admit(handle, source.length);
  } finally {
    await handle.close();
  }
}

/** A JFIF APP0 payload with explicit unit, density and thumbnail dimensions;
 * `length` cuts it short of the 14-byte fixed header. */
function jhJfifBytes(fields: {
  readonly unit?: number;
  readonly x?: number;
  readonly y?: number;
  readonly thumbnailWidth?: number;
  readonly thumbnailHeight?: number;
  readonly length?: number;
}): Buffer {
  const data = Buffer.alloc(9);
  data[0] = 1;
  data[1] = 1;
  data[2] = fields.unit ?? 1;
  data.writeUInt16BE(fields.x ?? 72, 3);
  data.writeUInt16BE(fields.y ?? 72, 5);
  data[7] = fields.thumbnailWidth ?? 0;
  data[8] = fields.thumbnailHeight ?? 0;
  const full = Buffer.concat([Buffer.from("JFIF\0", "ascii"), data]);
  return full.subarray(0, fields.length ?? full.length);
}

function jhStandardXmpOrientationPayload(
  orientation: number,
  guid?: string,
): Buffer {
  const note =
    guid === undefined
      ? ""
      : ` xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${guid}"`;
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description tiff:Orientation="${String(orientation)}" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"${note}></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

/** Only the first 32-byte chunk of an ExtendedXMP packet: a coverage gap, so
 * the reassembly is incomplete. */
function jhIncompleteExtendedXmpPayload(guid: string): Buffer {
  const xml = Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="8"></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
  const header = Buffer.alloc(8);
  header.writeUInt32BE(xml.length, 0);
  header.writeUInt32BE(0, 4);
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
    Buffer.from(guid, "ascii"),
    header,
    xml.subarray(0, 32),
  ]);
}

function jhGainMapXmpPayload(): Buffer {
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

describe("jpeg-handler.ts collectMetadata and helper clusters (67-23, jpeg-1)", () => {
  it("isStructuralMarker ConditionalExpression: a DRI restart-interval segment is structural and survives sanitization byte-identically", async () => {
    const source = minimalJpeg({ components: 3, restartInterval: 4 });
    expect(jhMarkerSequence(source)).toContain(JH_DRI);

    const { result, destinationPath } = await jhSanitizeBytes(source);
    expect(result.ok).toBe(true);
    const destination = await readFile(destinationPath);
    expect(jhMarkerSequence(destination)).toContain(JH_DRI);
    expect(destination.equals(source)).toBe(true);
  });

  it("readJfifDensity ConditionalExpression: a JFIF payload shorter than the 14-byte header reports no density", async () => {
    const whole = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP0, jhJfifBytes({})),
      ]),
    );
    expect(
      whole.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toHaveLength(3);

    const short = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP0, jhJfifBytes({ length: 13 })),
      ]),
    );
    expect(
      short.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toEqual([]);
  });

  it("collectMetadata BlockStatement and StringLiteral: a kept-candidate JFIF reports its unit and densities as named JPEG entries", async () => {
    const inspection = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP0, jhJfifBytes({ unit: 2, x: 300, y: 150 })),
      ]),
    );
    expect(
      inspection.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toEqual([
      { namespace: "JPEG", name: "JFIF:ResolutionUnit", value: 2 },
      { namespace: "JPEG", name: "JFIF:XResolution", value: 300 },
      { namespace: "JPEG", name: "JFIF:YResolution", value: 150 },
    ]);
  });

  it("jfifHasEmbeddedThumbnail LogicalOperator and ConditionalExpression: a width-only or height-only thumbnail declines resolution preservation", async () => {
    for (const thumbnail of [
      { thumbnailWidth: 1, thumbnailHeight: 0 },
      { thumbnailWidth: 0, thumbnailHeight: 1 },
    ]) {
      const source = spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP0, jhJfifBytes(thumbnail)),
      ]);
      const { result, sourcePath } = await jhSanitizeBytes(source, {
        preserveResolution: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("unsafe-structure");
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");
      expect((await readFile(sourcePath)).equals(source)).toBe(true);
    }

    const control = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP0, jhJfifBytes({})),
    ]);
    const { result } = await jhSanitizeBytes(control, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
  });

  it("jfifHasEmbeddedThumbnail ConditionalExpression, EqualityOperator and BooleanLiteral: a JFIF payload shorter than the header is never treated as carrying a thumbnail", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP0, jhJfifBytes({ thumbnailWidth: 1, length: 13 })),
    ]);
    const { result, destinationPath } = await jhSanitizeBytes(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    const destination = await readFile(destinationPath);
    const sourceJfif = jhFirstRangeByMarker(
      jhReadMarkerRanges(source),
      JH_APP0,
    )!;
    const destinationJfif = jhFirstRangeByMarker(
      jhReadMarkerRanges(destination),
      JH_APP0,
    )!;
    expect(
      destination
        .subarray(destinationJfif.start, destinationJfif.end)
        .equals(source.subarray(sourceJfif.start, sourceJfif.end)),
    ).toBe(true);
  });

  it("markerLabel ConditionalExpression: an APPn segment whose identifier is empty is named APPn without a colon", async () => {
    const inspection = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP15, Buffer.from([0x00, 0x41, 0x42])),
        appSegment(JH_APP15, Buffer.from("ZZ\0payload", "ascii")),
      ]),
    );
    const labelled = inspection.entries.filter((entry) =>
      entry.name.startsWith("APP15"),
    );
    expect(labelled).toEqual([
      { namespace: "JPEG", name: "APP15", value: 3 },
      { namespace: "JPEG", name: "APP15:ZZ", value: 10 },
    ]);
  });

  it("collectMetadata BooleanLiteral: jfifDroppedForAdobe is true only when an APP14 Adobe segment drops the JFIF segment", async () => {
    const base = minimalJpeg({ components: 3 });
    const jfif = appSegment(JH_APP0, jhJfifBytes({}));
    const adobe = appSegment(JH_APP14, jpegAdobe(1));

    expect(
      (await jhAdmitBytes(spliceSegments(base, [jfif, adobe])))
        .jfifDroppedForAdobe,
    ).toBe(true);
    expect(
      (await jhAdmitBytes(spliceSegments(base, [jfif]))).jfifDroppedForAdobe,
    ).toBe(false);
    expect(
      (await jhAdmitBytes(spliceSegments(base, [adobe]))).jfifDroppedForAdobe,
    ).toBe(false);
    expect((await jhAdmitBytes(base)).jfifDroppedForAdobe).toBe(false);
  });

  it("collectMetadata CallExpression: EXIF parse warnings reach the inspection", async () => {
    const broken = jpegExif(
      Buffer.concat([
        Buffer.from("II*\0", "latin1"),
        Buffer.from([0xff, 0xff, 0xff, 0x7f]),
      ]),
    );
    const warned = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP1, broken),
      ]),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP1, jpegExif(exifWithArtist("private workflow"))),
      ]),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata CallExpression: standard XMP parse warnings reach the inspection", async () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ]);
    const warned = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP1, invalidUtf8),
      ]),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await jhInspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(JH_APP1, jhXmpAppPayload("private workflow")),
      ]),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata CallExpression: the standard XMP entries feed the trailer classification, so a gain-map XMP with trailer bytes is refused", async () => {
    const withXmp = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jhGainMapXmpPayload()),
    ]);
    const clean = await inspectFile(await jhWriteSource(withXmp));
    expect(clean.ok).toBe(true);

    const refused = await inspectFile(
      await jhWriteSource(appendTrailer(withXmp, Buffer.alloc(32, 0x41))),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("unsafe-structure");
  });

  it("collectMetadata CallExpression: ICC parse warnings reach the inspection", async () => {
    const profile = iccProfileV4();
    const broken = Buffer.from(profile);
    broken.write("nope", 36, 4, "ascii");
    const warned = await jhInspectBytes(
      spliceSegments(
        minimalJpeg({ components: 3 }),
        iccSegments(broken, broken.length),
      ),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await jhInspectBytes(
      spliceSegments(
        minimalJpeg({ components: 3 }),
        iccSegments(profile, profile.length),
      ),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata MethodExpression: an XMP orientation that agrees with EXIF does not mask an incomplete ExtendedXMP", async () => {
    const exif = appSegment(JH_APP1, jpegExif(exifWithOrientation(6)));
    const agreeing = spliceSegments(minimalJpeg({ components: 3 }), [
      exif,
      appSegment(JH_APP1, jhStandardXmpOrientationPayload(6)),
    ]);
    const kept = await jhSanitizeBytes(agreeing, { preserveOrientation: true });
    expect(kept.result.ok).toBe(true);

    const incomplete = spliceSegments(minimalJpeg({ components: 3 }), [
      exif,
      appSegment(JH_APP1, jhStandardXmpOrientationPayload(6, JH_XMP_GUID)),
      appSegment(JH_APP1, jhIncompleteExtendedXmpPayload(JH_XMP_GUID)),
    ]);
    const { result } = await jhSanitizeBytes(incomplete, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if ("feature" in result.error) {
      expect(result.error.feature).toBe("orientation-preservation");
    }
  });
});

const JH_DQT = 0xdb;
const JH_DHT = 0xc4;
const JH_SOS = 0xda;
function jhEoiBytes(): Buffer {
  return Buffer.from([0xff, 0xd9]);
}

interface JhHandleCall {
  readonly offset: number;
  readonly length: number;
  readonly position: number;
  readonly bufferLength: number;
}

interface JhCallPlan {
  /** Bytes the call really transfers (a partial read or write). */
  readonly transfer?: number;
  /** Bytes subtracted from the reported count after a full real read. */
  readonly underReport?: number;
  /** Report zero bytes without touching the file. */
  readonly stall?: boolean;
  /** Throw, to stop a loop that should have ended. */
  readonly fail?: boolean;
}

type JhCallScript = (
  call: JhHandleCall,
  index: number,
) => JhCallPlan | undefined;

/**
 * Wraps a real FileHandle so every read and write is recorded and a script can
 * shorten, stall or fail individual calls. The record holds the exact
 * (offset, length, position) arguments the handler passed.
 */
function jhScriptedHandle(handle: FileHandle, script?: JhCallScript) {
  const reads: JhHandleCall[] = [];
  const writes: JhHandleCall[] = [];
  const serveRead = async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const call = { offset, length, position, bufferLength: buffer.length };
    const plan = script?.(call, reads.length) ?? {};
    reads.push(call);
    if (plan.fail === true) throw new Error("scripted handle: runaway loop");
    if (plan.stall === true) return { bytesRead: 0, buffer };
    const done = await handle.read(
      buffer,
      offset,
      Math.min(length, plan.transfer ?? length),
      position,
    );
    return { bytesRead: done.bytesRead - (plan.underReport ?? 0), buffer };
  };
  const serveWrite = async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const call = { offset, length, position, bufferLength: buffer.length };
    const plan = script?.(call, writes.length) ?? {};
    writes.push(call);
    if (plan.fail === true) throw new Error("scripted handle: runaway loop");
    if (plan.stall === true) return { bytesWritten: 0, buffer };
    const done = await handle.write(
      buffer,
      offset,
      Math.min(length, plan.transfer ?? length),
      position,
    );
    return { bytesWritten: done.bytesWritten, buffer };
  };
  const proxy = new Proxy(handle, {
    get(target, property) {
      if (property === "read") return serveRead;
      if (property === "write") return serveWrite;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { handle: proxy, reads, writes };
}

interface JhVerifyScripts {
  readonly source?: JhCallScript;
  readonly destination?: JhCallScript;
  readonly signal?: AbortSignal;
  /** Replaces the admission the verifier receives. */
  readonly admission?: (admitted: JpegAdmission) => JpegAdmission;
  /** Replaces the Orientation the verifier is asked to expect. */
  readonly expectedOrientation?: number;
}

/**
 * Runs the shipped jpegHandler.verifyOutput of `source` against an arbitrary
 * `destination` byte string (not necessarily what the handler would write), so
 * a test can change exactly one dimension of an otherwise valid output.
 */
async function jhVerifyDestination(
  source: Buffer,
  destination: Buffer,
  flags: Partial<JhPreservationFlags> = {},
  scripts: JhVerifyScripts = {},
) {
  const directory = await jhFreshDirectory();
  const sourcePath = join(directory, "source.jpg");
  const destinationPath = join(directory, "destination.jpg");
  await writeFile(sourcePath, source);
  await writeFile(destinationPath, destination);
  const sourceHandle = await open(sourcePath, "r");
  const destinationHandle = await open(destinationPath, "r");
  try {
    const admitted = await jpegHandler.admit(sourceHandle, source.length);
    const admission = scripts.admission?.(admitted) ?? admitted;
    const orientation =
      scripts.expectedOrientation ??
      (admitted.orientation.status === "valid"
        ? admitted.orientation.value
        : undefined);
    const scriptedSource = jhScriptedHandle(sourceHandle, scripts.source);
    const scriptedDestination = jhScriptedHandle(
      destinationHandle,
      scripts.destination,
    );
    const result: Result<void> = await jpegHandler.verifyOutput(
      scriptedSource.handle,
      admission,
      scriptedDestination.handle,
      destination.length,
      destinationPath,
      flags.preserveOrientation ?? false,
      flags.preserveColorProfile ?? false,
      flags.preserveResolution ?? false,
      orientation,
      scripts.signal,
    );
    return {
      result,
      sourceReads: scriptedSource.reads,
      destinationReads: scriptedDestination.reads,
    };
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
  }
}

/** The number of reads parseJpeg alone makes of `destination`. */
async function jhParseReadCount(destination: Buffer): Promise<number> {
  const directory = await jhFreshDirectory();
  const path = join(directory, "destination.jpg");
  await writeFile(path, destination);
  const handle = await open(path, "r");
  try {
    const scripted = jhScriptedHandle(handle);
    await parseJpeg(scripted.handle, destination.length);
    return scripted.reads.length;
  } finally {
    await handle.close();
  }
}

async function jhSanitizedBytes(
  source: Buffer,
  options: Partial<JhPreservationFlags> = {},
): Promise<Buffer> {
  const { result, destinationPath } = await jhSanitizeBytes(source, options);
  expect(result.ok).toBe(true);
  return readFile(destinationPath);
}

function jhSegmentRange(
  bytes: Buffer,
  marker: number,
  occurrence = 0,
): JhMarkerRange {
  const range = jhReadMarkerRanges(bytes).filter(
    (candidate) => candidate.marker === marker,
  )[occurrence];
  if (range === undefined) throw new Error("the marker is not in the bytes");
  return range;
}

function jhSwapAdjacentSegments(
  bytes: Buffer,
  firstMarker: number,
  secondMarker: number,
): Buffer {
  const first = jhSegmentRange(bytes, firstMarker);
  const second = jhSegmentRange(bytes, secondMarker);
  if (first.end !== second.start) throw new Error("the segments are apart");
  return Buffer.concat([
    bytes.subarray(0, first.start),
    bytes.subarray(second.start, second.end),
    bytes.subarray(first.start, first.end),
    bytes.subarray(second.end),
  ]);
}

function jhWithByte(bytes: Buffer, position: number, value: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[position] = value;
  return copy;
}

/** A metadata-free JPEG whose scan is longer than one copy block, filled with
 * a repeating pattern that never contains 0xFF. */
function jhLargeScanJpeg(): Buffer {
  const base = minimalJpeg({ components: 3 });
  const filler = Buffer.alloc(COPY_BLOCK_BYTES + 5000);
  for (let index = 0; index < filler.length; index += 1)
    filler[index] = (index * 7 + 3) % 251;
  return Buffer.concat([
    base.subarray(0, base.length - jhEoiBytes().length),
    filler,
    jhEoiBytes(),
  ]);
}

describe("jpeg-handler.ts plan, I/O and verification clusters (67-24, jpeg-2)", () => {
  it("buildOutputPlan CallExpression: the synthesized Exif slot contributes the APP1 marker to the expected sequence", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jpegExifOrientationPayload(6)),
    ]);
    const admission = await jhAdmitBytes(source);
    const plan = jpegHandler.buildOutputPlan(admission, true, false, false, 6);
    expect(plan.parts[0]?.kind).toBe("insert");
    expect(plan.expectedMarkers).toEqual([
      JH_APP1,
      JH_DQT,
      0xc0,
      JH_DHT,
      JH_SOS,
    ]);
  });

  it("buildOutputPlan ConditionalExpression: adjacent kept segments coalesce into one copy part and a removed segment splits the ranges", async () => {
    const plain = minimalJpeg({ components: 3 });
    const plainAdmission = await jhAdmitBytes(plain);
    const plainPlan = jpegHandler.buildOutputPlan(
      plainAdmission,
      false,
      false,
      false,
      undefined,
    );
    const segments = plainAdmission.parsed.segments;
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    expect(plainPlan.parts).toEqual([
      {
        kind: "copy",
        sourceOffset: first.offset,
        length: last.offset + last.totalLength - first.offset,
      },
    ]);
    expect(plainPlan.copiedRanges).toEqual([
      {
        sourceOffset: first.offset,
        length: last.offset + last.totalLength - first.offset,
      },
    ]);

    const split = spliceSegments(
      plain,
      [appSegment(0xfe, Buffer.from("remove me"))],
      "before-sof",
    );
    const splitAdmission = await jhAdmitBytes(split);
    const splitPlan = jpegHandler.buildOutputPlan(
      splitAdmission,
      false,
      false,
      false,
      undefined,
    );
    expect(splitPlan.parts.map((part) => part.kind)).toEqual(["copy", "copy"]);
  });

  it("writeAll ArithmeticOperator: a partial write continues at the next unwritten byte with only the remainder", async () => {
    const directory = await jhFreshDirectory();
    const path = join(directory, "destination.jpg");
    const destination = await open(path, "wx");
    try {
      const scripted = jhScriptedHandle(destination, () => ({ transfer: 2 }));
      const plan: JpegOutputPlan = {
        parts: [{ kind: "insert", data: Buffer.from([1, 2, 3, 4, 5, 6]) }],
        expectedMarkers: [],
        copiedRanges: [],
        preserveResolution: false,
      };
      await jpegHandler.writeOutput(
        undefined as unknown as FileHandle,
        scripted.handle,
        plan,
      );
      expect(
        scripted.writes.map((call) => [
          call.offset,
          call.length,
          call.position,
        ]),
      ).toEqual([
        [0, 2, 0],
        [0, 6, 2],
        [2, 4, 4],
        [4, 2, 6],
        [0, 2, 8],
      ]);
    } finally {
      await destination.close();
    }
    expect([...(await readFile(path))]).toEqual([
      0xff, 0xd8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9,
    ]);
  });

  it("writeAll ConditionalExpression: a write that makes no progress fails after exactly one attempt", async () => {
    const directory = await jhFreshDirectory();
    const destination = await open(join(directory, "destination.jpg"), "wx");
    try {
      const scripted = jhScriptedHandle(destination, (_call, index) =>
        index === 0 ? { stall: true } : { fail: true },
      );
      const plan: JpegOutputPlan = {
        parts: [],
        expectedMarkers: [],
        copiedRanges: [],
        preserveResolution: false,
      };
      await expect(
        jpegHandler.writeOutput(
          undefined as unknown as FileHandle,
          scripted.handle,
          plan,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(scripted.writes).toHaveLength(1);
    } finally {
      await destination.close();
    }
  });

  it("readTail ArithmeticOperator, EqualityOperator and ConditionalExpression: partial trailer reads continue at the next unread byte and stop when the tail is full", async () => {
    const tailBytes = 41;
    const source = appendTrailer(
      minimalJpeg({ components: 3 }),
      Buffer.alloc(tailBytes, 0x55),
    );
    const directory = await jhFreshDirectory();
    const path = join(directory, "source.jpg");
    await writeFile(path, source);
    const handle = await open(path, "r");
    try {
      const scripted = jhScriptedHandle(handle, (call) =>
        call.bufferLength === tailBytes ? { transfer: 5 } : undefined,
      );
      await jpegHandler
        .admit(scripted.handle, source.length)
        .catch(() => undefined);
      const tailStart = source.length - tailBytes;
      const expected: number[][] = [];
      for (let read = 0; read < tailBytes; read += 5)
        expected.push([read, tailBytes - read, tailStart + read]);
      expect(
        scripted.reads
          .filter((call) => call.bufferLength === tailBytes)
          .map((call) => [call.offset, call.length, call.position]),
      ).toEqual(expected);
    } finally {
      await handle.close();
    }
  });

  it("readTail ConditionalExpression: a read that returns no bytes ends the tail read after one attempt", async () => {
    const tailBytes = 41;
    const source = appendTrailer(
      minimalJpeg({ components: 3 }),
      Buffer.alloc(tailBytes, 0x55),
    );
    const directory = await jhFreshDirectory();
    const path = join(directory, "source.jpg");
    await writeFile(path, source);
    const handle = await open(path, "r");
    try {
      let stalledTailReads = 0;
      const scripted = jhScriptedHandle(handle, (call) => {
        if (call.bufferLength !== tailBytes) return undefined;
        stalledTailReads += 1;
        return stalledTailReads === 1 ? { stall: true } : { fail: true };
      });
      await jpegHandler
        .admit(scripted.handle, source.length)
        .catch(() => undefined);
      expect(
        scripted.reads.filter((call) => call.bufferLength === tailBytes),
      ).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it("segmentsEqual ConditionalExpression, EqualityOperator and BooleanLiteral, and verifyOutput BlockStatement and EqualityOperator: one altered byte in a kept segment fails verification while count and order are unchanged", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(0xee, jpegAdobe(1)),
    ]);
    const output = await jhSanitizedBytes(source);
    const control = await jhVerifyDestination(source, output);
    expect(control.result.ok).toBe(true);

    const adobe = jhSegmentRange(output, 0xee);
    const altered = jhWithByte(output, adobe.end - 1, 7);
    expect(jhMarkerSequence(altered)).toEqual(jhMarkerSequence(output));
    expect(altered.length).toBe(output.length);
    const outcome = await jhVerifyDestination(source, altered);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");

    const table = jhSegmentRange(output, JH_DQT);
    const tableAltered = jhWithByte(output, table.end - 1, 9);
    const tableOutcome = await jhVerifyDestination(source, tableAltered);
    expect(tableOutcome.result.ok).toBe(false);
  });

  it("segmentsEqual ConditionalExpression and BooleanLiteral: a longer scan segment with an identical prefix fails verification", async () => {
    const source = minimalJpeg({ components: 3 });
    const scan = jhSegmentRange(source, JH_SOS);
    const longer = Buffer.concat([
      source.subarray(0, scan.end),
      Buffer.alloc(6, 0x11),
      source.subarray(scan.end),
    ]);
    expect(jhMarkerSequence(longer)).toEqual(jhMarkerSequence(source));
    const outcome = await jhVerifyDestination(source, longer);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
  });

  it("segmentsEqual ArithmeticOperator and MethodExpression: a segment larger than one copy block compares block by block within the buffer bound", async () => {
    const source = jhLargeScanJpeg();
    const scan = jhSegmentRange(source, JH_SOS);
    expect(scan.end - scan.start).toBeGreaterThan(COPY_BLOCK_BYTES);

    const spy = vi.spyOn(Buffer, "allocUnsafe");
    let allocated: number[];
    let outcome;
    try {
      outcome = await jhVerifyDestination(source, source);
      allocated = spy.mock.calls.map((call) => call[0]);
    } finally {
      spy.mockRestore();
    }
    expect(outcome.result.ok).toBe(true);
    expect(Math.max(...allocated)).toBeLessThanOrEqual(COPY_BLOCK_BYTES);
    const scanBlocks = outcome.sourceReads.map((call) => [
      call.length,
      call.position,
    ]);
    expect(
      scanBlocks.filter(([length]) => length === COPY_BLOCK_BYTES),
    ).toEqual([[COPY_BLOCK_BYTES, scan.start]]);

    const lastByte = scan.end - 1;
    const changed = jhWithByte(source, lastByte, source[lastByte]! ^ 0x01);
    const changedOutcome = await jhVerifyDestination(source, changed);
    expect(changedOutcome.result.ok).toBe(false);
  });

  it("segmentsEqual ConditionalExpression and LogicalOperator: a short source read or a short destination read fails verification", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(0xee, jpegAdobe(1)),
    ]);
    const output = await jhSanitizedBytes(source);

    const shortSource = await jhVerifyDestination(
      source,
      output,
      {},
      {
        source: () => ({ underReport: 1 }),
      },
    );
    expect(shortSource.result.ok).toBe(false);
    if (shortSource.result.ok) throw new Error("unreachable");
    expect(shortSource.result.error.code).toBe("verification-failed");

    let sourceReadCount = 0;
    const shortDestination = await jhVerifyDestination(
      source,
      output,
      {},
      {
        source: () => {
          sourceReadCount += 1;
          return undefined;
        },
        destination: () =>
          sourceReadCount > 0 ? { underReport: 1 } : undefined,
      },
    );
    expect(shortDestination.result.ok).toBe(false);
    if (shortDestination.result.ok) throw new Error("unreachable");
    expect(shortDestination.result.error.code).toBe("verification-failed");
  });

  it("segmentsEqual ConditionalExpression: an abort during segment comparison reports the typed aborted error", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(0xee, jpegAdobe(1)),
    ]);
    const output = await jhSanitizedBytes(source);
    const controller = new AbortController();
    const outcome = await jhVerifyDestination(
      source,
      output,
      {},
      {
        source: (_call, index) => {
          if (index === 0) controller.abort();
          return undefined;
        },
        signal: controller.signal,
      },
    );
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("aborted");
  });

  it("verifyOutput ConditionalExpression: a destination with trailer bytes after the primary EOI fails verification", async () => {
    const source = minimalJpeg({ components: 3 });
    const output = await jhSanitizedBytes(source);
    const outcome = await jhVerifyDestination(
      source,
      appendTrailer(output, Buffer.from([1, 2, 3, 4])),
    );
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
  });

  it("verifyOutput ConditionalExpression, LogicalOperator, MethodExpression and ArrowFunction: a changed marker sequence fails before any segment byte is compared", async () => {
    const source = minimalJpeg({ components: 3, restartInterval: 4 });
    const output = await jhSanitizedBytes(source);
    const control = await jhVerifyDestination(source, output);
    expect(control.result.ok).toBe(true);

    const swapped = jhSwapAdjacentSegments(output, JH_DHT, 0xdd);
    expect(jhMarkerSequence(swapped)).toHaveLength(
      jhMarkerSequence(output).length,
    );
    expect(jhMarkerSequence(swapped)).not.toEqual(jhMarkerSequence(output));
    const outcome = await jhVerifyDestination(source, swapped);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
    expect(outcome.sourceReads).toEqual([]);
  });

  it("verifyOutput ConditionalExpression: a destination whose markers are a prefix of the plan fails before its Exif payload is read", async () => {
    const source = spliceSegments(
      minimalJpeg({ components: 3, scans: "per-component" }),
      [appSegment(JH_APP1, jpegExifOrientationPayload(6))],
    );
    const flags = { preserveOrientation: true };
    const output = await jhSanitizedBytes(source, flags);
    const control = await jhVerifyDestination(source, output, flags);
    expect(control.result.ok).toBe(true);

    const lastScan = jhSegmentRange(output, JH_SOS, 2);
    const prefix = Buffer.concat([
      output.subarray(0, lastScan.start),
      jhEoiBytes(),
    ]);
    expect(jhMarkerSequence(prefix)).toEqual([
      ...jhMarkerSequence(output).slice(0, -2),
      0xd9,
    ]);
    const outcome = await jhVerifyDestination(source, prefix, flags);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
    expect(outcome.destinationReads).toHaveLength(
      await jhParseReadCount(prefix),
    );
  });

  it("verifyOutput BlockStatement and ConditionalExpression: a destination segment that classifies as removed fails before any segment byte is compared", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(0xee, jpegAdobe(1)),
    ]);
    const output = await jhSanitizedBytes(source);
    const control = await jhVerifyDestination(source, output);
    expect(control.result.ok).toBe(true);

    const adobe = jhSegmentRange(output, 0xee);
    // "Adobe" -> "Adobx": still an APP14 segment of the same length, but no
    // longer an Adobe segment, so the destination classifies it as removed.
    const renamed = jhWithByte(output, adobe.start + 4 + 4, 0x78);
    expect(jhMarkerSequence(renamed)).toEqual(jhMarkerSequence(output));
    const outcome = await jhVerifyDestination(source, renamed);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
    expect(outcome.sourceReads).toEqual([]);
  });

  it("verifyOutput LogicalOperator and ConditionalExpression: with a synthesized Exif a removed destination segment still fails before any segment byte is compared", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jpegExifOrientationPayload(6)),
      appSegment(0xee, jpegAdobe(1)),
    ]);
    const flags = { preserveOrientation: true };
    const output = await jhSanitizedBytes(source, flags);
    const control = await jhVerifyDestination(source, output, flags);
    expect(control.result.ok).toBe(true);

    const adobe = jhSegmentRange(output, 0xee);
    const renamed = jhWithByte(output, adobe.start + 4 + 4, 0x78);
    const outcome = await jhVerifyDestination(source, renamed, flags);
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("unreachable");
    expect(outcome.result.error.code).toBe("verification-failed");
    expect(outcome.sourceReads).toEqual([]);
  });

  it("verifyOutput BlockStatement, LogicalOperator and ConditionalExpression: an altered synthesized Exif payload fails verification", async () => {
    const resolutionSource = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jpegExifResolutionPayload(300, 300, 2)),
    ]);
    const resolutionFlags = { preserveResolution: true };
    const resolutionOutput = await jhSanitizedBytes(
      resolutionSource,
      resolutionFlags,
    );
    const resolutionControl = await jhVerifyDestination(
      resolutionSource,
      resolutionOutput,
      resolutionFlags,
    );
    expect(resolutionControl.result.ok).toBe(true);
    const resolutionExif = jhSegmentRange(resolutionOutput, JH_APP1);
    const resolutionAltered = await jhVerifyDestination(
      resolutionSource,
      jhWithByte(resolutionOutput, resolutionExif.end - 1, 2),
      resolutionFlags,
    );
    expect(resolutionAltered.result.ok).toBe(false);
    if (resolutionAltered.result.ok) throw new Error("unreachable");
    expect(resolutionAltered.result.error.code).toBe("verification-failed");

    const orientationSource = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jpegExifOrientationPayload(6)),
    ]);
    const orientationFlags = { preserveOrientation: true };
    const orientationOutput = await jhSanitizedBytes(
      orientationSource,
      orientationFlags,
    );
    const orientationExif = jhSegmentRange(orientationOutput, JH_APP1);
    const orientationAltered = await jhVerifyDestination(
      orientationSource,
      jhWithByte(orientationOutput, orientationExif.end - 1, 1),
      orientationFlags,
    );
    expect(orientationAltered.result.ok).toBe(false);
  });

  it("findInsertPosition EqualityOperator and verifyOutput ConditionalExpression: the synthesized Exif slot is excluded from the kept-segment comparison whatever the source classified it as", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(JH_APP1, jpegExifOrientationPayload(6)),
    ]);
    const flags = { preserveOrientation: true };
    const output = await jhSanitizedBytes(source, flags);
    for (const classified of ["structural", "keep"] as const) {
      const outcome = await jhVerifyDestination(source, output, flags, {
        admission: (admitted) => ({
          ...admitted,
          classes: admitted.classes.map((cls, index) =>
            index === admitted.exifSlot ? classified : cls,
          ),
        }),
      });
      expect(outcome.result.ok).toBe(true);
    }
  });
});

/**
 * Raw ICC_PROFILE APPn payload as parseJpeg buffers it: identifier prefix, a
 * 1-byte sequence number, a 1-byte total count, then chunk bytes.
 */
function jhIccPayload(sequence: number, count: number, chunk: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from("ICC_PROFILE\0", "ascii"),
    Buffer.from([sequence, count]),
    chunk,
  ]);
}

/** Asserts the typed malformed-container refusal, not a range error or a result. */
function jhExpectIccMalformed(payloads: readonly Buffer[]): void {
  try {
    reassembleIccSegments(payloads);
  } catch (error) {
    expect(error).toBeInstanceOf(JpegStructureError);
    expect((error as JpegStructureError).refusal).toBe("malformed-container");
    return;
  }
  expect.unreachable();
}

/** The reads admit performs after parseJpeg's own, and the Trailer entry value. */
async function jhAdmitTailReads(bytes: Buffer): Promise<{
  readonly tailReads: readonly JhHandleCall[];
  readonly trailerEntry: unknown;
}> {
  const parseReads = await jhParseReadCount(bytes);
  const handle = await open(await jhWriteSource(bytes), "r");
  try {
    const scripted = jhScriptedHandle(handle);
    const admission = await jpegHandler.admit(scripted.handle, bytes.length);
    const entry = admission.entries.find(
      (candidate) =>
        candidate.namespace === "JPEG" && candidate.name === "Trailer",
    );
    return {
      tailReads: scripted.reads.slice(parseReads),
      trailerEntry: entry?.value,
    };
  } finally {
    await handle.close();
  }
}

/** The decline fields the classifyAdmissionFailure test reads from the closed union. */
interface JhDeclineFields {
  readonly code: string;
  readonly detail: string;
  readonly feature?: string;
  readonly reason?: string;
}

/**
 * Runs the shipped writeOutput with a hand-built plan whose only part is an
 * insert, so only the loop's own abort check (not copyRange's) can stop it.
 */
async function jhWriteWithSignal(
  bytes: Buffer,
  signal: AbortSignal,
): Promise<{ readonly error: unknown; readonly written: Buffer }> {
  const sourcePath = await jhWriteSource(bytes);
  const destinationPath = join(await jhFreshDirectory(), "destination.jpg");
  await writeFile(destinationPath, Buffer.alloc(0));
  const source = await open(sourcePath, "r");
  const destination = await open(destinationPath, "r+");
  try {
    const admission = await jpegHandler.admit(source, bytes.length);
    const built = jpegHandler.buildOutputPlan(
      admission,
      false,
      false,
      false,
      undefined,
    );
    const plan = {
      ...built,
      parts: [{ kind: "insert" as const, data: Buffer.from([0x01, 0x02]) }],
    };
    let error: unknown;
    try {
      await jpegHandler.writeOutput(source, destination, plan, signal);
    } catch (caught) {
      error = caught;
    }
    return { error, written: await destination.readFile() };
  } finally {
    await source.close();
    await destination.close();
  }
}

describe("jpeg-handler.ts admit, output-plan and write clusters, and reassembleIccSegments (67-25, jpeg-3)", () => {
  it("reassembleIccSegments: an empty payload list is refused with the typed malformed-container error", () => {
    jhExpectIccMalformed([]);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: a payload shorter than the 14-byte header is refused with the typed error, not a range error", () => {
    for (const length of [0, 1, 10, 11, 12, 13]) {
      jhExpectIccMalformed([Buffer.alloc(length, 0x41)]);
    }
  });

  it("reassembleIccSegments EqualityOperator: a header-only payload of exactly 14 bytes is a valid empty profile", () => {
    const result = reassembleIccSegments([jhIccPayload(1, 1, Buffer.alloc(0))]);
    expect(result.length).toBe(0);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: sequence zero is refused even beside a complete 1-of-1 set", () => {
    const zero = jhIccPayload(0, 1, Buffer.from([0x0a]));
    const one = jhIccPayload(1, 1, Buffer.from([0x0b]));
    jhExpectIccMalformed([zero, one]);
    jhExpectIccMalformed([one, zero]);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: a sequence number above its declared count is refused even beside a complete set", () => {
    const first = jhIccPayload(1, 1, Buffer.from([0x0a]));
    const beyond = jhIccPayload(2, 1, Buffer.from([0x0b]));
    jhExpectIccMalformed([first, beyond]);
    jhExpectIccMalformed([beyond, first]);
  });

  it("reassembleIccSegments ConditionalExpression: segments that declare different counts are refused even when the last count yields a complete set", () => {
    const declaresThree = jhIccPayload(1, 3, Buffer.from([0x0a]));
    const declaresTwo = jhIccPayload(2, 2, Buffer.from([0x0b]));
    jhExpectIccMalformed([declaresThree, declaresTwo]);
  });

  it("reassembleIccSegments EqualityOperator: a profile of exactly MAX_PROFILE_BYTES is accepted and returned in sequence order", () => {
    const half = MAX_PROFILE_BYTES / 2;
    const result = reassembleIccSegments([
      jhIccPayload(2, 2, Buffer.alloc(half, 0x22)),
      jhIccPayload(1, 2, Buffer.alloc(half, 0x11)),
    ]);
    expect(result.length).toBe(MAX_PROFILE_BYTES);
    expect(result[0]).toBe(0x11);
    expect(result[half - 1]).toBe(0x11);
    expect(result[half]).toBe(0x22);
    expect(result[MAX_PROFILE_BYTES - 1]).toBe(0x22);
  });

  it("admit MethodExpression, ArithmeticOperator, ConditionalExpression and EqualityOperator: a trailer longer than the 64-byte window reads exactly the last 64 bytes", async () => {
    const bytes = appendTrailer(minimalJpeg(), Buffer.alloc(200, 0x5a));
    const result = await jhAdmitTailReads(bytes);
    expect(result.tailReads).toEqual([
      { offset: 0, length: 64, position: bytes.length - 64, bufferLength: 64 },
    ]);
    expect(result.trailerEntry).toBe(200);
  });

  it("admit MethodExpression, ArithmeticOperator, ConditionalExpression and EqualityOperator: a short trailer reads exactly its own bytes from the primary EOI", async () => {
    const bytes = appendTrailer(minimalJpeg(), Buffer.alloc(20, 0x5a));
    const result = await jhAdmitTailReads(bytes);
    expect(result.tailReads).toEqual([
      { offset: 0, length: 20, position: bytes.length - 20, bufferLength: 20 },
    ]);
    expect(result.trailerEntry).toBe(20);
  });

  it("admit MethodExpression and ArithmeticOperator: a file without a trailer reads nothing beyond the parse", async () => {
    const result = await jhAdmitTailReads(minimalJpeg());
    expect(result.tailReads).toEqual([]);
    expect(result.trailerEntry).toBeUndefined();
  });

  it("checkOutputPlan ConditionalExpression: a plan without a scan declines with a string, and a declined plan returns its own reason", async () => {
    const admission = await jhAdmitBytes(minimalJpeg());
    const plan = jpegHandler.buildOutputPlan(
      admission,
      false,
      false,
      false,
      undefined,
    );
    expect(jpegHandler.checkOutputPlan(plan)).toBeUndefined();
    expect(plan.expectedMarkers).toContain(JH_SOS);

    const noScan = {
      ...plan,
      expectedMarkers: plan.expectedMarkers.filter(
        (marker) => marker !== JH_SOS,
      ),
    };
    expect(typeof jpegHandler.checkOutputPlan(noScan)).toBe("string");

    const declined = { ...plan, declineReason: "scripted decline reason" };
    expect(jpegHandler.checkOutputPlan(declined)).toBe(
      "scripted decline reason",
    );
  });

  it("writeOutput ConditionalExpression and LogicalOperator: an aborted signal stops the write loop and rejects with the signal's own reason", async () => {
    const reason = new Error("scripted abort reason");
    const controller = new AbortController();
    controller.abort(reason);
    const outcome = await jhWriteWithSignal(minimalJpeg(), controller.signal);
    expect(outcome.error).toBe(reason);
    expect(outcome.written.length).toBeLessThanOrEqual(2);
  });

  it("writeOutput StringLiteral and LogicalOperator: an aborted signal without a reason rejects with a DOMException named AbortError", async () => {
    const signalWithoutReason = { aborted: true } as unknown as AbortSignal;
    const outcome = await jhWriteWithSignal(minimalJpeg(), signalWithoutReason);
    expect(outcome.error).toBeInstanceOf(DOMException);
    expect((outcome.error as DOMException).name).toBe("AbortError");
  });

  it("classifyAdmissionFailure StringLiteral: an over-limit ICC profile declines color-profile preservation with the typed policy-limit reason, and other structure errors keep their kind", () => {
    const oversize = new JpegStructureError(
      "resource-limits",
      "scripted oversize ICC profile",
      { segment: ICC_SEGMENT_IDENTIFIER, size: 99, limit: 16 },
    );
    const preserved = jpegHandler.classifyAdmissionFailure(oversize, true) as
      JhDeclineFields | undefined;
    expect(preserved?.code).toBe("unsupported-feature");
    expect(preserved?.feature).toBe("color-profile-preservation");
    expect(preserved?.reason).toBe("policy-limit");
    expect(typeof preserved?.detail).toBe("string");

    const notPreserved = jpegHandler.classifyAdmissionFailure(
      oversize,
      false,
    ) as JhDeclineFields | undefined;
    expect(notPreserved?.code).toBe(oversize.kind);
    expect(notPreserved?.feature).toBeUndefined();

    expect(
      jpegHandler.classifyAdmissionFailure(new Error("unrelated"), true),
    ).toBeUndefined();
  });
});

// Marker byte sweeps for src/jpeg/markers.ts (67-26, jpeg-4). The expectations are written out
// from ITU-T T.81 Table B.1 and the APPn identifier strings, never derived from the constants or
// operators under test, so a changed boundary comparison or a dropped marker check is a visible
// difference at a named byte.
function jmRange(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => first + offset);
}

function jmAllMarkerBytes(): number[] {
  return jmRange(0, 256);
}

function jmExpectedMarkerClass(marker: number): MarkerClassification {
  const admitted = (kind: string): MarkerClassification =>
    ({ admitted: true, kind }) as MarkerClassification;
  const refused = (refusal: JpegRefusal): MarkerClassification => ({
    admitted: false,
    refusal,
  });
  const single = new Map<number, MarkerClassification>([
    [0xd8, admitted("soi")],
    [0xd9, admitted("eoi")],
    [0xda, admitted("sos")],
    [0xdb, admitted("dqt")],
    [0xc4, admitted("dht")],
    [0xdd, admitted("dri")],
    [0xfe, admitted("com")],
    [0xc0, admitted("sof-admitted")],
    [0xc1, admitted("sof-admitted")],
    [0xc2, admitted("sof-admitted")],
    [0xdc, refused("dnl-marker")],
    [0xcc, refused("arithmetic-frame")],
    [0xde, refused("hierarchical-frame")],
    [0xdf, refused("hierarchical-frame")],
    [0xc3, refused("lossless-frame")],
    [0xc5, refused("hierarchical-frame")],
    [0xc6, refused("hierarchical-frame")],
    [0xc7, refused("hierarchical-frame")],
    [0xc8, refused("non-t81-frame")],
    [0xc9, refused("arithmetic-frame")],
    [0xca, refused("arithmetic-frame")],
    [0xcb, refused("arithmetic-frame")],
    [0xcd, refused("arithmetic-frame")],
    [0xce, refused("arithmetic-frame")],
    [0xcf, refused("arithmetic-frame")],
  ]);
  const known = single.get(marker);
  if (known !== undefined) return known;
  if (jmRange(0xe0, 16).includes(marker)) return admitted("app");
  if (jmRange(0xd0, 8).includes(marker)) return admitted("restart");
  if (jmRange(0xf0, 14).includes(marker)) return refused("non-t81-frame");
  return refused("malformed-container");
}

function jmAppIdentifiers(): ReadonlyArray<{
  readonly marker: number;
  readonly kind: AppSegmentKind;
  readonly identifier: Buffer;
}> {
  return [
    { marker: 0xe0, kind: "jfif", identifier: Buffer.from("JFIF\0", "latin1") },
    {
      marker: 0xe1,
      kind: "exif",
      identifier: Buffer.from("Exif\0\0", "latin1"),
    },
    {
      marker: 0xe1,
      kind: "xmp",
      identifier: Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"),
    },
    {
      marker: 0xe1,
      kind: "extended-xmp",
      identifier: Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1"),
    },
    {
      marker: 0xe2,
      kind: "icc",
      identifier: Buffer.from("ICC_PROFILE\0", "latin1"),
    },
    { marker: 0xe2, kind: "mpf", identifier: Buffer.from("MPF\0", "latin1") },
    { marker: 0xee, kind: "adobe", identifier: Buffer.from("Adobe", "latin1") },
  ];
}

describe("jpeg/markers.ts marker and APPn classification clusters (67-26, jpeg-4)", () => {
  it("isAppMarker ConditionalExpression, EqualityOperator and LogicalOperator: exactly the sixteen codes 0xE0 to 0xEF are application markers", () => {
    const apps = new Set(jmRange(0xe0, 16));
    for (const marker of jmAllMarkerBytes()) {
      expect([marker, isAppMarker(marker)]).toEqual([marker, apps.has(marker)]);
    }
    expect(isAppMarker(0xdf)).toBe(false);
    expect(isAppMarker(0xe0)).toBe(true);
    expect(isAppMarker(0xef)).toBe(true);
    expect(isAppMarker(0xf0)).toBe(false);
  });

  it("isRestartMarker ConditionalExpression, EqualityOperator and LogicalOperator: exactly the eight codes 0xD0 to 0xD7 are restart markers", () => {
    const restarts = new Set(jmRange(0xd0, 8));
    for (const marker of jmAllMarkerBytes()) {
      expect([marker, isRestartMarker(marker)]).toEqual([
        marker,
        restarts.has(marker),
      ]);
    }
    expect(isRestartMarker(0xcf)).toBe(false);
    expect(isRestartMarker(0xd0)).toBe(true);
    expect(isRestartMarker(0xd7)).toBe(true);
    expect(isRestartMarker(0xd8)).toBe(false);
  });

  it("classifyMarker ConditionalExpression, BlockStatement and EqualityOperator: every marker byte 0x00 to 0xFF maps to exactly its T.81 admit or refuse class", () => {
    for (const marker of jmAllMarkerBytes()) {
      expect([marker, classifyMarker(marker)]).toEqual([
        marker,
        jmExpectedMarkerClass(marker),
      ]);
    }
    // Endpoints and neighbours the comparisons turn on.
    expect(classifyMarker(0xd8)).toEqual({ admitted: true, kind: "soi" });
    expect(classifyMarker(0xcf)).toEqual({
      admitted: false,
      refusal: "arithmetic-frame",
    });
    expect(classifyMarker(0xd0)).toEqual({ admitted: true, kind: "restart" });
    expect(classifyMarker(0xd7)).toEqual({ admitted: true, kind: "restart" });
    expect(classifyMarker(0xef)).toEqual({ admitted: true, kind: "app" });
    expect(classifyMarker(0xf0)).toEqual({
      admitted: false,
      refusal: "non-t81-frame",
    });
    expect(classifyMarker(0xfd)).toEqual({
      admitted: false,
      refusal: "non-t81-frame",
    });
    expect(classifyMarker(0xff)).toEqual({
      admitted: false,
      refusal: "malformed-container",
    });
  });

  it("classifyAppPayload startsWithAppId EqualityOperator: a payload exactly as long as its identifier is still classified by that identifier", () => {
    for (const { marker, kind, identifier } of jmAppIdentifiers()) {
      expect([
        kind,
        classifyAppPayload(marker, Buffer.from(identifier)),
      ]).toEqual([kind, kind]);
    }
  });

  it("classifyAppPayload ConditionalExpression and LogicalOperator: each identifier classifies only under its own APPn marker, and the right marker needs the right identifier", () => {
    const tail = Buffer.from([0x01, 0x02, 0x03]);
    for (const { marker: own, kind, identifier } of jmAppIdentifiers()) {
      const payload = Buffer.concat([identifier, tail]);
      for (const marker of jmAllMarkerBytes()) {
        expect([kind, marker, classifyAppPayload(marker, payload)]).toEqual([
          kind,
          marker,
          marker === own ? kind : "other",
        ]);
      }
      // The identifier minus its last byte is not the identifier, under any marker.
      const short = identifier.subarray(0, identifier.length - 1);
      for (const marker of jmAllMarkerBytes()) {
        expect([kind, marker, classifyAppPayload(marker, short)]).toEqual([
          kind,
          marker,
          "other",
        ]);
      }
    }
    // The right marker with an unrelated, an empty and an absent payload.
    for (const marker of [0xe0, 0xe1, 0xe2, 0xee]) {
      expect(
        classifyAppPayload(marker, Buffer.from("XXXXXXXX", "latin1")),
      ).toBe("other");
      expect(classifyAppPayload(marker, Buffer.alloc(0))).toBe("other");
      expect(classifyAppPayload(marker, undefined)).toBe("other");
    }
  });
});

// Parser clusters for src/jpeg/parser.ts (67-27, jpeg-5). Every assertion is a typed refusal
// (`refusal` and `kind`), a returned offset, a segment identifier or the exact reads the parser
// asked of the file handle (offset, length, position), never diagnostic wording. The scripted
// handle is the 67-24 `jhScriptedHandle`, which records each read and can shorten or stall it.
type JpParseOutcome =
  | {
      readonly parsed: Awaited<ReturnType<typeof parseJpeg>>;
      readonly error: undefined;
      readonly reads: readonly JhHandleCall[];
    }
  | {
      readonly parsed: undefined;
      readonly error: unknown;
      readonly reads: readonly JhHandleCall[];
    };

async function jpParse(
  bytes: Buffer,
  script?: JhCallScript,
  declaredSize?: number,
): Promise<JpParseOutcome> {
  const directory = await jhFreshDirectory();
  const path = join(directory, "input.jpg");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    const scripted = jhScriptedHandle(handle, script);
    try {
      const parsed = await parseJpeg(
        scripted.handle,
        declaredSize ?? bytes.length,
      );
      return { parsed, error: undefined, reads: scripted.reads };
    } catch (error) {
      return { parsed: undefined, error, reads: scripted.reads };
    }
  } finally {
    await handle.close();
  }
}

/** The typed outcome of a parse: the refusal literal, or "parsed", or "other-error". */
function jpOutcomeName(outcome: JpParseOutcome): string {
  if (outcome.error === undefined) return "parsed";
  return outcome.error instanceof JpegStructureError
    ? outcome.error.refusal
    : "other-error";
}

function jpDqtTable(precision: 0 | 1, slot: number): Buffer {
  return Buffer.concat([
    Buffer.from([(precision << 4) | slot]),
    Buffer.alloc(precision === 0 ? 64 : 128, 1),
  ]);
}

/** minimalJpeg (one component, quantization slot 0) with its DQT payload replaced. */
function jpWithDqtPayload(payload: Buffer): Buffer {
  const base = minimalJpeg({ components: 1 });
  const dqtLength = base.readUInt16BE(4);
  const header = Buffer.from([0xff, 0xdb, 0x00, 0x00]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    base.subarray(0, 2),
    header,
    payload,
    base.subarray(4 + dqtLength),
  ]);
}

function jpWithAppPayload(marker: number, payload: Buffer): Buffer {
  return spliceSegments(minimalJpeg({ components: 1 }), [
    appSegment(marker, payload),
  ]);
}

function jpIdentifierOf(bytes: Buffer, marker: number): Promise<unknown> {
  return jpParse(bytes).then(
    (outcome) =>
      outcome.parsed?.segments.find((segment) => segment.marker === marker)
        ?.identifier,
  );
}

/** About 150 KiB of COM segments after SOI: three 50000-byte payloads, then the frame. */
function jpMultiWindowJpeg(): Buffer {
  return spliceSegments(
    minimalJpeg({ components: 1 }),
    [1, 2, 3].map((fill) => appSegment(0xfe, Buffer.alloc(50_000, fill))),
  );
}

describe("jpeg/parser.ts structure error, signature, read and DQT clusters (67-27, jpeg-5)", () => {
  it("constructor StringLiteral: a JpegStructureError is named JpegStructureError and carries its typed refusal and kind", () => {
    const error = new JpegStructureError("truncation", "any text");
    expect(error.name).toBe("JpegStructureError");
    expect(error).toBeInstanceOf(Error);
    expect([error.refusal, error.kind, error.limit]).toEqual([
      "truncation",
      "malformed-file",
      undefined,
    ]);
    const limited = new JpegStructureError("resource-limits", "any text", {
      segment: "segment-count",
      size: 2,
      limit: 1,
    });
    expect([limited.name, limited.kind, limited.limit]).toEqual([
      "JpegStructureError",
      "unsafe-structure",
      { segment: "segment-count", size: 2, limit: 1 },
    ]);
  });

  it("isJpegSignature ConditionalExpression, EqualityOperator and LogicalOperator: only FF D8 FF followed by anything is a signature, at exactly three bytes too", () => {
    const cases: ReadonlyArray<readonly [number[], boolean]> = [
      [[0xff, 0xd8, 0xff], true],
      [[0xff, 0xd8, 0xff, 0xe0], true],
      [[0xff, 0xd8, 0xff, 0x00, 0x00], true],
      [[], false],
      [[0xff], false],
      [[0xff, 0xd8], false],
      [[0x00, 0xd8, 0xff], false],
      [[0xff, 0x00, 0xff], false],
      [[0xff, 0xd8, 0x00], false],
      [[0x00, 0x00, 0xff], false],
      [[0x00, 0xd8, 0x00], false],
      [[0xff, 0x00, 0x00], false],
      [[0x00, 0x00, 0x00], false],
      [[0x00, 0xd8, 0xff, 0xe0], false],
      [[0xff, 0x00, 0xff, 0xe0], false],
      [[0xff, 0xd8, 0x00, 0xe0], false],
    ];
    for (const [bytes, expected] of cases) {
      expect([bytes, isJpegSignature(Buffer.from(bytes))]).toEqual([
        bytes,
        expected,
      ]);
    }
  });

  it("readExactly ArithmeticOperator, ConditionalExpression and BlockStatement: a handle that returns three bytes per read still yields the same parse, each read asks for exactly what is left, and a file shorter than declared is a truncation", async () => {
    const bytes = minimalJpeg({ components: 3 });
    const whole = await jpParse(bytes);
    const short = await jpParse(bytes, () => ({ transfer: 3 }));
    expect(jpOutcomeName(whole)).toBe("parsed");
    expect(jpOutcomeName(short)).toBe("parsed");
    expect(short.parsed).toEqual(whole.parsed);
    expect(short.reads.length).toBe(Math.ceil(bytes.length / 3));
    short.reads.forEach((call, index) => {
      expect([index, call.offset, call.position]).toEqual([
        index,
        index * 3,
        index * 3,
      ]);
      expect([index, call.length]).toEqual([
        index,
        call.bufferLength - call.offset,
      ]);
    });

    // The handle reports zero bytes: the read loop must stop with a truncation, not spin.
    const stalled = await jpParse(bytes, (_call, index) =>
      index === 0 ? { stall: true } : { fail: true },
    );
    expect(jpOutcomeName(stalled)).toBe("truncation");
    expect(stalled.reads.length).toBe(1);

    // The file really ends before the declared size: one full read, then a read at EOF.
    const declaredTooLong = await jpParse(
      bytes,
      (_call, index) => (index >= 6 ? { fail: true } : undefined),
      bytes.length + 7,
    );
    expect(jpOutcomeName(declaredTooLong)).toBe("truncation");
    expect(
      declaredTooLong.error instanceof JpegStructureError &&
        declaredTooLong.error.kind,
    ).toBe("malformed-file");
    expect(declaredTooLong.reads.map((call) => call.position)).toEqual([
      0,
      bytes.length,
    ]);
  });

  it("readWindowed ConditionalExpression, EqualityOperator and ArithmeticOperator: a file under 64 KiB is read once, and a larger file is read in windows that never extend past the end of the file", async () => {
    const small = minimalJpeg({ components: 3 });
    const smallOutcome = await jpParse(small);
    expect(jpOutcomeName(smallOutcome)).toBe("parsed");
    expect(smallOutcome.reads).toEqual([
      {
        offset: 0,
        length: small.length,
        position: 0,
        bufferLength: small.length,
      },
    ]);

    const large = jpMultiWindowJpeg();
    const largeOutcome = await jpParse(large);
    expect(jpOutcomeName(largeOutcome)).toBe("parsed");
    expect(largeOutcome.parsed?.primaryEoiEnd).toBe(large.length);
    // The windows open where a payload does not fit the open window: the second and third
    // COM payloads start at 50010 and 100014; each window is 64 KiB or what remains.
    expect(largeOutcome.reads).toEqual([
      { offset: 0, length: 65_536, position: 0, bufferLength: 65_536 },
      { offset: 0, length: 65_536, position: 50_010, bufferLength: 65_536 },
      {
        offset: 0,
        length: large.length - 100_014,
        position: 100_014,
        bufferLength: large.length - 100_014,
      },
    ]);
  });

  it("readIdentifier MethodExpression, ConditionalExpression and EqualityOperator: an APPn identifier is the text before a NUL found in the first 32 payload bytes, empty for a leading NUL, absent otherwise", async () => {
    const withNul = (text: string, total: number): Buffer =>
      Buffer.concat([
        Buffer.from(text, "latin1"),
        Buffer.alloc(total - text.length, 0x58),
      ]);
    const nulAt = (index: number, total: number): Buffer => {
      const payload = Buffer.alloc(total, 0x41);
      payload[index] = 0x00;
      return payload;
    };
    const cases: ReadonlyArray<readonly [string, Buffer, string | undefined]> =
      [
        ["Exif NUL NUL", Buffer.from("Exif\0\0abc", "latin1"), "Exif"],
        ["NUL at index 31", nulAt(31, 40), "A".repeat(31)],
        ["NUL at index 32", nulAt(32, 40), undefined],
        ["NUL at index 35", nulAt(35, 40), undefined],
        ["leading NUL", nulAt(0, 6), ""],
        ["no NUL, short", Buffer.alloc(10, 0x44), undefined],
        ["no NUL, one byte", Buffer.alloc(1, 0x44), undefined],
        ["NUL last of a short payload", nulAt(9, 10), "A".repeat(9)],
        ["empty payload", Buffer.alloc(0), undefined],
        ["text then filler", withNul("abc", 5), undefined],
      ];
    for (const [label, payload, expected] of cases) {
      expect([
        label,
        await jpIdentifierOf(jpWithAppPayload(0xe5, payload), 0xe5),
      ]).toEqual([label, expected]);
    }
  });

  it("parseDqtSlots ArithmeticOperator, ConditionalExpression and BlockStatement: a DQT table is admitted at exactly its 65 or 129 bytes and refused as malformed-container one byte short, from any cursor", async () => {
    const cases: ReadonlyArray<readonly [string, Buffer, string]> = [
      ["8-bit table", jpDqtTable(0, 0), "parsed"],
      [
        "8-bit table one byte short",
        jpDqtTable(0, 0).subarray(0, 64),
        "malformed-container",
      ],
      [
        "lone table header byte",
        jpDqtTable(0, 0).subarray(0, 1),
        "malformed-container",
      ],
      ["16-bit table", jpDqtTable(1, 0), "parsed"],
      [
        "16-bit table one byte short",
        jpDqtTable(1, 0).subarray(0, 128),
        "malformed-container",
      ],
      [
        "16-bit table cut at the 8-bit length",
        jpDqtTable(1, 0).subarray(0, 65),
        "malformed-container",
      ],
      [
        "two 8-bit tables",
        Buffer.concat([jpDqtTable(0, 0), jpDqtTable(0, 1)]),
        "parsed",
      ],
      [
        "second 8-bit table one byte short",
        Buffer.concat([jpDqtTable(0, 0), jpDqtTable(0, 1).subarray(0, 64)]),
        "malformed-container",
      ],
      [
        "8-bit then 16-bit table",
        Buffer.concat([jpDqtTable(0, 0), jpDqtTable(1, 1)]),
        "parsed",
      ],
      [
        "16-bit then 8-bit table",
        Buffer.concat([jpDqtTable(1, 0), jpDqtTable(0, 1)]),
        "parsed",
      ],
    ];
    for (const [label, payload, expected] of cases) {
      const outcome = await jpParse(jpWithDqtPayload(payload));
      expect([label, jpOutcomeName(outcome)]).toEqual([label, expected]);
      if (expected !== "parsed") {
        expect(
          outcome.error instanceof JpegStructureError && outcome.error.kind,
        ).toBe("malformed-file");
      }
    }
  });
});

// Parser clusters for src/jpeg/parser.ts (67-28, jpeg-6): DHT table framing, SOS header framing,
// the table requirements of each scan type and the entropy-data terminator. Every fixture is built
// from the marker grammar (T.81: marker, length, payload), so each expected outcome comes from the
// format, not from the parser's own operators. Outcomes are typed refusals, "parsed" or a
// `jpOutcomeName` of "other-error" (an untyped Buffer RangeError), never diagnostic wording.

/** One DHT table: Tc/Th byte, 16 BITS counts (code lengths 1 to 16), then VALUES. */
function jpHuffmanTable(
  tableClass: 0 | 1,
  tableId: number,
  counts: readonly number[],
  values: readonly number[],
): Buffer {
  const bits = Buffer.alloc(16);
  counts.forEach((count, index) => {
    bits[index] = count;
  });
  return Buffer.concat([
    Buffer.from([(tableClass << 4) | tableId]),
    bits,
    Buffer.from(values),
  ]);
}

function jpDc0Ac0Tables(): Buffer {
  return Buffer.concat([
    jpHuffmanTable(0, 0, [1], [0]),
    jpHuffmanTable(1, 0, [1], [0]),
  ]);
}

interface JpSpectral {
  readonly ss: number;
  readonly se: number;
  readonly ah: number;
  readonly al: number;
}

/** SOS payload: Ns, (Cs, TdTa) per component, Ss, Se, AhAl. */
function jpSosPayload(
  components: ReadonlyArray<readonly [cs: number, td: number, ta: number]>,
  spectral: JpSpectral,
): Buffer {
  const bytes: number[] = [components.length];
  for (const [cs, td, ta] of components) bytes.push(cs, (td << 4) | ta);
  bytes.push(spectral.ss, spectral.se, (spectral.ah << 4) | spectral.al);
  return Buffer.from(bytes);
}

const JP_SEQUENTIAL_SPECTRAL: JpSpectral = { ss: 0, se: 63, ah: 0, al: 0 };

interface JpScanFixture {
  readonly sofMarker?: number;
  readonly frameComponents?: ReadonlyArray<readonly [id: number, tq: number]>;
  readonly dhtPayload?: Buffer;
  readonly sos: Buffer;
  /** Bytes spliced between the entropy data and the EOI (may hold markers). */
  readonly afterEntropy?: Buffer;
}

/** SOI, DQT (Tq 0), SOF, DHT, one SOS, two entropy bytes, optional bytes, EOI. */
function jpScanFixture(fixture: JpScanFixture): Buffer {
  const frameComponents = fixture.frameComponents ?? [[1, 0]];
  const sof = Buffer.alloc(6 + frameComponents.length * 3);
  sof.writeUInt8(8, 0);
  sof.writeUInt16BE(8, 1);
  sof.writeUInt16BE(8, 3);
  sof.writeUInt8(frameComponents.length, 5);
  frameComponents.forEach(([id, tq], index) => {
    sof.writeUInt8(id, 6 + index * 3);
    sof.writeUInt8(0x11, 7 + index * 3);
    sof.writeUInt8(tq, 8 + index * 3);
  });
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    appSegment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])),
    appSegment(fixture.sofMarker ?? 0xc0, sof),
    appSegment(0xc4, fixture.dhtPayload ?? jpDc0Ac0Tables()),
    appSegment(0xda, fixture.sos),
    Buffer.from([0x12, 0x34]),
    fixture.afterEntropy ?? Buffer.alloc(0),
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function jpScanOutcome(fixture: JpScanFixture): Promise<string> {
  return jpOutcomeName(await jpParse(jpScanFixture(fixture)));
}

describe("jpeg/parser.ts DHT, SOS, scan-table and entropy clusters (67-28, jpeg-6)", () => {
  it("validateScanTables BooleanLiteral, BlockStatement, ConditionalExpression, EqualityOperator and LogicalOperator clusters: each scan type requires exactly its own tables", async () => {
    // Defined: DC table 0 and AC table 0. Table id 1 is undefined for both classes.
    const sequential = 0xc0;
    const progressive = 0xc2;
    const dcFirst: JpSpectral = { ss: 0, se: 0, ah: 0, al: 0 };
    const dcRefine: JpSpectral = { ss: 0, se: 0, ah: 1, al: 0 };
    const acFirst: JpSpectral = { ss: 1, se: 63, ah: 0, al: 0 };
    const acRefine: JpSpectral = { ss: 1, se: 63, ah: 1, al: 0 };
    const ok = "parsed";
    const noTable = "undefined-table-reference";
    const cases: ReadonlyArray<
      readonly [
        label: string,
        sofMarker: number,
        spectral: JpSpectral,
        td: number,
        ta: number,
        expected: string,
      ]
    > = [
      ["sequential, DC 0, AC 0", sequential, JP_SEQUENTIAL_SPECTRAL, 0, 0, ok],
      [
        "sequential, undefined DC 1",
        sequential,
        JP_SEQUENTIAL_SPECTRAL,
        1,
        0,
        noTable,
      ],
      [
        "sequential, undefined AC 1",
        sequential,
        JP_SEQUENTIAL_SPECTRAL,
        0,
        1,
        noTable,
      ],
      ["progressive DC-first, DC 0, AC 1", progressive, dcFirst, 0, 1, ok],
      [
        "progressive DC-first, undefined DC 1",
        progressive,
        dcFirst,
        1,
        0,
        noTable,
      ],
      [
        "progressive DC-first, undefined DC and AC",
        progressive,
        dcFirst,
        1,
        1,
        noTable,
      ],
      [
        "progressive DC refinement, undefined DC 1",
        progressive,
        dcRefine,
        1,
        0,
        ok,
      ],
      [
        "progressive DC refinement, undefined AC 1",
        progressive,
        dcRefine,
        0,
        1,
        ok,
      ],
      [
        "progressive DC refinement, undefined DC and AC",
        progressive,
        dcRefine,
        1,
        1,
        ok,
      ],
      ["progressive AC-first, undefined DC 1", progressive, acFirst, 1, 0, ok],
      [
        "progressive AC-first, undefined AC 1",
        progressive,
        acFirst,
        0,
        1,
        noTable,
      ],
      [
        "progressive AC refinement, undefined DC 1",
        progressive,
        acRefine,
        1,
        0,
        ok,
      ],
      [
        "progressive AC refinement, undefined AC 1",
        progressive,
        acRefine,
        0,
        1,
        noTable,
      ],
    ];
    for (const [label, sofMarker, spectral, td, ta, expected] of cases) {
      const outcome = await jpScanOutcome({
        sofMarker,
        sos: jpSosPayload([[1, td, ta]], spectral),
      });
      expect([label, outcome]).toEqual([label, expected]);
    }
  });

  it("validateScanTables ConditionalExpression cluster: a scan component is resolved to its own frame component by id", async () => {
    // Components 1 and 3 use quantization table 0 (defined); component 2 uses table 1 (not).
    const frameComponents = [
      [1, 0],
      [2, 1],
      [3, 0],
    ] as const;
    const resolve = (cs: number) =>
      jpScanOutcome({
        frameComponents,
        sos: jpSosPayload([[cs, 0, 0]], JP_SEQUENTIAL_SPECTRAL),
      });
    expect(await resolve(1)).toBe("parsed");
    expect(await resolve(2)).toBe("undefined-table-reference");
    expect(await resolve(9)).toBe("malformed-container");
  });

  it("parseDhtSlots ArithmeticOperator, BlockStatement and ConditionalExpression clusters: a table whose BITS promise more VALUES than the payload holds is refused", async () => {
    const cases: ReadonlyArray<readonly [label: string, dhtPayload: Buffer]> = [
      ["one promised value, none present", jpHuffmanTable(0, 0, [1], [])],
      [
        "second table promises two values, holds one",
        Buffer.concat([
          jpHuffmanTable(0, 0, [1], [0]),
          jpHuffmanTable(1, 0, [2], [0]),
        ]),
      ],
    ];
    for (const [label, dhtPayload] of cases) {
      const outcome = await jpScanOutcome({
        dhtPayload,
        sos: jpSosPayload([[1, 0, 0]], JP_SEQUENTIAL_SPECTRAL),
      });
      expect([label, outcome]).toEqual([label, "malformed-container"]);
    }
  });

  it("parseDhtSlots EqualityOperator cluster: a table with zero VALUES that ends exactly at the payload end is admitted and defines its slot", async () => {
    // 17 bytes: Tc/Th plus sixteen zero BITS counts, no VALUES. It is the last table.
    const dhtPayload = Buffer.concat([
      jpDc0Ac0Tables(),
      jpHuffmanTable(0, 1, [], []),
    ]);
    const usesDcTableOne = jpSosPayload([[1, 1, 0]], JP_SEQUENTIAL_SPECTRAL);
    expect(await jpScanOutcome({ dhtPayload, sos: usesDcTableOne })).toBe(
      "parsed",
    );
    // Without the empty table the same scan names an undefined DC table.
    expect(await jpScanOutcome({ sos: usesDcTableOne })).toBe(
      "undefined-table-reference",
    );
    // One to sixteen trailing bytes cannot hold a table header.
    for (let trailing = 1; trailing <= 16; trailing += 1) {
      const outcome = await jpScanOutcome({
        dhtPayload: Buffer.concat([
          jpDc0Ac0Tables(),
          Buffer.alloc(trailing, 0),
        ]),
        sos: jpSosPayload([[1, 0, 0]], JP_SEQUENTIAL_SPECTRAL),
      });
      expect([trailing, outcome]).toEqual([trailing, "malformed-container"]);
    }
  });

  it("parseSosHeader BlockStatement, ConditionalExpression and ArithmeticOperator clusters: an SOS payload shorter than its own header is refused as malformed-container", async () => {
    const outcomes: string[] = [];
    // Empty payload: the segment length field is 2.
    outcomes.push(await jpScanOutcome({ sos: Buffer.alloc(0) }));
    // Every proper prefix of a valid SOS payload for 1, 3 and 4 components.
    for (const count of [1, 3, 4]) {
      const frameComponents = Array.from(
        { length: count },
        (_, index) => [index + 1, 0] as const,
      );
      const valid = jpSosPayload(
        frameComponents.map(([id]) => [id, 0, 0] as const),
        JP_SEQUENTIAL_SPECTRAL,
      );
      expect(valid.length).toBe(1 + count * 2 + 3);
      for (let length = 1; length < valid.length; length += 1) {
        outcomes.push(
          await jpScanOutcome({
            frameComponents,
            sos: valid.subarray(0, length),
          }),
        );
      }
      expect(await jpScanOutcome({ frameComponents, sos: valid })).toBe(
        "parsed",
      );
    }
    expect(outcomes).toHaveLength(1 + 5 + 9 + 11);
    expect(new Set(outcomes)).toEqual(new Set(["malformed-container"]));
  });

  it("scanEntropyData BlockStatement, ConditionalExpression, AssignmentOperator and EqualityOperator clusters: a 0xFF fill run ends the scan at its last 0xFF, restart markers RST0 to RST7 stay inside the scan and any other marker ends it", async () => {
    // Fill run: ... entropy, FF, FF, FF D9. The scan ends at the last 0xFF, which starts the EOI.
    const filled = jpScanFixture({
      sos: jpSosPayload([[1, 0, 0]], JP_SEQUENTIAL_SPECTRAL),
      afterEntropy: Buffer.from([0xff, 0xff]),
    });
    const filledParse = (await jpParse(filled)).parsed;
    expect(
      filledParse?.segments.find((segment) => segment.marker === 0xda)
        ?.entropyEnd,
    ).toBe(filled.length - 2);
    expect(filledParse?.primaryEoiEnd).toBe(filled.length);

    // Nine MCUs with a restart interval of one carry RST0 through RST7.
    const restarts = minimalJpeg({ width: 72, height: 8, restartInterval: 1 });
    for (let marker = 0xd0; marker <= 0xd7; marker += 1) {
      expect(restarts.includes(Buffer.from([0xff, marker]))).toBe(true);
    }
    const restartParse = (await jpParse(restarts)).parsed;
    expect(restartParse?.segments.map((segment) => segment.marker)).toEqual([
      0xdb, 0xc0, 0xc4, 0xdd, 0xda,
    ]);
    expect(restartParse?.primaryEoiEnd).toBe(restarts.length);

    // A DHT (0xC4, below RST0) between two scans ends the first scan.
    const twoScans = minimalJpeg({ components: 3, scans: "per-component" });
    const firstScan = twoScans.indexOf(Buffer.from([0xff, 0xda]));
    const secondScan = twoScans.indexOf(
      Buffer.from([0xff, 0xda]),
      firstScan + 2,
    );
    const betweenScans = Buffer.concat([
      twoScans.subarray(0, secondScan),
      appSegment(0xc4, jpHuffmanTable(0, 2, [], [])),
      twoScans.subarray(secondScan),
    ]);
    const betweenParse = (await jpParse(betweenScans)).parsed;
    expect(betweenParse?.segments.map((segment) => segment.marker)).toEqual([
      0xdb, 0xc0, 0xc4, 0xda, 0xc4, 0xda, 0xda,
    ]);
  });
});

// parseJpeg main loop and classifyMpfPayload clusters (67-29, jpeg-7). Every assertion is a typed
// refusal literal, the thrown abort reason, a segment identifier or buffered index, a parsed frame
// component or an MPF class set, never diagnostic wording. The fixtures are built from the T.81
// marker grammar and the CIPA DC-007 MP Index layout, not derived from the operators under test.
async function jqParse(
  bytes: Buffer,
  options: {
    readonly declaredSize?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<JpParseOutcome> {
  const directory = await jhFreshDirectory();
  const path = join(directory, "input.jpg");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    const parsed = await parseJpeg(
      handle,
      options.declaredSize ?? bytes.length,
      options.signal,
    );
    return { parsed, error: undefined, reads: [] };
  } catch (error) {
    return { parsed: undefined, error, reads: [] };
  } finally {
    await handle.close();
  }
}

/** A duck-typed signal that reports `aborted` false for its first `calm` reads, then true. */
function jqSignalAfter(calm: number, reason?: unknown): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads > calm;
    },
    reason,
  } as unknown as AbortSignal;
}

function jqOutcome(bytes: Buffer, declaredSize?: number): Promise<string> {
  return jqParse(
    bytes,
    declaredSize === undefined ? {} : { declaredSize },
  ).then(jpOutcomeName);
}

/** The bytes of `base` before the first occurrence of `marker`, plus that marker. */
function jqHeadThrough(base: Buffer, marker: number): Buffer {
  return base.subarray(0, base.indexOf(Buffer.from([0xff, marker])) + 2);
}

function jqConcat(...parts: ReadonlyArray<Buffer | readonly number[]>): Buffer {
  return Buffer.concat(
    parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))),
  );
}

interface JqMpfSpec {
  readonly little?: boolean;
  readonly orderBytes?: string;
  readonly magic?: number;
  readonly numberOfImages?: number;
  readonly secondary?: ReadonlyArray<readonly [size: number, offset: number]>;
  readonly declaredBytes?: number;
  readonly trailingTags?: readonly number[];
  readonly ifdLast?: boolean;
  readonly ifdOffset?: number;
}

/**
 * An APP2 MPF payload ("MPF\0" plus the CIPA DC-007 header): byte order, the 42 magic, the IFD
 * offset, an IFD of NumberOfImages (B001), MPEntry (B002) and any trailing tags, then 16-byte MP
 * entries (the primary entry first). `ifdLast` puts the MP entries before the IFD, so the IFD
 * ends exactly at the end of the payload.
 */
function jqMpfPayload(spec: JqMpfSpec = {}): Buffer {
  const little = spec.little ?? true;
  const u16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    if (little) bytes.writeUInt16LE(value);
    else bytes.writeUInt16BE(value);
    return bytes;
  };
  const u32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    if (little) bytes.writeUInt32LE(value);
    else bytes.writeUInt32BE(value);
    return bytes;
  };
  const images = spec.numberOfImages ?? 2;
  const entries: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    ...(spec.secondary ?? [[100, 50] as const]),
  ];
  const mpEntries = Buffer.concat(
    entries.map(([size, offset]) =>
      Buffer.concat([u32(0), u32(size), u32(offset), u16(0), u16(0)]),
    ),
  );
  const tags = [0xb001, 0xb002, ...(spec.trailingTags ?? [])];
  const ifdLength = 2 + tags.length * 12 + (spec.ifdLast ? 0 : 4);
  const mpOffset = spec.ifdLast ? 8 : 8 + ifdLength;
  const ifdAt = spec.ifdLast ? 8 + mpEntries.length : 8;
  const entry = (tag: number): Buffer => {
    if (tag === 0xb001) {
      return Buffer.concat([u16(tag), u16(4), u32(1), u32(images)]);
    }
    if (tag === 0xb002) {
      return Buffer.concat([
        u16(tag),
        u16(7),
        u32(spec.declaredBytes ?? mpEntries.length),
        u32(mpOffset),
      ]);
    }
    return Buffer.concat([u16(tag), u16(7), u32(4), u32(0x30313030)]);
  };
  const ifd = Buffer.concat([
    u16(tags.length),
    ...tags.map(entry),
    ...(spec.ifdLast ? [] : [u32(0)]),
  ]);
  const header = Buffer.concat([
    Buffer.from(spec.orderBytes ?? (little ? "II" : "MM"), "ascii"),
    u16(spec.magic ?? 42),
    u32(spec.ifdOffset ?? ifdAt),
  ]);
  const body = spec.ifdLast
    ? Buffer.concat([header, mpEntries, ifd])
    : Buffer.concat([header, ifd, mpEntries]);
  return Buffer.concat([Buffer.from("MPF\0", "latin1"), body]);
}

function jqMpfClasses(
  mpfPayload: Buffer,
  fileSize = 1000,
  xmpEntries: readonly MetadataEntry[] = [],
): string[] {
  return [
    ...classifyTrailerClasses({
      mpfPayload,
      xmpEntries,
      trailerTail: Buffer.alloc(0),
      trailerBytes: 0,
      fileSize,
    }),
  ].sort();
}

describe("jpeg/parser.ts parseJpeg main-loop clusters (67-29, jpeg-7)", () => {
  it("parseJpeg BlockStatement, ConditionalExpression, LogicalOperator, StringLiteral and EqualityOperator clusters: an aborted signal rejects with its own reason or an AbortError, at the entry and at every marker boundary but not past the last segment", async () => {
    const bytes = minimalJpeg();
    const custom = new Error("scripted abort reason");
    const controller = new AbortController();
    controller.abort(custom);
    expect((await jqParse(bytes, { signal: controller.signal })).error).toBe(
      custom,
    );
    // Calm at the entry check, aborted at the first marker boundary.
    expect(
      (await jqParse(bytes, { signal: jqSignalAfter(1, custom) })).error,
    ).toBe(custom);
    for (const calm of [0, 1]) {
      const error = (await jqParse(bytes, { signal: jqSignalAfter(calm) }))
        .error;
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    }
    expect(
      jpOutcomeName(await jqParse(bytes, { signal: jqSignalAfter(1000) })),
    ).toBe("parsed");
    // The entry check runs before any size or signature refusal: an aborted signal wins over a
    // three-byte file that would otherwise be refused as too small.
    const tooSmall = jqConcat([0xff, 0xd8, 0xff]);
    expect((await jqParse(tooSmall, { signal: controller.signal })).error).toBe(
      custom,
    );
    expect(jpOutcomeName(await jqParse(tooSmall))).toBe("malformed-container");
    // SOI and one COM segment, no EOI: the loop ends at the end of the file and the third read of
    // the signal never happens, so the refusal is the missing EOI, not the abort.
    const unfinished = jqConcat(
      [0xff, 0xd8],
      appSegment(0xfe, Buffer.from("hi")),
    );
    const outcome = await jqParse(unfinished, {
      signal: jqSignalAfter(2, custom),
    });
    expect(jpOutcomeName(outcome)).toBe("truncation");
  });

  it("parseJpeg BlockStatement, ConditionalExpression, LogicalOperator and EqualityOperator clusters: the file-size guard refuses only a size above the cap, and a size that is not a safe integer or is below four bytes", async () => {
    const bytes = minimalJpeg();
    const cases: ReadonlyArray<
      readonly [label: string, size: number, expected: string]
    > = [
      [
        "exactly the cap, then the file ends early",
        JPEG_MAX_FILE_BYTES,
        "truncation",
      ],
      ["one above the cap", JPEG_MAX_FILE_BYTES + 1, "resource-limits"],
      ["NaN", Number.NaN, "malformed-container"],
      ["a fraction", 4.5, "malformed-container"],
      ["zero", 0, "malformed-container"],
      ["three bytes", 3, "malformed-container"],
      ["four bytes: SOI and a marker with no length field", 4, "truncation"],
    ];
    for (const [label, size, expected] of cases) {
      expect(await jqOutcome(bytes, size), label).toBe(expected);
    }
  });

  it("parseJpeg BlockStatement, ConditionalExpression and LogicalOperator clusters: a file refuses unless both of its first two bytes are the SOI, and a segment must start with a 0xFF prefix", async () => {
    const bytes = minimalJpeg();
    expect(await jqOutcome(bytes)).toBe("parsed");
    for (const soi of [
      [0x00, 0xd8],
      [0xff, 0x00],
      [0x00, 0x00],
    ]) {
      const corrupted = jqConcat(soi, bytes.subarray(2));
      expect(await jqOutcome(corrupted), `SOI ${soi.join(",")}`).toBe(
        "malformed-container",
      );
    }
    // The prefix byte of the first segment, and of a later one, is not 0xFF.
    const firstPrefix = Buffer.from(bytes);
    firstPrefix[2] = 0x00;
    expect(await jqOutcome(firstPrefix)).toBe("malformed-container");
    const sofAt = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    const laterPrefix = Buffer.from(bytes);
    laterPrefix[sofAt] = 0x00;
    expect(await jqOutcome(laterPrefix)).toBe("malformed-container");
  });

  it("parseJpeg BlockStatement, ConditionalExpression, EqualityOperator and ArithmeticOperator clusters: SOS and other segment headers refuse at the exact byte that is missing", async () => {
    const base = minimalJpeg({ components: 1 });
    const sosHead = jqHeadThrough(base, 0xda);
    const sosCases: ReadonlyArray<readonly [string, Buffer, string]> = [
      ["SOS marker is the last two bytes", sosHead, "truncation"],
      ["one byte of the SOS length", jqConcat(sosHead, [0x00]), "truncation"],
      [
        "SOS length 2 and an empty payload",
        jqConcat(sosHead, [0x00, 0x02]),
        "malformed-container",
      ],
      [
        "SOS length 0",
        jqConcat(sosHead, [0x00, 0x00, 0xaa, 0xbb]),
        "malformed-container",
      ],
      [
        "SOS length 1",
        jqConcat(sosHead, [0x00, 0x01, 0xaa, 0xbb]),
        "malformed-container",
      ],
      [
        "SOS payload runs past the end of the file",
        jqConcat(sosHead, [0x00, 0x20, 0x01]),
        "truncation",
      ],
    ];
    for (const [label, bytes, expected] of sosCases) {
      expect(await jqOutcome(bytes), label).toBe(expected);
    }
    // An SOS whose payload ends exactly at the end of the file is still parsed and validated: the
    // scan names an undefined DC table.
    const scan = jpScanFixture({
      sos: jpSosPayload([[1, 1, 0]], JP_SEQUENTIAL_SPECTRAL),
    });
    const sosAt = scan.indexOf(Buffer.from([0xff, 0xda]));
    expect(await jqOutcome(scan.subarray(0, sosAt + 4 + 6))).toBe(
      "undefined-table-reference",
    );

    const sofHead = jqHeadThrough(base, 0xc0);
    const sofAt = sofHead.length - 2;
    const segmentCases: ReadonlyArray<readonly [string, Buffer, string]> = [
      ["SOF marker is the last two bytes", sofHead, "truncation"],
      ["one byte of the SOF length", jqConcat(sofHead, [0x00]), "truncation"],
      [
        "SOF length 2 and an empty payload",
        jqConcat(sofHead, [0x00, 0x02]),
        "malformed-container",
      ],
      [
        "SOF length 0",
        jqConcat(sofHead, [0x00, 0x00, 0x11, 0x22]),
        "malformed-container",
      ],
      [
        "SOF length 1",
        jqConcat(sofHead, [0x00, 0x01, 0x11, 0x22]),
        "malformed-container",
      ],
      [
        "SOF payload runs past the end of the file",
        jqConcat(sofHead, [0x00, 0x20, 0x01]),
        "truncation",
      ],
      [
        "a 12-bit SOF is the last segment and ends exactly at the end of the file",
        jqConcat(
          base.subarray(0, sofAt),
          appSegment(0xc0, Buffer.from([12, 0, 8, 0, 8, 1, 1, 0x11, 0])),
        ),
        "non-8-bit-precision",
      ],
    ];
    for (const [label, bytes, expected] of segmentCases) {
      expect(await jqOutcome(bytes), label).toBe(expected);
    }
  });

  it("parseJpeg BlockStatement, ConditionalExpression, EqualityOperator and ArithmeticOperator clusters: an SOF payload must hold its six header bytes and three bytes per declared component", async () => {
    const base = minimalJpeg({ components: 1 });
    const beforeSof = base.subarray(0, jqHeadThrough(base, 0xc0).length - 2);
    const sofWith = (payload: readonly number[]): Buffer =>
      jqConcat(beforeSof, appSegment(0xc0, Buffer.from(payload)));
    const cases: ReadonlyArray<readonly [string, readonly number[], string]> = [
      ["five payload bytes", [8, 0, 8, 0, 8], "malformed-container"],
      [
        "six payload bytes, zero components",
        [8, 0, 8, 0, 8, 0],
        "unsupported-component-count",
      ],
      [
        "one component declared, none present",
        [8, 0, 8, 0, 8, 1],
        "malformed-container",
      ],
      [
        "three components declared, two present",
        [8, 0, 8, 0, 8, 3, 1, 0x11, 0, 2, 0x11, 0],
        "malformed-container",
      ],
      [
        "four components declared, three present",
        [8, 0, 8, 0, 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0],
        "malformed-container",
      ],
      [
        "three components declared and present (the file then ends without an EOI)",
        [8, 0, 8, 0, 8, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0],
        "truncation",
      ],
    ];
    for (const [label, payload, expected] of cases) {
      expect(await jqOutcome(sofWith(payload)), label).toBe(expected);
    }
  });

  it("parseJpeg ArithmeticOperator cluster: each frame component keeps its own id, sampling nibbles and quantization table index", async () => {
    const sof = Buffer.from([
      8, 0, 8, 0, 8, 3, 7, 0x21, 0, 8, 0x12, 1, 9, 0x34, 1,
    ]);
    const bytes = jqConcat(
      [0xff, 0xd8],
      appSegment(0xdb, Buffer.concat([jpDqtTable(0, 0), jpDqtTable(0, 1)])),
      appSegment(0xc0, sof),
      appSegment(0xc4, jpDc0Ac0Tables()),
      appSegment(
        0xda,
        jpSosPayload(
          [
            [7, 0, 0],
            [8, 0, 0],
            [9, 0, 0],
          ],
          JP_SEQUENTIAL_SPECTRAL,
        ),
      ),
      [0x12, 0x34, 0xff, 0xd9],
    );
    const parsed = (await jqParse(bytes)).parsed;
    expect(parsed?.frame.components).toEqual([
      { id: 7, h: 2, v: 1, tq: 0 },
      { id: 8, h: 1, v: 2, tq: 1 },
      { id: 9, h: 3, v: 4, tq: 1 },
    ]);
  });

  it("parseJpeg ConditionalExpression, EqualityOperator, LogicalOperator and BooleanLiteral clusters: only APPn segments carry an identifier and only the first JFIF and MPF segments are buffered, while every Adobe segment is", async () => {
    const jfif = appSegment(
      0xe0,
      Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00", "latin1"),
    );
    const mpf = appSegment(0xe2, Buffer.from("MPF\0abcd", "latin1"));
    const adobe = appSegment(
      0xee,
      Buffer.from("Adobe\0\x64\x00\x00\x00\x00\x00", "latin1"),
    );
    const unknown = appSegment(0xe3, Buffer.from("Foo\0bar", "latin1"));
    const comment = appSegment(0xfe, Buffer.from("hi\0there", "latin1"));
    const bytes = spliceSegments(minimalJpeg({ components: 1 }), [
      jfif,
      jfif,
      mpf,
      mpf,
      adobe,
      adobe,
      unknown,
      comment,
    ]);
    const parsed = (await jqParse(bytes)).parsed;
    expect(parsed?.segments.map((segment) => segment.identifier)).toEqual([
      "JFIF",
      "JFIF",
      "MPF",
      "MPF",
      "Adobe",
      "Adobe",
      "Foo",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect([...(parsed?.buffered.keys() ?? [])].sort((a, b) => a - b)).toEqual([
      0, 2, 4, 5,
    ]);
  });

  it("parseJpeg EqualityOperator cluster: the ICC segment count and the ExtendedXMP byte total are refused only above their caps", async () => {
    const icc = (sequence: number): Buffer =>
      appSegment(
        0xe2,
        Buffer.concat([
          Buffer.from("ICC_PROFILE\0", "latin1"),
          Buffer.from([sequence, JPEG_MAX_ICC_SEGMENTS]),
          Buffer.alloc(4),
        ]),
      );
    const iccBytes = spliceSegments(
      minimalJpeg({ components: 1 }),
      Array.from({ length: JPEG_MAX_ICC_SEGMENTS }, (_, index) =>
        icc(index + 1),
      ),
    );
    const iccParsed = (await jqParse(iccBytes)).parsed;
    expect(iccParsed?.buffered.size).toBe(JPEG_MAX_ICC_SEGMENTS);

    const header = Buffer.concat([
      Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1"),
      Buffer.alloc(32, 0x41),
      Buffer.alloc(8),
    ]);
    const chunk = (payloadBytes: number): Buffer =>
      appSegment(
        0xe1,
        Buffer.concat([header, Buffer.alloc(payloadBytes - header.length, 0)]),
      );
    const full = 65_533;
    const count = Math.floor(JPEG_MAX_EXTENDED_XMP_BYTES / full);
    const rest = JPEG_MAX_EXTENDED_XMP_BYTES - count * full;
    const xmpBytes = spliceSegments(minimalJpeg({ components: 1 }), [
      ...Array.from({ length: count }, () => chunk(full)),
      chunk(rest),
    ]);
    const xmpParsed = (await jqParse(xmpBytes)).parsed;
    const total = [...(xmpParsed?.buffered.values() ?? [])].reduce(
      (sum, payload) => sum + payload.length,
      0,
    );
    expect(total).toBe(JPEG_MAX_EXTENDED_XMP_BYTES);
  }, 60_000);
});

describe("jpeg/trailer.ts classifyMpfPayload, isSamsungSeftTail and classifyTrailerClasses clusters (67-29, jpeg-7)", () => {
  it("classifyMpfPayload BooleanLiteral, ConditionalExpression and StringLiteral clusters: II and MM are the only byte orders, each read in its own endianness", () => {
    expect(jqMpfClasses(jqMpfPayload({ little: true }))).toEqual(["mpf"]);
    expect(jqMpfClasses(jqMpfPayload({ little: false }))).toEqual(["mpf"]);
    for (const little of [true, false]) {
      expect(
        jqMpfClasses(jqMpfPayload({ little, orderBytes: "XX" })),
        `XX read as ${little ? "little" : "big"}-endian`,
      ).toEqual(["mpf-index-invalid"]);
    }
  });

  it("classifyMpfPayload ConditionalExpression and EqualityOperator clusters: the magic number, the IFD location and the image count each have an exact boundary", () => {
    expect(jqMpfClasses(jqMpfPayload({ magic: 43 }))).toEqual([
      "mpf-index-invalid",
    ]);
    const headerLength = jqMpfPayload().length - 4;
    for (const ifdOffset of [headerLength, headerLength - 1, 0xffffffff]) {
      expect(
        jqMpfClasses(jqMpfPayload({ ifdOffset })),
        `ifdOffset ${ifdOffset}`,
      ).toEqual(["mpf-index-invalid"]);
    }
    expect(jqMpfClasses(jqMpfPayload({ numberOfImages: 1 }))).toEqual([
      "mpf-index-invalid",
    ]);
    expect(jqMpfClasses(jqMpfPayload({ numberOfImages: 2 }))).toEqual(["mpf"]);
    // Three images need three 16-byte MP entries.
    expect(jqMpfClasses(jqMpfPayload({ numberOfImages: 3 }))).toEqual([
      "mpf-index-invalid",
    ]);
    expect(
      jqMpfClasses(
        jqMpfPayload({
          numberOfImages: 3,
          secondary: [
            [100, 50],
            [100, 60],
          ],
        }),
      ),
    ).toEqual(["mpf"]);
    // A tag other than B001 and B002 after them leaves the MP entry alone.
    expect(jqMpfClasses(jqMpfPayload({ trailingTags: [0xb000] }))).toEqual([
      "mpf",
    ]);
  });

  it("classifyMpfPayload EqualityOperator and ConditionalExpression clusters: an IFD that ends exactly at the end of the payload is admitted, and every proper prefix of a valid payload is the invalid class", () => {
    for (const little of [true, false]) {
      expect(
        jqMpfClasses(jqMpfPayload({ little, ifdLast: true })),
        `IFD last, ${little ? "little" : "big"}-endian`,
      ).toEqual(["mpf"]);
    }
    for (const spec of [{}, { ifdLast: true }, { little: false }]) {
      const full = jqMpfPayload(spec);
      for (let cut = 0; cut < full.length; cut += 1) {
        expect(
          jqMpfClasses(full.subarray(0, cut)),
          `${JSON.stringify(spec)} cut to ${cut} bytes`,
        ).toEqual(["mpf-index-invalid"]);
      }
    }
  });

  it("classifyMpfPayload ArithmeticOperator, ConditionalExpression and EqualityOperator clusters: a secondary image must end within the file, and a file of exactly its end is admitted", () => {
    expect(
      jqMpfClasses(jqMpfPayload({ secondary: [[600, 500]] }), 1000),
    ).toEqual(["mpf-index-invalid"]);
    expect(
      jqMpfClasses(jqMpfPayload({ secondary: [[600, 400]] }), 1000),
    ).toEqual(["mpf"]);
    expect(
      jqMpfClasses(jqMpfPayload({ secondary: [[600, 400]] }), 999),
    ).toEqual(["mpf-index-invalid"]);
  });

  it("isSamsungSeftTail EqualityOperator cluster and classifyTrailerClasses ConditionalExpression cluster: an eight-byte SEFT tail is Samsung, a shorter one is not, and an XMP flag counts when only an MPF payload carries the secondary bytes", () => {
    const seft = Buffer.concat([
      Buffer.from("SEFT", "ascii"),
      Buffer.alloc(4, 1),
    ]);
    const classesOf = (trailerTail: Buffer): string[] =>
      [
        ...classifyTrailerClasses({
          mpfPayload: undefined,
          xmpEntries: [],
          trailerTail,
          trailerBytes: trailerTail.length,
          fileSize: 1000,
        }),
      ].sort();
    expect(classesOf(seft)).toEqual(["plain-trailer", "samsung-trailer"]);
    expect(
      classesOf(Buffer.concat([Buffer.from([1, 2, 3, 4, 5]), seft])),
    ).toEqual(["plain-trailer", "samsung-trailer"]);
    expect(classesOf(seft.subarray(0, 7))).toEqual(["plain-trailer"]);

    const entry = (name: string): MetadataEntry => ({
      namespace: "XMP",
      name,
      value: "1",
    });
    const mpf = jqMpfPayload();
    expect(jqMpfClasses(mpf, 1000, [entry("GCamera:MotionPhoto")])).toEqual([
      "google-motion-photo",
      "mpf",
    ]);
    expect(jqMpfClasses(mpf, 1000, [entry("hdrgm:Version")])).toEqual([
      "gain-map",
      "mpf",
    ]);
  });
});

const JX_GUID = "0123456789ABCDEF0123456789ABCDEF";
const JX_OTHER_GUID = "FEDCBA9876543210FEDCBA9876543210";
// Adobe XMP Part 3: the identifier and its NUL (35 bytes), the 32-byte GUID, then the 4-byte full
// length and the 4-byte chunk offset.
const JX_EXTENSION_HEADER_BYTES = 35 + 32 + 8;

/** One raw ExtendedXMP APP1 payload (Adobe XMP Part 3). */
function jxChunk(
  guid: string,
  fullLength: number,
  offset: number,
  data: Buffer,
): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(fullLength, 0);
  head.writeUInt32BE(offset, 4);
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
    Buffer.from(guid, "ascii"),
    head,
    data,
  ]);
}

/** The standard packet names `declared` through xmpNote:HasExtendedXMP. */
function jxReassemble(chunks: readonly Buffer[], declared = JX_GUID) {
  return reassembleExtendedXmp(
    jhStandardXmpOrientationPayload(1, declared),
    chunks,
  );
}

function jxExpectIncompleteWithDetail(
  result: ReturnType<typeof reassembleExtendedXmp>,
): void {
  expect(result.status).toBe("incomplete");
  if (result.status !== "incomplete") return;
  expect(typeof result.detail).toBe("string");
  expect(result.detail.length).toBeGreaterThan(0);
}

describe("jpeg/xmp.ts reassembleExtendedXmp and helper clusters (67-30, jpeg-8)", () => {
  it("reassembleExtendedXmp StringLiteral cluster: every incomplete outcome (inconsistent lengths, oversize, overlap, coverage mismatch) carries a non-empty detail", () => {
    const data = Buffer.alloc(10, 7);
    // Two chunks of the named GUID that disagree on the full length.
    jxExpectIncompleteWithDetail(
      jxReassemble([
        jxChunk(JX_GUID, 20, 0, data),
        jxChunk(JX_GUID, 21, 10, data),
      ]),
    );
    // A declared full length one byte over the cap, with the chunk data covering all of it.
    const oversized = JPEG_MAX_EXTENDED_XMP_BYTES + 1;
    jxExpectIncompleteWithDetail(
      jxReassemble([jxChunk(JX_GUID, oversized, 0, Buffer.alloc(oversized))]),
    );
    // Offset overlap: the second chunk starts inside the first.
    jxExpectIncompleteWithDetail(
      jxReassemble([
        jxChunk(JX_GUID, 20, 0, data),
        jxChunk(JX_GUID, 20, 5, data),
      ]),
    );
    // A hole: the second chunk starts after the first one ends.
    jxExpectIncompleteWithDetail(
      jxReassemble([
        jxChunk(JX_GUID, 20, 0, data),
        jxChunk(JX_GUID, 20, 15, data),
      ]),
    );
    // Exact-length coverage of fewer bytes than declared.
    jxExpectIncompleteWithDetail(jxReassemble([jxChunk(JX_GUID, 20, 0, data)]));
    // Coverage of more bytes than declared.
    jxExpectIncompleteWithDetail(jxReassemble([jxChunk(JX_GUID, 5, 0, data)]));
  });

  it("parseExtendedXmpChunk ArithmeticOperator, BlockStatement, ConditionalExpression and EqualityOperator clusters: a payload shorter than identifier, GUID and 8-byte header is ignored, a header-only payload is a chunk", () => {
    const whole = jxChunk(JX_GUID, 10, 0, Buffer.alloc(10, 7));
    for (const length of [0, 34, 35, 58, 59, 66, 67, 70, 71, 74]) {
      const truncated = whole.subarray(0, length);
      expect(jxReassemble([truncated])).toEqual({ status: "absent" });
      // A short payload beside a good chunk is skipped, not thrown on.
      const result = jxReassemble([truncated, whole]);
      expect(result.status).toBe("complete");
      if (result.status === "complete")
        expect(result.xmp.equals(Buffer.alloc(10, 7))).toBe(true);
    }

    // Exactly the header, no data: a real zero-length chunk (not ignored).
    const headerOnly = jxChunk(JX_GUID, 0, 0, Buffer.alloc(0));
    expect(headerOnly.length).toBe(JX_EXTENSION_HEADER_BYTES);
    const empty = jxReassemble([headerOnly]);
    expect(empty.status).toBe("complete");
    if (empty.status === "complete") expect(empty.xmp.length).toBe(0);
    // ...and a header-only chunk still takes part in the full length agreement.
    jxExpectIncompleteWithDetail(
      jxReassemble([
        jxChunk(JX_GUID, 10, 0, Buffer.alloc(10, 7)),
        jxChunk(JX_GUID, 11, 10, Buffer.alloc(0)),
      ]),
    );
  });

  it("findHasExtendedXmpGuid MethodExpression cluster: a HasExtendedXMP GUID padded with numeric-entity whitespace still names its chunks", () => {
    // parseXmp trims the raw attribute text and only then decodes entities, so whitespace written
    // as character references (&#32; and &#10;) reaches the GUID lookup and has to be trimmed there.
    const data = Buffer.alloc(10, 7);
    const padded = jxReassemble(
      [jxChunk(JX_GUID, 10, 0, data)],
      `&#32;${JX_GUID}&#10;`,
    );
    expect(padded.status).toBe("complete");
    if (padded.status === "complete")
      expect(padded.xmp.equals(data)).toBe(true);
    // A GUID that is not 32 characters even once trimmed names nothing.
    expect(
      jxReassemble(
        [jxChunk(JX_GUID, 10, 0, data)],
        `&#32;${JX_GUID.slice(1)}&#10;`,
      ),
    ).toEqual({ status: "absent" });
  });

  it("reassembleExtendedXmp ConditionalExpression cluster: a declared GUID with no chunk of that GUID is absent, never an error", () => {
    expect(jxReassemble([])).toEqual({ status: "absent" });
    expect(
      jxReassemble([jxChunk(JX_OTHER_GUID, 10, 0, Buffer.alloc(10))]),
    ).toEqual({ status: "absent" });
  });

  it("reassembleExtendedXmp EqualityOperator, ConditionalExpression and BlockStatement clusters: exactly JPEG_MAX_EXTENDED_XMP_BYTES reassembles, one byte more is incomplete even when fully covered", () => {
    const exact = Buffer.alloc(JPEG_MAX_EXTENDED_XMP_BYTES, 0x41);
    const atCap = jxReassemble([
      jxChunk(JX_GUID, JPEG_MAX_EXTENDED_XMP_BYTES, 0, exact),
    ]);
    expect(atCap.status).toBe("complete");
    if (atCap.status === "complete") {
      expect(atCap.xmp.length).toBe(JPEG_MAX_EXTENDED_XMP_BYTES);
      expect(atCap.xmp.equals(exact)).toBe(true);
    }
    const over = JPEG_MAX_EXTENDED_XMP_BYTES + 1;
    expect(
      jxReassemble([jxChunk(JX_GUID, over, 0, Buffer.alloc(over, 0x41))])
        .status,
    ).toBe("incomplete");
  });

  it("reassembleExtendedXmp MethodExpression and ArithmeticOperator clusters: chunks arriving out of offset order are sorted by offset, without reordering the caller's input", () => {
    const full = Buffer.from(
      "ExtendedXMP chunk payload bytes whose order must come out by offset.",
      "ascii",
    );
    const third = Math.floor(full.length / 3);
    const parts = [
      { offset: 0, data: full.subarray(0, third) },
      { offset: third, data: full.subarray(third, 2 * third) },
      { offset: 2 * third, data: full.subarray(2 * third) },
    ];
    const reversed = parts
      .map((part) => jxChunk(JX_GUID, full.length, part.offset, part.data))
      .reverse();
    const input = [...reversed];
    const result = jxReassemble(reversed);
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(result.xmp.equals(full)).toBe(true);
    expect(reversed).toEqual(input);
    // Interleaved order as well: the middle chunk first.
    const shuffled = [reversed[1]!, reversed[2]!, reversed[0]!];
    const again = jxReassemble(shuffled);
    expect(again.status).toBe("complete");
    if (again.status === "complete") expect(again.xmp.equals(full)).toBe(true);
  });
});

// metadata/exif.ts parseExif and TIFF reader clusters (67-31, metadata-1). The fixtures are
// little- and big-endian TIFF containers with an IFD0 built entry by entry. Every assertion is on
// the typed outcome (`entries`, the orientation status, the warning codes), never on message text.
interface ExEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Value bytes: at most 4 are stored inline (zero padded), longer values follow the IFD. */
  readonly value?: Buffer;
  /** Writes this offset into the 4-byte value/offset field instead of the value. */
  readonly offset?: number;
}

function exTiff(entries: readonly ExEntry[], big: boolean): Buffer {
  const w16 = (buffer: Buffer, at: number, value: number): void => {
    if (big) buffer.writeUInt16BE(value, at);
    else buffer.writeUInt16LE(value, at);
  };
  const w32 = (buffer: Buffer, at: number, value: number): void => {
    if (big) buffer.writeUInt32BE(value, at);
    else buffer.writeUInt32LE(value, at);
  };
  const dataStart = 8 + 2 + entries.length * 12 + 4;
  const head = Buffer.alloc(dataStart);
  head.write(big ? "MM" : "II", 0, "ascii");
  w16(head, 2, 42);
  w32(head, 4, 8);
  w16(head, 8, entries.length);
  const external: Buffer[] = [];
  let next = dataStart;
  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    w16(head, at, entry.tag);
    w16(head, at + 2, entry.type);
    w32(head, at + 4, entry.count);
    if (entry.offset !== undefined) {
      w32(head, at + 8, entry.offset);
      return;
    }
    const value = entry.value ?? Buffer.alloc(0);
    if (value.length <= 4) {
      value.copy(head, at + 8);
      return;
    }
    w32(head, at + 8, next);
    external.push(value);
    next += value.length;
  });
  return Buffer.concat([head, ...external]);
}

function exU16(values: readonly number[], big: boolean): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, index) =>
    big
      ? out.writeUInt16BE(value, index * 2)
      : out.writeUInt16LE(value, index * 2),
  );
  return out;
}

function exU32(values: readonly number[], big: boolean): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) =>
    big
      ? out.writeUInt32BE(value, index * 4)
      : out.writeUInt32LE(value, index * 4),
  );
  return out;
}

function exI32(values: readonly number[], big: boolean): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) =>
    big
      ? out.writeInt32BE(value, index * 4)
      : out.writeInt32LE(value, index * 4),
  );
  return out;
}

/** Numerator/denominator pairs as RATIONAL (unsigned) or SRATIONAL (signed) bytes. */
function exRational(
  pairs: ReadonlyArray<readonly [number, number]>,
  signed: boolean,
  big: boolean,
): Buffer {
  const flat = pairs.flat();
  return signed ? exI32(flat, big) : exU32(flat, big);
}

function exEntries(tiff: Buffer): ReturnType<typeof parseExif>["entries"] {
  const parsed = parseExif(tiff);
  expect(parsed.warnings).toEqual([]);
  expect(parsed.orientation).toEqual({ status: "absent" });
  return parsed.entries;
}

function exNamed(tag: number, value: unknown): unknown {
  return {
    namespace: "EXIF",
    name: `Tag0x${tag.toString(16).padStart(4, "0")}`,
    value,
  };
}

function exExpectMalformed(tiff: Buffer): void {
  const parsed = parseExif(tiff);
  expect(parsed.entries).toEqual([]);
  expect(parsed.orientation.status).toBe("malformed");
  expect(parsed.warnings.map((warning) => warning.code)).toEqual([
    "metadata-invalid",
  ]);
}

describe("metadata/exif.ts parseExif and TIFF reader clusters (67-31, metadata-1)", () => {
  it("readValue ConditionalExpression, BlockStatement and CallExpression clusters: a value pointing past the end of the EXIF data is malformed, never truncated", () => {
    for (const big of [false, true]) {
      const whole = exTiff(
        [{ tag: 0xf001, type: 2, count: 8, value: Buffer.alloc(8, 0x41) }],
        big,
      );
      // The 8-byte value starts at offset 26; moving it to length - 4 leaves only 4 of its bytes.
      const patch = (offset: number): Buffer => {
        const copy = Buffer.from(whole);
        if (big) copy.writeUInt32BE(offset, 18);
        else copy.writeUInt32LE(offset, 18);
        return copy;
      };
      exExpectMalformed(patch(whole.length - 4));
      exExpectMalformed(patch(whole.length - 1));
      exExpectMalformed(patch(0xfffffff0));
      // Flush against the end is still read.
      expect(exEntries(patch(whole.length - 8))).toEqual([
        exNamed(0xf001, "AAAAAAAA"),
      ]);
    }
  });

  it("inBounds ArithmeticOperator, ConditionalExpression, EqualityOperator and LogicalOperator clusters: a value is read from offset 0, with length 0 and flush against the end, and refused one byte past the end", () => {
    for (const big of [false, true]) {
      // Offset 0: the value is the TIFF header itself (NUL-terminated at the first zero byte).
      expect(
        exEntries(exTiff([{ tag: 0xf001, type: 2, count: 8, offset: 0 }], big)),
      ).toEqual([exNamed(0xf001, big ? "MM" : "II*")]);
      // Length 0: an ASCII value of count 0 is the empty string.
      expect(
        exEntries(exTiff([{ tag: 0xf002, type: 2, count: 0 }], big)),
      ).toEqual([exNamed(0xf002, "")]);
      // Flush against the end is read, one byte past the end is refused.
      expect(
        exEntries(
          exTiff(
            [
              {
                tag: 0xf003,
                type: 2,
                count: 8,
                value: Buffer.from("ABCDEFG\0"),
              },
            ],
            big,
          ),
        ),
      ).toEqual([exNamed(0xf003, "ABCDEFG")]);
      exExpectMalformed(
        exTiff(
          [{ tag: 0xf003, type: 2, count: 9, value: Buffer.alloc(8, 0x41) }],
          big,
        ),
      );
    }
  });

  it("readNumber ConditionalExpression cluster: BYTE, LONG and SLONG values decode by their own width and sign", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            // A BYTE reads one byte even though the next inline byte is not zero.
            {
              tag: 0xf010,
              type: 1,
              count: 1,
              value: Buffer.from([5, 1, 0, 0]),
            },
            { tag: 0xf011, type: 4, count: 1, value: exU32([0xfffffffe], big) },
            { tag: 0xf012, type: 4, count: 1, value: exU32([0x80000000], big) },
            { tag: 0xf013, type: 9, count: 1, value: exI32([-5], big) },
            {
              tag: 0xf014,
              type: 9,
              count: 1,
              value: exI32([-0x80000000], big),
            },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf010, 5),
        exNamed(0xf011, 4294967294),
        exNamed(0xf012, 2147483648),
        exNamed(0xf013, -5),
        exNamed(0xf014, -2147483648),
      ]);
    }
  });

  it("readValue ArithmeticOperator and simplify ConditionalExpression clusters: multi-value arrays advance by the element width and a single value is not wrapped", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            { tag: 0xf020, type: 3, count: 2, value: exU16([1, 0x8002], big) },
            { tag: 0xf021, type: 1, count: 3, value: Buffer.from([7, 8, 9]) },
            {
              tag: 0xf022,
              type: 4,
              count: 3,
              value: exU32([1, 0xffffffff, 3], big),
            },
            { tag: 0xf023, type: 9, count: 2, value: exI32([-1, 2], big) },
            { tag: 0xf024, type: 3, count: 1, value: exU16([9], big) },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf020, [1, 0x8002]),
        exNamed(0xf021, [7, 8, 9]),
        exNamed(0xf022, [1, 4294967295, 3]),
        exNamed(0xf023, [-1, 2]),
        exNamed(0xf024, 9),
      ]);
    }
  });

  it("readValue ConditionalExpression, ArithmeticOperator and ObjectLiteral clusters: RATIONAL and SRATIONAL values decode sign, division and a zero denominator exactly", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            {
              tag: 0xf030,
              type: 5,
              count: 1,
              value: exRational([[0xffffffff, 1]], false, big),
            },
            {
              tag: 0xf031,
              type: 5,
              count: 1,
              value: exRational([[1, 0x80000000]], false, big),
            },
            {
              tag: 0xf032,
              type: 5,
              count: 1,
              value: exRational([[3, 4]], false, big),
            },
            {
              tag: 0xf033,
              type: 10,
              count: 1,
              value: exRational([[-3, 4]], true, big),
            },
            {
              tag: 0xf034,
              type: 10,
              count: 1,
              value: exRational([[3, -4]], true, big),
            },
            {
              tag: 0xf035,
              type: 5,
              count: 1,
              value: exRational([[5, 0]], false, big),
            },
            {
              tag: 0xf036,
              type: 10,
              count: 1,
              value: exRational([[-5, 0]], true, big),
            },
            {
              tag: 0xf037,
              type: 5,
              count: 3,
              value: exRational(
                [
                  [1, 2],
                  [3, 4],
                  [5, 8],
                ],
                false,
                big,
              ),
            },
            {
              tag: 0xf038,
              type: 10,
              count: 2,
              value: exRational(
                [
                  [-1, 2],
                  [3, -4],
                ],
                true,
                big,
              ),
            },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf030, 4294967295),
        exNamed(0xf031, 1 / 0x80000000),
        exNamed(0xf032, 0.75),
        exNamed(0xf033, -0.75),
        exNamed(0xf034, -0.75),
        exNamed(0xf035, { numerator: 5, denominator: 0 }),
        exNamed(0xf036, { numerator: -5, denominator: 0 }),
        exNamed(0xf037, [0.5, 0.75, 0.625]),
        exNamed(0xf038, [-0.5, -0.75]),
      ]);
    }
  });

  it("readValue ConditionalExpression and EqualityOperator clusters: ASCII values stop at the first NUL, keep an unterminated tail and read a leading NUL as empty", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            { tag: 0xf040, type: 2, count: 5, value: Buffer.from("Hello") },
            {
              tag: 0xf041,
              type: 2,
              count: 9,
              value: Buffer.from("Hi\0there\0"),
            },
            { tag: 0xf042, type: 2, count: 4, value: Buffer.from("abc\0") },
            { tag: 0xf043, type: 2, count: 5, value: Buffer.alloc(5) },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf040, "Hello"),
        exNamed(0xf041, "Hi"),
        exNamed(0xf042, "abc"),
        exNamed(0xf043, ""),
      ]);
    }
  });

  it("readValue ConditionalExpression and EqualityOperator clusters: a count above 1,000,000 is an unsupported value, exactly 1,000,000 is read", () => {
    for (const big of [false, true]) {
      const over = parseExif(
        exTiff(
          [{ tag: 0xf050, type: 1, count: 1_000_001, offset: 0xfffffff0 }],
          big,
        ),
      );
      expect(over.entries).toEqual([]);
      expect(over.orientation).toEqual({ status: "absent" });
      expect(over.warnings.map((warning) => warning.code)).toEqual([
        "metadata-unsupported",
      ]);
      const text = Buffer.alloc(1_000_000, 0x61);
      const at = exEntries(
        exTiff([{ tag: 0xf051, type: 2, count: 1_000_000, value: text }], big),
      );
      expect(at).toHaveLength(1);
      expect(at[0]!.name).toBe("Tag0xf051");
      expect(at[0]!.value).toBe(text.toString("latin1"));
    }
  });

  it("readValue type 7 clusters: UNDEFINED bytes that are all text decode as a string without their trailing NULs", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            { tag: 0xf060, type: 7, count: 4, value: Buffer.from("0230") },
            {
              tag: 0xf061,
              type: 7,
              count: 8,
              value: Buffer.from([0x41, 0x09, 0x0a, 0x0d, 0x20, 0x42, 0, 0]),
            },
            {
              tag: 0xf062,
              type: 7,
              count: 6,
              value: Buffer.from([0x41, 0, 0x42, 0, 0, 0]),
            },
            {
              tag: 0xf063,
              type: 7,
              count: 4,
              value: Buffer.from([0x41, 0, 0, 0]),
            },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf060, "0230"),
        exNamed(0xf061, "A\t\n\r B"),
        exNamed(0xf062, "A\u0000B"),
        exNamed(0xf063, "A"),
      ]);
    }
  });

  it("inBounds ConditionalExpression and LogicalOperator clusters: an offset or length that is not a non-negative safe integer is out of bounds", () => {
    const buffer = Buffer.alloc(16);
    expect(inBounds(buffer, 0, 16)).toBe(true);
    expect(inBounds(buffer, 16, 0)).toBe(true);
    expect(inBounds(buffer, 15, 1)).toBe(true);
    expect(inBounds(buffer, 15, 2)).toBe(false);
    // A fractional offset or length, NaN and values beyond the safe-integer range.
    expect(inBounds(buffer, 1.5, 1)).toBe(false);
    expect(inBounds(buffer, 1, 1.5)).toBe(false);
    expect(inBounds(buffer, Number.NaN, 1)).toBe(false);
    expect(inBounds(buffer, 0, Number.NaN)).toBe(false);
    expect(inBounds(buffer, Number.MAX_SAFE_INTEGER + 1, 1)).toBe(false);
    expect(inBounds(buffer, 0, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    // Negative values, alone and together.
    expect(inBounds(buffer, -1, 1)).toBe(false);
    expect(inBounds(buffer, 0, -1)).toBe(false);
    expect(inBounds(buffer, -1, -1)).toBe(false);
    expect(inBounds(buffer, -17, 1)).toBe(false);
  });

  it("readValue type 7 clusters: UNDEFINED bytes containing a control byte decode as a byte array", () => {
    for (const big of [false, true]) {
      const entries = exEntries(
        exTiff(
          [
            {
              tag: 0xf070,
              type: 7,
              count: 4,
              value: Buffer.from([0x41, 0x01, 0x42, 0x43]),
            },
            {
              tag: 0xf071,
              type: 7,
              count: 5,
              value: Buffer.from([0x41, 0x42, 0x43, 0x44, 0x1f]),
            },
            {
              tag: 0xf072,
              type: 7,
              count: 4,
              value: Buffer.from([0x01, 0x02, 0x03, 0x04]),
            },
          ],
          big,
        ),
      );
      expect(entries).toEqual([
        exNamed(0xf070, [0x41, 0x01, 0x42, 0x43]),
        exNamed(0xf071, [0x41, 0x42, 0x43, 0x44, 0x1f]),
        exNamed(0xf072, [1, 2, 3, 4]),
      ]);
    }
  });
});

// metadata/exif.ts parseExif, visitIfd and createMinimalExif clusters (67-32, metadata-2). The
// fixtures are little- and big-endian TIFF containers; `exIfds` builds several IFDs, each pointer
// entry naming the IFD it points at. Assertions are on the typed outcome (`entries`, the
// orientation status, the warning codes) and on entry names, never on diagnostic wording; where a
// detail string is checked it is only that it is non-empty and the same on both channels.
interface ExPointer {
  readonly tag: number;
  /** Index of the IFD (in the `exIfds` argument) this pointer entry points at. */
  readonly pointsTo: number;
}

function exIfds(
  ifds: ReadonlyArray<ReadonlyArray<ExEntry | ExPointer>>,
  big: boolean,
): Buffer {
  const w16 = (buffer: Buffer, at: number, value: number): void => {
    if (big) buffer.writeUInt16BE(value, at);
    else buffer.writeUInt16LE(value, at);
  };
  const w32 = (buffer: Buffer, at: number, value: number): void => {
    if (big) buffer.writeUInt32BE(value, at);
    else buffer.writeUInt32LE(value, at);
  };
  const starts: number[] = [];
  let end = 8;
  for (const ifd of ifds) {
    starts.push(end);
    end += 2 + ifd.length * 12 + 4;
  }
  const out = Buffer.alloc(end);
  out.write(big ? "MM" : "II", 0, "ascii");
  w16(out, 2, 42);
  w32(out, 4, starts[0] ?? 8);
  ifds.forEach((ifd, index) => {
    const base = starts[index] ?? 0;
    w16(out, base, ifd.length);
    ifd.forEach((node, position) => {
      const at = base + 2 + position * 12;
      w16(out, at, node.tag);
      if ("pointsTo" in node) {
        w16(out, at + 2, 4);
        w32(out, at + 4, 1);
        w32(out, at + 8, starts[node.pointsTo] ?? 0);
        return;
      }
      w16(out, at + 2, node.type);
      w32(out, at + 4, node.count);
      if (node.offset !== undefined) w32(out, at + 8, node.offset);
      else (node.value ?? Buffer.alloc(0)).copy(out, at + 8);
    });
  });
  return out;
}

function exMarker(tag: number, marker: number): ExEntry {
  return { tag, type: 1, count: 1, value: Buffer.from([marker]) };
}

function exShort(tag: number, value: number, big: boolean): ExEntry {
  return { tag, type: 3, count: 1, value: exU16([value], big) };
}

function exSummary(tiff: Buffer): {
  readonly names: readonly string[];
  readonly values: readonly unknown[];
  readonly warnings: readonly string[];
  readonly orientation: string;
} {
  const parsed = parseExif(tiff);
  return {
    names: parsed.entries.map((entry) => entry.name),
    values: parsed.entries.map((entry) => entry.value),
    warnings: parsed.warnings.map((warning) => warning.code),
    orientation: parsed.orientation.status,
  };
}

/** The orientation detail, which must be a non-empty string that the warning repeats. */
function exExpectUnsupportedOrientation(tiff: Buffer): void {
  const parsed = parseExif(tiff);
  expect(parsed.orientation.status).toBe("unsupported");
  if (parsed.orientation.status !== "unsupported") return;
  expect(parsed.orientation.detail.length).toBeGreaterThan(0);
  const warning = parsed.warnings.at(-1);
  expect(warning?.code).toBe("metadata-unsupported");
  expect(warning?.detail).toBe(parsed.orientation.detail);
}

describe("metadata/exif.ts parseExif, visitIfd and createMinimalExif clusters (67-32, metadata-2)", () => {
  it("parseExif ConditionalExpression, BlockStatement and CallExpression clusters: a byte order other than II or MM, or a marker other than 42, is malformed", () => {
    for (const big of [false, true]) {
      const good = exTiff([exMarker(0xf101, 7)], big);
      expect(exSummary(good).names).toEqual(["Tag0xf101"]);
      // "XX" is read as big-endian when the check is gone, and the big-endian fixture parses.
      const badOrder = Buffer.from(good);
      badOrder.write("XX", 0, "ascii");
      exExpectMalformed(badOrder);
      const lowerCase = Buffer.from(good);
      lowerCase.write(big ? "mm" : "ii", 0, "ascii");
      exExpectMalformed(lowerCase);
      // Every other marker value is refused, not just a different one.
      for (const marker of [0, 41, 43, 0x2a00]) {
        const badMarker = Buffer.from(good);
        if (big) badMarker.writeUInt16BE(marker, 2);
        else badMarker.writeUInt16LE(marker, 2);
        exExpectMalformed(badMarker);
      }
    }
  });

  it("visitIfd EqualityOperator, ConditionalExpression, LogicalOperator and ArithmeticOperator clusters: IFD nesting stops after depth 4", () => {
    for (const big of [false, true]) {
      // Seven IFDs, each holding one marker entry and a pointer to the next.
      const chain = Array.from({ length: 7 }, (_, index) => [
        exMarker(0xf200 + index, index + 1),
        ...(index < 6 ? [{ tag: 0x8769, pointsTo: index + 1 }] : []),
      ]);
      const summary = exSummary(exIfds(chain, big));
      expect(summary.warnings).toEqual([]);
      // Depths 0 through 4 are read (the first at the top level, the others under "Exif.").
      expect(summary.names).toEqual([
        "Tag0xf200",
        "Exif.Tag0xf201",
        "Exif.Tag0xf202",
        "Exif.Tag0xf203",
        "Exif.Tag0xf204",
      ]);
      expect(summary.values).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("visitIfd LogicalOperator, ConditionalExpression and CallExpression clusters: an IFD that points back at itself or at an ancestor is read once", () => {
    for (const big of [false, true]) {
      const self = exSummary(
        exIfds([[exMarker(0xf210, 1), { tag: 0x8769, pointsTo: 0 }]], big),
      );
      expect(self.names).toEqual(["Tag0xf210"]);
      expect(self.warnings).toEqual([]);
      const loop = exSummary(
        exIfds(
          [
            [exMarker(0xf211, 1), { tag: 0x8769, pointsTo: 1 }],
            [exMarker(0xf212, 2), { tag: 0x8825, pointsTo: 0 }],
          ],
          big,
        ),
      );
      expect(loop.names).toEqual(["Tag0xf211", "Exif.Tag0xf212"]);
      expect(loop.warnings).toEqual([]);
      // Two pointers to the same child IFD read it once; the first pointer names it.
      const twice = exSummary(
        exIfds(
          [
            [
              { tag: 0x8769, pointsTo: 1 },
              { tag: 0x8825, pointsTo: 1 },
            ],
            [exMarker(0xf213, 3)],
          ],
          big,
        ),
      );
      expect(twice.names).toEqual(["Exif.Tag0xf213"]);
    }
  });

  it("visitIfd ConditionalExpression, EqualityOperator and StringLiteral clusters: the Exif, GPS and Interop pointers name their entries and the pointer tags are not entries", () => {
    for (const big of [false, true]) {
      const summary = exSummary(
        exIfds(
          [
            [
              { tag: 0x8769, pointsTo: 1 },
              { tag: 0x8825, pointsTo: 2 },
              { tag: 0xa005, pointsTo: 3 },
            ],
            [exMarker(0xf301, 1)],
            [exMarker(0xf302, 2)],
            [exMarker(0xf303, 3)],
          ],
          big,
        ),
      );
      expect(summary.warnings).toEqual([]);
      expect(summary.names).toEqual([
        "Exif.Tag0xf301",
        "GPS.Tag0xf302",
        "Interop.Tag0xf303",
      ]);
      expect(summary.values).toEqual([1, 2, 3]);
    }
  });

  it("visitIfd EqualityOperator, LogicalOperator, ConditionalExpression and BlockStatement clusters: 4096 entries are read, 4097 are refused even when they all fit", () => {
    for (const big of [false, true]) {
      const many = (count: number): Buffer =>
        exTiff(
          Array.from({ length: count }, (_, index) =>
            exMarker(0xf400 + (index % 0x100), index & 0xff),
          ),
          big,
        );
      const atCap = parseExif(many(4096));
      expect(atCap.warnings).toEqual([]);
      expect(atCap.orientation).toEqual({ status: "absent" });
      expect(atCap.entries).toHaveLength(4096);
      exExpectMalformed(many(4097));
    }
  });

  it("visitIfd ArithmeticOperator, BlockStatement and CallExpression clusters: an IFD missing the last byte of its next-IFD field is malformed", () => {
    for (const big of [false, true]) {
      const whole = exTiff([exMarker(0xf500, 9)], big);
      expect(exSummary(whole).names).toEqual(["Tag0xf500"]);
      exExpectMalformed(whole.subarray(0, whole.length - 1));
      exExpectMalformed(whole.subarray(0, whole.length - 4));
      // The entry itself is complete but the IFD is not, so no partial entry list is reported.
      exExpectMalformed(whole.subarray(0, whole.length - 3));
    }
  });

  it("visitIfd ConditionalExpression and BlockStatement clusters: a second Orientation tag is unsupported and is not read", () => {
    for (const big of [false, true]) {
      const tiff = exTiff(
        [exShort(0x0112, 6, big), exShort(0x0112, 8, big)],
        big,
      );
      const parsed = parseExif(tiff);
      expect(parsed.entries.map((entry) => [entry.name, entry.value])).toEqual([
        ["Orientation", 6],
      ]);
      exExpectUnsupportedOrientation(tiff);
    }
  });

  it("visitIfd StringLiteral and ConditionalExpression clusters: an Orientation that is not one SHORT, or is outside 1 through 8, is unsupported", () => {
    for (const big of [false, true]) {
      // LONG instead of SHORT.
      const long = exTiff(
        [{ tag: 0x0112, type: 4, count: 1, value: exU32([3], big) }],
        big,
      );
      expect(parseExif(long).entries).toEqual([]);
      exExpectUnsupportedOrientation(long);
      // Two SHORT values.
      const two = exTiff(
        [{ tag: 0x0112, type: 3, count: 2, value: exU16([3, 4], big) }],
        big,
      );
      expect(parseExif(two).entries).toEqual([]);
      exExpectUnsupportedOrientation(two);
      // Out of range SHORT values are read as entries and refused as orientation.
      for (const value of [0, 9, 0xffff]) {
        const tiff = exTiff([exShort(0x0112, value, big)], big);
        expect(parseExif(tiff).entries.map((entry) => entry.value)).toEqual([
          value,
        ]);
        exExpectUnsupportedOrientation(tiff);
      }
      // The ends of the valid range stay valid.
      for (const value of [1, 8]) {
        const parsed = parseExif(exTiff([exShort(0x0112, value, big)], big));
        expect(parsed.orientation).toEqual({ status: "valid", value });
        expect(parsed.warnings).toEqual([]);
      }
    }
  });

  it("visitIfd ConditionalExpression clusters: an Orientation tag below an Exif pointer is an ordinary entry and never sets the orientation", () => {
    for (const big of [false, true]) {
      const under = (child: ExEntry): ReturnType<typeof exSummary> =>
        exSummary(exIfds([[{ tag: 0x8769, pointsTo: 1 }], [child]], big));
      // A LONG, an invalid SHORT and a valid SHORT all stay plain "Exif.Orientation" entries.
      for (const child of [
        { tag: 0x0112, type: 4, count: 1, value: exU32([3], big) },
        exShort(0x0112, 9, big),
        exShort(0x0112, 3, big),
      ]) {
        const summary = under(child);
        expect(summary.names).toEqual(["Exif.Orientation"]);
        expect(summary.warnings).toEqual([]);
        expect(summary.orientation).toBe("absent");
      }
      // Neither does it count as a second Orientation next to a valid top-level one.
      const both = parseExif(
        exIfds(
          [
            [exShort(0x0112, 6, big), { tag: 0x8769, pointsTo: 1 }],
            [exShort(0x0112, 3, big)],
          ],
          big,
        ),
      );
      expect(both.warnings).toEqual([]);
      expect(both.orientation).toEqual({ status: "valid", value: 6 });
      expect(both.entries.map((entry) => entry.name)).toEqual([
        "Orientation",
        "Exif.Orientation",
      ]);
    }
  });

  it("visitIfd StringLiteral clusters: an unsupported TIFF type warns with the zero-padded tag and an unknown tag is named with four hex digits", () => {
    for (const big of [false, true]) {
      const parsed = parseExif(
        exTiff(
          [
            // SBYTE (6) has no width in TYPE_WIDTHS.
            { tag: 0x00ab, type: 6, count: 1, value: Buffer.from([1]) },
            exMarker(0x00cd, 5),
          ],
          big,
        ),
      );
      expect(parsed.entries).toEqual([exNamed(0x00cd, 5)]);
      expect(parsed.warnings.map((warning) => warning.code)).toEqual([
        "metadata-unsupported",
      ]);
      const detail = parsed.warnings[0]?.detail ?? "";
      // The detail names the tag by its four-digit hex id, not a shortened one.
      expect(detail).toContain("0x00ab");
      expect(detail).not.toContain("0xab ");
    }
  });

  it("createMinimalExif assertUint32 and assertResolutionValue clusters: a non-integer resolution field is a RangeError, never rounded into the bytes", () => {
    const fields = [
      (value: number) => ({
        x: { numerator: value, denominator: 1 },
        y: { numerator: 1, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: value },
        y: { numerator: 1, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: 1 },
        y: { numerator: value, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: 1 },
        y: { numerator: 1, denominator: value },
      }),
    ];
    for (const field of fields) {
      for (const bad of [
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        2 ** 32,
      ]) {
        expect(() => createMinimalExif({ resolution: field(bad) })).toThrow(
          RangeError,
        );
      }
    }
  });

  it("createMinimalExif assertUint32 EqualityOperator cluster: 0 and 0xffffffff are accepted in every resolution field and written exactly", () => {
    for (const edge of [0, 0xffffffff]) {
      const result = createMinimalExif({
        resolution: {
          x: { numerator: edge, denominator: edge },
          y: { numerator: edge, denominator: edge },
        },
      });
      // Two RATIONAL entries; their values follow the IFD (8 + 2 + 2 * 12 + 4 = 38).
      expect(result).toHaveLength(54);
      expect([38, 42, 46, 50].map((at) => result.readUInt32LE(at))).toEqual([
        edge,
        edge,
        edge,
        edge,
      ]);
    }
  });

  it("parseExif header clusters (67-32 amendment): every truncated prefix of a payload, from 0 bytes to just short of the end of its IFD, is malformed with no entries", () => {
    for (const big of [false, true]) {
      const whole = exTiff([exMarker(0xf600, 1)], big);
      for (let length = 0; length < whole.length; length += 1) {
        exExpectMalformed(whole.subarray(0, length));
      }
      expect(exSummary(whole).names).toEqual(["Tag0xf600"]);
    }
  });

  it("createMinimalExif assertUint32 cluster (67-32 amendment): a negative or oversized resolution field is a RangeError in each of the four fields", () => {
    const fields = [
      (value: number) => ({
        x: { numerator: value, denominator: 1 },
        y: { numerator: 1, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: value },
        y: { numerator: 1, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: 1 },
        y: { numerator: value, denominator: 1 },
      }),
      (value: number) => ({
        x: { numerator: 1, denominator: 1 },
        y: { numerator: 1, denominator: value },
      }),
    ];
    for (const field of fields) {
      for (const bad of [-1, -0x80000000, 2 ** 32, 2 ** 53]) {
        expect(() => createMinimalExif({ resolution: field(bad) })).toThrow(
          RangeError,
        );
      }
    }
  });
});

// metadata/icc.ts parseIcc and ascii clusters (67-33, metadata-3). `iccBuild` lays out a profile
// byte by byte: the 128-byte header, the tag count at 128 and 12-byte tag records from 132. Entry
// names are returned metadata keys, so they are asserted exactly; a warning's `detail` is only
// checked to be non-empty (or to differ between two situations), never for its wording.
interface IccTagSpec {
  readonly sig: string;
  readonly offset: number;
  readonly size: number;
}

interface IccBuildOptions {
  readonly length: number;
  readonly declared?: number;
  readonly signature?: string;
  /** Major version byte and the packed minor/bugfix byte. */
  readonly version?: readonly [number, number];
  readonly text?: Partial<
    Record<
      "cmm" | "class" | "space" | "pcs" | "platform" | "maker" | "model",
      string
    >
  >;
  readonly intent?: number;
  readonly tagCount?: number;
  readonly tags?: readonly IccTagSpec[];
}

function iccBuild(options: IccBuildOptions): Buffer {
  const out = Buffer.alloc(options.length);
  const put32 = (at: number, value: number): void => {
    if (at + 4 <= out.length) out.writeUInt32BE(value, at);
  };
  const putText = (at: number, text: string): void => {
    if (at + 4 <= out.length) out.write(text, at, "ascii");
  };
  const text = options.text ?? {};
  put32(0, options.declared ?? options.length);
  putText(4, text.cmm ?? "lcms");
  if (out.length > 9) {
    out[8] = options.version?.[0] ?? 4;
    out[9] = options.version?.[1] ?? 0x30;
  }
  putText(12, text.class ?? "mntr");
  putText(16, text.space ?? "RGB ");
  putText(20, text.pcs ?? "XYZ ");
  putText(36, options.signature ?? "acsp");
  putText(40, text.platform ?? "APPL");
  putText(48, text.maker ?? "ABCD");
  putText(52, text.model ?? "mdl1");
  put32(64, options.intent ?? 1);
  const tags = options.tags ?? [];
  put32(128, options.tagCount ?? tags.length);
  tags.forEach((tag, index) => {
    const at = 132 + index * 12;
    if (at + 12 > out.length) return;
    putText(at, tag.sig);
    put32(at + 4, tag.offset);
    put32(at + 8, tag.size);
  });
  return out;
}

function iccNamed(name: string, value: unknown): unknown {
  return { namespace: "ICC", name, value };
}

/** The eleven header entries of a profile built with the default `iccBuild` fields. */
function iccHeaderEntries(length: number, declared = length): unknown[] {
  return [
    iccNamed("Size", length),
    iccNamed("DeclaredSize", declared),
    iccNamed("CMMType", "lcms"),
    iccNamed("Version", "4.3.0"),
    iccNamed("DeviceClass", "mntr"),
    iccNamed("ColorSpace", "RGB "),
    iccNamed("PCS", "XYZ "),
    iccNamed("Platform", "APPL"),
    iccNamed("Manufacturer", "ABCD"),
    iccNamed("Model", "mdl1"),
    iccNamed("RenderingIntent", 1),
  ];
}

/** Every warning is `metadata-invalid` with some detail text; returns the details. */
function iccWarnings(payload: Buffer, expectedCount: number): string[] {
  const { warnings } = parseIcc(payload);
  expect(warnings.map((warning) => warning.code)).toEqual(
    Array.from({ length: expectedCount }, () => "metadata-invalid"),
  );
  for (const warning of warnings) {
    expect(warning.detail.length).toBeGreaterThan(0);
  }
  return warnings.map((warning) => warning.detail);
}

function iccSignatures(payload: Buffer): unknown {
  return parseIcc(payload).entries.find(
    (entry) => entry.name === "TagSignatures",
  )?.value;
}

function iccEntryNames(payload: Buffer): string[] {
  return parseIcc(payload).entries.map((entry) => entry.name);
}

describe("metadata/icc.ts parseIcc and ascii clusters (67-33, metadata-3)", () => {
  it("ascii Regex and StringLiteral clusters: only trailing NULs, and all of them, are stripped from the four-byte text fields", () => {
    const parsed = parseIcc(
      iccBuild({
        length: 132,
        text: {
          cmm: "AB\0\0",
          class: "A\0B\0",
          space: "ABCD",
          pcs: "\0\0\0\0",
          platform: "\0ABC",
          maker: "A\0\0\0",
        },
      }),
    );
    const byName = new Map(
      parsed.entries.map((entry) => [entry.name, entry.value]),
    );
    expect(byName.get("CMMType")).toBe("AB");
    expect(byName.get("DeviceClass")).toBe("A\0B");
    expect(byName.get("ColorSpace")).toBe("ABCD");
    expect(byName.get("PCS")).toBe("");
    expect(byName.get("Platform")).toBe("\0ABC");
    expect(byName.get("Manufacturer")).toBe("A");
  });

  it("parseIcc StringLiteral and ArrayDeclaration clusters: every header and tag entry is named and carries its value", () => {
    const payload = iccBuild({
      length: 300,
      tags: [
        { sig: "desc", offset: 200, size: 10 },
        { sig: "wtpt", offset: 128, size: 0 },
      ],
    });
    expect(parseIcc(payload)).toEqual({
      entries: [
        ...iccHeaderEntries(300),
        iccNamed("TagCount", 2),
        iccNamed("TagSignatures", ["desc", "wtpt"]),
      ],
      warnings: [],
    });
  });

  it("parseIcc LogicalOperator and StringLiteral clusters: the Version entry joins the major byte with the two nibbles of the next byte", () => {
    const versionOf = (version: readonly [number, number]): unknown =>
      parseIcc(iccBuild({ length: 128, version })).entries.find(
        (entry) => entry.name === "Version",
      )?.value;
    expect(versionOf([2, 0x13])).toBe("2.1.3");
    expect(versionOf([4, 0x30])).toBe("4.3.0");
    expect(versionOf([0, 0])).toBe("0.0.0");
    expect(versionOf([255, 0xff])).toBe("255.f.f");
  });

  it("parseIcc ArrayDeclaration, StringLiteral and EqualityOperator clusters: a payload shorter than the 128-byte header reports its size and one warning", () => {
    for (const length of [0, 1, 4, 127]) {
      const payload = iccBuild({ length });
      expect(parseIcc(payload).entries).toEqual([iccNamed("Size", length)]);
      iccWarnings(payload, 1);
    }
  });

  it("parseIcc EqualityOperator, ConditionalExpression and BlockStatement clusters: a header-only payload and one that cuts the tag-count field short are different failures", () => {
    // Exactly 128 bytes is a complete header with no tag-count field.
    const headerOnly = iccBuild({ length: 128 });
    expect(parseIcc(headerOnly).entries).toEqual(iccHeaderEntries(128));
    const [headerOnlyDetail] = iccWarnings(headerOnly, 1);
    // 129 through 131 bytes cut the four-byte tag count short: every length is one failure,
    // and it is not the header-only one.
    const cutDetails = new Set<string>();
    for (const length of [129, 130, 131]) {
      const payload = iccBuild({ length });
      expect(parseIcc(payload).entries).toEqual(iccHeaderEntries(length));
      cutDetails.add(iccWarnings(payload, 1)[0] ?? "");
    }
    expect(cutDetails.size).toBe(1);
    expect(cutDetails.has(headerOnlyDetail ?? "")).toBe(false);
    // Exactly 132 bytes hold a tag count of zero and nothing else.
    const countOnly = iccBuild({ length: 132 });
    expect(parseIcc(countOnly)).toEqual({
      entries: [...iccHeaderEntries(132), iccNamed("TagCount", 0)],
      warnings: [],
    });
  });

  it("parseIcc ConditionalExpression and BlockStatement clusters: a wrong signature and a wrong declared size are one warning each", () => {
    expect(iccWarnings(iccBuild({ length: 132 }), 0)).toEqual([]);
    iccWarnings(iccBuild({ length: 132, signature: "xxxx" }), 1);
    for (const declared of [0, 131, 133, 0xffffffff]) {
      const payload = iccBuild({ length: 132, declared });
      expect(parseIcc(payload).entries).toEqual([
        ...iccHeaderEntries(132, declared),
        iccNamed("TagCount", 0),
      ]);
      iccWarnings(payload, 1);
    }
    iccWarnings(iccBuild({ length: 132, signature: "xxxx", declared: 0 }), 2);
  });

  it("parseIcc EqualityOperator, LogicalOperator, ConditionalExpression and BlockStatement clusters: 4096 tags that all fit are read, 4097 that all fit are refused", () => {
    const records = (count: number): IccTagSpec[] =>
      Array.from({ length: count }, (_, index) => ({
        sig: index.toString(16).padStart(4, "0"),
        offset: 128,
        size: 0,
      }));
    const atCap = iccBuild({ length: 132 + 4096 * 12, tags: records(4096) });
    expect(iccWarnings(atCap, 0)).toEqual([]);
    expect(iccSignatures(atCap)).toEqual(records(4096).map((tag) => tag.sig));
    expect(iccEntryNames(atCap)).toContain("TagCount");

    const overCap = iccBuild({ length: 132 + 4097 * 12, tags: records(4097) });
    iccWarnings(overCap, 1);
    expect(iccEntryNames(overCap)).toContain("TagCount");
    expect(iccSignatures(overCap)).toBeUndefined();
  });

  it("parseIcc ArithmeticOperator, ConditionalExpression, LogicalOperator and BlockStatement clusters: a tag count the profile cannot hold is refused without reading past the end", () => {
    const tags = [
      { sig: "aaaa", offset: 128, size: 0 },
      { sig: "bbbb", offset: 128, size: 0 },
      { sig: "cccc", offset: 128, size: 0 },
    ];
    // Two whole records and eight bytes of a third: floor(32 / 12) = 2 records fit, three are declared.
    const short = iccBuild({ length: 164, tagCount: 3, tags });
    iccWarnings(short, 1);
    expect(iccEntryNames(short)).toContain("TagCount");
    expect(iccSignatures(short)).toBeUndefined();
    // The same three records, all present, are read.
    const exact = iccBuild({ length: 168, tags });
    expect(iccWarnings(exact, 0)).toEqual([]);
    expect(iccSignatures(exact)).toEqual(["aaaa", "bbbb", "cccc"]);
    // A count far above both the cap and the profile.
    iccWarnings(iccBuild({ length: 140, tagCount: 0xffffffff }), 1);
    // A count above what fits, but below the cap, with only a table of two records present.
    iccWarnings(iccBuild({ length: 156, tagCount: 5, tags }), 1);
  });

  it("parseIcc ArithmeticOperator, ConditionalExpression and CallExpression clusters: tag records are read at their own offsets and returned in order", () => {
    const payload = iccBuild({
      length: 400,
      tags: [
        { sig: "okAa", offset: 128, size: 0 },
        { sig: "low1", offset: 127, size: 0 },
        { sig: "low2", offset: 0, size: 4 },
        { sig: "okBb", offset: 390, size: 10 },
        { sig: "end1", offset: 391, size: 10 },
        { sig: "huge", offset: 200, size: 0xffffffff },
        { sig: "over", offset: 140, size: 300 },
      ],
    });
    // Offsets from 128 up to the end of the profile are inside; a tag one byte too far, below the
    // header, or sized past the end is outside.
    expect(iccSignatures(payload)).toEqual(["okAa", "okBb"]);
    iccWarnings(payload, 5);
    // A size of 0xffffffff on the first record is read from the record, not from the header.
    const first = iccBuild({
      length: 300,
      tags: [{ sig: "huge", offset: 200, size: 0xffffffff }],
    });
    iccWarnings(first, 1);
    expect(iccSignatures(first)).toBeUndefined();
    // A data range that ends exactly at the end of the profile is inside it.
    const edge = iccBuild({
      length: 300,
      tags: [{ sig: "edge", offset: 290, size: 10 }],
    });
    expect(iccWarnings(edge, 0)).toEqual([]);
    expect(iccSignatures(edge)).toEqual(["edge"]);
  });

  it("parseIcc ConditionalExpression and ArrayDeclaration clusters: a profile whose tags are all outside, or that has none, has no TagSignatures entry", () => {
    const none = iccBuild({ length: 132 });
    expect(iccEntryNames(none)).not.toContain("TagSignatures");
    const allOutside = iccBuild({
      length: 300,
      tags: [
        { sig: "out1", offset: 299, size: 10 },
        { sig: "out2", offset: 10, size: 1 },
      ],
    });
    iccWarnings(allOutside, 2);
    expect(iccEntryNames(allOutside)).toContain("TagCount");
    expect(iccEntryNames(allOutside)).not.toContain("TagSignatures");
    const one = iccBuild({
      length: 300,
      tags: [{ sig: "only", offset: 128, size: 1 }],
    });
    expect(iccSignatures(one)).toEqual(["only"]);
  });
});

// metadata/exif.ts createMinimalExif and readIfd0Resolution clusters (67-33, metadata-3). The
// IFD0 fixtures reuse `exTiff` (little- and big-endian); RATIONAL values are external.
const RI_X = { numerator: 72, denominator: 1 };
const RI_Y = { numerator: 96, denominator: 1 };

function riRational(
  tag: number,
  value: { readonly numerator: number; readonly denominator: number },
  big: boolean,
): ExEntry {
  return {
    tag,
    type: 5,
    count: 1,
    value: exU32([value.numerator, value.denominator], big),
  };
}

function riXY(big: boolean): ExEntry[] {
  return [riRational(0x011a, RI_X, big), riRational(0x011b, RI_Y, big)];
}

/** An X or Y entry whose value offset points at the first eight bytes of the TIFF header. */
function riHeaderValue(tag: number): ExEntry {
  return { tag, type: 5, count: 1, offset: 0 };
}

function riHeaderRational(
  tiff: Buffer,
  big: boolean,
): { readonly numerator: number; readonly denominator: number } {
  return big
    ? { numerator: tiff.readUInt32BE(0), denominator: tiff.readUInt32BE(4) }
    : { numerator: tiff.readUInt32LE(0), denominator: tiff.readUInt32LE(4) };
}

describe("metadata/exif.ts createMinimalExif and readIfd0Resolution clusters (67-33, metadata-3)", () => {
  it("createMinimalExif ConditionalExpression, LogicalOperator and EqualityOperator clusters: Orientation 0 and below, above 8 and non-integers are refused; 1 through 8 are written", () => {
    for (const bad of [0, -1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createMinimalExif({ orientation: bad })).toThrow(RangeError);
    }
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(
        parseExif(createMinimalExif({ orientation: value })).orientation,
      ).toEqual({ status: "valid", value });
    }
  });

  it("createMinimalExif BlockStatement, ConditionalExpression, LogicalOperator, EqualityOperator and CallExpression clusters: ResolutionUnit 0 through 65535 is written exactly, anything else is refused by createMinimalExif's own RangeError", () => {
    for (const unit of [0, 1, 2, 3, 0xfffe, 0xffff]) {
      const written = createMinimalExif({
        resolution: { x: RI_X, y: RI_Y, unit },
      });
      expect(readIfd0Resolution(written)).toStrictEqual({
        x: RI_X,
        y: RI_Y,
        unit,
      });
    }
    expect(
      readIfd0Resolution(
        createMinimalExif({ resolution: { x: RI_X, y: RI_Y } }),
      ),
    ).toStrictEqual({ x: RI_X, y: RI_Y });
    for (const bad of [
      -1,
      0x10000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      let thrown: unknown;
      try {
        createMinimalExif({ resolution: { x: RI_X, y: RI_Y, unit: bad } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      // Buffer's own range error carries code ERR_OUT_OF_RANGE; the validation error has none.
      expect((thrown as { code?: unknown }).code).toBeUndefined();
    }
  });

  it("createMinimalExif: the IFD0 entries are written in ascending tag order and read back through both readers", () => {
    const written = createMinimalExif({
      orientation: 6,
      resolution: { x: RI_X, y: RI_Y, unit: 2 },
    });
    expect(written.toString("ascii", 0, 2)).toBe("II");
    expect(written.readUInt16LE(8)).toBe(4);
    expect(
      [0, 1, 2, 3].map((index) => written.readUInt16LE(10 + index * 12)),
    ).toEqual([0x0112, 0x011a, 0x011b, 0x0128]);
    expect(parseExif(written).orientation).toEqual({
      status: "valid",
      value: 6,
    });
    expect(readIfd0Resolution(written)).toStrictEqual({
      x: RI_X,
      y: RI_Y,
      unit: 2,
    });
  });

  it("readIfd0Resolution ConditionalExpression and EqualityOperator clusters: a byte order other than II or MM, a marker other than 42 and a payload shorter than the header give undefined", () => {
    for (const big of [false, true]) {
      const good = exTiff([...riXY(big), exShort(0x0128, 2, big)], big);
      expect(readIfd0Resolution(good)).toStrictEqual({
        x: RI_X,
        y: RI_Y,
        unit: 2,
      });
      // "XX" is read as big-endian when the check is gone, and the big-endian fixture parses.
      const badOrder = Buffer.from(good);
      badOrder.write("XX", 0, "ascii");
      expect(readIfd0Resolution(badOrder)).toBeUndefined();
      const lowerCase = Buffer.from(good);
      lowerCase.write(big ? "mm" : "ii", 0, "ascii");
      expect(readIfd0Resolution(lowerCase)).toBeUndefined();
      for (const marker of [0, 41, 43, 0x2a00]) {
        const badMarker = Buffer.from(good);
        if (big) badMarker.writeUInt16BE(marker, 2);
        else badMarker.writeUInt16LE(marker, 2);
        expect(readIfd0Resolution(badMarker)).toBeUndefined();
      }
      for (let length = 0; length <= 8; length += 1) {
        expect(readIfd0Resolution(good.subarray(0, length))).toBeUndefined();
      }
      // An IFD0 offset at or past the end of the payload leaves nothing to read.
      for (const offset of [good.length - 1, good.length, 0xffffffff]) {
        const badOffset = Buffer.from(good);
        if (big) badOffset.writeUInt32BE(offset, 4);
        else badOffset.writeUInt32LE(offset, 4);
        expect(readIfd0Resolution(badOffset)).toBeUndefined();
      }
    }
  });

  it("readIfd0Resolution EqualityOperator, ConditionalExpression, LogicalOperator and ArithmeticOperator clusters: 4096 entries that fit are read, 4097 are refused, and an IFD cut one byte short is refused", () => {
    for (const big of [false, true]) {
      const entriesOf = (count: number): ExEntry[] => [
        riHeaderValue(0x011a),
        riHeaderValue(0x011b),
        ...Array.from({ length: count - 2 }, () => exMarker(0xf700, 1)),
      ];
      const atCap = exTiff(entriesOf(4096), big);
      const value = riHeaderRational(atCap, big);
      expect(readIfd0Resolution(atCap)).toStrictEqual({ x: value, y: value });
      expect(readIfd0Resolution(exTiff(entriesOf(4097), big))).toBeUndefined();

      // Entries only, no next-IFD field and no values behind them: the last entry ends the payload.
      const three = exTiff(entriesOf(3), big);
      const entriesEnd = 10 + 3 * 12;
      const exact = three.subarray(0, entriesEnd);
      const tripleValue = riHeaderRational(exact, big);
      expect(readIfd0Resolution(exact)).toStrictEqual({
        x: tripleValue,
        y: tripleValue,
      });
      expect(
        readIfd0Resolution(three.subarray(0, entriesEnd - 1)),
      ).toBeUndefined();
      expect(
        readIfd0Resolution(three.subarray(0, entriesEnd - 12)),
      ).toBeUndefined();
    }
  });

  it("readIfd0Resolution EqualityOperator cluster: only the declared entries are read, never the bytes that follow them", () => {
    for (const big of [false, true]) {
      const w16 = (buffer: Buffer, at: number, value: number): void => {
        if (big) buffer.writeUInt16BE(value, at);
        else buffer.writeUInt16LE(value, at);
      };
      const w32 = (buffer: Buffer, at: number, value: number): void => {
        if (big) buffer.writeUInt32BE(value, at);
        else buffer.writeUInt32LE(value, at);
      };
      // One declared entry (X). The next-IFD field and the bytes after it form a complete Y entry.
      const base = exTiff([riHeaderValue(0x011a)], big);
      const phantom = Buffer.concat([base, Buffer.alloc(8)]);
      const at = 10 + 12;
      w16(phantom, at, 0x011b);
      w16(phantom, at + 2, 5);
      w32(phantom, at + 4, 1);
      w32(phantom, at + 8, 0);
      expect(readIfd0Resolution(phantom)).toBeUndefined();
      // Declaring that second entry makes the same bytes a resolution.
      const declared = exTiff(
        [riHeaderValue(0x011a), riHeaderValue(0x011b)],
        big,
      );
      const value = riHeaderRational(declared, big);
      expect(readIfd0Resolution(declared)).toStrictEqual({
        x: value,
        y: value,
      });
    }
  });

  it("readIfd0Resolution ConditionalExpression and LogicalOperator clusters: entries with other tags never overwrite X or Y", () => {
    for (const big of [false, true]) {
      const tiff = exTiff(
        [
          ...riXY(big),
          riRational(0x829a, { numerator: 1, denominator: 250 }, big),
          exShort(0x0112, 6, big),
        ],
        big,
      );
      expect(readIfd0Resolution(tiff)).toStrictEqual({ x: RI_X, y: RI_Y });
    }
  });

  it("readIfd0Resolution ConditionalExpression and LogicalOperator clusters: a ResolutionUnit that is not one SHORT is ignored", () => {
    for (const big of [false, true]) {
      const withUnit = (unit: ExEntry): Buffer =>
        exTiff([...riXY(big), unit], big);
      expect(
        readIfd0Resolution(withUnit(exShort(0x0128, 2, big))),
      ).toStrictEqual({
        x: RI_X,
        y: RI_Y,
        unit: 2,
      });
      // A LONG with count 1 and a SHORT with count 2 are not a ResolutionUnit.
      const long: ExEntry = {
        tag: 0x0128,
        type: 4,
        count: 1,
        value: exU32([2], big),
      };
      const pair: ExEntry = {
        tag: 0x0128,
        type: 3,
        count: 2,
        value: exU16([2, 3], big),
      };
      expect(readIfd0Resolution(withUnit(long))).toStrictEqual({
        x: RI_X,
        y: RI_Y,
      });
      expect(readIfd0Resolution(withUnit(pair))).toStrictEqual({
        x: RI_X,
        y: RI_Y,
      });
    }
  });

  it("readIfd0Resolution ConditionalExpression and LogicalOperator clusters: an X or Y that is not one RATIONAL is ignored, leaving the resolution incomplete", () => {
    for (const big of [false, true]) {
      for (const [tag, otherTag, other] of [
        [0x011a, 0x011b, RI_Y],
        [0x011b, 0x011a, RI_X],
      ] as const) {
        const long: ExEntry = { tag, type: 4, count: 1, offset: 0 };
        const pair: ExEntry = { tag, type: 5, count: 2, offset: 0 };
        for (const bad of [long, pair]) {
          expect(
            readIfd0Resolution(
              exTiff([bad, riRational(otherTag, other, big)], big),
            ),
          ).toBeUndefined();
        }
      }
    }
  });

  it("readIfd0Resolution ConditionalExpression cluster: a value offset outside the payload skips that entry and a later valid one is still read", () => {
    for (const big of [false, true]) {
      const w32 = (buffer: Buffer, at: number, value: number): void => {
        if (big) buffer.writeUInt32BE(value, at);
        else buffer.writeUInt32LE(value, at);
      };
      const tiff = exTiff(
        [
          { tag: 0x011a, type: 5, count: 1, offset: 0xfffffff0 },
          riHeaderValue(0x011a),
          riRational(0x011a, RI_X, big),
          riRational(0x011b, RI_Y, big),
        ],
        big,
      );
      // The second entry's value starts four bytes before the end: eight bytes do not fit.
      w32(tiff, 10 + 12 + 8, tiff.length - 4);
      expect(readIfd0Resolution(tiff)).toStrictEqual({ x: RI_X, y: RI_Y });
    }
  });
});

// metadata/icc_admission.ts validateIccForPreservation, validDate, bcd and profileIdMatches clusters
// (67-34, metadata-4). Every refusal is asserted by its typed `reason`; a refusal's `detail` is only
// checked to be a non-empty string (the diagnostic is present), never for its wording. The profiles
// come from the shared iccProfileV4 fixture (header, one `rTRC` tag at 144 of size 8, 152 bytes) and
// change one field at a time, so a refusal can only come from that field.
function iccAdmissionVerdict(profile: Buffer): {
  readonly ok: boolean;
  readonly reason?: "invalid" | "unsupported" | "policy-limit";
  readonly detail?: string;
} {
  return validateIccForPreservation(profile);
}

function expectIccRefusal(
  profile: Buffer,
  reason: "invalid" | "unsupported" | "policy-limit",
): void {
  const verdict = iccAdmissionVerdict(profile);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe(reason);
  expect(typeof verdict.detail).toBe("string");
  expect((verdict.detail ?? "").length).toBeGreaterThan(0);
}

function expectIccAdmitted(profile: Buffer): void {
  expect(iccAdmissionVerdict(profile)).toStrictEqual({ ok: true });
}

function iccWithDate(
  fields: readonly [number, number, number, number, number, number],
): Buffer {
  const profile = iccProfileV4();
  for (const [index, value] of fields.entries())
    profile.writeUInt16BE(value, 24 + index * 2);
  return profile;
}

/** The ICC Profile ID: MD5 of the profile with flags, rendering intent and the ID itself zeroed. */
function iccWithProfileId(profile: Buffer): Buffer {
  const digestInput = Buffer.from(profile);
  digestInput.fill(0, 44, 48);
  digestInput.fill(0, 64, 68);
  digestInput.fill(0, 84, 100);
  const result = Buffer.from(profile);
  createHash("md5").update(digestInput).digest().copy(result, 84);
  return result;
}

describe("metadata/icc_admission.ts validateIccForPreservation clusters (67-34, metadata-4)", () => {
  it("validDate clusters: each date field is refused outside its range and admitted at its edges", () => {
    // Edges that are valid: the first and last month, hour, minute, second and day.
    expectIccAdmitted(iccWithDate([2024, 1, 1, 0, 0, 0]));
    expectIccAdmitted(iccWithDate([2024, 12, 31, 23, 59, 59]));
    expectIccAdmitted(iccWithDate([2024, 6, 15, 12, 34, 56]));
    // One field out of range at a time, the others valid.
    const refused: readonly (readonly [
      string,
      [number, number, number, number, number, number],
    ])[] = [
      ["year zero", [0, 6, 15, 12, 34, 56]],
      ["month zero", [2024, 0, 15, 12, 34, 56]],
      ["month thirteen", [2024, 13, 15, 12, 34, 56]],
      ["hour twenty-four", [2024, 6, 15, 24, 34, 56]],
      ["minute sixty", [2024, 6, 15, 12, 60, 56]],
      ["second sixty", [2024, 6, 15, 12, 34, 60]],
      ["day zero", [2024, 6, 0, 12, 34, 56]],
      ["day past the month", [2024, 6, 31, 12, 34, 56]],
    ];
    for (const [, fields] of refused)
      expectIccRefusal(iccWithDate(fields), "invalid");
  });

  it("bcd clusters: a packed version byte whose high nibble is 9 is decimal and reaches the minor-version policy", () => {
    // 0x90 and 0x99 are valid BCD (minor 9): they are refused as an unsupported minor version,
    // not as malformed BCD. 0xa0 and 0x0a are not decimal.
    for (const version of [0x90, 0x99]) {
      const profile = iccProfileV4();
      profile[9] = version;
      expectIccRefusal(profile, "unsupported");
    }
    for (const version of [0xa0, 0x0a]) {
      const profile = iccProfileV4();
      profile[9] = version;
      expectIccRefusal(profile, "invalid");
    }
  });

  it("profileIdMatches CallExpression cluster: the Profile ID is computed with flags and rendering intent zeroed", () => {
    const profile = iccProfileV4();
    profile.writeUInt32BE(0x0000_0001, 44);
    profile.writeUInt32BE(1, 64);
    const withId = iccWithProfileId(profile);
    expect(withId.readUInt32BE(44)).toBe(1);
    expect(withId.readUInt32BE(64)).toBe(1);
    expect(withId.subarray(84, 100).equals(Buffer.alloc(16))).toBe(false);
    expectIccAdmitted(withId);
    const flipped = Buffer.from(withId);
    flipped[84] = (flipped[84] ?? 0) ^ 1;
    expectIccRefusal(flipped, "invalid");
  });

  it("validateIccForPreservation size clusters: the policy limit, the header length and four-byte alignment", () => {
    const limit = (extra: number): Buffer =>
      iccProfileV4({}, [
        { signature: "rTRC", size: MAX_PROFILE_BYTES + extra - 144 },
      ]);
    // Exactly the limit is admitted; the next four-byte step is a policy-limit refusal.
    const atLimit = limit(0);
    expect(atLimit.length).toBe(MAX_PROFILE_BYTES);
    expectIccAdmitted(atLimit);
    const overLimit = limit(4);
    expect(overLimit.length).toBe(MAX_PROFILE_BYTES + 4);
    expectIccRefusal(overLimit, "policy-limit");
    // A 128-byte header with no tag count is truncated (a typed refusal, not a read past the end).
    const headerOnly = iccProfileV4().subarray(0, 128);
    headerOnly.writeUInt32BE(128, 0);
    expectIccRefusal(Buffer.from(headerOnly), "invalid");
    // A 132-byte profile (header and tag count, no tags) is not truncated: it reaches the version
    // policy before the missing tags.
    const noTags = iccProfileV4({}, []);
    expect(noTags.length).toBe(132);
    noTags[9] = 0x50;
    expectIccRefusal(noTags, "unsupported");
    // An unaligned length is refused as invalid before the version policy would refuse it.
    const unaligned = Buffer.concat([iccProfileV4(), Buffer.alloc(1)]);
    unaligned.writeUInt32BE(unaligned.length, 0);
    unaligned[9] = 0x50;
    expectIccRefusal(unaligned, "invalid");
    // The same profile, aligned, is refused by the version policy.
    const aligned = iccProfileV4();
    aligned[9] = 0x50;
    expectIccRefusal(aligned, "unsupported");
  });

  it("validateIccForPreservation header clusters: rendering intent 3 and a v2 profile without a D50 illuminant are admitted, a v4 illuminant word is checked", () => {
    const intent = iccProfileV4();
    intent.writeUInt32BE(3, 64);
    expectIccAdmitted(intent);
    // Only a v4 profile carries the D50 illuminant requirement.
    const v2 = iccProfileV2();
    v2.fill(0, 68, 80);
    expectIccAdmitted(v2);
    for (const offset of [68, 72, 76]) {
      const v4 = iccProfileV4();
      v4.writeUInt32BE((v4.readUInt32BE(offset) + 1) >>> 0, offset);
      expectIccRefusal(v4, "invalid");
    }
  });

  it("validateIccForPreservation tag table clusters: no tags, a tag count the profile cannot hold and a tag range that ends past the profile are typed refusals", () => {
    expectIccRefusal(iccProfileV4({}, []), "invalid");
    // A tag count of 1 in a profile of 132 bytes: the table does not fit, and nothing is read from it.
    const noRoom = iccProfileV4({}, []);
    noRoom.writeUInt32BE(1, 128);
    expectIccRefusal(noRoom, "invalid");
    // A table cut four bytes short of its only record: a typed refusal, not a read past the end.
    const cutTable = Buffer.concat([iccProfileV4({}, []), Buffer.alloc(4)]);
    cutTable.writeUInt32BE(cutTable.length, 0);
    cutTable.writeUInt32BE(1, 128);
    expectIccRefusal(cutTable, "invalid");
    // A table that fits but leaves no room for one 8-byte tag payload is refused the same way.
    const noPayloadRoom = Buffer.concat([
      iccProfileV4({}, []),
      Buffer.alloc(16),
    ]);
    noPayloadRoom.writeUInt32BE(noPayloadRoom.length, 0);
    noPayloadRoom.writeUInt32BE(1, 128);
    noPayloadRoom.write("rTRC", 132, 4, "ascii");
    noPayloadRoom.writeUInt32BE(144, 136);
    noPayloadRoom.writeUInt32BE(8, 140);
    expectIccRefusal(noPayloadRoom, "invalid");
    // A tag whose 8 bytes start 4 bytes before the end: refused, and the type word at offset + 4
    // is never read past the end of the profile.
    const pastEnd = iccProfileV4();
    pastEnd.writeUInt32BE(pastEnd.length - 4, 136);
    expectIccRefusal(pastEnd, "invalid");
    // Tag offsets that are below the table, unaligned or beyond the profile stay typed refusals.
    const belowTable = iccProfileV4();
    belowTable.writeUInt32BE(140, 136);
    expectIccRefusal(belowTable, "invalid");
    const unalignedOffset = iccProfileV4();
    unalignedOffset.writeUInt32BE(146, 136);
    expectIccRefusal(unalignedOffset, "invalid");
    const beyond = iccProfileV4();
    beyond.writeUInt32BE(beyond.length + 4, 136);
    expectIccRefusal(beyond, "invalid");
    const atEnd = iccProfileV4();
    atEnd.writeUInt32BE(atEnd.length, 136);
    expectIccRefusal(atEnd, "invalid");
    // Two tags that share one range are admitted.
    expectIccAdmitted(
      iccProfileV4({}, [
        { signature: "rTRC", offset: 156 },
        { signature: "gTRC", offset: 156 },
      ]),
    );
  });

  it("validateIccForPreservation StringLiteral cluster: every refusal path carries its typed reason and a non-empty detail", () => {
    const withExtra = (
      extra: Buffer,
      mutate?: (profile: Buffer) => void,
    ): Buffer => {
      const profile = Buffer.concat([iccProfileV4(), extra]);
      profile.writeUInt32BE(profile.length, 0);
      mutate?.(profile);
      return profile;
    };
    const mutated = (
      build: () => Buffer,
      mutate: (profile: Buffer) => void,
    ): Buffer => {
      const profile = build();
      mutate(profile);
      return profile;
    };
    const cases: readonly (readonly [
      string,
      () => Buffer,
      "invalid" | "unsupported" | "policy-limit",
    ])[] = [
      [
        "over the policy size limit",
        () =>
          iccProfileV4({}, [
            { signature: "rTRC", size: MAX_PROFILE_BYTES + 4 - 144 },
          ]),
        "policy-limit",
      ],
      [
        "header truncated",
        () => Buffer.from(iccProfileV4().subarray(0, 131)),
        "invalid",
      ],
      [
        "length not four-byte aligned",
        () => withExtra(Buffer.alloc(1)),
        "invalid",
      ],
      [
        "declared size mismatch",
        () => mutated(iccProfileV4, (p) => p.writeUInt32BE(p.length + 4, 0)),
        "invalid",
      ],
      [
        "signature not acsp",
        () => mutated(iccProfileV4, (p) => p.write("nope", 36, 4, "ascii")),
        "invalid",
      ],
      [
        "non-decimal BCD",
        () =>
          mutated(iccProfileV4, (p) => {
            p[9] = 0xa0;
          }),
        "invalid",
      ],
      [
        "major version not admitted",
        () =>
          mutated(iccProfileV4, (p) => {
            p[8] = 5;
          }),
        "unsupported",
      ],
      [
        "minor version not admitted",
        () =>
          mutated(iccProfileV4, (p) => {
            p[9] = 0x50;
          }),
        "unsupported",
      ],
      [
        "version-reserved bytes nonzero",
        () =>
          mutated(iccProfileV4, (p) => {
            p[10] = 1;
          }),
        "invalid",
      ],
      [
        "creation date invalid",
        () => iccWithDate([2024, 13, 15, 12, 34, 56]),
        "invalid",
      ],
      [
        "rendering intent invalid",
        () => mutated(iccProfileV4, (p) => p.writeUInt32BE(4, 64)),
        "invalid",
      ],
      [
        "device class not admitted",
        () => mutated(iccProfileV4, (p) => p.write("prtr", 12, 4, "ascii")),
        "unsupported",
      ],
      [
        "color space not admitted",
        () => mutated(iccProfileV4, (p) => p.write("CMYK", 16, 4, "ascii")),
        "unsupported",
      ],
      [
        "v2 reserved bytes nonzero",
        () =>
          mutated(iccProfileV2, (p) => {
            p[84] = 1;
          }),
        "invalid",
      ],
      [
        "v4 required header field invalid",
        () =>
          mutated(iccProfileV4, (p) => {
            p[68] = 1;
          }),
        "invalid",
      ],
      ["no tag records", () => iccProfileV4({}, []), "invalid"],
      [
        "tag count over the policy limit",
        () => mutated(iccProfileV4, (p) => p.writeUInt32BE(4_097, 128)),
        "policy-limit",
      ],
      [
        "tag table truncated",
        () => mutated(iccProfileV4, (p) => p.writeUInt32BE(2, 128)),
        "invalid",
      ],
      [
        "zero tag signature",
        () => iccProfileV4({}, [{ signature: "\0\0\0\0" }]),
        "invalid",
      ],
      [
        "tag range invalid",
        () => iccProfileV4({}, [{ signature: "rTRC", offset: 145 }]),
        "invalid",
      ],
      [
        "tag type reserved bytes nonzero",
        () => iccProfileV4({}, [{ signature: "rTRC", reserved: 1 }]),
        "invalid",
      ],
      [
        "tag payloads not canonical",
        () => iccProfileV4({}, [{ signature: "rTRC", offset: 148 }]),
        "invalid",
      ],
      [
        "tag padding nonzero",
        () =>
          mutated(
            () => iccProfileV4({}, [{ signature: "rTRC", size: 9 }]),
            (p) => {
              p[153] = 1;
            },
          ),
        "invalid",
      ],
      ["tag trailer bytes", () => withExtra(Buffer.alloc(4)), "invalid"],
    ];
    expect(cases).toHaveLength(24);
    for (const [, build, reason] of cases) expectIccRefusal(build(), reason);
  });
});

describe("metadata/xmp.ts parseXmp and xmpOrientation clusters (67-35, metadata-5)", () => {
  const XMP_RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const xmpDoc = (inner: string, attributes = ""): Buffer =>
    Buffer.from(
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${XMP_RDF_NS}"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"${attributes}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`,
      "utf8",
    );
  const titleDoc = (value: string): Buffer =>
    xmpDoc(`<dc:title>${value}</dc:title>`);
  const bare = (xml: string): Buffer => Buffer.from(xml, "utf8");
  const titleOf = (payload: Buffer): unknown =>
    parseXmp(payload).entries.find((entry) => entry.name === "dc:title")?.value;
  const orientationDoc = (value: string): Buffer =>
    xmpDoc("", ` tiff:Orientation="${value}"`);
  // A refused packet has no entries and exactly one typed warning; only that the detail is
  // non-empty is asserted, never its wording.
  const expectXmpRefused = (payload: Buffer, label: string): void => {
    const result = parseXmp(payload);
    expect(result.entries, label).toEqual([]);
    expect(result.warnings, label).toHaveLength(1);
    expect(result.warnings[0]?.code, label).toBe("metadata-invalid");
    expect(result.warnings[0]?.detail.length, label).toBeGreaterThan(0);
  };

  it("isOrientationValue clusters: xmpOrientation admits exactly the integers 1 through 8", () => {
    for (const refused of ["0", "-1", "NaN", "9"])
      expect(xmpOrientation(orientationDoc(refused)), refused).toBe("invalid");
    for (const admitted of [1, 2, 7, 8])
      expect(
        xmpOrientation(orientationDoc(String(admitted))),
        String(admitted),
      ).toBe(admitted);
  });

  it("isValidCodePoint and decodeXml clusters: numeric entities decode in both radixes across the valid range", () => {
    const decoded: readonly (readonly [string, string])[] = [
      ["&#65;", "A"],
      ["&#x41;", "A"],
      ["&#X41;", "A"],
      ["&#0;", "\u0000"],
      ["&#x0;", "\u0000"],
      ["&#xD7FF;", "퟿"],
      ["&#55295;", "퟿"],
      ["&#xE000;", ""],
      ["&#57344;", ""],
      ["&#x10FFFF;", "\u{10FFFF}"],
      ["&#1114111;", "\u{10FFFF}"],
    ];
    for (const [entity, text] of decoded)
      expect(titleOf(titleDoc(entity)), entity).toBe(text);
  });

  it("isValidCodePoint and decodeXml clusters: surrogate and above-range numeric entities refuse the packet", () => {
    for (const entity of [
      "&#xD800;",
      "&#xDBFF;",
      "&#xDFFF;",
      "&#55296;",
      "&#57343;",
      "&#x110000;",
      "&#1114112;",
    ])
      expectXmpRefused(titleDoc(entity), entity);
  });

  it("decodeXml clusters: the five predefined entities decode once and in order", () => {
    expect(titleOf(titleDoc("&quot;q&quot;"))).toBe('"q"');
    expect(titleOf(titleDoc("&apos;a&apos;"))).toBe("'a'");
    expect(titleOf(titleDoc("&lt;b&gt;"))).toBe("<b>");
    expect(titleOf(titleDoc("a &amp; b"))).toBe("a & b");
    // The ampersand is decoded last, so an escaped entity is not decoded twice.
    expect(titleOf(titleDoc("&amp;lt;"))).toBe("&lt;");
    expect(titleOf(titleDoc("&amp;quot;"))).toBe("&quot;");
    expect(titleOf(titleDoc("&amp;#65;"))).toBe("&#65;");
  });

  it("validateEntities clusters: a malformed or unsupported entity refuses the packet", () => {
    for (const text of ["a &foo; b", "a & b", "&#;", "&#x;", "&#xZZ;", "&#6a;"])
      expectXmpRefused(titleDoc(text), text);
  });

  it("validateEntities clusters: ampersands inside CDATA, comments and processing instructions are not entity text", () => {
    expect(titleOf(xmpDoc("<dc:title><![CDATA[a & b]]></dc:title>"))).toBe(
      "a & b",
    );
    expect(titleOf(xmpDoc("<!-- a & b --><dc:title>t</dc:title>"))).toBe("t");
    expect(titleOf(xmpDoc("<? a & b ?><dc:title>t</dc:title>"))).toBe("t");
    expect(titleOf(xmpDoc("<dc:title>t</dc:title><![CDATA[a & b & c]]>"))).toBe(
      "t",
    );
  });

  it("validateEntities clusters: an entity interrupted by a comment, CDATA section or processing instruction is rejoined", () => {
    expect(titleOf(titleDoc("&<!---->amp;"))).toBe("&");
    expect(titleOf(titleDoc("&<![CDATA[]]>amp;"))).toBe("&");
    expect(titleOf(titleDoc("&<?x?>amp;"))).toBe("&");
  });

  it("validateEntities clusters: valid entities of any length are not malformed text", () => {
    expect(titleOf(titleDoc("&#65;&#x41;&#x1F600;&#128512;&amp;"))).toBe(
      "AA\u{1F600}\u{1F600}&",
    );
  });

  it("validateXmlStructure clusters: a DOCTYPE or ENTITY declaration anywhere refuses the packet", () => {
    for (const inner of [
      "<!DOCTYPE a><dc:title>t</dc:title>",
      "<!-- <!DOCTYPE a> --><dc:title>t</dc:title>",
      '<dc:title><![CDATA[<!ENTITY a "b">]]></dc:title>',
      "<dc:title>t</dc:title><?pi <!doctype a> ?>",
    ])
      expectXmpRefused(xmpDoc(inner), inner);
  });

  it("validateXmlStructure Regex cluster: comments, processing instructions and CDATA sections may contain greater-than and less-than signs", () => {
    for (const inner of [
      "<!-- a > <b --><dc:title>t</dc:title>",
      "<!--a><b--><dc:title>t</dc:title>",
      "<? a > <b ?><dc:title>t</dc:title>",
      "<?a><b?><dc:title>t</dc:title>",
      "<![CDATA[ a > <b ]]><dc:title>t</dc:title>",
      "<![CDATA[a><b]]><dc:title>t</dc:title>",
      "<!----><?x?><![CDATA[]]><dc:title>t</dc:title>",
    ])
      expect(titleOf(xmpDoc(inner)), inner).toBe("t");
  });

  it("validateXmlStructure MethodExpression cluster: comment and CDATA tokens are skipped, not read as tags", () => {
    expect(titleOf(xmpDoc("<!-- c --><dc:title>t</dc:title>"))).toBe("t");
    expect(titleOf(xmpDoc("<dc:title>t</dc:title><![CDATA[x]]>"))).toBe("t");
    expect(titleOf(xmpDoc("<dc:title><![CDATA[x]]></dc:title>"))).toBe("x");
  });

  it("validateXmlStructure clusters: mismatched close tags refuse the packet", () => {
    for (const inner of [
      "<dc:title>t</dc:title></y:z>",
      "<a><b></a></b>",
      "<a></b>",
    ])
      expectXmpRefused(
        bare(`<x:xmpmeta xmlns:x="a">${inner}</x:xmpmeta>`),
        inner,
      );
  });

  it("validateXmlStructure clusters: malformed tags refuse the packet", () => {
    for (const tag of ["< 1>", "<1a>", "< 1 <a></a>", "<>", "< >"])
      expectXmpRefused(
        bare(`<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title>${tag}</x:xmpmeta>`),
        tag,
      );
  });

  it("validateXmlStructure clusters: unclosed tags and trailing markup refuse the packet", () => {
    for (const text of [
      '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title>',
      '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title></x:xmpmeta><',
      '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title></x:xmpmeta><oops',
      '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title></x:xmpmeta>trailing < text',
    ])
      expectXmpRefused(bare(text), text);
  });

  it("validateXmlStructure Regex cluster: close tags tolerate whitespace and a token that only contains a later tag is not that tag", () => {
    expect(
      titleOf(
        bare('<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title ></x:xmpmeta >'),
      ),
    ).toBe("t");
    expect(
      titleOf(
        bare('<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title\n></x:xmpmeta>'),
      ),
    ).toBe("t");
    // `<x </a>` is one token that opens `x`; it does not close `a`.
    expectXmpRefused(
      bare(
        '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title><a><x </a></x:xmpmeta>',
      ),
      "open token that contains a close tag",
    );
    // `< 1 <a>` starts with a non-name, so the later `<a>` does not rescue it.
    expectXmpRefused(
      bare(
        '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title>< 1 <a></a></x:xmpmeta>',
      ),
      "malformed token that contains an open tag",
    );
  });

  it("validateXmlStructure Regex cluster: self-closing tags do not open an element", () => {
    expect(
      titleOf(
        bare(
          '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title><br/><br /><br\n/></x:xmpmeta>',
        ),
      ),
    ).toBe("t");
    expect(
      titleOf(
        bare(
          '<x:xmpmeta xmlns:x="a"><dc:title>t</dc:title><a b="/"></a></x:xmpmeta>',
        ),
      ),
    ).toBe("t");
  });
});

describe("metadata/xmp.ts parseXmp, add and xmpOrientation clusters (67-36, metadata-6)", () => {
  const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const packet = (inner: string, attributes = ""): Buffer =>
    Buffer.from(
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"${attributes}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`,
      "utf8",
    );
  const entriesOf = (payload: Buffer): readonly [string, unknown][] =>
    parseXmp(payload).entries.map((entry) => [entry.name, entry.value]);
  const orientationOf = (inner: string, attributes = ""): unknown =>
    xmpOrientation(packet(inner, attributes));

  it("parseXmp BooleanLiteral, ObjectLiteral and StringLiteral clusters: bytes that are not UTF-8 refuse the whole packet", () => {
    const good = packet("<dc:title>title</dc:title>");
    expect(entriesOf(good)).toEqual([["dc:title", "title"]]);
    expect(entriesOf(packet("<dc:title>é€😀</dc:title>"))).toEqual([
      ["dc:title", "é€😀"],
    ]);
    const at = good.indexOf("</dc:title>");
    const invalid: readonly (readonly number[])[] = [
      [0xff],
      [0xc3, 0x28],
      [0xe2, 0x82],
      [0xc0, 0xaf],
    ];
    for (const bytes of invalid) {
      const payload = Buffer.concat([
        good.subarray(0, at),
        Buffer.from(bytes),
        good.subarray(at),
      ]);
      const result = parseXmp(payload);
      const label = bytes.map((byte) => byte.toString(16)).join(" ");
      expect(result.entries, label).toEqual([]);
      expect(result.warnings, label).toHaveLength(1);
      expect(result.warnings[0]?.code, label).toBe("metadata-invalid");
      expect(result.warnings[0]?.detail.length, label).toBeGreaterThan(0);
      expect(xmpOrientation(payload), label).toBeUndefined();
    }
  });

  it("parseXmp Regex cluster: attributes may put any whitespace before and after the equals sign", () => {
    expect(
      entriesOf(
        packet("", ' dc:title ="a" dc:creator\t=\t\'b\' dc:rights\n=\n"c"'),
      ),
    ).toEqual([
      ["dc:title", "a"],
      ["dc:creator", "b"],
      ["dc:rights", "c"],
    ]);
    expect(orientationOf("", ' tiff:Orientation = "6"')).toBe(6);
  });

  it("parseXmp Regex cluster: open tags may carry attributes and close tags may carry whitespace", () => {
    expect(
      entriesOf(packet('<dc:title xml:lang="x-default">T</dc:title >')),
    ).toEqual([["dc:title", "T"]]);
    expect(entriesOf(packet("<dc:title>U</dc:title\n>"))).toEqual([
      ["dc:title", "U"],
    ]);
  });

  it("parseXmp Regex and add CallExpression clusters: list items tolerate close-tag whitespace and repeated names collect every value", () => {
    expect(
      entriesOf(
        packet(
          "<dc:subject><rdf:Bag><rdf:li>a</rdf:li ><rdf:li>b</rdf:li\n><rdf:li>a</rdf:li></rdf:Bag></dc:subject>",
        ),
      ),
    ).toEqual([["dc:subject", ["a", "b", "a"]]]);
    expect(
      entriesOf(
        packet(
          "<dc:subject><rdf:Bag><rdf:li>only</rdf:li></rdf:Bag></dc:subject>",
        ),
      ),
    ).toEqual([["dc:subject", "only"]]);
  });

  it("add Regex, StringLiteral and MethodExpression clusters: markup inside a value is stripped and the text is trimmed", () => {
    expect(
      entriesOf(
        packet(
          "<dc:description><rdf:Alt><rdf:li> a<em>b</em>c<i>d</i> </rdf:li></rdf:Alt></dc:description>",
        ),
      ),
    ).toEqual([["dc:description", "abcd"]]);
    expect(entriesOf(packet("<dc:title>  spaced \n</dc:title>"))).toEqual([
      ["dc:title", "spaced"],
    ]);
    expect(entriesOf(packet("<dc:title>   </dc:title>"))).toEqual([]);
    expect(
      entriesOf(
        packet("<dc:title><rdf:Alt><rdf:li> </rdf:li></rdf:Alt></dc:title>"),
      ),
    ).toEqual([]);
  });

  it("parseXmp Regex and ConditionalExpression clusters: an element that holds another element yields no value of its own", () => {
    expect(
      entriesOf(packet("<dc:title><dc:sub>x</dc:sub></dc:title>")),
    ).toEqual([]);
    expect(
      entriesOf(packet("<dc:title>t<dc:sub>x</dc:sub></dc:title>")),
    ).toEqual([]);
  });

  it("parseXmp Regex, StringLiteral and add clusters: CDATA text that looks like markup is kept as text, and a comment that wraps a CDATA marker is not markup", () => {
    expect(entriesOf(packet("<dc:title>t<![CDATA[ <b ]]></dc:title>"))).toEqual(
      [["dc:title", "t <b"]],
    );
    expect(
      entriesOf(packet("<dc:title><![CDATA[ <b c ]]>z</dc:title>")),
    ).toEqual([["dc:title", "<b c z"]]);
    expect(
      entriesOf(packet("<dc:title>T<!--<<![CDATA[x]]>1--></dc:title>")),
    ).toEqual([["dc:title", "T"]]);
  });

  it("parseXmp Regex, ConditionalExpression and BlockStatement clusters: a packet without an RDF root keeps its entries and reports one typed warning", () => {
    expect(parseXmp(packet("<dc:title>t</dc:title>")).warnings).toEqual([]);
    for (const root of ["x:xmpmeta", "rdf:RDF", "rdf:Description"])
      expect(
        parseXmp(
          Buffer.from(`<${root}><dc:title>t</dc:title></${root}>`, "utf8"),
        ).warnings,
        root,
      ).toEqual([]);
    const result = parseXmp(Buffer.from("<dc:title>t</dc:title>", "utf8"));
    expect(result.entries.map((entry) => [entry.name, entry.value])).toEqual([
      ["dc:title", "t"],
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("metadata-invalid");
    expect(result.warnings[0]?.detail.length).toBeGreaterThan(0);
  });

  it("xmpOrientation MethodExpression, ConditionalExpression and EqualityOperator clusters: whitespace that entity decoding adds is ignored, and repeated or blank values are invalid", () => {
    expect(orientationOf("", ' tiff:Orientation="&#32;6&#32;"')).toBe(6);
    expect(
      orientationOf("<tiff:Orientation>&#x20;8&#x9;</tiff:Orientation>"),
    ).toBe(8);
    expect(orientationOf("", ' tiff:Orientation="&#32;"')).toBe("invalid");
    expect(
      orientationOf(
        "<tiff:Orientation>6</tiff:Orientation>",
        ' tiff:Orientation="6"',
      ),
    ).toBe("invalid");
    expect(
      orientationOf(
        "<tiff:Orientation>6</tiff:Orientation><tiff:Orientation>3</tiff:Orientation>",
      ),
    ).toBe("invalid");
    expect(orientationOf("<tiff:Orientation>5</tiff:Orientation>")).toBe(5);
  });
});

describe("png-handler.ts parseIccpChunk, parseZtxtChunk, parseItxtChunk, parseTextChunkData and routeTextKeyword clusters (67-37, png-1)", () => {
  type PngChunkSpec = readonly [string, Buffer];
  const PROFILE = iccProfileV4();
  const ICC_ENTRIES = parseIcc(PROFILE).entries;
  // A zlib stream that holds no zero byte, so that a zTXt payload built from
  // one keyword byte followed by it has no keyword terminator at all.
  const NUL_FREE_ZLIB = Buffer.from(
    "789ccb2e2ecd4f2e2e2c4eac4ccd4fadcc2ecc2fcc06b3128b0b8b93f301c8690ce5",
    "hex",
  );

  const inspectPng = async (chunks: readonly PngChunkSpec[]) => {
    const path = await freshPath();
    await writeFile(path, pngWithChunksBefore(chunks));
    return inspectFile(path);
  };
  const refusalCodeOf = async (
    chunks: readonly PngChunkSpec[],
  ): Promise<string> => {
    const result = await inspectPng(chunks);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    return result.error.code;
  };
  const acceptedOf = async (chunks: readonly PngChunkSpec[]) => {
    const result = await inspectPng(chunks);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    return result.value;
  };
  const pngEntriesOf = (
    entries: readonly MetadataEntry[],
  ): readonly [string, unknown][] =>
    entries
      .filter((entry) => entry.namespace === "PNG")
      .map((entry) => [entry.name, entry.value]);
  const iccpWith = (name: Buffer, method: number, profile = PROFILE): Buffer =>
    Buffer.concat([name, Buffer.from([0, method]), deflateSync(profile)]);

  it("parseIccpChunk Conditional, Equality and Logical clusters: a profile name of 1 to 79 bytes is read and any other length refuses the chunk", async () => {
    for (const length of [1, 2, 78, 79]) {
      const value = await acceptedOf([
        ["iCCP", pngIccp(PROFILE, "n".repeat(length))],
      ]);
      expect(value.entries, `name of ${length} bytes`).toEqual(ICC_ENTRIES);
    }
    for (const length of [0, 80, 81, 200])
      expect(
        await refusalCodeOf([["iCCP", pngIccp(PROFILE, "n".repeat(length))]]),
        `name of ${length} bytes`,
      ).toBe("malformed-file");
  });

  it("parseIccpChunk Conditional and Block clusters: only compression method zero is read", async () => {
    expect(
      (await acceptedOf([["iCCP", iccpWith(Buffer.from("icc"), 0)]])).entries,
    ).toEqual(ICC_ENTRIES);
    for (const method of [1, 2, 255])
      expect(
        await refusalCodeOf([["iCCP", iccpWith(Buffer.from("icc"), method)]]),
        `method ${method}`,
      ).toBe("malformed-file");
  });

  it("parseZtxtChunk Block, Conditional, Equality and Logical clusters: a keyword terminator is required, and an empty keyword is read", async () => {
    const noTerminator = Buffer.concat([Buffer.from("k"), NUL_FREE_ZLIB]);
    expect(noTerminator.includes(0)).toBe(false);
    expect(await refusalCodeOf([["zTXt", noTerminator]])).toBe(
      "malformed-file",
    );
    const emptyKeyword = Buffer.concat([
      Buffer.from([0, 0]),
      deflateSync(Buffer.from("value", "latin1")),
    ]);
    expect(
      pngEntriesOf((await acceptedOf([["zTXt", emptyKeyword]])).entries),
    ).toEqual([["", "value"]]);
    const named = Buffer.concat([
      Buffer.from("Author"),
      Buffer.from([0, 0]),
      deflateSync(Buffer.from("value", "latin1")),
    ]);
    expect(pngEntriesOf((await acceptedOf([["zTXt", named]])).entries)).toEqual(
      [["Author", "value"]],
    );
  });

  it("parseItxtChunk BlockStatement, Conditional and Equality clusters: the language tag and translated keyword terminators are required, and an empty keyword is read", async () => {
    const noLanguageTerminator = Buffer.concat([
      Buffer.from("kw"),
      Buffer.from([0, 0, 0]),
      Buffer.from("value"),
    ]);
    expect(noLanguageTerminator.indexOf(0, 5)).toBe(-1);
    expect(await refusalCodeOf([["iTXt", noLanguageTerminator]])).toBe(
      "malformed-file",
    );
    const noTranslatedTerminator = Buffer.concat([
      Buffer.from("kw"),
      Buffer.from([0, 0, 0]),
      Buffer.from("en"),
      Buffer.from([0]),
      Buffer.from("value"),
    ]);
    expect(noTranslatedTerminator.indexOf(0, 8)).toBe(-1);
    expect(await refusalCodeOf([["iTXt", noTranslatedTerminator]])).toBe(
      "malformed-file",
    );
    expect(
      pngEntriesOf(
        (await acceptedOf([["iTXt", pngItxt("kw", Buffer.from("value"))]]))
          .entries,
      ),
    ).toEqual([["kw", "value"]]);
    expect(
      pngEntriesOf(
        (await acceptedOf([["iTXt", pngItxt("", Buffer.from("value"))]]))
          .entries,
      ),
    ).toEqual([["", "value"]]);
  });

  it("parseTextChunkData Conditional, Equality and String clusters: a tEXt chunk without a terminator is all keyword with empty text, and an empty keyword is read", async () => {
    expect(
      pngEntriesOf(
        (await acceptedOf([["tEXt", Buffer.from("Comment", "latin1")]]))
          .entries,
      ),
    ).toEqual([["Comment", ""]]);
    expect(
      pngEntriesOf(
        (await acceptedOf([["tEXt", Buffer.from("\0value", "latin1")]]))
          .entries,
      ),
    ).toEqual([["", "value"]]);
    expect(
      pngEntriesOf(
        (await acceptedOf([["tEXt", Buffer.from("Comment\0value", "latin1")]]))
          .entries,
      ),
    ).toEqual([["Comment", "value"]]);
  });

  it("routeTextKeyword CallExpression cluster: warnings from an XMP packet reach the inspection", async () => {
    const withoutRoot = Buffer.from("<dc:title>t</dc:title>", "utf8");
    const value = await acceptedOf([
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, withoutRoot)],
    ]);
    expect(value.warnings.map((warning) => warning.code)).toEqual([
      "metadata-invalid",
    ]);
    const rooted = Buffer.from(
      "<x:xmpmeta><dc:title>t</dc:title></x:xmpmeta>",
      "utf8",
    );
    expect(
      (await acceptedOf([["iTXt", pngItxt(XMP_ITXT_KEYWORD, rooted)]]))
        .warnings,
    ).toEqual([]);
  });
});
