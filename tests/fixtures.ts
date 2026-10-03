import { deflateSync } from "node:zlib";
import { PNG_SIGNATURE, encodePngChunk } from "../src/png/chunks.js";
import { heifFile } from "./isobmff-support/builder.js";

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

/**
 * Builds a structurally-admitted ICC v4 profile (per `validateIccForPreservation`)
 * carrying the canary text inside a second `cprt`/`text` tag, after the default
 * `rTRC` tag. Offsets/sizes stay canonical contiguous ranges with zero padding,
 * since `iccProfileV4` computes them from the tag list and this only writes into
 * the already-zeroed data region past the 8-byte type+reserved tag header. Shared
 * by both WebP's and PNG's qualification generators (56-10) -- the ICC container
 * format and its structural admission are format-neutral.
 */
export function iccCanaryProfile(canaryText: string): Buffer {
  const canary = Buffer.from(canaryText, "ascii");
  const tags = [
    { signature: "rTRC" },
    { signature: "cprt", type: "text", size: 8 + canary.length },
  ] as const;
  const tableEnd = 132 + tags.length * 12;
  const cprtOffset = tableEnd + 1 * 8; // matches iccProfileV4's default per-index offset
  const profile = iccProfileV4({}, tags);
  canary.copy(profile, cprtOffset + 8);
  return profile;
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

/**
 * An XMP packet asserting `tiff:Orientation` as an rdf:Description attribute
 * (D-11/D-12). Read only for routing by `xmpOrientation` -- never written.
 */
export function xmpWithOrientation(value: number | string): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${String(value)}"></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

/**
 * An ImageMagick-style "Raw profile type exif"/"Raw profile type APP1"
 * text-chunk payload wrapping `exif` (D-11/D-12): a newline, the profile
 * name, a newline, a right-aligned decimal byte count, a newline, then hex
 * digits wrapped at 36 bytes (72 hex characters) per line -- matching
 * `rawProfileExifOrientation`'s expected grammar exactly.
 */
export function rawProfileExifText(exif: Buffer): string {
  const hex = exif.toString("hex");
  const lines: string[] = [];
  for (let index = 0; index < hex.length; index += 72) {
    lines.push(hex.slice(index, index + 72));
  }
  const count = String(exif.length).padStart(8, " ");
  return `\nexif\n${count}\n${lines.join("\n")}\n`;
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
        ["mDCV", pngMdcv()],
        ["cLLI", pngClli()],
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
export function screenshotShapedPng(height = 4, orientation = 1): Buffer {
  const ihdr = pngChunk("IHDR", pngIhdr(1, height));
  const iccp = pngChunk("iCCP", pngIccp(iccProfileV4()));
  const cicp = pngChunk("cICP", pngCicp());
  const exif = pngChunk("eXIf", exifWithOrientation(orientation));
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

// JPEG builders (57-03). A minimal but genuinely decodable baseline/progressive
// JPEG, built entropy-code-first so every admitted fixture is real -- never a
// throwaway. Every block's DC/AC coefficients decode to exactly zero (a single
// 1-bit Huffman code per symbol: DC category 0, AC "EOB"), so the quantization
// table's actual values never affect the decoded image (mid-gray, 128 after the
// level shift) and no true bit-packing complexity is needed. `sofMarker` and
// `precision` patching exists to build refusal fixtures (Task 2), which are not
// decodable -- only the default (SOF0/1/2, 8-bit) output is a real, djpeg-decodable
// JPEG.

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** A DHT segment defining one Huffman table with a single 1-bit code "0" for
 * the given single symbol value -- `tableClass` 0 = DC, 1 = AC; `tableId` 0-3. */
function singleCodeHuffmanTable(
  tableClass: 0 | 1,
  tableId: number,
  symbol: number,
): Buffer {
  const bits = Buffer.alloc(16);
  bits[0] = 1; // exactly one 1-bit code
  return Buffer.concat([
    Buffer.from([(tableClass << 4) | tableId]),
    bits,
    Buffer.from([symbol]),
  ]);
}

class JpegBitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private bitCount = 0;

  private emitByte(byte: number): void {
    this.bytes.push(byte);
    if (byte === 0xff) this.bytes.push(0x00); // byte-stuff literal 0xFF data
  }

  writeBit(bit: 0 | 1): void {
    this.current = (this.current << 1) | bit;
    this.bitCount += 1;
    if (this.bitCount === 8) {
      this.emitByte(this.current);
      this.current = 0;
      this.bitCount = 0;
    }
  }

  /** Pads the current partial byte with 1-bits (JPEG's required padding) and
   * flushes it, if a partial byte is pending. */
  padToByte(): void {
    while (this.bitCount !== 0) this.writeBit(1);
  }

  /** Flushes any pending partial byte, then appends a raw marker (e.g. an
   * RSTn restart marker) directly -- never byte-stuffed. */
  appendMarker(marker: number): void {
    this.padToByte();
    this.bytes.push(0xff, marker);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** Encodes `mcuCount` MCUs, each containing `componentsPerMcu` blocks (every
 * block: a 1-bit DC-category-0 code then a 1-bit AC-EOB code), inserting an
 * RSTn restart marker (cycling 0xD0..0xD7) every `restartInterval` MCUs. */
function encodeScanEntropy(
  componentsPerMcu: number,
  mcuCount: number,
  restartInterval?: number,
): Buffer {
  const writer = new JpegBitWriter();
  let sinceRestart = 0;
  let restartIndex = 0;
  for (let mcu = 0; mcu < mcuCount; mcu += 1) {
    for (let component = 0; component < componentsPerMcu; component += 1) {
      writer.writeBit(0); // DC category 0 (diff = 0)
      writer.writeBit(0); // AC EOB (all 63 AC coefficients zero)
    }
    sinceRestart += 1;
    if (
      restartInterval !== undefined &&
      sinceRestart === restartInterval &&
      mcu !== mcuCount - 1
    ) {
      writer.appendMarker(0xd0 + (restartIndex % 8));
      restartIndex += 1;
      sinceRestart = 0;
    }
  }
  writer.padToByte();
  return writer.toBuffer();
}

export interface MinimalJpegOptions {
  readonly components?: 1 | 3 | 4;
  readonly width?: number;
  readonly height?: number;
  readonly sofMarker?: number;
  readonly precision?: number;
  readonly restartInterval?: number;
  readonly scans?: "interleaved" | "per-component";
}

/**
 * Builds a real, decodable flat-grey baseline JPEG (or a patched variant for
 * refusal fixtures): SOI; one DQT (table 0, all ones); SOF (`sofMarker`, default
 * 0xC0) with `precision` (default 8), `width`x`height` (default 8x8) and
 * `components` (default 3; ids 1..N, sampling 1x1, Tq 0); a DHT with DC table 0
 * (one code, category 0) and AC table 0 (one code, EOB); an optional DRI plus
 * RSTn restart markers every `restartInterval` MCUs; one SOS per `scans`; EOI.
 */
export function minimalJpeg({
  components = 3,
  width = 8,
  height = 8,
  sofMarker = 0xc0,
  precision = 8,
  restartInterval,
  scans = "interleaved",
}: MinimalJpegOptions = {}): Buffer {
  const parts: Buffer[] = [JPEG_SOI];

  // DQT: one table, id 0, 8-bit precision, all values 1 (moot -- every
  // coefficient this builder emits is zero, so the quant step never matters).
  const dqtPayload = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]);
  parts.push(jpegSegment(0xdb, dqtPayload));

  // SOF: precision, height, width, component count, then id/sampling/Tq per
  // component.
  const componentIds = Array.from({ length: components }, (_, i) => i + 1);
  const sofPayload = Buffer.alloc(6 + components * 3);
  sofPayload.writeUInt8(precision, 0);
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload.writeUInt8(components, 5);
  componentIds.forEach((id, index) => {
    const base = 6 + index * 3;
    sofPayload.writeUInt8(id, base);
    sofPayload.writeUInt8(0x11, base + 1); // H=1, V=1
    sofPayload.writeUInt8(0, base + 2); // Tq=0
  });
  parts.push(jpegSegment(sofMarker, sofPayload));

  // DHT: DC table 0 (symbol 0x00 = category 0), AC table 0 (symbol 0x00 = EOB).
  const dhtPayload = Buffer.concat([
    singleCodeHuffmanTable(0, 0, 0x00),
    singleCodeHuffmanTable(1, 0, 0x00),
  ]);
  parts.push(jpegSegment(0xc4, dhtPayload));

  if (restartInterval !== undefined) {
    const driPayload = Buffer.alloc(2);
    driPayload.writeUInt16BE(restartInterval, 0);
    parts.push(jpegSegment(0xdd, driPayload));
  }

  const blocksX = Math.ceil(width / 8);
  const blocksY = Math.ceil(height / 8);
  const totalBlocks = blocksX * blocksY;

  if (scans === "interleaved") {
    const sosPayload = Buffer.alloc(1 + components * 2 + 3);
    sosPayload.writeUInt8(components, 0);
    componentIds.forEach((id, index) => {
      const base = 1 + index * 2;
      sosPayload.writeUInt8(id, base);
      sosPayload.writeUInt8(0x00, base + 1); // Td=0, Ta=0
    });
    sosPayload.writeUInt8(0, 1 + components * 2); // Ss
    sosPayload.writeUInt8(63, 1 + components * 2 + 1); // Se
    sosPayload.writeUInt8(0, 1 + components * 2 + 2); // Ah/Al
    parts.push(jpegSegment(0xda, sosPayload));
    parts.push(encodeScanEntropy(components, totalBlocks, restartInterval));
  } else {
    for (const id of componentIds) {
      const sosPayload = Buffer.alloc(1 + 1 * 2 + 3);
      sosPayload.writeUInt8(1, 0);
      sosPayload.writeUInt8(id, 1);
      sosPayload.writeUInt8(0x00, 2);
      sosPayload.writeUInt8(0, 3);
      sosPayload.writeUInt8(63, 4);
      sosPayload.writeUInt8(0, 5);
      parts.push(jpegSegment(0xda, sosPayload));
      parts.push(encodeScanEntropy(1, totalBlocks, restartInterval));
    }
  }

  parts.push(JPEG_EOI);
  return Buffer.concat(parts);
}

// JPEG metadata builders (57-05). Segment payloads only -- `jpegSegment`
// above wraps them in the `0xFFmarker` length-prefixed shape.

const JPEG_EXIF_IDENTIFIER = Buffer.from("Exif\0\0", "ascii");

/** APP0 JFIF payload (14 bytes): "JFIF\0", version 1.1, a density unit (1 =
 * dots per inch), X/Y density, and no embedded thumbnail. */
export function jpegJfif(xDensity = 72, yDensity = 72): Buffer {
  const data = Buffer.alloc(9);
  data[0] = 1; // version major
  data[1] = 1; // version minor
  data[2] = 1; // units: dots per inch
  data.writeUInt16BE(xDensity, 3);
  data.writeUInt16BE(yDensity, 5);
  data[7] = 0; // thumbnail width
  data[8] = 0; // thumbnail height
  return Buffer.concat([Buffer.from("JFIF\0", "ascii"), data]);
}

/**
 * A bare (no "Exif\0\0" prefix) little-endian TIFF/EXIF payload carrying a
 * single IFD0 Artist tag (ASCII, external value) -- no Orientation, no
 * resolution. Mirrors `exifWithOrientation`'s layout shape (WebP/PNG builder
 * above) for a single-entry IFD with an out-of-line value.
 */
export function exifWithArtist(text = "private workflow"): Buffer {
  const valueBytes = Buffer.from(`${text}\0`, "ascii");
  const ifdBytes = 2 + 1 * 12 + 4; // count(2) + one 12-byte entry + next-IFD(4)
  const dataOffset = 8 + ifdBytes;
  const result = Buffer.alloc(dataOffset + valueBytes.length);
  result.write("II", 0, 2, "ascii");
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(8, 4);
  result.writeUInt16LE(1, 8); // one IFD0 entry

  result.writeUInt16LE(0x013b, 10); // Artist
  result.writeUInt16LE(2, 12); // type: ASCII
  result.writeUInt32LE(valueBytes.length, 14);
  result.writeUInt32LE(dataOffset, 18);

  result.writeUInt32LE(0, 8 + ifdBytes - 4); // next-IFD offset: none
  valueBytes.copy(result, dataOffset);
  return result;
}

/** APP1 Exif payload: the "Exif\0\0" identifier prefix plus a bare TIFF body. */
export function jpegExif(tiff: Buffer): Buffer {
  return Buffer.concat([JPEG_EXIF_IDENTIFIER, tiff]);
}

/** APP13 Photoshop 3.0 Image Resources payload. Content is opaque to the
 * handler (every APP13 segment is removed unconditionally, D-01); this is
 * just a realistic-shaped identifier prefix. */
export function jpegPhotoshop(): Buffer {
  return Buffer.from("Photoshop 3.0\0", "ascii");
}

/** APP14 Adobe payload (12 bytes): "Adobe" (no NUL), DCTEncodeVersion 100,
 * APP14Flags0/1 zero, then the given ColorTransform byte. */
export function jpegAdobe(transform = 1): Buffer {
  const data = Buffer.alloc(7);
  data.writeUInt16BE(100, 0);
  data.writeUInt16BE(0, 2);
  data.writeUInt16BE(0, 4);
  data[6] = transform;
  return Buffer.concat([Buffer.from("Adobe", "ascii"), data]);
}

/**
 * A JPEG carrying APP0 JFIF (72 dpi), APP1 Exif (Artist "private workflow",
 * no Orientation or resolution), APP13 Photoshop 3.0, APP14 Adobe (transform
 * 1) and a COM "private comment", in that order after SOI -- 57-05's
 * QUALIFICATION_FORMATS.jpeg sample.
 */
export function metadataJpeg(): Buffer {
  const base = minimalJpeg({ components: 3 });
  return Buffer.concat([
    base.subarray(0, 2),
    jpegSegment(0xe0, jpegJfif()),
    jpegSegment(0xe1, jpegExif(exifWithArtist("private workflow"))),
    jpegSegment(0xed, jpegPhotoshop()),
    jpegSegment(0xee, jpegAdobe(1)),
    jpegSegment(0xfe, Buffer.from("private comment", "ascii")),
    base.subarray(2),
  ]);
}

/** HEIF Exif item payload: a 4-byte `exif_tiff_header_offset` of 0, then a bare TIFF body. */
function heifExifItem(tiff: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), tiff]);
}

function metadataHeif(
  majorBrand: string,
  compatibleBrands: readonly string[],
  primaryItemType: string,
): Buffer {
  return heifFile({
    majorBrand,
    compatibleBrands,
    primary: {
      itemId: 1,
      itemType: primaryItemType,
      width: 1,
      height: 1,
      payload: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    },
    exif: {
      itemId: 2,
      payload: heifExifItem(exifWithArtist("private workflow")),
    },
    mime: {
      itemId: 3,
      contentType: "application/rdf+xml",
      payload: xmpPacket("private workflow"),
    },
  });
}

/**
 * An admitted HEIC (ftyp heic, compatible mif1/heic) carrying an Exif item (Artist "private
 * workflow") and an XMP `mime` item, so removal is observable -- 62.1-07's
 * QUALIFICATION_FORMATS.heic sample.
 */
export function metadataHeic(): Buffer {
  return metadataHeif("heic", ["mif1", "heic"], "hvc1");
}

/**
 * An admitted AVIF (ftyp avif, compatible mif1/avif) carrying the same Exif and XMP items --
 * 62.1-07's QUALIFICATION_FORMATS.avif sample.
 */
export function metadataAvif(): Buffer {
  return metadataHeif("avif", ["mif1", "avif"], "av01");
}
