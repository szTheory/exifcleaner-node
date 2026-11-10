import { type MinimalExifResolution } from "../metadata/exif.js";
import type { FormatAdmission, FormatHandler } from "./handler.js";
import { type ParsedWebp, type WebpChunk } from "../webp/riff.js";
export interface WebpOutputChunk {
    readonly fourCc: string;
    readonly size: number;
    readonly source?: WebpChunk;
    readonly data?: Buffer;
}
export interface WebpAdmission extends FormatAdmission {
    readonly parsed: ParsedWebp;
    /** The raw IFD0 XResolution/YResolution/ResolutionUnit of the source EXIF chunk, when complete. */
    readonly sourceResolution: MinimalExifResolution | undefined;
}
export type WebpOutputPlan = readonly WebpOutputChunk[];
export declare function webpOutputSize(plan: readonly WebpOutputChunk[]): number;
export declare const webpHandler: FormatHandler<WebpAdmission, WebpOutputPlan>;
//# sourceMappingURL=webp-handler.d.ts.map