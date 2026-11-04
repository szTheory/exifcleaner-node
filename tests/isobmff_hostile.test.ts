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
import { sanitizeFile } from "../src/engine.js";
import { verifyIsobmffOutput } from "../src/isobmff/verify.js";
import type { Result } from "../src/types.js";
import {
  buildIsobmffOutputPlan,
  checkIsobmffOutputPlan,
} from "../src/isobmff/plan.js";
import { createOrientationExif } from "../src/metadata/exif.js";
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
import { iccProfileV4 } from "./fixtures.js";
import {
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
  readonly wrapSource?: (handle: FileHandle) => FileHandle;
  readonly wrapDestination?: (handle: FileHandle) => FileHandle;
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
    return await verifyIsobmffOutput(
      options.wrapSource?.(sourceHandle) ?? sourceHandle,
      admission,
      options.wrapDestination?.(destinationHandle) ?? destinationHandle,
      destinationBytes.length,
      destinationPath,
      false,
      options.preserveColorProfile ?? true,
      false,
      undefined,
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
    // source: base_offset 3 and extent_offset 5; destination: base_offset 0 and extent_offset 8.
    // Both name idat bytes 8..11 ("IJKL"); every other combination of the three terms reads
    // different bytes in the two files.
    const source = idatOffsetFile(3, 5);
    const destination = idatOffsetFile(0, 8);
    expect((await verifyPair(source, destination)).ok).toBe(true);

    // control: the idat bytes themselves are compared, so a destination that points at other
    // idat bytes does not verify
    expectVerificationFailed(await verifyPair(source, idatOffsetFile(0, 9)));
  });
});
