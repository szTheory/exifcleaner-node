import type { FormatAdmission, FormatHandler } from "./handler.js";
import { type ParsedPng, type PngChunk } from "../png/chunks.js";
export type PngChunkClass = "keep" | "remove" | "conditional-color" | "conditional-resolution";
export declare const PNG_PRESERVED_CHUNK_TYPES: ReadonlySet<string>;
export declare const PNG_REMOVED_CHUNK_TYPES: ReadonlySet<string>;
export type PngConditionalChunkKind = "colorProfile" | "resolution";
export declare const PNG_CONDITIONAL_CHUNK_TYPES: ReadonlyMap<string, PngConditionalChunkKind>;
export interface PngAdmission extends FormatAdmission {
    readonly parsed: ParsedPng;
    /** One classification per entry in `parsed.chunks`, same index order. */
    readonly classes: readonly PngChunkClass[];
}
export type PngOutputPlanPart = {
    readonly kind: "copy";
    readonly sourceOffset: number;
    readonly length: number;
} | {
    readonly kind: "insert";
    readonly data: Buffer;
};
export interface PngOutputPlan {
    readonly parts: readonly PngOutputPlanPart[];
    readonly expectedTypes: readonly string[];
    readonly copiedChunks: readonly PngChunk[];
}
export declare const pngHandler: FormatHandler<PngAdmission, PngOutputPlan>;
//# sourceMappingURL=png-handler.d.ts.map