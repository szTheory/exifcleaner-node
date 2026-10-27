// src/isobmff/{errors,caps,boxes,parse}.ts coverage (61-04): box framing, the top-level
// allowlist, the FullBox meta check, and caps checked before reads. Every expected byte offset
// or length below is hand-computed from `tests/isobmff-support/builder.ts`'s own field-width
// contracts (docs/isobmff.md `## Grammar`) and written as a literal -- never read back from the
// builder or the parser under test (D-20).
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECLINE_CLASS_TO_KIND,
  ISOBMFF_DECLINE_CLASSES,
  IsobmffStructureError,
} from "../src/isobmff/errors.js";
import { parseIsobmff, type IsobmffModel } from "../src/isobmff/parse.js";
import {
  DEFAULT_ISOBMFF_CAPS,
  IsobmffBudget,
  type IsobmffCaps,
} from "../src/isobmff/caps.js";
import {
  C2PA_UUID_USERTYPE,
  parseBoxHeader,
  readExactly,
  readTopLevelBoxes,
  walkContainer,
} from "../src/isobmff/boxes.js";
import {
  box,
  type BoxSizeOverride,
  ftypBox,
  fullBox,
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
  uuidBox,
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

/** ftyp's hand-computed total size: 8 header + 4 major_brand + 4 minor_version + 2*4 compatible_brands. */
const FTYP_SIZE = 24;
/** meta's hand-computed total size (see `minimalHeif` below for the per-child breakdown). */
const META_SIZE = 214;

/**
 * Build a minimal single-`hvc1`-item HEIF file directly from the low-level builder primitives
 * (not `heifFile()`'s convenience composer), so every box's byte length is hand-computable here
 * rather than depending on a higher-level helper's own internal layout choices. `mdatSize`
 * overrides the trailing mdat box's declared size convention (default: a normal declared size).
 */
function minimalHeif(mdatSize?: BoxSizeOverride["size"]): Buffer {
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
  const ftypSize = FTYP_SIZE;
  const hdlrSize = 33; // 8 + 4 (version/flags) + 4 pre_defined + 4 handler_type + 12 reserved + 1 name
  const pitmSize = 14; // 8 + 4 (version/flags) + 2 item_ID (v0)
  const infeSize = 21; // 8 + 4 (version/flags) + 2 item_ID (v2) + 2 protection_index + 4 item_type + 1 name
  const iinfSize = 35; // 8 + 4 (version/flags) + 2 entry_count (v0) + 21 infe
  const ipcoSize = 59; // 8 + 20 ispe + 31 hvcC
  const iprpSize = 88; // 8 + 59 ipco + 21 ipma
  const ilocSize = 32; // 8 + 4 (version/flags) + 2 size-nibbles + 2 item_count (v1) + 2 item_ID + 2 construction_method + 2 data_reference_index + 2 extent_count + 4 offset + 4 length
  const metaPayloadSize = hdlrSize + pitmSize + iinfSize + iprpSize + ilocSize; // 202
  const metaSize = 8 + 4 + metaPayloadSize; // 214
  expect(metaSize).toBe(META_SIZE);

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

  const mdat = mdatBox(
    itemPayload,
    mdatSize === undefined ? {} : { size: mdatSize },
  );
  if (mdatSize === undefined) expect(mdat.length).toBe(8 + itemPayload.length);

  const file = Buffer.concat([ftyp, meta, mdat]);
  if (mdatSize === undefined) {
    expect(file.length).toBe(ftypSize + metaSize + 8 + itemPayload.length); // 250
  }
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

/** `ftyp` alone, for hostile fixtures where meta/mdat content is irrelevant to the behavior under test. */
function minimalFtyp(): Buffer {
  return ftypBox("heic", 0, ["mif1", "heic"]);
}

function expectBoxFramingFailure(action: () => unknown): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(IsobmffStructureError);
  expect(error).toMatchObject({
    declineClass: "box-framing",
    kind: "malformed-file",
  });
}

describe("isobmff-2 parseBoxHeader ConditionalExpression", () => {
  it("rejects a truncated base header and a zero-sized in-memory box", () => {
    const truncatedBaseHeader = Buffer.alloc(3);
    expectBoxFramingFailure(() =>
      parseBoxHeader(truncatedBaseHeader, 0, truncatedBaseHeader.length),
    );

    const zeroSizedBox = Buffer.alloc(8);
    zeroSizedBox.write("free", 4, "ascii");
    expectBoxFramingFailure(() =>
      parseBoxHeader(zeroSizedBox, 0, zeroSizedBox.length),
    );
  });

  it("accepts a largesize equal to its header and rejects one byte below", () => {
    const equalToHeader = Buffer.alloc(16);
    equalToHeader.writeUInt32BE(1, 0);
    equalToHeader.write("free", 4, "ascii");
    equalToHeader.writeBigUInt64BE(16n, 8);

    expect(
      parseBoxHeader(equalToHeader, 0, equalToHeader.length),
    ).toMatchObject({
      type: "free",
      start: 0,
      headerSize: 16,
      size: 16,
      payloadStart: 16,
      end: 16,
      sizeForm: "largesize",
    });

    const belowHeader = Buffer.alloc(16);
    belowHeader.writeUInt32BE(1, 0);
    belowHeader.write("free", 4, "ascii");
    belowHeader.writeBigUInt64BE(15n, 8);

    expectBoxFramingFailure(() =>
      parseBoxHeader(belowHeader, 0, belowHeader.length),
    );
  });

  it("rejects an incomplete largesize field and unsafe largesize values", () => {
    const incompleteLargesize = Buffer.alloc(15);
    incompleteLargesize.writeUInt32BE(1, 0);
    incompleteLargesize.write("free", 4, "ascii");
    expectBoxFramingFailure(() =>
      parseBoxHeader(incompleteLargesize, 0, incompleteLargesize.length),
    );

    const unsafeLargesize = Buffer.alloc(16);
    unsafeLargesize.writeUInt32BE(1, 0);
    unsafeLargesize.write("free", 4, "ascii");
    unsafeLargesize.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    expectBoxFramingFailure(() =>
      parseBoxHeader(unsafeLargesize, 0, unsafeLargesize.length),
    );
  });

  it("rejects undersized normal boxes with the typed framing failure", () => {
    const undersizedBox = Buffer.alloc(8);
    undersizedBox.writeUInt32BE(7, 0);
    undersizedBox.write("free", 4, "ascii");
    expectBoxFramingFailure(() =>
      parseBoxHeader(undersizedBox, 0, undersizedBox.length),
    );
  });

  it("uses UUID header extents and rejects missing or undersized UUID payloads", () => {
    const uuidType = Buffer.from("uuid", "ascii");
    const usertype = Buffer.from("d8fec3d61b0e483c92975828877ec481", "hex");
    const validUuid = Buffer.alloc(24);
    validUuid.writeUInt32BE(24, 0);
    uuidType.copy(validUuid, 4);
    usertype.copy(validUuid, 8);

    expect(parseBoxHeader(validUuid, 0, validUuid.length)).toMatchObject({
      type: "uuid",
      start: 0,
      headerSize: 24,
      size: 24,
      payloadStart: 24,
      end: 24,
      usertype: "d8fec3d61b0e483c92975828877ec481",
    });

    const missingUsertype = Buffer.alloc(8);
    missingUsertype.writeUInt32BE(8, 0);
    uuidType.copy(missingUsertype, 4);
    expectBoxFramingFailure(() =>
      parseBoxHeader(missingUsertype, 0, missingUsertype.length),
    );

    const undersizedUuid = Buffer.alloc(24);
    undersizedUuid.writeUInt32BE(8, 0);
    uuidType.copy(undersizedUuid, 4);
    usertype.copy(undersizedUuid, 8);
    expectBoxFramingFailure(() =>
      parseBoxHeader(undersizedUuid, 0, undersizedUuid.length),
    );
  });
});

/**
 * A structurally-valid meta box, same content/size (214 bytes, see `META_SIZE`) as `minimalHeif`'s
 * meta -- this plan's walker never resolves `iloc`'s item table semantically (that's 61-05+), so a
 * placeholder extent offset of 0 is fine for every test that reuses this helper.
 */
function minimalMeta(extraChildren: readonly Buffer[] = []): Buffer {
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
        extents: [{ offset: 0, length: 4 }],
      },
    ],
  });
  const meta = metaBox([hdlr, pitm, iinf, iprp, iloc, ...extraChildren]);
  if (extraChildren.length === 0) {
    expect(meta.length).toBe(META_SIZE);
  }
  return meta;
}

