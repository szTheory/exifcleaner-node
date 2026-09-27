import { createHash } from "node:crypto";
import type { DifferentialProfile } from "../kit/oracles.js";

// JPEG's differential-oracle profile (57-05 tracer slice). Deliberately does
// not import anything from src/jpeg (the oracle and the handler must
// independently agree a profile is clean, never share one implementation --
// mirrors png/oracles.ts's own T-56-50 rationale). `permittedKinds` stays
// empty until 57-09 measures JPEG's own preservation grants.

export const JPEG_EXTENSION = ".jpg";

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Walks a JPEG marker stream (its own small length-driven parse, independent
 * of `src/jpeg/parser.ts`) and returns the sha256 of the reassembled APP2
 * `ICC_PROFILE` payload (concatenated in declared-sequence order), or
 * undefined when no such segment is present or the profile is inconsistent.
 * Only ever reads length-prefixed segment headers -- an entropy-coded scan's
 * internal bytes are never interpreted as a marker, so this walker stops
 * bounds-checking at the first SOS and returns whatever it has reassembled by
 * then (ICC_PROFILE segments always precede the frame's scan data in every
 * fixture and real-world encoder this oracle is measured against).
 */
export function jpegRawColorProfileSha256(input: Buffer): string | undefined {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    return undefined;
  }
  const identifier = Buffer.from("ICC_PROFILE\0", "ascii");
  const bySequence = new Map<number, Buffer>();
  let declaredCount: number | undefined;
  let offset = 2;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return undefined;
    const marker = input[offset + 1]!;
    if (marker === 0xd9 /* EOI */) break;
    if (marker === 0xda /* SOS */) break;
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = input.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > input.length) return undefined;
    const payloadOffset = offset + 4;
    const payloadLength = length - 2;
    if (
      marker === 0xe2 /* APP2 */ &&
      payloadLength >= identifier.length + 2 &&
      input
        .subarray(payloadOffset, payloadOffset + identifier.length)
        .equals(identifier)
    ) {
      const sequence = input.readUInt8(payloadOffset + identifier.length);
      const count = input.readUInt8(payloadOffset + identifier.length + 1);
      if (sequence === 0 || count === 0 || sequence > count) return undefined;
      if (declaredCount === undefined) declaredCount = count;
      else if (declaredCount !== count) return undefined;
      if (bySequence.has(sequence)) return undefined;
      bySequence.set(
        sequence,
        input.subarray(
          payloadOffset + identifier.length + 2,
          payloadOffset + payloadLength,
        ),
      );
    }
    offset = payloadOffset + payloadLength;
  }

  if (declaredCount === undefined) return undefined;
  const chunks: Buffer[] = [];
  for (let sequence = 1; sequence <= declaredCount; sequence += 1) {
    const chunk = bySequence.get(sequence);
    if (chunk === undefined) return undefined;
    chunks.push(chunk);
  }
  return digest(Buffer.concat(chunks));
}

export const jpegDifferentialProfile: DifferentialProfile = {
  format: "jpeg",
  extension: JPEG_EXTENSION,
  rawColorProfileSha256: jpegRawColorProfileSha256,
  // 57-09 fills this once JPEG's own preservation grants (orientation,
  // color profile, resolution) are measured against ExifTool.
  permittedKinds: [],
};

export interface JpegMarkerWalk {
  /** Ordered one-byte marker codes seen between SOI and the first EOI
   * (SOI/EOI/RSTn excluded; SOS is included once per scan, its
   * entropy-coded data skipped rather than interpreted). */
  readonly markers: readonly number[];
  /** Bytes after the first EOI (`57-07` tracer: 0 proves the primary-EOI
   * truncation cleanly removed any trailer/MPF/motion-photo payload). */
  readonly trailerBytes: number;
}

/**
 * Independent JPEG marker walker (57-07 tracer companion). Deliberately does
 * not import anything from `src/jpeg/parser.ts` -- the oracle and the
 * handler must independently agree on a sanitized output's shape, never
 * share one implementation (mirrors `jpegRawColorProfileSha256` above and
 * png/oracles.ts's own T-56-50 rationale). Walks the length-prefixed marker
 * segments from just after SOI, skips each SOS's entropy-coded scan data by
 * scanning for the next non-stuffed, non-restart marker byte, and stops at
 * the first EOI.
 */
export function jpegMarkerSequence(bytes: Buffer): JpegMarkerWalk {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("jpegMarkerSequence: not a JPEG (missing SOI).");
  }
  const markers: number[] = [];
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      throw new Error(
        `jpegMarkerSequence: expected a marker prefix byte at offset ${offset}.`,
      );
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 /* EOI */) {
      return { markers, trailerBytes: bytes.length - (offset + 2) };
    }
    if (marker >= 0xd0 && marker <= 0xd7 /* stray RSTn, never expected here */) {
      offset += 2;
      continue;
    }
    if (marker === 0xda /* SOS */) {
      markers.push(marker);
      const length = bytes.readUInt16BE(offset + 2);
      offset += 2 + length;
      for (;;) {
        while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
        if (offset >= bytes.length - 1) {
          throw new Error(
            "jpegMarkerSequence: truncated entropy-coded data (no EOI found).",
          );
        }
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      continue;
    }
    markers.push(marker);
    const length = bytes.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("jpegMarkerSequence: no EOI found.");
}
