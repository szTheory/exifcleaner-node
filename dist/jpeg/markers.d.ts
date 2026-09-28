export declare const SOI = 216;
export declare const EOI = 217;
export declare const SOS = 218;
export declare const DQT = 219;
export declare const DHT = 196;
export declare const DRI = 221;
export declare const DNL = 220;
export declare const DAC = 204;
export declare const DHP = 222;
export declare const EXP = 223;
export declare const COM = 254;
/** Reserved for JPEG extensions (never admitted, never a real content marker). */
export declare const JPG = 200;
export declare const SOF0 = 192;
export declare const SOF1 = 193;
export declare const SOF2 = 194;
export declare const APP0 = 224;
export declare const APP1 = 225;
export declare const APP2 = 226;
export declare const APP14 = 238;
export declare const APP15 = 239;
export declare const RST0 = 208;
export declare const RST7 = 215;
export declare const JPGN_FIRST = 240;
export declare const JPGN_LAST = 253;
export declare function isAppMarker(marker: number): boolean;
export declare function isRestartMarker(marker: number): boolean;
export declare const JPEG_ADMITTED_SOF_MARKERS: ReadonlySet<number>;
export type JpegRefusal = "malformed-container" | "truncation" | "undefined-table-reference" | "lossless-frame" | "hierarchical-frame" | "arithmetic-frame" | "non-t81-frame" | "non-8-bit-precision" | "unsupported-component-count" | "dnl-marker" | "resource-limits" | "mpf-secondary-image";
export declare const JPEG_REFUSAL_KIND: Readonly<Record<JpegRefusal, "malformed-file" | "unsafe-structure">>;
export declare const JPEG_REFUSAL_DETAILS: Readonly<Record<JpegRefusal, string>>;
export type MarkerKind = "soi" | "eoi" | "sos" | "dqt" | "dht" | "dri" | "sof-admitted" | "app" | "com" | "restart";
export type MarkerClassification = {
    readonly admitted: true;
    readonly kind: MarkerKind;
} | {
    readonly admitted: false;
    readonly refusal: JpegRefusal;
};
/**
 * Classifies every 0x00..0xFF marker byte exactly once against the closed
 * D-08/D-09/D-10 admit/refuse table -- an exhaustive switch so no code falls
 * through to "admit" by default (D-09/T-57-12). 0xFF fill bytes and 0x00 stuffed
 * data never reach this function; the caller resolves the real marker code first.
 */
export declare function classifyMarker(marker: number): MarkerClassification;
export declare const JPEG_MAX_SEGMENT_COUNT = 2048;
export declare const JPEG_MAX_SCAN_COUNT = 512;
export declare const JPEG_MAX_TABLE_SEGMENT_COUNT = 512;
export declare const JPEG_MAX_ICC_SEGMENTS = 255;
export declare const JPEG_MAX_EXTENDED_XMP_BYTES: number;
export declare const JPEG_MAX_FILE_BYTES: number;
//# sourceMappingURL=markers.d.ts.map