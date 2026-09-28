// JPEG marker-code constants and the T.81 Annex B segment grammar (D-08/D-09/D-10).
// Mirrors src/png/chunks.ts's constants section: pure data, no I/O. Must not import
// anything from src/png or src/webp (57-03 prohibition).

export const SOI = 0xd8;
export const EOI = 0xd9;
export const SOS = 0xda;
export const DQT = 0xdb;
export const DHT = 0xc4;
export const DRI = 0xdd;
export const DNL = 0xdc;
export const DAC = 0xcc;
export const DHP = 0xde;
export const EXP = 0xdf;
export const COM = 0xfe;
/** Reserved for JPEG extensions (never admitted, never a real content marker). */
export const JPG = 0xc8;

export const SOF0 = 0xc0;
export const SOF1 = 0xc1;
export const SOF2 = 0xc2;

export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
export const APP14 = 0xee;
export const APP15 = 0xef;
export const RST0 = 0xd0;
export const RST7 = 0xd7;
export const JPGN_FIRST = 0xf0;
export const JPGN_LAST = 0xfd;

export function isAppMarker(marker: number): boolean {
  return marker >= APP0 && marker <= APP15;
}

export function isRestartMarker(marker: number): boolean {
  return marker >= RST0 && marker <= RST7;
}

// D-08/D-09: the admit list is fixed in code, never derived from the pixel oracle.
// SOF0 (baseline), SOF1 (extended sequential Huffman), SOF2 (progressive). SOF9
// (arithmetic baseline) is deliberately excluded per D-09/Pitfall 7, even though the
// local libjpeg-turbo oracle can decode it.
export const JPEG_ADMITTED_SOF_MARKERS: ReadonlySet<number> = Object.freeze(
  new Set([0xc0, 0xc1, 0xc2]),
);

export type JpegRefusal =
  | "malformed-container"
  | "truncation"
  | "undefined-table-reference"
  | "lossless-frame"
  | "hierarchical-frame"
  | "arithmetic-frame"
  | "non-t81-frame"
  | "non-8-bit-precision"
  | "unsupported-component-count"
  | "dnl-marker"
  | "resource-limits"
  // Task 3 / D-13: a measured-unsafe trailer class (57-EVIDENCE.md "Full
  // MPF/motion/trailer decision table"). Only classes the measurement records
  // `refuse` map to this literal -- see src/jpeg/trailer.ts
  // JPEG_REFUSED_TRAILER_CLASSES for the exact set and its citation.
  | "mpf-secondary-image";

// D-09/D-10: malformed-container and truncation are well-formed-JSON-schema-style
// violations (bad SOI/EOI/length/marker); every other refusal literal is a
// structural-safety decline (unsupported frame class or a resource cap).
export const JPEG_REFUSAL_KIND: Readonly<
  Record<JpegRefusal, "malformed-file" | "unsafe-structure">
> = Object.freeze({
  "malformed-container": "malformed-file",
  truncation: "malformed-file",
  "undefined-table-reference": "unsafe-structure",
  "lossless-frame": "unsafe-structure",
  "hierarchical-frame": "unsafe-structure",
  "arithmetic-frame": "unsafe-structure",
  "non-t81-frame": "unsafe-structure",
  "non-8-bit-precision": "unsafe-structure",
  "unsupported-component-count": "unsafe-structure",
  "dnl-marker": "unsafe-structure",
  "resource-limits": "unsafe-structure",
  "mpf-secondary-image": "unsafe-structure",
});

