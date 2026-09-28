// Non-test JPEG qualification fixture builders (57-04 Task 1). Lives under
// tests/qualification/jpeg/ per the D-15/D-16 layout gate (a subdirectory file is
// never "flat", so it needs no PENDING_FLAT_FILES entry). Splices synthetic
// segments into a real, parseable JPEG (typically `minimalJpeg()` from
// tests/fixtures.ts) without needing a full re-encode.

import { iccProfileV4 } from "../../fixtures.js";

const SOI_BYTES = 2;
const SOF_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
const RESTART_FIRST = 0xd0;
const RESTART_LAST = 0xd7;

export const MAX_APP_SEGMENT_PAYLOAD_BYTES = 65_533;

/** Builds one `0xFFmarker` length-prefixed segment (APPn/COM shape: a 2-byte
 * big-endian length counting itself, then the payload). Throws if the payload
 * would make the segment's declared length exceed the 16-bit length field. */
export function appSegment(marker: number, payload: Buffer): Buffer {
  if (payload.length > MAX_APP_SEGMENT_PAYLOAD_BYTES) {
    throw new Error(
      `appSegment payload exceeds ${MAX_APP_SEGMENT_PAYLOAD_BYTES} bytes: ${payload.length}`,
    );
  }
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** Finds the byte offset of the first admitted SOF marker (0xC0/0xC1/0xC2) in a
 * well-formed JPEG produced by `minimalJpeg()`, by walking its length-prefixed
 * segments from just after SOI. Used only by `spliceSegments(..., "before-sof")`;
 * never used on untrusted input (this module is test-fixture-only). */
function findSofOffset(jpeg: Buffer): number {
  let offset = SOI_BYTES;
  while (offset < jpeg.length - 1) {
    if (jpeg[offset] !== 0xff) {
      throw new Error("findSofOffset: expected a marker prefix byte (0xFF).");
    }
    const marker = jpeg[offset + 1] as number;
    if (SOF_MARKERS.has(marker)) return offset;
    if (marker >= RESTART_FIRST && marker <= RESTART_LAST) {
      offset += 2;
      continue;
    }
    const length = jpeg.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("findSofOffset: no SOF marker found.");
}

/**
 * Splices `segments` into `jpeg` at the given `position`: `"after-soi"` (default,
 * right after the 2-byte SOI marker) or `"before-sof"` (right before the first
 * admitted SOF marker).
 */
export function spliceSegments(
  jpeg: Buffer,
  segments: readonly Buffer[],
  position: "after-soi" | "before-sof" = "after-soi",
): Buffer {
  const at = position === "after-soi" ? SOI_BYTES : findSofOffset(jpeg);
  return Buffer.concat([jpeg.subarray(0, at), ...segments, jpeg.subarray(at)]);
}

/**
 * Splits `profile` into `Math.ceil(profile.length / chunkBytes)` APP2
 * ICC_PROFILE segments per ICC.1 Annex B.4: `"ICC_PROFILE\0"`, a 1-based
 * sequence byte, the total count byte, then that chunk's profile bytes. A
 * zero-length profile still produces one (empty-chunk) segment.
 */
export function iccSegments(profile: Buffer, chunkBytes: number): Buffer[] {
  const count = Math.max(1, Math.ceil(profile.length / chunkBytes));
  const identifier = Buffer.from("ICC_PROFILE\0", "ascii");
  const segments: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * chunkBytes;
    const chunk = profile.subarray(
      start,
      Math.min(start + chunkBytes, profile.length),
    );
    const payload = Buffer.concat([
      identifier,
      Buffer.from([index + 1, count]),
      chunk,
    ]);
    segments.push(appSegment(0xe2, payload));
  }
  return segments;
}

/** Appends raw trailer bytes after a JPEG's primary EOI. */
export function appendTrailer(jpeg: Buffer, bytes: Buffer): Buffer {
  return Buffer.concat([jpeg, bytes]);
}

// -----------------------------------------------------------------------------
// Task 3: TS ports of the 57-01 constructed MPF/motion-photo/trailer class
// builders (.planning/phases/57-native-jpeg-and-node-0-3-0/57-reproducers/
// build-fixtures.mjs), parameterized by primary image bytes instead of reading
// Writer.jpg from disk. Byte layout is kept identical to the script so 57-10 can
// feed real Writer.jpg bytes and reproduce the sha256 values 57-EVIDENCE.md
// records.
// -----------------------------------------------------------------------------

/** Deterministic filler bytes -- no Math.random, no Date, so two runs of the
 * same builder produce identical bytes. */
function fillerBytes(n: number, seed: number): Buffer {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) buf[i] = (seed + i * 7) % 256;
  return buf;
}

