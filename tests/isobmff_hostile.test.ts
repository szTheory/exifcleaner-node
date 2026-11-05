// Hostile ISOBMFF/HEIF fixture catalog coverage (BMF-03, D-14): walks every `IsobmffDeclineClass`
// against its one catalog fixture, proves the D3 variants and D5 non-C2PA-uuid variant outside
// that catalog, pins `DECLINE_RULE_ORDER` determinism when several classes could apply, and covers
// the empty-input edges (zero items, no meta). `tests/isobmff-support/hostile.ts` is the one
// support module allowed a type-only import of `IsobmffDeclineClass` from `src/isobmff/errors.js`
// (see tests/isobmff_isolation.test.ts); this test file itself imports `src/isobmff/` freely.
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { JpegStructureError, parseJpeg } from "../src/jpeg/parser.js";
import {
  ICC_SEGMENT_IDENTIFIER,
  reassembleIccSegments,
} from "../src/jpeg/icc.js";
import { MAX_PROFILE_BYTES } from "../src/metadata/icc_admission.js";
import {
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
import type { Result } from "../src/types.js";
import {
  buildIsobmffOutputPlan,
  checkIsobmffOutputPlan,
} from "../src/isobmff/plan.js";
import {
  createMinimalExif,
  createOrientationExif,
} from "../src/metadata/exif.js";
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
  exifWithArtist,
  exifWithOrientation,
  iccProfileV4,
  jpegAdobe,
  jpegExif,
  minimalJpeg,
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
