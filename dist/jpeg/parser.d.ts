import type { FileHandle } from "node:fs/promises";
import { type JpegRefusal } from "./markers.js";
export declare class JpegStructureError extends Error {
    readonly kind: "malformed-file" | "unsafe-structure";
    readonly refusal: JpegRefusal;
    readonly limit?: {
        segment: string;
        size: number;
        limit: number;
    };
    constructor(refusal: JpegRefusal, message: string, limit?: {
        segment: string;
        size: number;
        limit: number;
    });
}
export interface JpegSegment {
    readonly marker: number;
    readonly offset: number;
    readonly totalLength: number;
    readonly payloadOffset: number;
    readonly payloadLength: number;
    readonly identifier: string | undefined;
    readonly entropyEnd?: number;
}
export interface JpegFrameComponent {
    readonly id: number;
    readonly h: number;
    readonly v: number;
    readonly tq: number;
}
export interface JpegFrame {
    readonly marker: number;
    readonly precision: number;
    readonly height: number;
    readonly width: number;
    readonly components: readonly JpegFrameComponent[];
}
export interface ParsedJpeg {
    readonly segments: readonly JpegSegment[];
    readonly frame: JpegFrame;
    readonly primaryEoiEnd: number;
    readonly trailerBytes: number;
    readonly buffered: ReadonlyMap<number, Buffer>;
}
export declare function isJpegSignature(magic: Buffer): boolean;
/**
 * Parses a JPEG marker stream from an open file handle: SOI, a length-driven single
 * forward pass over marker segments (bounds-checking each declared length as its
 * header is read), the admitted-SOF frame header, one or more SOS scans (each
 * followed by a forward-only entropy-data scan), and the primary EOI. Anything after
 * the primary EOI is the trailer.
 */
export declare function parseJpeg(handle: FileHandle, size: number, signal?: AbortSignal): Promise<ParsedJpeg>;
//# sourceMappingURL=parser.d.ts.map