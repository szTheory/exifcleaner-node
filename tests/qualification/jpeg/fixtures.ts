// Non-test JPEG qualification fixture builders (57-04 Task 1). Lives under
// tests/qualification/jpeg/ per the D-15/D-16 layout gate (a subdirectory file is
// never "flat", so it needs no PENDING_FLAT_FILES entry). Splices synthetic
// segments into a real, parseable JPEG (typically `minimalJpeg()` from
// tests/fixtures.ts) without needing a full re-encode.

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
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
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