function identifierPayload(
  identifier: string,
  extra: Buffer = Buffer.alloc(0),
): Buffer {
  return Buffer.concat([
    Buffer.from(identifier, "latin1"),
    Buffer.from([0x00]),
    extra,
  ]);
}

function standardXmpPayload(rdfInner: string): Buffer {
  // "﻿" (UTF-8 BOM, 3 bytes) in the xpacket `begin` attribute matches
  // `build-fixtures.mjs`'s own `standardXmpPayload` exactly (57-11, D-13
  // byte-parity fix: an earlier TS port silently dropped this attribute's
  // value to an empty string, producing google-motion-photo-shape.jpg and
  // gainmap-mpf-hdrgm.jpg 3 bytes short of the sha256 57-EVIDENCE.md
  // recorded -- found live when this plan's own sha256 assertion measured
  // the mismatch).
  const xml =
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    rdfInner +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return identifierPayload(
    "http://ns.adobe.com/xap/1.0/",
    Buffer.from(xml, "utf8"),
  );
}

function googleMotionPhotoXmp(mp4BlobLength: number): Buffer {
  const rdf =
    `<rdf:Description rdf:about="" ` +
    `xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" ` +
    `xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
    `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ` +
    `GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1">` +
    `<Container:Directory><rdf:Seq>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${mp4BlobLength}" Item:Padding="0"/></rdf:li>` +
    `</rdf:Seq></Container:Directory></rdf:Description>`;
  return standardXmpPayload(rdf);
}