// One fixed detail sentence per refusal literal (D-09/D-10, Task 2). Used as the
// JpegStructureError message prefix so tests can assert the refusal class from the
// message alone.
export const JPEG_REFUSAL_DETAILS: Readonly<Record<JpegRefusal, string>> =
  Object.freeze({
    "malformed-container": "JPEG marker stream is malformed.",
    truncation: "JPEG file is truncated.",
    "undefined-table-reference":
      "A scan references a DQT/DHT table slot that was never defined.",
    "lossless-frame": "JPEG lossless frames (SOF3) are refused.",
    "hierarchical-frame":
      "JPEG hierarchical frames (SOF5-SOF7, DHP, EXP) are refused.",
    "arithmetic-frame":
      "JPEG arithmetic-coded frames (SOF9-SOF11, SOF13-SOF15, DAC) are refused.",
    "non-t81-frame":
      "JPEG frames outside ITU-T T.81 (JPG, JPGn including JPEG-LS) are refused.",
    "non-8-bit-precision":
      "JPEG frames with a sample precision other than 8 bits are refused.",
    "unsupported-component-count":
      "JPEG frames with a component count other than 1, 3 or 4 are refused.",
    "dnl-marker":
      "JPEG files using the DNL mechanism (a zero frame height or a DNL marker) are refused.",
    "resource-limits":
      "JPEG structure exceeds a census-derived resource limit.",
    "mpf-secondary-image":
      "JPEG carries a measured-unsafe MPF secondary image or gain-map trailer.",
  });

export type MarkerKind =
  | "soi"
  | "eoi"
  | "sos"
  | "dqt"
  | "dht"
  | "dri"
  | "sof-admitted"
  | "app"
  | "com"
  | "restart";

export type MarkerClassification =
  | { readonly admitted: true; readonly kind: MarkerKind }
  | { readonly admitted: false; readonly refusal: JpegRefusal };

/**
 * Classifies every 0x00..0xFF marker byte exactly once against the closed
 * D-08/D-09/D-10 admit/refuse table -- an exhaustive switch so no code falls
 * through to "admit" by default (D-09/T-57-12). 0xFF fill bytes and 0x00 stuffed
 * data never reach this function; the caller resolves the real marker code first.
 */
export function classifyMarker(marker: number): MarkerClassification {
  if (marker === SOI) return { admitted: true, kind: "soi" };
  if (marker === EOI) return { admitted: true, kind: "eoi" };
  if (marker === SOS) return { admitted: true, kind: "sos" };
  if (marker === DQT) return { admitted: true, kind: "dqt" };
  if (marker === DHT) return { admitted: true, kind: "dht" };
  if (marker === DRI) return { admitted: true, kind: "dri" };
  if (marker === DNL) return { admitted: false, refusal: "dnl-marker" };
  if (marker === DAC) return { admitted: false, refusal: "arithmetic-frame" };
  if (marker === DHP) return { admitted: false, refusal: "hierarchical-frame" };
  if (marker === EXP) return { admitted: false, refusal: "hierarchical-frame" };
  if (marker === COM) return { admitted: true, kind: "com" };
  if (marker >= APP0 && marker <= APP15) return { admitted: true, kind: "app" };
  if (marker >= RST0 && marker <= RST7) {
    return { admitted: true, kind: "restart" };
  }
  if (JPEG_ADMITTED_SOF_MARKERS.has(marker)) {
    return { admitted: true, kind: "sof-admitted" };
  }
  if (marker === 0xc3) return { admitted: false, refusal: "lossless-frame" };
  if (marker === 0xc5 || marker === 0xc6 || marker === 0xc7) {
    return { admitted: false, refusal: "hierarchical-frame" };
  }
  if (marker === JPG) return { admitted: false, refusal: "non-t81-frame" };
  if (
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  ) {
    return { admitted: false, refusal: "arithmetic-frame" };
  }
  if (marker >= JPGN_FIRST && marker <= JPGN_LAST) {
    // Includes 0xF7, JPEG-LS (SOF55).
    return { admitted: false, refusal: "non-t81-frame" };
  }
  // Every other byte (0x01 TEM, 0x02..0xBF reserved) is an unknown non-APPn
  // marker (D-10).
  return { admitted: false, refusal: "malformed-container" };
}

// D-10 census-derived structural caps (57-EVIDENCE.md "Census: structural caps
// (D-10)", 2026-09-27, 7187 host + corpus JPEGs). Never lowered below its derived
// value to make a fixture pass; a file above a cap is a typed pre-write decline
// (resource-limits) that falls back to ExifTool, never a hard failure.

// Rule: next power of two >= 32x census max totalSegments (max=34).
// 57-EVIDENCE: 32*34=1088 -> 2048.
export const JPEG_MAX_SEGMENT_COUNT = 2048;