/** A raw `size==1` box header with an explicit (possibly hostile) 64-bit largesize value. */
function rawLargesizeHeader(type: string, largesize: bigint): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, "ascii");
  header.writeBigUInt64BE(largesize, 8);
  return header;
}

describe("Task 2: box framing (BMF-01/BMF-05)", () => {
  it("a last top-level mdat with declared size 0 parses; its end equals the file length", async () => {
    const file = minimalHeif("zero");
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);

    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);
    const payloadStart = FTYP_SIZE + META_SIZE + 8; // 246
    expect(model.mdatRanges).toEqual([
      { offset: payloadStart, length: size - payloadStart },
    ]);
  });

  it("a size-0 box inside meta declines box-framing", async () => {
    const hostileMeta = metaBox([
      box("free", Buffer.alloc(4), { size: "zero" }),
    ]);
    const file = Buffer.concat([minimalFtyp(), hostileMeta]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("a size-0 top-level box that is not mdat, followed by more bytes, declines box-framing", async () => {
    const zeroFree = box("free", Buffer.alloc(4), { size: "zero" });
    const mdat = mdatBox(Buffer.from([9, 9, 9, 9]));
    const file = Buffer.concat([minimalFtyp(), zeroFree, mdat]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it.each([2, 7])(
    "a top-level box declaring size %d declines box-framing",
    async (declaredSize) => {
      const hostile = box("free", Buffer.alloc(0), { size: declaredSize });
      const file = Buffer.concat([minimalFtyp(), hostile]);
      const { path, size } = await writeFixture(file);

      await expect(parseFixture(path, size)).rejects.toMatchObject({
        declineClass: "box-framing",
        kind: "malformed-file",
      });
    },
  );

  it("a top-level box declaring size 8 (an empty box) parses", async () => {
    const empty = box("free", Buffer.alloc(0), { size: 8 });
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), empty, mdat]);
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);
    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "free",
      "mdat",
    ]);
  });

  it("largesize 16 with an empty payload parses", async () => {
    const largesizeBox = box("free", Buffer.alloc(0), { size: "largesize" });
    expect(largesizeBox.length).toBe(16);
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const file = Buffer.concat([
      minimalFtyp(),
      minimalMeta(),
      largesizeBox,
      mdat,
    ]);
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);
    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "free",
      "mdat",
    ]);
  });

  it("largesize 15 (0x20000000000000-scale precision case's sibling: below the 16-byte header) declines box-framing", async () => {
    const hostile = rawLargesizeHeader("free", 15n);
    const file = Buffer.concat([minimalFtyp(), hostile]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("largesize 2^53 (one above Number.MAX_SAFE_INTEGER) declines box-framing via the BigInt path", async () => {
    expect(2n ** 53n).toBe(0x20000000000000n);
    const hostile = rawLargesizeHeader("free", 2n ** 53n);
    const file = Buffer.concat([minimalFtyp(), hostile]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("a largesize mdat equal to the remaining file length parses", async () => {
    const largesizeMdat = mdatBox(Buffer.from([1, 2, 3, 4]), {
      size: "largesize",
    });
    expect(largesizeMdat.length).toBe(20);
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), largesizeMdat]);
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);
    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);
    expect(model.mdatRanges).toEqual([
      { offset: FTYP_SIZE + META_SIZE + 16, length: 4 },
    ]);
  });

  it("a child box whose end passes its parent's end declines box-framing", async () => {
    const hostileChild = box("free", Buffer.alloc(4), { size: 1000 });
    const hostileMeta = metaBox([hostileChild]);
    const file = Buffer.concat([minimalFtyp(), hostileMeta]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("a file truncated mid-header declines box-framing", async () => {
    const file = Buffer.concat([minimalFtyp(), Buffer.from([0, 0, 0])]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("a file whose first box is not ftyp declines box-framing", async () => {
    const file = box("free", Buffer.alloc(4));
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  // CR-01 (code review 2026-10-01): a zero-payload iinf box positioned at the exact end of
  // meta's own payload drove `containerChildOffset`'s unguarded `buffer.readUInt8(payloadStart)`
  // past the buffer end, throwing a native Node RangeError instead of IsobmffStructureError --
  // escaping the fail-closed decline surface. This exact shape (meta payload: 4 zero bytes,
  // version/flags, followed immediately by an 8-byte "iinf" box with zero bytes of payload) is
  // the BLOCKER's concrete repro from 61-REVIEW.md: no hdlr/pitm/iloc/mdat is needed at all, since
  // the crash was in the structural walk (walkContainer -> containerChildOffset), which runs
  // before buildItemModel is ever called.
  it("an iinf box too short for its version byte declines box-framing (not a native RangeError)", async () => {
    const zeroPayloadIinf = box("iinf", Buffer.alloc(0));
    expect(zeroPayloadIinf.length).toBe(8);
    const metaPayload = Buffer.concat([Buffer.alloc(4), zeroPayloadIinf]);
    const hostileMeta = box(
      "meta",
      metaPayload,
    ); /* fullBox-shaped: the leading 4 zero bytes above are its version/flags field. */
    const file = Buffer.concat([minimalFtyp(), hostileMeta]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    // A plain `.rejects.toThrow(RangeError)` would also pass if the bug regressed (RangeError
    // extends Error, and `rejects.toMatchObject` on a RangeError would simply fail the match
    // above with no declineClass) -- assert the *shape* explicitly as well, so a regression to a
    // native RangeError is unambiguous in the failure message rather than just "object mismatch".
    await expect(parseFixture(path, size)).rejects.not.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("Task 2: meta and top-level allowlist rules (BMF-01)", () => {
  it("meta with version 1 declines meta-not-fullbox", async () => {
    const metaV1 = fullBox("meta", 1, 0, hdlrBox("pict"));
    const file = Buffer.concat([minimalFtyp(), metaV1]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "meta-not-fullbox",
      kind: "malformed-file",
    });
  });

  it("a second top-level meta declines duplicate-meta", async () => {
    const meta = minimalMeta();
    const file = Buffer.concat([minimalFtyp(), meta, meta]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "duplicate-meta",
      kind: "malformed-file",
    });
  });

  // WR-03 (code review 2026-10-01): ftyp had no singleton guard, unlike the explicit, dedicated
  // sawMeta/sawMdat checks for the other two D5-admitted top-level boxes -- a second top-level
  // ftyp silently overwrote the first ftyp's parsed majorBrand/minorVersion/compatibleBrands with
  // no error at all.
  it("a second top-level ftyp declines box-framing", async () => {
    const ftyp = minimalFtyp();
    const file = Buffer.concat([ftyp, ftyp, minimalMeta()]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("a second top-level mdat declines multiple-mdat", async () => {
    const mdat1 = mdatBox(Buffer.from([1, 2, 3, 4]));
    const mdat2 = mdatBox(Buffer.from([5, 6, 7, 8]));
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), mdat1, mdat2]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "multiple-mdat",
      kind: "unsupported-format",
    });
  });

  it("a top-level moov declines sequence-box", async () => {
    const moov = box("moov", Buffer.alloc(4));
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), moov]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "sequence-box",
      kind: "unsupported-format",
    });
  });

  it.each([
    ["a top-level moof", box("moof", Buffer.alloc(4))],
    [
      "a non-C2PA uuid",
      uuidBox("000102030405060708090a0b0c0d0e0f", Buffer.alloc(4)),
    ],
  ])("%s declines top-level-box-not-allowed", async (_label, hostile) => {
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), hostile]);
    const { path, size } = await writeFixture(file);

    await expect(parseFixture(path, size)).rejects.toMatchObject({
      declineClass: "top-level-box-not-allowed",
      kind: "unsupported-format",
    });
  });

  it("free and skip boxes at the top level parse", async () => {
    const freeBox = box("free", Buffer.alloc(4));
    const skipBox = box("skip", Buffer.alloc(4));
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const file = Buffer.concat([
      minimalFtyp(),
      minimalMeta(),
      freeBox,
      skipBox,
      mdat,
    ]);
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);
    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "free",
      "skip",
      "mdat",
    ]);
  });

  it("a C2PA uuid box parses and is recorded in removableTopLevel", async () => {
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const c2pa = uuidBox(C2PA_UUID_USERTYPE, Buffer.from([9, 9]));
    const file = Buffer.concat([minimalFtyp(), minimalMeta(), mdat, c2pa]);
    const { path, size } = await writeFixture(file);

    const model = await parseFixture(path, size);
    expect(model.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
      "uuid",
    ]);
    const c2paOffset = FTYP_SIZE + META_SIZE + mdat.length;
    expect(model.removableTopLevel).toEqual([
      { offset: c2paOffset, length: c2pa.length },
    ]);
  });
});

