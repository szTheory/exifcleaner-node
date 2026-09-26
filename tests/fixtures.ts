import { deflateSync } from "node:zlib";
import { PNG_SIGNATURE, encodePngChunk } from "../src/png/chunks.js";

export interface FixtureChunk {
  readonly fourCc: string;
  readonly data: Buffer;
  readonly padding?: number;
}

export function chunk(fourCc: string, data: Buffer, padding = 0): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCc, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 === 1 ? [Buffer.from([padding])] : []),
  ]);
}

export function webp(
  chunks: readonly FixtureChunk[],
  declaredAdjustment = 0,
): Buffer {
  const body = Buffer.concat(
    chunks.map((item) => chunk(item.fourCc, item.data, item.padding)),
  );
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4 + declaredAdjustment, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

function writeUInt24LE(target: Buffer, value: number, offset: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
}

export function vp8x(flags: number, width = 1, height = 1): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  writeUInt24LE(data, width - 1, 4);
  writeUInt24LE(data, height - 1, 7);
  return data;
}

export function vp8(width = 1, height = 1, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x10; // Key frame, version 0, displayable, empty first partition.
  header.set([0x9d, 0x01, 0x2a], 3);
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return Buffer.concat([header, data]);
}

export function vp8l(
  width = 1,
  height = 1,
  hasAlpha = false,
  data = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x2f;
  const bits =
    ((width - 1) & 0x3fff) |
    (((height - 1) & 0x3fff) << 14) |
    (hasAlpha ? 0x1000_0000 : 0);
  header.writeUInt32LE(bits >>> 0, 1);
  return Buffer.concat([header, data]);
}

export function alpha(width = 1, height = 1, value = 0xff): Buffer {
  return Buffer.concat([Buffer.from([0]), Buffer.alloc(width * height, value)]);
}

export function anim(backgroundColor = 0, loopCount = 0): Buffer {
  const data = Buffer.alloc(6);
  data.writeUInt32LE(backgroundColor >>> 0, 0);
  data.writeUInt16LE(loopCount, 4);
  return data;
}

export interface AnimationFrameOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly dispose?: boolean;
  readonly blend?: boolean;
  readonly chunks?: readonly FixtureChunk[];
}

export function animationFrame({
  x = 0,
  y = 0,
  width = 1,
  height = 1,
  duration = 0,
  dispose = false,
  blend = true,
  chunks = [{ fourCc: "VP8 ", data: vp8(width, height) }],
}: AnimationFrameOptions = {}): Buffer {
  const header = Buffer.alloc(16);
  writeUInt24LE(header, x / 2, 0);
  writeUInt24LE(header, y / 2, 3);
  writeUInt24LE(header, width - 1, 6);
  writeUInt24LE(header, height - 1, 9);
  writeUInt24LE(header, duration, 12);
  header[15] = (dispose ? 1 : 0) | (blend ? 0 : 2);
  return Buffer.concat([
    header,
    ...chunks.map((item) => chunk(item.fourCc, item.data, item.padding)),
  ]);
}

export function exifWithOrientation(
  orientation: number,
  make = "CameraCo",
): Buffer {
  const makeBytes = Buffer.from(`${make}\0`, "ascii");
  const dataOffset = 8 + 2 + 2 * 12 + 4;
  const result = Buffer.alloc(dataOffset + makeBytes.length);
  result.write("II", 0, 2, "ascii");
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(8, 4);
  result.writeUInt16LE(2, 8);

  result.writeUInt16LE(0x0112, 10);
  result.writeUInt16LE(3, 12);
  result.writeUInt32LE(1, 14);
  result.writeUInt16LE(orientation, 18);

  result.writeUInt16LE(0x010f, 22);
  result.writeUInt16LE(2, 24);
  result.writeUInt32LE(makeBytes.length, 26);
  result.writeUInt32LE(dataOffset, 30);
  result.writeUInt32LE(0, 34);
  makeBytes.copy(result, dataOffset);
  return result;
}

export function xmpPacket(value = "private workflow"): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/webp"><dc:description>${value}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

export interface IccProfileFixtureOptions {
  readonly deviceClass?: "scnr" | "mntr";
  readonly colorSpace?: "RGB ";
  readonly pcs?: "XYZ " | "Lab ";
}

export interface IccTagFixture {
  readonly signature: string;
  readonly offset?: number;
  readonly size?: number;
  readonly type?: string;
  readonly reserved?: number;
}

