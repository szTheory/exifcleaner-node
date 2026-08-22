import type { MetadataEntry, MetadataWarning } from "../types.js";
export interface ParsedXmp {
    readonly entries: readonly MetadataEntry[];
    readonly warnings: readonly MetadataWarning[];
}
export declare function parseXmp(payload: Buffer): ParsedXmp;
//# sourceMappingURL=xmp.d.ts.map