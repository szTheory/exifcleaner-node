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
export declare function createOrientationExif(orientation: number): Buffer;
//# sourceMappingURL=exif.d.ts.map