export type IccProfileMutation = "signature" | "device-class";

export function iccProfileV4(
  {
    deviceClass = "mntr",
    colorSpace = "RGB ",
    pcs = "XYZ ",
  }: IccProfileFixtureOptions = {},
  tags: readonly IccTagFixture[] = [{ signature: "rTRC" }],
): Buffer {
  const tableEnd = 132 + tags.length * 12;
  const ranges = tags.map((tag, index) => ({
    offset: tag.offset ?? tableEnd + index * 8,
    size: tag.size ?? 8,
  }));
  const profile = Buffer.alloc(
    Math.max(
      tableEnd,
      ...ranges.map(
        (range) => range.offset + range.size + ((4 - (range.size % 4)) % 4),
      ),
    ),
  );
  profile.writeUInt32BE(profile.length, 0);
  profile.write("TEST", 4, 4, "ascii");
  profile[8] = 4;
  profile[9] = 0x40;
  profile.write(deviceClass, 12, 4, "ascii");
  profile.write(colorSpace, 16, 4, "ascii");
  profile.write(pcs, 20, 4, "ascii");
  profile.writeUInt16BE(2024, 24);
  profile.writeUInt16BE(2, 26);
  profile.writeUInt16BE(29, 28);
  profile.writeUInt16BE(12, 30);
  profile.writeUInt16BE(34, 32);
  profile.writeUInt16BE(56, 34);
  profile.write("acsp", 36, 4, "ascii");
  profile.write("APPL", 40, 4, "ascii");
  profile.write("TEST", 48, 4, "ascii");
  profile.write("MODL", 52, 4, "ascii");
  profile.writeUInt32BE(0, 64);
  profile.writeUInt32BE(0x0000_f6d6, 68);
  profile.writeUInt32BE(0x0001_0000, 72);
  profile.writeUInt32BE(0x0000_d32d, 76);
  profile.writeUInt32BE(tags.length, 128);
  for (const [index, tag] of tags.entries()) {
    const recordOffset = 132 + index * 12;
    const range = ranges[index]!;
    profile.write(tag.signature, recordOffset, 4, "ascii");
    profile.writeUInt32BE(range.offset, recordOffset + 4);
    profile.writeUInt32BE(range.size, recordOffset + 8);
    if (
      range.offset >= tableEnd &&
      range.offset + range.size <= profile.length
    ) {
      profile.write(tag.type ?? "curv", range.offset, 4, "ascii");
      profile.writeUInt32BE(tag.reserved ?? 0, range.offset + 4);
    }
  }
  profile.writeUInt32BE(profile.length, 0);
  return profile;
}

export function iccProfileV2(): Buffer {
  const profile = iccProfileV4();
  profile[8] = 2;
  profile[9] = 0x40;
  profile.fill(0, 84, 128);
  return profile;
}

export function mutateIccProfile(
  profile: Buffer,
  mutation: IccProfileMutation,
): Buffer {
  const result = Buffer.from(profile);
  if (mutation === "signature") result.write("nope", 36, 4, "ascii");
  // "prtr" (printer) is a real ICC device class the structural policy does
  // not admit (only scnr/mntr) -- used to exercise the policy-rejection path
  // (56-05 D-08 Photoshop-style fixture) distinctly from a structurally
  // invalid profile.
  if (mutation === "device-class") result.write("prtr", 12, 4, "ascii");
  return result;
}

export function iccProfile(): Buffer {
  return iccProfileV4();
}

export function metadataWebp(imagePayload = vp8()): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x2c) },
    { fourCc: "ICCP", data: iccProfile() },
    { fourCc: "VP8 ", data: imagePayload },
    { fourCc: "EXIF", data: exifWithOrientation(6) },
    { fourCc: "XMP ", data: xmpPacket() },
  ]);
}

// PNG builders. A CRC-correct chunk is produced via the src encoder itself
// (encodePngChunk), so the fixture builders and the parser share one encoder while the
// CRC-32 algorithm itself is pinned by png_chunks.test.ts's reference vectors.

export function pngChunk(type: string, data: Buffer): Buffer {
  return encodePngChunk(type, data);
}

export function png(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

export function pngIhdr(
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 2,
): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return data;
}

