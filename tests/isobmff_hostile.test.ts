// Hostile ISOBMFF/HEIF fixture catalog coverage (BMF-03, D-14): walks every `IsobmffDeclineClass`
// against its one catalog fixture, proves the D3 variants and D5 non-C2PA-uuid variant outside
// that catalog, pins `DECLINE_RULE_ORDER` determinism when several classes could apply, and covers
// the empty-input edges (zero items, no meta). `tests/isobmff-support/hostile.ts` is the one
// support module allowed a type-only import of `IsobmffDeclineClass` from `src/isobmff/errors.js`
// (see tests/isobmff_isolation.test.ts); this test file itself imports `src/isobmff/` freely.
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff, type IsobmffAdmission } from "../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../src/isobmff/brand.js";
import { sanitizeFile } from "../src/engine.js";
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
  box,
  fullBox,
  HOSTILE_FIXTURES,
  NON_C2PA_UUID_USERTYPE,
  uuidBox,
} from "./isobmff-support/hostile.js";
import {
  createIsobmffTestHandler,
  createIsobmffWriterCountingHandlerForTests,
} from "./isobmff-support/test-handler.js";
import {
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
  irefBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
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
    ...registeredHandlersForTests(),
    handler,
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
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
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
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
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
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
    });

    it("a second ipma inside iprp declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = buildWithExtraIprpChild(
        ipmaBox({ version: 0, flags: 0, entries: [] }),
      );
      await writeFile(path, bytes);
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
    });
  });

  describe("dinf/dref self-contained rule (D-17, inferred)", () => {
    function urlEntry(flags: number, trailing: Buffer = Buffer.alloc(0)): Buffer {
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
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
    });

    it("a url entry with flags 0 (not self-contained) declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        extraMetaChildren: [dinfWith(drefWith([urlEntry(0)]))],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
    });

    it("a url entry with flags 1 plus trailing location bytes declines item-graph-invalid", async () => {
      const path = await freshPath();
      const bytes = assembleHeif({
        extraMetaChildren: [
          dinfWith(drefWith([urlEntry(1, Buffer.from("loc\0", "ascii"))])),
        ],
      });
      await writeFile(path, bytes);
      await expectAdmissionDecline(path, "item-graph-invalid", "malformed-file");
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
    expect(checkIsobmffOutputPlan(declinedPlan)).toBe(declinedPlan.declineReason);

    const okPlan = buildIsobmffOutputPlan(starved, false, true, false, undefined);
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
