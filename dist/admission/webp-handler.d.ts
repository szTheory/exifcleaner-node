import type { FileHandle } from "node:fs/promises";
import { parseExif } from "../metadata/exif.js";
import type { Inspection, MetadataEntry, MetadataWarning, Result, WebpCapabilities } from "../types.js";
import { type ParsedWebp, type WebpChunk } from "../webp/riff.js";
type OrientationState = ReturnType<typeof parseExif>["orientation"];
export interface WebpOutputChunk {
    readonly fourCc: string;
    readonly size: number;
    readonly source?: WebpChunk;
    readonly data?: Buffer;
}
export interface WebpAdmission {
    readonly parsed: ParsedWebp;
    readonly entries: readonly MetadataEntry[];
    readonly warnings: readonly MetadataWarning[];
    readonly orientation: OrientationState;
}
declare function buildOutputPlan(parsed: ParsedWebp, preserveOrientation: boolean, preserveColorProfile: boolean, orientation: number | undefined): readonly WebpOutputChunk[];
export declare function webpOutputSize(plan: readonly WebpOutputChunk[]): number;
declare function verifyOutput(sourceHandle: FileHandle, source: ParsedWebp, destinationHandle: FileHandle, destinationSize: number, destinationPath: string, preserveOrientation: boolean, preserveColorProfile: boolean, expectedOrientation: number | undefined, signal?: AbortSignal): Promise<Result<void>>;
export declare const webpHandler: Readonly<{
    capability: WebpCapabilities;
    matches(magic: Buffer): boolean;
    admit(handle: FileHandle, size: number, signal?: AbortSignal): Promise<WebpAdmission>;
    inspect(admission: WebpAdmission): Inspection;
    buildOutputPlan: typeof buildOutputPlan;
    writeOutput(source: FileHandle, destination: FileHandle, plan: readonly WebpOutputChunk[], signal?: AbortSignal): Promise<void>;
    verifyOutput: typeof verifyOutput;
}>;
export {};
//# sourceMappingURL=webp-handler.d.ts.map