export function pngIdat(): Buffer {
  // One filter-0 scanline for a 1x1 truecolor (colorType 2) pixel: filter byte + RGB.
  const scanline = Buffer.from([0, 0, 0, 0]);
  return deflateSync(scanline);
}

export function minimalPng(): Buffer {
  return png([
    pngChunk("IHDR", pngIhdr()),
    pngChunk("IDAT", pngIdat()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pngChrm(): Buffer {
  // Eight 4-byte unsigned values (white point + RGB primaries), each in units
  // of 1/100000. Arbitrary admitted values -- content is opaque to the handler.
  const data = Buffer.alloc(32);
  const values = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
  values.forEach((value, index) => data.writeUInt32BE(value, index * 4));
  return data;
}

export function pngBkgd(): Buffer {
  // colorType 2 (truecolor, pngIhdr()'s default): three 2-byte RGB samples.
  return Buffer.alloc(6);
}

/** PNG `gAMA` chunk payload: a single 4-byte gamma value in units of
 * 1/100000. D-08: this chunk is removed by every request, unconditionally. */
export function pngGama(value = 45455): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value, 0);
  return data;
}

export function pngPhys(): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt32BE(2835, 0); // pixels per unit, X (72 DPI)
  data.writeUInt32BE(2835, 4); // pixels per unit, Y
  data[8] = 1; // unit specifier: meters
  return data;
}

export function pngTime(): Buffer {
  const data = Buffer.alloc(7);
  data.writeUInt16BE(2026, 0);
  data[2] = 9;
  data[3] = 25;
  data[4] = 12;
  data[5] = 0;
  data[6] = 0;
  return data;
}

export function pngTextChunkData(keyword: string, text: string): Buffer {
  return Buffer.from(`${keyword}\0${text}`, "latin1");
}

/** PNG `zTXt` chunk payload: keyword, null terminator, compression method (0
 * = deflate), then the deflated text. */
export function pngZtxtChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from([0]),
    deflateSync(Buffer.from(text, "latin1")),
  ]);
}

/**
 * IHDR, cHRM (32 bytes), bKGD (6 bytes), pHYs (9 bytes), a tEXt "Comment"
 * private-workflow marker, tIME (7 bytes), IDAT, IEND. Every chunk except
 * IHDR/IDAT/IEND is either D-05 preserve-list (cHRM, bKGD) or D-05/D-02
 * removed-by-default (pHYs, tEXt, tIME) -- exercising the 56-03 tracer's full
 * classification surface in one fixture.
 */
