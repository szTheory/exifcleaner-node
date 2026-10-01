// src/isobmff/{errors,caps,boxes,parse}.ts coverage (61-04): box framing, the top-level
// allowlist, the FullBox meta check, and caps checked before reads. Every expected byte offset
// or length below is hand-computed from `tests/isobmff-support/builder.ts`'s own field-width
// contracts (docs/isobmff.md `## Grammar`) and written as a literal -- never read back from the
// builder or the parser under test (D-20).
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECLINE_CLASS_TO_KIND,
  ISOBMFF_DECLINE_CLASSES,
  IsobmffStructureError,
} from "../src/isobmff/errors.js";
import { parseIsobmff, type IsobmffModel } from "../src/isobmff/parse.js";
import type { IsobmffCaps } from "../src/isobmff/caps.js";
import {
  ftypBox,
  hdlrBox,
  hvcC,
  iinfBox,
  infeBox,
  ilocBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
} from "./isobmff-support/builder.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-boxes-"));
  cleanupDirectories.push(directory);
  return directory;
}

async function writeFixture(
  bytes: Buffer,
): Promise<{ path: string; size: number }> {
  const directory = await freshDirectory();
  const path = join(directory, "input.heic");
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
  return { path, size: bytes.length };
}

async function parseFixture(
  path: string,
  size: number,
  caps?: IsobmffCaps,
): Promise<IsobmffModel> {
  const handle = await open(path, "r");
  try {
    return await parseIsobmff(handle, size, caps);
  } finally {
    await handle.close();
  }
}

/**
 * Build a minimal single-`hvc1`-item HEIF file directly from the low-level builder primitives
 * (not `heifFile()`'s convenience composer), so every box's byte length is hand-computable here
 * rather than depending on a higher-level helper's own internal layout choices.
 */
function minimalHeif(): Buffer {
  const itemPayload = Buffer.from([0, 1, 2, 3]);

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
  const iprp = iprpBox(ipco, ipma);

  // mdat's item payload begins right after ftyp + meta + the 8-byte mdat header. meta's length
  // doesn't depend on this offset's value (only on iloc's declared widths), so one pass suffices.
  const ftypSize = 24; // 8 header + 4 major_brand + 4 minor_version + 2*4 compatible_brands
  const hdlrSize = 33; // 8 + 4 (version/flags) + 4 pre_defined + 4 handler_type + 12 reserved + 1 name
  const pitmSize = 14; // 8 + 4 (version/flags) + 2 item_ID (v0)
  const infeSize = 21; // 8 + 4 (version/flags) + 2 item_ID (v2) + 2 protection_index + 4 item_type + 1 name
  const iinfSize = 35; // 8 + 4 (version/flags) + 2 entry_count (v0) + 21 infe
  const ispeSize = 20; // 8 + 4 (version/flags) + 4 width + 4 height
  const hvcCSize = 31; // 8 + 23-byte HEVCDecoderConfigurationRecord
  const ipcoSize = 59; // 8 + 20 ispe + 31 hvcC
  const ipmaSize = 21; // 8 + 4 (version/flags) + 4 entry_count + 2 item_ID (v0) + 1 association_count + 2*1 associations
  const iprpSize = 88; // 8 + 59 ipco + 21 ipma
  const ilocSize = 32; // 8 + 4 (version/flags) + 2 size-nibbles + 2 item_count (v1) + 2 item_ID + 2 construction_method + 2 data_reference_index + 2 extent_count + 4 offset + 4 length
  const metaPayloadSize = hdlrSize + pitmSize + iinfSize + iprpSize + ilocSize; // 202
  const metaSize = 8 + 4 + metaPayloadSize; // 214

  expect(ftyp.length).toBe(ftypSize);
  expect(hdlr.length).toBe(hdlrSize);
  expect(pitm.length).toBe(pitmSize);
  expect(infe.length).toBe(infeSize);
  expect(iinf.length).toBe(iinfSize);
  expect(ipco.length).toBe(ipcoSize);
  expect(iprp.length).toBe(iprpSize);

  const itemOffset = ftypSize + metaSize + 8; // 246: past ftyp + meta + the mdat header
  const iloc = ilocBox({
    version: 1,
    offsetSize: 4,
    lengthSize: 4,
    baseOffsetSize: 0,
    indexSize: 0,
    items: [
      {
        itemId: 1,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: 0,
        extents: [{ offset: itemOffset, length: itemPayload.length }],
      },
    ],
  });
  expect(iloc.length).toBe(ilocSize);

  const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
  expect(meta.length).toBe(metaSize);

  const mdat = mdatBox(itemPayload);
  expect(mdat.length).toBe(8 + itemPayload.length);

  const file = Buffer.concat([ftyp, meta, mdat]);
  expect(file.length).toBe(ftypSize + metaSize + 8 + itemPayload.length); // 250
  return file;
}

describe("parseIsobmff tracer: a builder HEIF file reads end to end", () => {
  it("parses topLevel types, majorBrand/compatibleBrands and the hand-computed meta range", async () => {
    const file = minimalHeif();
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);

    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);
    expect(model.majorBrand).toBe("heic");
    expect(model.compatibleBrands).toEqual(["mif1", "heic"]);
    // metaRange: starts right after ftyp's 24 bytes, spans meta's own 214-byte total size.
    expect(model.metaRange).toEqual({ offset: 24, length: 214 });
    // mdatRanges: payload starts right after ftyp(24) + meta(214) + the 8-byte mdat header.
    expect(model.mdatRanges).toEqual([{ offset: 246, length: 4 }]);
    expect(model.removableTopLevel).toEqual([]);
  });

  it("rejects a QuickTime-style meta (no version/flags) with declineClass meta-not-fullbox and kind malformed-file", async () => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const quickTimeMeta = metaBox([hdlrBox("pict")], { quickTime: true });
    const file = Buffer.concat([ftyp, quickTimeMeta]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "meta-not-fullbox",
      kind: "malformed-file",
    });
  });
});

describe("IsobmffDeclineClass <-> kind (D-11)", () => {
  it("ISOBMFF_DECLINE_CLASSES has exactly 24 members", () => {
    expect(ISOBMFF_DECLINE_CLASSES.length).toBe(24);
    expect(new Set(ISOBMFF_DECLINE_CLASSES).size).toBe(24);
  });

  it("every IsobmffDeclineClass member's kind matches DECLINE_CLASS_TO_KIND", () => {
    for (const declineClass of ISOBMFF_DECLINE_CLASSES) {
      const error = new IsobmffStructureError(declineClass, "probe");
      expect(error.kind).toBe(DECLINE_CLASS_TO_KIND[declineClass]);
      expect(error.declineClass).toBe(declineClass);
      expect(error.name).toBe("IsobmffStructureError");
    }
  });
});