// Rule: next power of two >= 32x census max maxSosScans (max=14).
// 57-EVIDENCE: 32*14=448 -> 512.
export const JPEG_MAX_SCAN_COUNT = 512;

// Rule: next power of two >= 32x census max dqtDhtSegments (max=9).
// 57-EVIDENCE: 32*9=288 -> 512.
export const JPEG_MAX_TABLE_SEGMENT_COUNT = 512;

// Rule: fixed -- ICC.1 Annex B.4's one-byte sequence-number ceiling. The
// reassembled profile is bounded separately by MAX_PROFILE_BYTES (16 MiB).
// 57-EVIDENCE: 255.
export const JPEG_MAX_ICC_SEGMENTS = 255;

// Rule: fixed -- the PNG_MAX_INFLATED_TEXT_BYTES precedent (census
// extendedXmpSegments max was 0 in this scan, no real-world signal to derive
// from). 57-EVIDENCE: 16 MiB (16,777,216 bytes).
export const JPEG_MAX_EXTENDED_XMP_BYTES = 16 * 1024 * 1024;

// Rule: larger of 512 MiB and the next power of two >= 8x census max fileBytes
// (max=6,721,323 bytes). 57-EVIDENCE: 8*6,721,323=53,770,584 -> next pow2
// 67,108,864 (64 MiB), smaller than the 512 MiB floor -> 512 MiB.
export const JPEG_MAX_FILE_BYTES = 512 * 1024 * 1024;

// WR-01: single source of truth for APPn-prefix classification, shared by
// src/jpeg/parser.ts (decides what gets buffered) and
// src/admission/jpeg-handler.ts (decides what gets removed vs. kept, D-01) so
// the two can never desynchronize on "what's buffered" vs. "what's
// classified" -- previously each file re-implemented the identical prefix
// match with its own locally-declared constants.
export type AppSegmentKind =
  "jfif" | "exif" | "xmp" | "extended-xmp" | "icc" | "mpf" | "adobe" | "other";

const JFIF_ID = Buffer.from("JFIF\0", "ascii");
const EXIF_ID = Buffer.from("Exif\0\0", "ascii");
const XMP_STANDARD_ID = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
const XMP_EXTENDED_ID = Buffer.from(
  "http://ns.adobe.com/xmp/extension/\0",
  "ascii",
);
const ICC_PROFILE_ID = Buffer.from("ICC_PROFILE\0", "ascii");
const MPF_ID = Buffer.from("MPF\0", "ascii");
const ADOBE_ID = Buffer.from("Adobe", "ascii");

function startsWithAppId(payload: Buffer, prefix: Buffer): boolean {
  return (
    payload.length >= prefix.length &&
    payload.subarray(0, prefix.length).equals(prefix)
  );
}

/**
 * Classifies an APPn segment's raw payload by matching its own identifying
 * byte prefix directly -- never the 32-byte NUL-truncated `identifier` field,
 * which can misclassify a genuine Adobe/JFIF/MPF segment if its content bytes
 * happen to place the first NUL byte somewhere other than immediately after
 * the identifier string (ExtendedXMP's real identifier is 36 bytes, past a
 * 32-byte window). `payload` is `undefined` for any segment the caller never
 * buffered; that case always classifies as "other".
 */
export function classifyAppPayload(
  marker: number,
  payload: Buffer | undefined,
): AppSegmentKind {
  if (payload === undefined) return "other";
  if (marker === APP0 && startsWithAppId(payload, JFIF_ID)) return "jfif";
  if (marker === APP1 && startsWithAppId(payload, EXIF_ID)) return "exif";
  if (marker === APP1 && startsWithAppId(payload, XMP_EXTENDED_ID)) {
    return "extended-xmp";
  }
  if (marker === APP1 && startsWithAppId(payload, XMP_STANDARD_ID)) {
    return "xmp";
  }
  if (marker === APP2 && startsWithAppId(payload, ICC_PROFILE_ID)) {
    return "icc";
  }
  if (marker === APP2 && startsWithAppId(payload, MPF_ID)) return "mpf";
  if (marker === APP14 && startsWithAppId(payload, ADOBE_ID)) return "adobe";
  return "other";
}
