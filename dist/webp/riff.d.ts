import type { FileHandle } from "node:fs/promises";
export declare const RIFF_HEADER_SIZE = 12;
export declare const MAX_BUFFERED_METADATA_BYTES: number;
export declare const MAX_CHUNK_COUNT = 10000;
export declare const MAX_RIFF_BYTES = 4294967294;
export declare const COPY_BLOCK_BYTES: number;
export interface WebpMetadataLimitContext {
    readonly fourCc: "ICCP" | "EXIF" | "XMP ";
    readonly size: number;
    readonly limit: number;
}
export declare class WebpStructureError extends Error {
    readonly kind: "unsupported-format" | "malformed-file" | "unsafe-structure";
    readonly metadataLimit?: WebpMetadataLimitContext;
    constructor(kind: "unsupported-format" | "malformed-file" | "unsafe-structure", message: string, metadataLimit?: WebpMetadataLimitContext);
}
export interface WebpChunk {
    readonly fourCc: string;
    readonly headerOffset: number;
    readonly dataOffset: number;
    readonly size: number;
    readonly paddedSize: number;
    readonly metadata?: Buffer;
}
export interface ParsedWebp {
    readonly fileSize: number;
    readonly chunks: readonly WebpChunk[];
    readonly vp8x?: {
        readonly chunk: WebpChunk;
        readonly data: Buffer;
    };
}
export declare function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer>;
export declare function parseWebp(handle: FileHandle, fileSize: number, signal?: AbortSignal): Promise<ParsedWebp>;
export declare function encodeChunkHeader(fourCc: string, size: number): Buffer;
export declare function encodeRiffHeader(fileSize: number): Buffer;
//# sourceMappingURL=riff.d.ts.map