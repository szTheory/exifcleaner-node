import type { FileHandle } from "node:fs/promises";
import type { Capabilities, FormatCapabilities } from "../types.js";
declare const HANDLERS: readonly [Readonly<{
    capability: import("../types.js").WebpCapabilities;
    matches(magic: Buffer): boolean;
    admit(handle: FileHandle, size: number, signal?: AbortSignal): Promise<import("./webp-handler.js").WebpAdmission>;
    inspect(admission: import("./webp-handler.js").WebpAdmission): import("../types.js").Inspection;
    buildOutputPlan: (parsed: import("../webp/riff.js").ParsedWebp, preserveOrientation: boolean, preserveColorProfile: boolean, orientation: number | undefined) => readonly import("./webp-handler.js").WebpOutputChunk[];
    writeOutput(source: FileHandle, destination: FileHandle, plan: readonly import("./webp-handler.js").WebpOutputChunk[], signal?: AbortSignal): Promise<void>;
    verifyOutput: (sourceHandle: FileHandle, source: import("../webp/riff.js").ParsedWebp, destinationHandle: FileHandle, destinationSize: number, destinationPath: string, preserveOrientation: boolean, preserveColorProfile: boolean, expectedOrientation: number | undefined, signal?: AbortSignal) => Promise<import("../types.js").Result<void>>;
}>];
export type RegisteredHandler = (typeof HANDLERS)[number];
export declare function getRegisteredCapabilities(): Capabilities;
export declare function getFormatCapabilities(): readonly [
    FormatCapabilities,
    ...FormatCapabilities[]
];
export declare function selectHandler(handle: FileHandle): Promise<RegisteredHandler | undefined>;
export {};
//# sourceMappingURL=registry.d.ts.map