/** ImageMagick's legacy raw-EXIF-profile text-chunk keywords (D-11). */
export declare const RAW_PROFILE_EXIF_KEYWORDS: ReadonlySet<string>;
/**
 * Reads a `tiff:Orientation` entry out of an XMP packet (D-11/D-12). Returns
 * the value when it parses as an integer 1-8, `"invalid"` when the entry is
 * present but unusable, or `undefined` when no such entry exists. Never
 * returns XMP bytes -- only a value for routing.
 */
export declare function xmpOrientation(xmp: Buffer): number | "invalid" | undefined;
/**
 * Parses an ImageMagick-style "Raw profile type exif"/"Raw profile type
 * APP1" text-chunk payload (a newline, the profile name, a newline, a
 * right-aligned decimal byte count, a newline, then hex digits in lines) and
 * reads its embedded EXIF Orientation (D-11/D-12). The declared byte count
 * is bounds-checked against `maxBytes` *before* any hex is decoded (D-14's
 * DoS mitigation for this reader); an over-bound declaration always refuses,
 * independent of any preservation flag. Malformed layout or hex is
 * `malformed-file`. Never returns the decoded bytes -- only a value or
 * absence, for routing.
 */
export declare function rawProfileExifOrientation(text: string, maxBytes: number): number | "invalid" | undefined;
//# sourceMappingURL=orientation-sources.d.ts.map