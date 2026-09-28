import type { MetadataEntry, MetadataWarning } from "../types.js";
export interface ParsedExif {
    readonly entries: readonly MetadataEntry[];
    readonly warnings: readonly MetadataWarning[];
    readonly orientation: {
        readonly status: "absent";
    } | {
        readonly status: "valid";
        readonly value: number;
    } | {
        readonly status: "malformed";
        readonly detail: string;
    } | {
        readonly status: "unsupported";
        readonly detail: string;
    };
}
export declare function parseExif(payload: Buffer): ParsedExif;
/** A single IFD0 X or Y resolution rational, stored exactly as the source held it. */
export interface MinimalExifResolutionValue {
    readonly numerator: number;
    readonly denominator: number;
}
/**
 * D-03: the resolution tags `createMinimalExif` may write. `unit` (IFD0 0x0128
 * ResolutionUnit) is optional; when omitted no ResolutionUnit tag is written.
 */
export interface MinimalExifResolution {
    readonly x: MinimalExifResolutionValue;
    readonly y: MinimalExifResolutionValue;
    readonly unit?: number;
}
/** D-03: the only tags `createMinimalExif` may ever write. */
export interface MinimalExifTags {
    readonly orientation?: number;
    readonly resolution?: MinimalExifResolution;
}
/**
 * D-03: builds a minimal little-endian TIFF/EXIF payload containing only the
 * requested IFD0 tags, in ascending tag order (0x0112 Orientation SHORT,
 * 0x011A XResolution RATIONAL, 0x011B YResolution RATIONAL, 0x0128
 * ResolutionUnit SHORT), with RATIONAL values stored after the IFD block and
 * referenced by offset. No YCbCrPositioning, no ExifIFD pointer, no IFD1, no
 * Software, no DateTime, no other tag. Resolution values are written exactly
 * as given — never derived, reduced or reconciled with JFIF/SPIFF/Photoshop
 * values (D-04).
 *
 * Throws `RangeError` when no tag is requested, or any field is out of range.
 */
export declare function createMinimalExif(tags: MinimalExifTags): Buffer;
export declare function createOrientationExif(orientation: number): Buffer;
/**
 * D-03: reads the raw (unreduced) IFD0 X/YResolution and ResolutionUnit from a
 * TIFF/EXIF payload, without going through `parseExif`'s reduced-rational
 * decode. Returns `undefined` when either X or Y is absent, of the wrong TIFF
 * type/count, or the TIFF is malformed — never throws.
 */
export declare function readIfd0Resolution(tiff: Buffer): MinimalExifResolution | undefined;
//# sourceMappingURL=exif.d.ts.map