function gainmapHdrgmXmp(secondarySize: number): Buffer {
  const rdf =
    `<rdf:Description rdf:about="" ` +
    `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ` +
    `xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
    `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ` +
    `hdrgm:Version="1.0">` +
    `<Container:Directory><rdf:Seq>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>` +
    `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="${secondarySize}" Item:Padding="0"/></rdf:li>` +
    `</rdf:Seq></Container:Directory></rdf:Description>`;
  return standardXmpPayload(rdf);
}

function buildMp4Blob(mdatDataLength: number): Buffer {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write("ftyp", 4, 4, "latin1");
  ftyp.write("isom", 8, 4, "latin1");
  ftyp.writeUInt32BE(0, 12);
  const mdatData = fillerBytes(mdatDataLength, 0x4d);
  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(8 + mdatData.length, 0);
  mdatHead.write("mdat", 4, 4, "latin1");
  return Buffer.concat([ftyp, mdatHead, mdatData]);
}

/** Approximation of the Samsung SEFH/SEFT embedded-picture trailer shape:
 * payload blob, then an SEFH directory, then an SEFT tail naming the
 * directory offset. Not byte-exact to Samsung's proprietary format -- see
 * build-fixtures.mjs's own comment. */
function buildSamsungTrailer(): Buffer {
  const payload = fillerBytes(256, 0x53);
  const sefh = Buffer.alloc(4 + 2 + 4 + 4);
  let o = 0;
  sefh.write("SEFH", o, 4, "latin1");
  o += 4;
  sefh.writeUInt16BE(1, o);
  o += 2;
  sefh.writeUInt32BE(0, o);
  o += 4;
  sefh.writeUInt32BE(payload.length, o);
  const seft = Buffer.alloc(8);
  seft.write("SEFT", 0, 4, "latin1");
  seft.writeUInt32BE(payload.length, 4);
  return Buffer.concat([payload, sefh, seft]);
}

interface MpfSegmentOptions {
  readonly primarySize: number;
  readonly secondaryOffsetFromMpHeader: number;
  readonly secondarySize: number;
}

/** Minimal CIPA DC-007 MP Index IFD (2 entries: primary + one secondary),
 * wrapped in an APP2 `MPF\0` segment. The MP header's byte size is fixed (2
 * entries => 82 bytes) regardless of the values written into it. */
function buildMpfSegmentEntries({
  primarySize,
  secondaryOffsetFromMpHeader,
  secondarySize,
}: MpfSegmentOptions): Buffer {
  const mpHeaderSize = 8 + 2 + 3 * 12 + 4 + 2 * 16;
  const mpHeader = Buffer.alloc(mpHeaderSize);
  let o = 0;
  mpHeader.write("MM", o, 2, "latin1");
  o += 2;
  mpHeader.writeUInt16BE(0x002a, o);
  o += 2;
  mpHeader.writeUInt32BE(8, o);
  o += 4;
  mpHeader.writeUInt16BE(3, o);
  o += 2;
  const entriesStart = 8 + 2;
  const mpEntryArrayOffset = entriesStart + 3 * 12 + 4;

  mpHeader.writeUInt16BE(0xb000, o);
  o += 2;
  mpHeader.writeUInt16BE(7, o);
  o += 2;
  mpHeader.writeUInt32BE(4, o);
  o += 4;
  mpHeader.write("0100", o, 4, "latin1");
  o += 4;

  mpHeader.writeUInt16BE(0xb001, o);
  o += 2;
  mpHeader.writeUInt16BE(4, o);
  o += 2;
  mpHeader.writeUInt32BE(1, o);
  o += 4;
  mpHeader.writeUInt32BE(2, o);
  o += 4;

  mpHeader.writeUInt16BE(0xb002, o);
  o += 2;
  mpHeader.writeUInt16BE(7, o);
  o += 2;
  mpHeader.writeUInt32BE(32, o);
  o += 4;
  mpHeader.writeUInt32BE(mpEntryArrayOffset, o);
  o += 4;

  mpHeader.writeUInt32BE(0, o);
  o += 4;

  const e0 = mpEntryArrayOffset;
  mpHeader.writeUInt32BE(0, e0 + 0);
  mpHeader.writeUInt32BE(primarySize, e0 + 4);
  mpHeader.writeUInt32BE(0, e0 + 8);
  mpHeader.writeUInt16BE(0, e0 + 12);
  mpHeader.writeUInt16BE(0, e0 + 14);

  const e1 = mpEntryArrayOffset + 16;
  mpHeader.writeUInt32BE(0, e1 + 0);
  mpHeader.writeUInt32BE(secondarySize, e1 + 4);
  mpHeader.writeUInt32BE(secondaryOffsetFromMpHeader, e1 + 8);
  mpHeader.writeUInt16BE(0, e1 + 12);
  mpHeader.writeUInt16BE(0, e1 + 14);

  const payload = Buffer.concat([Buffer.from("MPF\0", "latin1"), mpHeader]);
  return appSegment(0xe2, payload);
}

/** A second, real JPEG built from `primary`'s own DQT/SOF/DHT/SOS/entropy
 * bytes (spliced after its SOI), with a distinguishing COM marker so its
 * bytes are never a subset of a sanitized-primary output that reused the
 * same source tables (57-01's measured confound). */
function buildDistinguishableSecondary(
  primary: Buffer,
  markerText: string,
): Buffer {
  const comSeg = appSegment(0xfe, Buffer.from(markerText, "ascii"));
  return spliceSegments(primary, [comSeg]);
}

/** `cipa-mpf-two-images` shape: a real CIPA DC-007 MP Index (2 images) plus a
 * distinguishable secondary JPEG appended as the trailer. */
export function buildCipaMpfTwoImages(primary: Buffer): Buffer {
  const secondary = buildDistinguishableSecondary(
    primary,
    "SECONDARY-IMAGE-MPF-TWO-IMAGES",
  );
  const mpfSegPreview = buildMpfSegmentEntries({
    primarySize: 0,
    secondaryOffsetFromMpHeader: 0,
    secondarySize: secondary.length,
  });
  const mpHeaderStartInSegment = 4 + 4; // marker(2)+length(2) + "MPF\0"(4)
  const primaryTotalLength = primary.length + mpfSegPreview.length;
  const mpHeaderStartAbsolute = 2 + mpHeaderStartInSegment;
  const secondaryDataOffset = primaryTotalLength - mpHeaderStartAbsolute;
  const mpfSeg = buildMpfSegmentEntries({
    primarySize: primaryTotalLength,
    secondaryOffsetFromMpHeader: secondaryDataOffset,
    secondarySize: secondary.length,
  });
  const primaryOut = spliceSegments(primary, [mpfSeg]);
  return appendTrailer(primaryOut, secondary);
}

/** `google-motion-photo-shape`: standard XMP naming a motion-photo container
 * plus an appended `ftyp`/`mdat` MP4 blob (shares no bytes with the
 * primary). */
export function buildGoogleMotionPhotoShape(primary: Buffer): Buffer {
  const mp4Blob = buildMp4Blob(4096);
  const xmpSeg = appSegment(0xe1, googleMotionPhotoXmp(mp4Blob.length));
  const primaryOut = spliceSegments(primary, [xmpSeg]);
  return appendTrailer(primaryOut, mp4Blob);
}

/** `samsung-sefh-seft-trailer`: an SEFH/SEFT-shaped trailer (approximation,
 * see `buildSamsungTrailer`). */
export function buildSamsungSefhSeftTrailer(primary: Buffer): Buffer {
  return appendTrailer(primary, buildSamsungTrailer());
}

/** `gainmap-mpf-hdrgm`: standard XMP naming an Adobe gain-map container plus a
 * real CIPA DC-007 MP Index (2 images) and a distinguishable secondary JPEG
 * trailer. */
export function buildGainmapMpfHdrgm(primary: Buffer): Buffer {
  const secondary = buildDistinguishableSecondary(
    primary,
    "SECONDARY-IMAGE-GAINMAP-HDRGM",
  );
  const mpfSegPreview = buildMpfSegmentEntries({
    primarySize: 0,
    secondaryOffsetFromMpHeader: 0,
    secondarySize: secondary.length,
  });
  const xmpSeg = appSegment(0xe1, gainmapHdrgmXmp(secondary.length));
  const mpHeaderStartInSegment = 4 + 4;
  const primaryTotalLength =
    primary.length + xmpSeg.length + mpfSegPreview.length;
  const mpHeaderStartAbsolute = 2 + xmpSeg.length + mpHeaderStartInSegment;
  const secondaryDataOffset = primaryTotalLength - mpHeaderStartAbsolute;
  const mpfSeg = buildMpfSegmentEntries({
    primarySize: primaryTotalLength,
    secondaryOffsetFromMpHeader: secondaryDataOffset,
    secondarySize: secondary.length,
  });
  const primaryOut = spliceSegments(primary, [xmpSeg, mpfSeg]);
  return appendTrailer(primaryOut, secondary);
}

/** `mpf-index-truncated`: a real MP Index whose declared MPEntry array (2 *
 * 16 bytes) is truncated mid-second-entry -- the segment's own bytes stop 8
 * bytes into it, even though the IFD0 header fields parse cleanly. */
export function buildMpfIndexTruncated(primary: Buffer): Buffer {
  const secondary = primary;
  const mpfSegPreview = buildMpfSegmentEntries({
    primarySize: 0,
    secondaryOffsetFromMpHeader: 0,
    secondarySize: secondary.length,
  });
  const mpHeaderStartInSegment = 4 + 4;
  const primaryTotalLength = primary.length + mpfSegPreview.length;
  const mpHeaderStartAbsolute = 2 + mpHeaderStartInSegment;
  const secondaryDataOffset = primaryTotalLength - mpHeaderStartAbsolute;
  const fullMpfSeg = buildMpfSegmentEntries({
    primarySize: primaryTotalLength,
    secondaryOffsetFromMpHeader: secondaryDataOffset,
    secondarySize: secondary.length,
  });
  const mpEntryArrayOffsetInHeader = 8 + 2 + 3 * 12 + 4;
  const cutPoint = 4 + 4 + mpEntryArrayOffsetInHeader + 16 + 8;
  const truncatedPayload = fullMpfSeg.subarray(4, cutPoint);
  const truncatedSeg = appSegment(0xe2, truncatedPayload);
  return spliceSegments(primary, [truncatedSeg]);
}

/** `mpf-index-out-of-range`: a real MP Index whose secondary entry's
 * `dataOffset` points far past end of file; no real secondary is appended. */
export function buildMpfIndexOutOfRange(primary: Buffer): Buffer {
  const secondary = primary;
  const bogusOffset = 0x7fffffff;
  const mpfSeg = buildMpfSegmentEntries({
    primarySize: primary.length,
    secondaryOffsetFromMpHeader: bogusOffset,
    secondarySize: secondary.length,
  });
  return spliceSegments(primary, [mpfSeg]);
}

// -----------------------------------------------------------------------------
// Plan 57-10: per-identifier segment (D-01), C2PA (D-02) and preservation
// (D-04/D-06) fixture builders, all spliced onto a real Writer.jpg-shaped
// `primary` (`buildSegmentFixture` mirrors `build-fixtures.mjs`'s `segment` +
// `spliceAfterSoi` pair, ported to TS so this plan can commit its output
// bytes and regenerate them byte-identically in a test).
// -----------------------------------------------------------------------------

/** Splices one APPn/COM segment (`marker`, `payload`) right after `primary`'s
 * SOI -- the one-segment-per-identifier shape every D-01 segment-policy
 * fixture shares. */
export function buildSegmentFixture(
  primary: Buffer,
  marker: number,
  payload: Buffer,
): Buffer {
  return spliceSegments(primary, [appSegment(marker, payload)]);
}

/** A JFIF APP0 payload (`build-fixtures.mjs`'s `jfifPayload`, no thumbnail):
 * `"JFIF\0"`, version 1.2 (ExifTool's own default JFIF-write version, so a
 * bare `-all=`-reference differential run needs no JFIFVersion grant), a
 * density unit (1 = dots per inch) and the given X/Y density. */
export function jpegJfifPayload(xDensity = 72, yDensity = 72): Buffer {
  const buf = Buffer.alloc(14);
  buf.write("JFIF\0", 0, 5, "latin1");
  buf[5] = 1; // version major
  buf[6] = 2; // version minor -- matches ExifTool 13.59's own JFIF-write default
  buf[7] = 1; // units: dots per inch
  buf.writeUInt16BE(xDensity, 8);
  buf.writeUInt16BE(yDensity, 10);
  buf[12] = 0; // thumbnail width
  buf[13] = 0; // thumbnail height
  return buf;
}

/** An EXIF APP1 payload carrying only an IFD0 Orientation tag (`"Exif\0\0"` +
 * a minimal big-endian TIFF/IFD0, mirrors `build-fixtures.mjs`'s
 * `exifOrientationPayload`). */
export function jpegExifOrientationPayload(orientation: number): Buffer {
  const buf = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  let o = 0;
  buf.write("Exif\0\0", o, 6, "latin1");
  o += 6;
  buf.write("MM", o, 2, "latin1");
  o += 2;
  buf.writeUInt16BE(0x002a, o);
  o += 2;
  buf.writeUInt32BE(8, o);
  o += 4;
  buf.writeUInt16BE(1, o);
  o += 2;
  buf.writeUInt16BE(0x0112, o);
  o += 2;
  buf.writeUInt16BE(3, o);
  o += 2;
  buf.writeUInt32BE(1, o);
  o += 4;
  buf.writeUInt16BE(orientation, o);
  o += 2;
  buf.writeUInt16BE(0, o);
  o += 2;
  buf.writeUInt32BE(0, o);
  return buf;
}

/** An EXIF APP1 payload carrying only IFD0 X/YResolution + ResolutionUnit
 * (big-endian TIFF/IFD0, ascending tag order, RATIONALs stored after the IFD
 * -- mirrors `src/metadata/exif.ts`'s `createMinimalExif` layout but built
 * independently for fixture construction). */
export function jpegExifResolutionPayload(
  x: number,
  y: number,
  unit: number,
): Buffer {
  const ifdBytes = 2 + 3 * 12 + 4;
  const total = 8 + ifdBytes + 2 * 8;
  const buf = Buffer.alloc(total);
  buf.write("MM", 0, 2, "latin1");
  buf.writeUInt16BE(0x002a, 2);
  buf.writeUInt32BE(8, 4);
  buf.writeUInt16BE(3, 8);
  let rationalOffset = 8 + ifdBytes;
  const entryOffset = (index: number): number => 10 + index * 12;
  // 0x011A XResolution RATIONAL
  buf.writeUInt16BE(0x011a, entryOffset(0));
  buf.writeUInt16BE(5, entryOffset(0) + 2);
  buf.writeUInt32BE(1, entryOffset(0) + 4);
  buf.writeUInt32BE(rationalOffset, entryOffset(0) + 8);
  buf.writeUInt32BE(x, rationalOffset);
  buf.writeUInt32BE(1, rationalOffset + 4);
  rationalOffset += 8;
  // 0x011B YResolution RATIONAL
  buf.writeUInt16BE(0x011b, entryOffset(1));
  buf.writeUInt16BE(5, entryOffset(1) + 2);
  buf.writeUInt32BE(1, entryOffset(1) + 4);
  buf.writeUInt32BE(rationalOffset, entryOffset(1) + 8);
  buf.writeUInt32BE(y, rationalOffset);
  buf.writeUInt32BE(1, rationalOffset + 4);
  rationalOffset += 8;
  // 0x0128 ResolutionUnit SHORT
  buf.writeUInt16BE(0x0128, entryOffset(2));
  buf.writeUInt16BE(3, entryOffset(2) + 2);
  buf.writeUInt32BE(1, entryOffset(2) + 4);
  buf.writeUInt16BE(unit, entryOffset(2) + 8);
  buf.writeUInt32BE(0, 8 + ifdBytes - 4); // next IFD offset
  return Buffer.concat([Buffer.from("Exif\0\0", "ascii"), buf]);
}

/** APP14 Adobe payload (12 bytes): `"Adobe"` (no NUL), DCTEncodeVersion 100,
 * APP14Flags0/1 zero, the given ColorTransform byte -- mirrors
 * `tests/fixtures.ts`'s `jpegAdobe`, ported so this file needs no cross-import
 * from a `describe`-scoped test helper module. */
export function jpegAdobePayload(transform = 1): Buffer {
  const data = Buffer.alloc(7);
  data.writeUInt16BE(100, 0);
  data.writeUInt16BE(0, 2);
  data.writeUInt16BE(0, 4);
  data[6] = transform;
  return Buffer.concat([Buffer.from("Adobe", "ascii"), data]);
}

function jumbfBox(type: string, content: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + content.length, 0);
  head.write(type, 4, 4, "latin1");
  return Buffer.concat([head, content]);
}

function jumdBox(label: string): Buffer {
  const uuid = Buffer.alloc(16, 0x11);
  const toggles = Buffer.from([0x03]);
  const label8 = Buffer.from(`${label}\0`, "latin1");
  return jumbfBox("jumd", Buffer.concat([uuid, toggles, label8]));
}

/** APP11 JUMBF payload carrying a CAI-labelled manifest box (D-01/D-02): `"JP"`
 * + a 2-byte box instance number + a `jumb(jumd(cai) + bfdb(json))` box.
 * Mirrors `build-fixtures.mjs`'s `buildCaiJumbf`. */
export function jpegCaiJumbfPayload(): Buffer {
  const contentJson = Buffer.from(
    JSON.stringify({ note: "constructed CAI test box" }),
    "utf8",
  );
  const contentBox = jumbfBox("bfdb", contentJson);
  const outer = jumbfBox("jumb", Buffer.concat([jumdBox("cai"), contentBox]));
  return Buffer.concat([
    Buffer.from("JP", "latin1"),
    Buffer.from([0x00, 0x01]),
    outer,
  ]);
}

/** APP11 JUMBF payload carrying a nested C2PA manifest/claim/claim-content box
 * structure (D-02): `jumd(c2pa)` -> `jumd(c2ma)` -> `jumd(c2pa.claim)` + a
 * `json` content box. Mirrors `build-fixtures.mjs`'s `buildC2paJumbf`. */
export function jpegC2paJumbfPayload(): Buffer {
  const claimJson = Buffer.from(
    JSON.stringify({
      claim_generator: "exifcleaner-57-10-fixture/1.0",
      assertions: [],
    }),
    "utf8",
  );
  const claimContentBox = jumbfBox("json", claimJson);
  const claimBox = jumbfBox(
    "jumb",
    Buffer.concat([jumdBox("c2pa.claim"), claimContentBox]),
  );
  const c2maBox = jumbfBox("jumb", Buffer.concat([jumdBox("c2ma"), claimBox]));
  return Buffer.concat([
    Buffer.from("JP", "latin1"),
    Buffer.from([0x00, 0x02]),
    jumbfBox("jumb", Buffer.concat([jumdBox("c2pa"), c2maBox])),
  ]);
}

/** APP11 payload carrying a non-JUMBF identifier (D-02 edge: an APP11
 * segment that is not JP/JUMBF-shaped at all -- mirrors the real
 * `HDR_RI`-identified APP11 segment ExifTool.jpg itself carries). */
export function jpegNonJumbfApp11Payload(): Buffer {
  return Buffer.concat([
    Buffer.from("HDR_RI ver=11\n", "ascii"),
    fillerBytes(16, 42),
  ]);
}

/** `preservation-jfif-only`: a JFIF-only source (72dpi) with no EXIF segment
 * at all (D-04(a): native keeps this JFIF byte-identical under
 * `preserveResolution`, synthesizing no EXIF). */
export function buildPreservationJfifOnly(primary: Buffer): Buffer {
  return buildSegmentFixture(primary, 0xe0, jpegJfifPayload(72, 72));
}

/** `preservation-jfif-ifd0-conflict`: JFIF (72dpi) plus a real EXIF IFD0
 * resolution block (300dpi), no Adobe APP14 (D-04(c): both groups are kept
 * independently under `preserveResolution`, with no reconciliation). */
export function buildPreservationJfifIfd0Conflict(primary: Buffer): Buffer {
  const jfifSeg = appSegment(0xe0, jpegJfifPayload(72, 72));
  const exifSeg = appSegment(0xe1, jpegExifResolutionPayload(300, 300, 2));
  return spliceSegments(primary, [jfifSeg, exifSeg]);
}

/** `preservation-adobe-jfif-exif`: Adobe APP14 plus JFIF (72dpi) plus a real
 * EXIF IFD0 resolution block (300dpi) (D-06: JFIF is unconditionally dropped
 * because Adobe is present; IFD0 resolution is kept via the synthesized
 * minimal EXIF). */
export function buildPreservationAdobeJfifExif(primary: Buffer): Buffer {
  const adobeSeg = appSegment(0xee, jpegAdobePayload(1));
  const jfifSeg = appSegment(0xe0, jpegJfifPayload(72, 72));
  const exifSeg = appSegment(0xe1, jpegExifResolutionPayload(300, 300, 2));
  return spliceSegments(primary, [adobeSeg, jfifSeg, exifSeg]);
}

/** One entry per row of 57-EVIDENCE.md's segment-policy table (D-01/D-02):
 * every identifier `-all=` removes, plus the one it keeps (`Adobe`). `id` is
 * this plan's corpus/manifest id suffix (`jpeg-seg-<id>`); `kept` mirrors the
 * evidence table's own disposition, so a fixture whose D-01 disposition is
 * ever measured differently trips the D-01 guard mechanically rather than by
 * a hand-maintained expectation living twice. */
export interface JpegSegmentIdentifierFixture {
  readonly id: string;
  readonly marker: number;
  readonly payload: () => Buffer;
  readonly kept: boolean;
}

export const JPEG_SEGMENT_IDENTIFIER_FIXTURES: readonly JpegSegmentIdentifierFixture[] =
  [
    {
      id: "app0-jfif",
      marker: 0xe0,
      payload: () => jpegJfifPayload(),
      kept: false,
    },
    {
      id: "app0-jfxx",
      marker: 0xe0,
      payload: () => identifierPayload("JFXX", Buffer.from([0x10, 0x00, 0x00])),
      kept: false,
    },
    {
      id: "app0-avi1",
      marker: 0xe0,
      payload: () => identifierPayload("AVI1", fillerBytes(8, 1)),
      kept: false,
    },
    {
      id: "app1-exif",
      marker: 0xe1,
      payload: () => jpegExifOrientationPayload(1),
      kept: false,
    },
    {
      id: "app1-xmp",
      marker: 0xe1,
      payload: () => standardXmpPayload('<rdf:Description rdf:about=""/>'),
      kept: false,
    },
    {
      id: "app1-extended-xmp",
      marker: 0xe1,
      payload: () =>
        identifierPayload(
          "http://ns.adobe.com/xmp/extension/",
          Buffer.concat([
            Buffer.from("0123456789ABCDEF0123456789ABCDEF", "latin1"),
            (() => {
              const chunk = Buffer.from(
                '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>',
                "utf8",
              );
              const head = Buffer.alloc(8);
              head.writeUInt32BE(chunk.length, 0);
              head.writeUInt32BE(0, 4);
              return Buffer.concat([head, chunk]);
            })(),
          ]),
        ),
      kept: false,
    },
    {
      // A real, well-formed single-chunk ICC_PROFILE segment (ICC.1 Annex
      // B.4 shape: identifier, sequence=1, count=1, then a real ICC v4
      // profile) -- not the garbage payload an earlier revision used, which
      // `preserveColorProfile: true` (JPG-03's own payload-identity `.each`
      // exercises every admitted record under both all-flags-false and
      // all-flags-true) correctly refuses as `unsupported-feature` (D-01 is
      // about identifier REMOVAL under bare `-all=`, not about whether an
      // ICC payload is well-formed enough to ever be preserved).
      id: "app2-icc-profile",
      marker: 0xe2,
      payload: () => {
        const profile = iccProfileV4();
        return Buffer.concat([
          Buffer.from("ICC_PROFILE\0", "ascii"),
          Buffer.from([1, 1]),
          profile,
        ]);
      },
      kept: false,
    },
    {
      id: "app2-fpxr",
      marker: 0xe2,
      payload: () => identifierPayload("FPXR", fillerBytes(8, 3)),
      kept: false,
    },
    {
      id: "app2-mpf",
      marker: 0xe2,
      payload: () => identifierPayload("MPF", fillerBytes(8, 4)),
      kept: false,
    },
    {
      id: "app3-meta",
      marker: 0xe3,
      payload: () => identifierPayload("Meta", fillerBytes(8, 5)),
      kept: false,
    },
    {
      id: "app5-rmeta",
      marker: 0xe5,
      payload: () => identifierPayload("RMETA", fillerBytes(8, 6)),
      kept: false,
    },
    {
      id: "app6-eppim",
      marker: 0xe6,
      payload: () => identifierPayload("EPPIM", fillerBytes(8, 7)),
      kept: false,
    },
    {
      id: "app7-qualcomm",
      marker: 0xe7,
      payload: () =>
        identifierPayload(
          "\x1aQualcomm Camera Attributes\x01",
          fillerBytes(4, 8),
        ),
      kept: false,
    },
    {
      id: "app8-spiff",
      marker: 0xe8,
      payload: () => identifierPayload("SPIFF", fillerBytes(8, 9)),
      kept: false,
    },
    {
      id: "app9-media-jukebox",
      marker: 0xe9,
      payload: () => identifierPayload("Media Jukebox", fillerBytes(4, 10)),
      kept: false,
    },
    {
      id: "app10-unicode",
      marker: 0xea,
      payload: () => identifierPayload("UNICODE", fillerBytes(8, 11)),
      kept: false,
    },
    {
      id: "app11-cai",
      marker: 0xeb,
      payload: jpegCaiJumbfPayload,
      kept: false,
    },
    {
      id: "app11-c2pa",
      marker: 0xeb,
      payload: jpegC2paJumbfPayload,
      kept: false,
    },
    {
      id: "app11-non-jumbf",
      marker: 0xeb,
      payload: jpegNonJumbfApp11Payload,
      kept: false,
    },
    {
      id: "app12-ducky",
      marker: 0xec,
      payload: () => identifierPayload("Ducky", fillerBytes(8, 12)),
      kept: false,
    },
    {
      id: "app13-photoshop3",
      marker: 0xed,
      payload: () => identifierPayload("Photoshop 3.0", fillerBytes(8, 13)),
      kept: false,
    },
    {
      id: "app14-adobe",
      marker: 0xee,
      payload: () => jpegAdobePayload(1),
      kept: true,
    },
    {
      id: "app14-not-adobe",
      marker: 0xee,
      payload: () => identifierPayload("NotAdobe", fillerBytes(6, 14)),
      kept: false,
    },
    {
      id: "app15-q70",
      marker: 0xef,
      payload: () => identifierPayload("Q 70", fillerBytes(2, 15)),
      kept: false,
    },
    {
      id: "com",
      marker: 0xfe,
      payload: () => Buffer.from("Test comment", "ascii"),
      kept: false,
    },
    {
      id: "app1-qvci",
      marker: 0xe1,
      payload: () => identifierPayload("QVCI", fillerBytes(8, 16)),
      kept: false,
    },
    {
      id: "app1-myvendor",
      marker: 0xe1,
      payload: () => identifierPayload("MYVENDOR", fillerBytes(8, 17)),
      kept: false,
    },
    {
      id: "app13-not-photoshop",
      marker: 0xed,
      payload: () => identifierPayload("NotPhotoshop", fillerBytes(8, 18)),
      kept: false,
    },
    {
      id: "app1-random1",
      marker: 0xe1,
      payload: () => identifierPayload("Random1", fillerBytes(8, 19)),
      kept: false,
    },
    {
      id: "app12-random-app12",
      marker: 0xec,
      payload: () => identifierPayload("RandomApp12", fillerBytes(8, 20)),
      kept: false,
    },
    {
      id: "app15-random-app15",
      marker: 0xef,
      payload: () => identifierPayload("RandomApp15", fillerBytes(8, 21)),
      kept: false,
    },
  ];
