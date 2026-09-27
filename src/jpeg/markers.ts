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

export const APP0 = 0xe0;
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
  | "resource-limits";

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
});
