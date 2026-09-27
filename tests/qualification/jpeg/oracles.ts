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
