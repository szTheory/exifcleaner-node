export declare const STANDARD_XMP_IDENTIFIER = "http://ns.adobe.com/xap/1.0/";
export declare const EXTENDED_XMP_IDENTIFIER = "http://ns.adobe.com/xmp/extension/";
export type ExtendedXmpResult = {
    readonly status: "absent";
} | {
    readonly status: "complete";
    readonly xmp: Buffer;
} | {
    readonly status: "incomplete";
    readonly detail: string;
};
/**
 * Reassembles the ExtendedXMP chunks naming the GUID a standard XMP packet's
 * `xmpNote:HasExtendedXMP` declares. Chunks of any other GUID are ignored.
 * Requires a consistent declared full length at or below
 * `JPEG_MAX_EXTENDED_XMP_BYTES` and exact, non-overlapping coverage of
 * `0..fullLength` before allocating any output buffer -- coverage is proven by
 * a running byte count, never by allocating the declared full length up
 * front.
 */
export declare function reassembleExtendedXmp(standardXmp: Buffer, extensionPayloads: readonly Buffer[]): ExtendedXmpResult;
//# sourceMappingURL=xmp.d.ts.map