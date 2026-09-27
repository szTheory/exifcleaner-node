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
