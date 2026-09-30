import type { FileHandle } from "node:fs/promises";
export declare const PNG_SIGNATURE: Buffer<ArrayBuffer>;
export declare const PNG_CHUNK_READ_WINDOW_BYTES: number;
export declare const PNG_CRITICAL_CHUNK_TYPES: ReadonlySet<string>;
export declare const PNG_ANIMATION_CHUNK_TYPES: ReadonlySet<string>;
export declare const PNG_REGISTERED_CHUNK_TYPES: ReadonlySet<string>;
export declare const PNG_MAX_METADATA_BYTES_PER_CHUNK: number;
export declare const PNG_MAX_ANCILLARY_CHUNKS = 10000;
export declare const PNG_MAX_IDAT_CHUNKS = 65536;
type PngOrderClass = "before-plte-and-idat" | "after-plte-before-idat" | "before-idat" | "anywhere";
export declare const PNG_ORDER: ReadonlyMap<string, PngOrderClass>;
export declare function isPngSignature(magic: Buffer): boolean;
export declare function crc32(...parts: readonly Buffer[]): number;
export interface PngLimitContext {
    readonly chunkType: string;
    readonly size: number;
    readonly limit: number;
}
export declare class PngStructureError extends Error {
    readonly kind: "malformed-file" | "unsafe-structure";
    readonly limit?: PngLimitContext;
    constructor(kind: "malformed-file" | "unsafe-structure", message: string, limit?: PngLimitContext);
}
export interface PngChunk {
    readonly type: string;
    readonly offset: number;
    readonly dataOffset: number;
    readonly length: number;
    readonly crc: number;
}
export interface ParsedPng {
    readonly chunks: readonly PngChunk[];
    readonly buffered: ReadonlyMap<number, Buffer>;
}
export declare function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer>;
export declare function encodePngChunk(type: string, data: Buffer): Buffer;
export declare const PNG_MAX_BUFFERED_METADATA_BYTES_TOTAL: number;
export declare class BufferedBudget {
    #private;
    constructor(total: number);
    consumed(): number;
    consume(n: number): void;
}
/**
 * Parses a PNG chunk stream from an open file handle. Checks the 8-byte signature, then
 * walks chunks: reads the 8-byte header, bounds-checks dataOffset + length + 4 <= size,
 * verifies the CRC, and stops after IEND. IDAT data is never buffered: a chunk no larger
 * than the read window gets its CRC from that window (CR-02, 56-16); a longer one is
 * CRC-checked by streaming in bounded 64 KiB reads. Every other chunk's data is buffered for
 * the caller.
 *
 * Task 2 adds the full PNG-03 structural refusal set (type-byte validity, length ceiling,
 * trailing-data, critical/APNG/order/singleton/limit rules) on top of this shape.
 */
export declare function parsePng(handle: FileHandle, size: number, signal?: AbortSignal, budget?: BufferedBudget): Promise<ParsedPng>;
export declare const PNG_MAX_INFLATED_ICC_BYTES: number;
export declare const PNG_MAX_INFLATED_TEXT_BYTES: number;
export declare const PNG_MAX_INFLATED_BYTES_TOTAL: number;
export declare class InflateBudget {
    #private;
    constructor(total: number);
    remaining(): number;
    consume(n: number): void;
}
/**
 * Inflates a zlib-compressed chunk payload under a hard output cap, both per chunk and
 * against a shared per-file aggregate budget. Never trusts a declared uncompressed size;
 * relies solely on zlib's own maxOutputLength enforcement plus a post-inflate size check
 * for the exact-boundary case. An over-cap result or invalid zlib data is always a refusal,
 * never a partial read.
 *
 * The PNG spec defines a compressed field's datastream as the *entire remainder* of the
 * chunk -- there is no length prefix separating the zlib stream from anything after it. A
 * naive `inflateSync` call ignores this: zlib stops consuming input at Z_STREAM_END and
 * silently discards any bytes past it, so an attacker can append arbitrary content after a
 * legitimate profile and have it ride through inflate unnoticed (CR-01). This function
 * therefore requires the whole field to be consumed: `inflateSync(data, { info: true })`
 * reports `engine.bytesWritten`, the number of input bytes actually consumed, which must
 * equal `data.length`. A mismatch is a malformed chunk, refused before any write -- never
 * re-encoded, since native only removes chunks or copies them byte-identical (D-09, SC2).
 */
export declare function inflateBounded(data: Buffer, chunkType: string, perChunkLimit: number, budget: InflateBudget): Buffer;
export {};
//# sourceMappingURL=chunks.d.ts.map