interface ReadLogEntry {
  readonly position: number;
  readonly length: number;
}

/** Wraps a real `FileHandle`'s `read` calls with a position/length log (BMF-05 boundary proof:
 * a cap breach must never have already performed the read it guards). */
function loggingHandle(real: FileHandle): {
  handle: FileHandle;
  log: ReadLogEntry[];
} {
  const log: ReadLogEntry[] = [];
  const handle = {
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      log.push({ position, length });
      return real.read(buffer, offset, length, position);
    },
    close: () => real.close(),
  } as unknown as FileHandle;
  return { handle, log };
}

function memoryHandle(
  bytes: Buffer,
  options: { maxReadSize?: number; failAfterZeroReads?: number } = {},
): {
  handle: FileHandle;
  log: ReadLogEntry[];
} {
  const log: ReadLogEntry[] = [];
  let zeroReads = 0;
  const handle = {
    read: async (
      target: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      log.push({ position, length });
      const available = Math.max(0, bytes.length - position);
      const bytesRead = Math.max(
        0,
        Math.min(length, available, options.maxReadSize ?? length),
      );
      if (bytesRead === 0) {
        zeroReads += 1;
        if (
          zeroReads > (options.failAfterZeroReads ?? Number.POSITIVE_INFINITY)
        ) {
          throw new Error("bounded fake handle stopped repeated EOF reads");
        }
      }
      bytes.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  } as unknown as FileHandle;
  return { handle, log };
}

describe("isobmff-2 top-level box header boundaries", () => {
  it("readTopLevelBoxHeaderAt rejects an undersized UUID even when following bytes fill its usertype", async () => {
    const ftyp = Buffer.alloc(8);
    ftyp.writeUInt32BE(8, 0);
    ftyp.write("ftyp", 4, "ascii");

    const undersizedUuid = Buffer.alloc(20);
    undersizedUuid.writeUInt32BE(20, 0);
    undersizedUuid.write("uuid", 4, "ascii");

    const nextBox = Buffer.alloc(8);
    nextBox.writeUInt32BE(8, 0);
    nextBox.write("free", 4, "ascii");

    const bytes = Buffer.concat([ftyp, undersizedUuid, nextBox]);
    const { handle, log } = memoryHandle(bytes);

    await expect(
      readTopLevelBoxes(handle, bytes.length, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });

    expect(log).toHaveLength(3);
    expect(log).toEqual([
      { position: 0, length: 8 },
      { position: 8, length: 8 },
      { position: 16, length: 16 },
    ]);
    expect(
      log.every((entry) => entry.position + entry.length <= bytes.length),
    ).toBe(true);
  });

  it("readTopLevelBoxHeaderAt reads only headers inside fileSize and accepts exact UUID and safe largesize ends", async () => {
    const truncatedBase = Buffer.alloc(8);
    truncatedBase.writeUInt32BE(8, 0);
    truncatedBase.write("ftyp", 4, "ascii");
    const shortBase = memoryHandle(truncatedBase);
    await expect(
      readTopLevelBoxes(shortBase.handle, 7, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(shortBase.log).toEqual([]);

    const incompleteLarge = Buffer.alloc(16);
    incompleteLarge.writeUInt32BE(1, 0);
    incompleteLarge.write("ftyp", 4, "ascii");
    incompleteLarge.writeBigUInt64BE(16n, 8);
    const shortLarge = memoryHandle(incompleteLarge);
    await expect(
      readTopLevelBoxes(shortLarge.handle, 15, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(shortLarge.log).toEqual([{ position: 0, length: 8 }]);

    const exactLarge = memoryHandle(incompleteLarge);
    const exactLargeBoxes = await readTopLevelBoxes(
      exactLarge.handle,
      16,
      new IsobmffBudget(),
    );
    expect(exactLargeBoxes[0]).toMatchObject({
      type: "ftyp",
      headerSize: 16,
      size: 16,
      end: 16,
    });

    const missingUuid = Buffer.alloc(40);
    missingUuid.writeUInt32BE(8, 0);
    missingUuid.write("ftyp", 4, "ascii");
    missingUuid.writeUInt32BE(24, 8);
    missingUuid.write("uuid", 12, "ascii");
    missingUuid.writeUInt32BE(8, 24);
    missingUuid.write("free", 28, "ascii");
    const shortUuid = memoryHandle(missingUuid);
    await expect(
      readTopLevelBoxes(shortUuid.handle, 24, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(shortUuid.log).toEqual([
      { position: 0, length: 8 },
      { position: 8, length: 8 },
    ]);

    const exactUuid = Buffer.alloc(32);
    exactUuid.writeUInt32BE(8, 0);
    exactUuid.write("ftyp", 4, "ascii");
    exactUuid.writeUInt32BE(24, 8);
    exactUuid.write("uuid", 12, "ascii");
    Buffer.from(C2PA_UUID_USERTYPE, "hex").copy(exactUuid, 16);
    const exactUuidHandle = memoryHandle(exactUuid);
    const boxes = await readTopLevelBoxes(
      exactUuidHandle.handle,
      exactUuid.length,
      new IsobmffBudget(),
    );
    expect(boxes[1]).toMatchObject({
      type: "uuid",
      start: 8,
      headerSize: 24,
      size: 24,
      payloadStart: 32,
      end: 32,
      usertype: C2PA_UUID_USERTYPE,
    });
    expect(
      exactUuidHandle.log.every(
        (entry) => entry.position + entry.length <= exactUuid.length,
      ),
    ).toBe(true);

    const safeLarge = Buffer.alloc(16);
    safeLarge.writeUInt32BE(1, 0);
    safeLarge.write("ftyp", 4, "ascii");
    safeLarge.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER), 8);
    const safeHandle = memoryHandle(safeLarge);
    const safeBoxes = await readTopLevelBoxes(
      safeHandle.handle,
      Number.MAX_SAFE_INTEGER,
      new IsobmffBudget(),
    );
    expect(safeBoxes[0]).toMatchObject({
      type: "ftyp",
      size: Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
      headerSize: 16,
    });

    const roundedUnsafeLarge = Buffer.alloc(16);
    roundedUnsafeLarge.writeUInt32BE(1, 0);
    roundedUnsafeLarge.write("ftyp", 4, "ascii");
    roundedUnsafeLarge.writeBigUInt64BE(2n ** 53n + 1n, 8);
    await expect(
      readTopLevelBoxes(
        memoryHandle(roundedUnsafeLarge).handle,
        2 ** 53,
        new IsobmffBudget(),
      ),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
  });

  it("readTopLevelBoxHeaderAt rejects an undersized largesize UUID before a usertype read", async () => {
    const bytes = Buffer.alloc(40);
    bytes.writeUInt32BE(8, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.writeUInt32BE(1, 8);
    bytes.write("uuid", 12, "ascii");
    bytes.writeBigUInt64BE(15n, 16);
    const { handle, log } = memoryHandle(bytes);

    await expect(
      readTopLevelBoxes(handle, bytes.length, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(log).toEqual([
      { position: 0, length: 8 },
      { position: 8, length: 8 },
      { position: 16, length: 8 },
    ]);
  });

  it("readTopLevelBoxHeaderAt rejects an undersized normal UUID before a usertype read", async () => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(8, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.writeUInt32BE(7, 8);
    bytes.write("uuid", 12, "ascii");
    const { handle, log } = memoryHandle(bytes);

    await expect(
      readTopLevelBoxes(handle, bytes.length, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(log).toEqual([
      { position: 0, length: 8 },
      { position: 8, length: 8 },
    ]);
  });

  it("readTopLevelBoxes requires a first ftyp box and rejects a box extending beyond fileSize", async () => {
    const empty = memoryHandle(Buffer.alloc(0));
    await expect(
      readTopLevelBoxes(empty.handle, 0, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });

    const wrongFirst = Buffer.alloc(8);
    wrongFirst.writeUInt32BE(8, 0);
    wrongFirst.write("free", 4, "ascii");
    await expect(
      readTopLevelBoxes(
        memoryHandle(wrongFirst).handle,
        wrongFirst.length,
        new IsobmffBudget(),
      ),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });

    const beyondFile = Buffer.alloc(8);
    beyondFile.writeUInt32BE(16, 0);
    beyondFile.write("ftyp", 4, "ascii");
    const bounded = memoryHandle(beyondFile);
    await expect(
      readTopLevelBoxes(bounded.handle, 8, new IsobmffBudget()),
    ).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(bounded.log).toEqual([{ position: 0, length: 8 }]);
  });
});

describe("isobmff-2 readExactly boundaries", () => {
  it("readExactly assembles short reads and types EOF after a partial read", async () => {
    const source = Buffer.from([0, 1, 2, 3, 4, 5, 6]);
    const partial = memoryHandle(source, { maxReadSize: 2 });
    await expect(readExactly(partial.handle, 5, 2)).resolves.toEqual(
      Buffer.from([2, 3, 4, 5, 6]),
    );
    expect(partial.log).toEqual([
      { position: 2, length: 5 },
      { position: 4, length: 3 },
      { position: 6, length: 1 },
    ]);

    const eof = memoryHandle(Buffer.from([1, 2]), {
      maxReadSize: 1,
      failAfterZeroReads: 1,
    });
    await expect(readExactly(eof.handle, 3, 0)).rejects.toMatchObject({
      declineClass: "box-framing",
      kind: "malformed-file",
    });
    expect(eof.log).toEqual([
      { position: 0, length: 3 },
      { position: 1, length: 2 },
      { position: 2, length: 1 },
    ]);
  });
});

describe("isobmff-2 containerChildOffset and walkContainer", () => {
  it("containerChildOffset skips FullBox and versioned iinf prefixes when walking children", () => {
    const child = box("free", Buffer.alloc(0));
    for (const type of ["meta", "iref"] as const) {
      const parent = fullBox(type, 0, 0, child);
      const budget = new IsobmffBudget();
      expect(walkContainer(parent, 0, parent.length, 0, budget)).toHaveLength(
        1,
      );
      expect(budget.boxCount()).toBe(2);
    }

    for (const version of [0, 1] as const) {
      const parent = iinfBox(version, [
        infeBox({ version: 2, itemId: 7, itemType: "hvc1" }),
      ]);
      const budget = new IsobmffBudget();
      expect(walkContainer(parent, 0, parent.length, 0, budget)).toHaveLength(
        1,
      );
      expect(budget.boxCount()).toBe(2);
    }

    const missingVersion = Buffer.alloc(8);
    missingVersion.writeUInt32BE(8, 0);
    missingVersion.write("iinf", 4, "ascii");
    expectBoxFramingFailure(() =>
      walkContainer(
        missingVersion,
        0,
        missingVersion.length,
        0,
        new IsobmffBudget(),
      ),
    );
  });

  it("walkContainer CallExpression recurses through nested containers and counts each child", () => {
    const leaf = box("free", Buffer.alloc(0));
    const nested = fullBox("meta", 0, 0, leaf);
    const outer = box("dinf", nested);
    const budget = new IsobmffBudget();

    expect(walkContainer(outer, 0, outer.length, 0, budget)).toHaveLength(1);
    expect(budget.boxCount()).toBe(3);
  });
});

describe("Task 3: caps checked before reads (BMF-05)", () => {
  it("maxMetaBytes boundary: the meta payload's exact size parses; one less declines before reading it", async () => {
    const meta = minimalMeta();
    const payloadLength = meta.length - 8; // 206: meta's FullBox payload, incl. version/flags
    const mdat = mdatBox(Buffer.from([1, 2, 3, 4]));
    const file = Buffer.concat([minimalFtyp(), meta, mdat]);
    const { path, size } = await writeFixture(file);

    const atCap = await parseFixture(path, size, {
      ...DEFAULT_ISOBMFF_CAPS,
      maxMetaBytes: payloadLength,
    });
    expect(atCap.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);

    const real = await open(path, "r");
    const { handle, log } = loggingHandle(real);
    try {
      await expect(
        parseIsobmff(handle, size, {
          ...DEFAULT_ISOBMFF_CAPS,
          maxMetaBytes: payloadLength - 1,
        }),
      ).rejects.toMatchObject({
        declineClass: "cap-meta-bytes",
        kind: "unsafe-structure",
        limit: {
          cap: "maxMetaBytes",
          size: payloadLength,
          limit: payloadLength - 1,
        },
      });
    } finally {
      await real.close();
    }
    // The meta payload read is a single `length === payloadLength` call -- it must never
    // appear in the log once the cap check (which runs first) has thrown.
    expect(log.some((entry) => entry.length === payloadLength)).toBe(false);
  });

  it("maxBoxCount boundary: a 13-box fixture parses under cap 13 and declines under cap 12", async () => {
    // 3 top-level (ftyp, meta, mdat) + meta's 5 direct children (hdlr, pitm, iinf, iprp, iloc)
    // + iinf's 1 child (infe) + iprp's 2 children (ipco, ipma) + ipco's 2 children (ispe, hvcC)
    // = 3 + 5 + 1 + 2 + 2 = 13.
    const file = Buffer.concat([
      minimalFtyp(),
      minimalMeta(),
      mdatBox(Buffer.from([1, 2, 3, 4])),
    ]);
    const { path, size } = await writeFixture(file);

    const atCap = await parseFixture(path, size, {
      ...DEFAULT_ISOBMFF_CAPS,
      maxBoxCount: 13,
    });
    expect(atCap.topLevel.length).toBe(3);

    await expect(
      parseFixture(path, size, { ...DEFAULT_ISOBMFF_CAPS, maxBoxCount: 12 }),
    ).rejects.toMatchObject({
      declineClass: "cap-box-count",
      kind: "unsafe-structure",
      limit: { cap: "maxBoxCount", size: 13, limit: 12 },
    });
  });

  it("maxBoxDepth boundary: a dinf-in-dinf chain of depth 4 parses under cap 4 and declines under cap 3", async () => {
    // meta's children are walked at depth 1; dinf1's children at depth 2; dinf2's children at
    // depth 3; dinf3's (empty) children at depth 4 -- checkDepth(4) fires even with no children.
    const dinf3 = box("dinf", Buffer.alloc(0));
    const dinf2 = box("dinf", dinf3);
    const dinf1 = box("dinf", dinf2);
    const file = Buffer.concat([
      minimalFtyp(),
      minimalMeta([dinf1]),
      mdatBox(Buffer.from([1, 2, 3, 4])),
    ]);
    const { path, size } = await writeFixture(file);

    const atCap = await parseFixture(path, size, {
      ...DEFAULT_ISOBMFF_CAPS,
      maxBoxDepth: 4,
    });
    expect(atCap.topLevel.map((entry) => entry.type)).toEqual([
      "ftyp",
      "meta",
      "mdat",
    ]);

    await expect(
      parseFixture(path, size, { ...DEFAULT_ISOBMFF_CAPS, maxBoxDepth: 3 }),
    ).rejects.toMatchObject({
      declineClass: "cap-box-depth",
      kind: "unsafe-structure",
      limit: { cap: "maxBoxDepth", size: 4, limit: 3 },
    });
  });

  it("isobmff-3 consumeBuffered EqualityOperator and StringLiteral preserve exact cap metadata", () => {
    const budget = new IsobmffBudget({
      ...DEFAULT_ISOBMFF_CAPS,
      maxBufferedBytesTotal: 4,
    });

    budget.consumeBuffered(3);
    budget.consumeBuffered(1);
    expect(budget.bufferedBytes()).toBe(4);

    let error: unknown;
    try {
      budget.consumeBuffered(1);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(IsobmffStructureError);
    expect(error).toMatchObject({
      declineClass: "cap-buffered-bytes",
      kind: "unsafe-structure",
      limit: { cap: "maxBufferedBytesTotal", size: 5, limit: 4 },
    });
    expect(budget.bufferedBytes()).toBe(4);
  });

  it("a read log on a 1 GiB sparse mdat fixture shows parseIsobmff never reads bytes inside the mdat payload", async () => {
    const ftyp = minimalFtyp();
    const meta = minimalMeta();
    const mdatPayloadSize = 1024 * 1024 * 1024; // 1 GiB
    const mdatPayloadStart = ftyp.length + meta.length + 8;
    const totalSize = mdatPayloadStart + mdatPayloadSize;

    const directory = await freshDirectory();
    const path = join(directory, "sparse.heic");
    const writeHandle = await open(path, "w+");
    try {
      await writeHandle.write(ftyp, 0, ftyp.length, 0);
      await writeHandle.write(meta, 0, meta.length, ftyp.length);
      const mdatHeader = Buffer.alloc(8);
      mdatHeader.writeUInt32BE(8 + mdatPayloadSize, 0);
      mdatHeader.write("mdat", 4, 4, "ascii");
      await writeHandle.write(mdatHeader, 0, 8, ftyp.length + meta.length);
      await writeHandle.truncate(totalSize);
    } finally {
      await writeHandle.close();
    }

    const real = await open(path, "r");
    const { handle, log } = loggingHandle(real);
    try {
      const model = await parseIsobmff(handle, totalSize);
      expect(model.mdatRanges).toEqual([
        { offset: mdatPayloadStart, length: mdatPayloadSize },
      ]);
    } finally {
      await real.close();
    }

    for (const entry of log) {
      expect(entry.position + entry.length).toBeLessThanOrEqual(
        mdatPayloadStart,
      );
    }
  }, 30_000);
});

describe("IsobmffDeclineClass <-> kind (D-11)", () => {
  it("ISOBMFF_DECLINE_CLASSES has exactly 26 members", () => {
    expect(ISOBMFF_DECLINE_CLASSES.length).toBe(26);
    expect(new Set(ISOBMFF_DECLINE_CLASSES).size).toBe(26);
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
