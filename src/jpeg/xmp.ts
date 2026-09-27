// JPEG ExtendedXMP reassembly (Adobe XMP Part 3, D-05). Read-only: its only
// consumer is the orientation check (xmpOrientation in src/metadata/xmp.ts). It
// never returns bytes into any output path -- JPG-01 removes all XMP outright.

import { JPEG_MAX_EXTENDED_XMP_BYTES } from "./markers.js";
import { parseXmp } from "../metadata/xmp.js";

export const STANDARD_XMP_IDENTIFIER = "http://ns.adobe.com/xap/1.0/";
export const EXTENDED_XMP_IDENTIFIER = "http://ns.adobe.com/xmp/extension/";

const HAS_EXTENDED_XMP_NAME = "xmpNote:HasExtendedXMP";
const GUID_BYTES = 32;
// 4-byte full length + 4-byte chunk offset (Adobe XMP Part 3).
const CHUNK_HEADER_BYTES = 8;
// "http://ns.adobe.com/xmp/extension/\0" -- the raw APPn payload's identifier
// prefix, present because `extensionPayloads` are buffered by `parseJpeg` with
// their identifier intact (same convention as ICC segment payloads in icc.ts).
const EXTENDED_XMP_IDENTIFIER_PREFIX_BYTES = EXTENDED_XMP_IDENTIFIER.length + 1;

export type ExtendedXmpResult =
  | { readonly status: "absent" }
  | { readonly status: "complete"; readonly xmp: Buffer }
  | { readonly status: "incomplete"; readonly detail: string };

interface ExtendedXmpChunk {
  readonly guid: string;
  readonly fullLength: number;
  readonly offset: number;
  readonly data: Buffer;
}

function parseExtendedXmpChunk(
  payload: Buffer,
): ExtendedXmpChunk | undefined {
  const base = EXTENDED_XMP_IDENTIFIER_PREFIX_BYTES;
  if (payload.length < base + GUID_BYTES + CHUNK_HEADER_BYTES) {
    return undefined;
  }
  const guid = payload.toString("ascii", base, base + GUID_BYTES);
  const fullLength = payload.readUInt32BE(base + GUID_BYTES);
  const offset = payload.readUInt32BE(base + GUID_BYTES + 4);
  const data = payload.subarray(base + GUID_BYTES + CHUNK_HEADER_BYTES);
  return { guid, fullLength, offset, data };
}

/**
 * Reads the ExtendedXMP GUID a standard XMP packet names via a bounded
 * attribute/element match over `parseXmp` output -- never a regex over raw
 * bytes larger than the packet. Returns `undefined` when no valid 32-character
 * GUID is present.
 */
function findHasExtendedXmpGuid(standardXmp: Buffer): string | undefined {
  const { entries } = parseXmp(standardXmp);
  const entry = entries.find((item) => item.name === HAS_EXTENDED_XMP_NAME);
  if (entry === undefined) return undefined;
  const value = entry.value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === GUID_BYTES ? trimmed : undefined;
}

/**
 * Reassembles the ExtendedXMP chunks naming the GUID a standard XMP packet's
 * `xmpNote:HasExtendedXMP` declares. Chunks of any other GUID are ignored.
 * Requires a consistent declared full length at or below
 * `JPEG_MAX_EXTENDED_XMP_BYTES` and exact, non-overlapping coverage of
 * `0..fullLength` before allocating any output buffer -- coverage is proven by
 * a running byte count, never by allocating the declared full length up
 * front.
 */
export function reassembleExtendedXmp(
  standardXmp: Buffer,
  extensionPayloads: readonly Buffer[],
): ExtendedXmpResult {
  const guid = findHasExtendedXmpGuid(standardXmp);
  if (guid === undefined) return { status: "absent" };

  const matching: ExtendedXmpChunk[] = [];
  for (const payload of extensionPayloads) {
    const chunk = parseExtendedXmpChunk(payload);
    if (chunk !== undefined && chunk.guid === guid) matching.push(chunk);
  }
  if (matching.length === 0) return { status: "absent" };

  const fullLength = matching[0]!.fullLength;
  for (const chunk of matching) {
    if (chunk.fullLength !== fullLength) {
      return {
        status: "incomplete",
        detail: "ExtendedXMP chunks declare inconsistent full lengths.",
      };
    }
  }
  if (fullLength > JPEG_MAX_EXTENDED_XMP_BYTES) {
    return {
      status: "incomplete",
      detail: `ExtendedXMP declared full length ${fullLength} exceeds the ${JPEG_MAX_EXTENDED_XMP_BYTES}-byte limit.`,
    };
  }

  const sorted = [...matching].sort((left, right) => left.offset - right.offset);
  let coveredTo = 0;
  for (const chunk of sorted) {
    if (chunk.offset > coveredTo) {
      return {
        status: "incomplete",
        detail: `ExtendedXMP has a gap before offset ${chunk.offset}.`,
      };
    }
    if (chunk.offset < coveredTo) {
      return {
        status: "incomplete",
        detail: `ExtendedXMP chunks overlap at offset ${chunk.offset}.`,
      };
    }
    coveredTo = chunk.offset + chunk.data.length;
  }
  if (coveredTo !== fullLength) {
    return {
      status: "incomplete",
      detail: `ExtendedXMP coverage (${coveredTo} bytes) does not match its declared full length (${fullLength}).`,
    };
  }

  return { status: "complete", xmp: Buffer.concat(sorted.map((chunk) => chunk.data), fullLength) };
}