export function metadataPng(): Buffer {
  return png([
    pngChunk("IHDR", pngIhdr()),
    pngChunk("cHRM", pngChrm()),
    pngChunk("bKGD", pngBkgd()),
    pngChunk("pHYs", pngPhys()),
    pngChunk("tEXt", pngTextChunkData("Comment", "private workflow")),
    pngChunk("tIME", pngTime()),
    pngChunk("IDAT", pngIdat()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Builds `IHDR`, the given `[type, data]` chunks in order, `IDAT`, `IEND`.
 * The caller is responsible for choosing types/positions that satisfy
 * src/png/chunks.ts's PNG_ORDER structural rules for the intended fixture.
 */
export function pngWithChunksBefore(
  types: readonly (readonly [string, Buffer])[],
): Buffer {
  return png([
    pngChunk("IHDR", pngIhdr()),
    ...types.map(([type, data]) => pngChunk(type, data)),
    pngChunk("IDAT", pngIdat()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG `iCCP` chunk payload: profile name, null terminator, compression
 * method (0 = deflate), then the deflated profile bytes. */
export function pngIccp(profile: Buffer, name = "icc"): Buffer {
  return Buffer.concat([
    Buffer.from(name, "latin1"),
    Buffer.from([0]),
    Buffer.from([0]),
    deflateSync(profile),
  ]);
}

/** PNG `cICP` chunk payload: colour primaries, transfer characteristics,
 * matrix coefficients, video full range flag -- one byte each. */
export function pngCicp(
  primaries = 1,
  transfer = 13,
  matrix = 0,
  fullRange = 1,
): Buffer {
  return Buffer.from([primaries, transfer, matrix, fullRange]);
}

/** PNG `sRGB` chunk payload: a single rendering-intent byte (0-3). D-08: this
 * chunk is removed by every request, unconditionally, like `gAMA`. */
export function pngSrgb(renderingIntent = 0): Buffer {
  return Buffer.from([renderingIntent]);
}

/** PNG `mDCv` (Mastering Display Color Volume) chunk payload: three CIE 1931
 * xy chromaticity pairs (RGB primaries) plus white point, each a 2-byte
 * fraction of 0.00002, then 4-byte max/min luminance -- 24 bytes total.
 * Content is opaque to the handler; this is D-05's "keep" list. */
export function pngMdcv(): Buffer {
  const data = Buffer.alloc(24);
  const chromaticities = [34000, 16000, 13250, 34500, 7500, 3000, 15635, 16450];
  chromaticities.forEach((value, index) =>
    data.writeUInt16BE(value, index * 2),
  );
  data.writeUInt32BE(10_000_000, 16); // max display mastering luminance
  data.writeUInt32BE(1, 20); // min display mastering luminance
  return data;
}

/** PNG `cLLi` (Content Light Level Information) chunk payload: max content
 * light level and max frame-average light level, each a 4-byte fraction of
 * 0.0001 cd/m^2 -- 8 bytes total. */
export function pngClli(): Buffer {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(10_000_0000, 0);
  data.writeUInt32BE(4_000_0000, 4);
  return data;
}

/** PNG `caBX` (C2PA) chunk payload: an opaque JUMBF box. The handler never
 * parses its contents -- only its byte length is reported (D-15). */
export function pngCaBX(payload: Buffer): Buffer {
  return payload;
}

export interface ColourFixture {
  readonly id: string;
  readonly build: () => Buffer;
}

/**
 * D-10's nine colour fixtures. Exported from this module (not a `.test.ts`
 * file) so both 56-05's it.each matrix and Plan 08's live-oracle
 * differential test can reuse the same table.
 */
export const COLOUR_FIXTURES: readonly ColourFixture[] = [
  { id: "gama-only", build: () => pngWithChunksBefore([["gAMA", pngGama()]]) },
  { id: "srgb-only", build: () => pngWithChunksBefore([["sRGB", pngSrgb()]]) },
  {
    id: "gama-chrm",
    build: () =>
      pngWithChunksBefore([
        ["gAMA", pngGama()],
        ["cHRM", pngChrm()],
      ]),
  },
  {
    id: "srgb-chrm",
    build: () =>
      pngWithChunksBefore([
        ["sRGB", pngSrgb()],
        ["cHRM", pngChrm()],
      ]),
  },
  {
    id: "iccp-only",
    build: () => pngWithChunksBefore([["iCCP", pngIccp(iccProfileV4())]]),
  },
  {
    id: "iccp-gama-chrm",
    build: () =>
      pngWithChunksBefore([
        ["iCCP", pngIccp(iccProfileV4())],
        ["gAMA", pngGama()],
        ["cHRM", pngChrm()],
      ]),
  },
  { id: "cicp", build: () => pngWithChunksBefore([["cICP", pngCicp()]]) },
  {
    id: "cicp-mdcv-clli",
    build: () =>
      pngWithChunksBefore([
        ["cICP", pngCicp()],
        ["mDCv", pngMdcv()],
        ["cLLi", pngClli()],
      ]),
  },
  { id: "none", build: () => pngWithChunksBefore([]) },
];

export const XMP_ITXT_KEYWORD = "XML:com.adobe.xmp";

/** PNG `iTXt` chunk payload: keyword, compression flag/method, empty
 * language tag and translated keyword, then the (optionally deflated) text. */
export function pngItxt(
  keyword: string,
  text: Buffer,
  compressed = false,
): Buffer {
  const payload = compressed ? deflateSync(text) : text;
  return Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]), // keyword terminator
    Buffer.from([compressed ? 1 : 0]), // compression flag
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + terminator
    Buffer.from([0]), // empty translated keyword + terminator
    payload,
  ]);
}

/**
 * A decompression-bomb chunk payload for `iCCP`, `zTXt`, or a compressed
 * `iTXt` (D-14): a well-formed header (valid keyword/method/flags) around
 * `inflatedBytes` zero bytes, deflated at level 9. The header is intentionally
 * valid so the resulting decline is purely a decompression-bound refusal, not
 * a malformed-structure one.
 */
export function pngBomb(
  type: "iCCP" | "zTXt" | "iTXt",
  inflatedBytes: number,
): Buffer {
  const compressed = deflateSync(Buffer.alloc(inflatedBytes), { level: 9 });
  if (type === "iCCP") {
    return Buffer.concat([
      Buffer.from("bomb", "latin1"),
      Buffer.from([0]), // keyword terminator
      Buffer.from([0]), // compression method
      compressed,
    ]);
  }
  if (type === "zTXt") {
    return Buffer.concat([
      Buffer.from("bomb", "latin1"),
      Buffer.from([0]), // keyword terminator
      Buffer.from([0]), // compression method
      compressed,
    ]);
  }
  return Buffer.concat([
    Buffer.from("bomb", "latin1"),
    Buffer.from([0]), // keyword terminator
    Buffer.from([1]), // compression flag: compressed
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + terminator
    Buffer.from([0]), // empty translated keyword + terminator
    compressed,
  ]);
}

/**
 * Apple's private `iDOT` chunk payload (D-06/D-07): seven big-endian uint32
 * words `[2, 0, height, 40, height/2, height/2, offsetToSecondIdat]`. The
 * last word is the byte distance from the `iDOT` chunk's own start (its
 * length-field position) to the second IDAT segment's chunk start.
 */
export function idotPayload(offsetToSecondIdat: number, height = 4): Buffer {
  const data = Buffer.alloc(28);
  const words = [
    2,
    0,
    height,
    40,
    Math.floor(height / 2),
    Math.floor(height / 2),
    offsetToSecondIdat,
  ];
  words.forEach((word, index) => data.writeUInt32BE(word >>> 0, index * 4));
  return data;
}

/**
 * A synthetic fixture shaped like a real macOS screenshot (56-CONTEXT.md):
 * `IHDR iCCP cICP eXIf pHYs iTXt iDOT IDAT IDAT IEND`. The `iDOT` second-
 * segment offset is computed from the real byte layout, so
 * `idotSecondSegmentTarget()` always lands on the second IDAT chunk's start.
 */
export function screenshotShapedPng(height = 4): Buffer {
  const ihdr = pngChunk("IHDR", pngIhdr(1, height));
  const iccp = pngChunk("iCCP", pngIccp(iccProfileV4()));
  const cicp = pngChunk("cICP", pngCicp());
  const exif = pngChunk("eXIf", exifWithOrientation(1));
  const phys = pngChunk("pHYs", pngPhys());
  const itxt = pngChunk("iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpPacket()));
  const idat1 = pngChunk("IDAT", pngIdat());
  const idat2 = pngChunk("IDAT", Buffer.from("second-idat-segment", "ascii"));
  const iend = pngChunk("IEND", Buffer.alloc(0));

  const IDOT_CHUNK_SPAN = 40; // 8-byte header + 28-byte payload + 4-byte CRC
  const offsetToSecondIdat = IDOT_CHUNK_SPAN + idat1.length;
  const idot = pngChunk("iDOT", idotPayload(offsetToSecondIdat, height));

  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr,
    iccp,
    cicp,
    exif,
    phys,
    itxt,
    idot,
    idat1,
    idat2,
    iend,
  ]);
}

/**
 * Returns the absolute file offset the `iDOT` chunk's second-segment word
 * points at (`idotStart + word[6]`), or undefined when no `iDOT` chunk
 * exists.
 */
export function idotSecondSegmentTarget(file: Buffer): number | undefined {
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (type === "iDOT") {
      const secondSegmentWord = file.readUInt32BE(dataOffset + 24);
      return offset + secondSegmentWord;
    }
    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }
  return undefined;
}

/** The chunk type whose 8-byte header starts exactly at `offset`, or
 * undefined if no chunk starts there. */
export function chunkTypeAt(file: Buffer, offset: number): string | undefined {
  let cursor = 8;
  while (cursor + 8 <= file.length) {
    if (cursor === offset)
      return file.toString("ascii", cursor + 4, cursor + 8);
    const length = file.readUInt32BE(cursor);
    const type = file.toString("ascii", cursor + 4, cursor + 8);
    cursor += 12 + length;
    if (type === "IEND") break;
  }
  return undefined;
}

export function readChunks(file: Buffer): readonly FixtureChunk[] {
  const chunks: FixtureChunk[] = [];
  let offset = 12;
  while (offset < file.length) {
    const fourCc = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const data = file.subarray(offset + 8, offset + 8 + size);
    chunks.push({ fourCc, data });
    offset += 8 + size + (size & 1);
  }
  return chunks;
}
