import type { MetadataEntry, MetadataWarning } from "../types.js";
export interface ParsedXmp {
    readonly entries: readonly MetadataEntry[];
    readonly warnings: readonly MetadataWarning[];
}
export declare function parseXmp(payload: Buffer): ParsedXmp;
/**
 * D-05: reads a `tiff:Orientation` entry out of an XMP packet for routing
 * purposes only. Returns the value when it parses as an integer 1-8,
 * `"invalid"` when the entry is present but unusable, or `undefined` when no
 * such entry exists. Never returns or forwards XMP bytes — the caller uses
 * the returned value only to decide whether to decline or proceed; it must
 * never reach output.
 */
export declare function xmpOrientation(xmp: Buffer): number | "invalid" | undefined;
//# sourceMappingURL=xmp.d.ts.map