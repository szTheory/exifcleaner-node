import { inflateSync } from "node:zlib";
import { MAX_PROFILE_BYTES } from "../metadata/icc_admission.js";
// PNG chunk-stream codec: signature check, chunk parse/encode, CRC-32, and (Task 2/3)
// the PNG-03 structural refusals plus bounded decompression (D-14). Mirrors
// src/webp/riff.ts's structure (WebpStructureError / readExactly / chunk loop shape).
export const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_HEADER_BYTES = 8;
const CHUNK_HEADER_BYTES = 8; // 4-byte length + 4-byte type
const CHUNK_CRC_BYTES = 4;
const IDAT_STREAM_BLOCK_BYTES = 64 * 1024;
const MAX_CHUNK_LENGTH = 0x7fffffff;
export const PNG_CRITICAL_CHUNK_TYPES = new Set([
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
]);
export const PNG_ANIMATION_CHUNK_TYPES = new Set([
    "acTL",
    "fcTL",
    "fdAT",
]);
// PNG Third Edition (W3C): https://www.w3.org/TR/png/#11Chunks
// PNG extensions registry: https://ftp-osl.osuosl.org/pub/libpng/documents/pngextensions.html
// At minimum this covers IHDR PLTE IDAT IEND, acTL/fcTL/fdAT (APNG, refused not admitted),
// cHRM/cICP/gAMA/iCCP/mDCV/cLLI/sBIT/sRGB/bKGD/hIST/tRNS/eXIf/pHYs/sPLT/tIME/iTXt/tEXt/zTXt/
// oFFs/pCAL/sCAL/gIFg/gIFt/gIFx/sTER/dSIG/fRAc, plus Apple's iDOT/vpAg (measured in D-05/D-07
// as registered-and-order-constrained even though Apple-private). Both the standard
// "mDCV"/"cLLI" casing and the "mDCv"/"cLLi" lower-last-letter casing are admitted
// structurally here (order/singleton rules apply to either spelling if present); the D-05
// preserve-vs-decline split between them is the png-handler.ts admission layer's job, not
// this structural layer's (56-08 D-05 amendment, maintainer-approved 2026-09-26:
// "mDCV"/"cLLI" measured-preserved against ExifTool 13.59, "mDCv"/"cLLi" declines as
// registered-but-unmeasured).
export const PNG_REGISTERED_CHUNK_TYPES = new Set([
    "IHDR",
    "PLTE",
    "IDAT",
    "IEND",
    "acTL",
    "fcTL",
    "fdAT",
    "cHRM",
    "cICP",
    "gAMA",
    "iCCP",
    "mDCV",
    "cLLI",
    "mDCv",
    "cLLi",
    "sBIT",
    "sRGB",
    "bKGD",
    "hIST",
    "tRNS",
    "eXIf",
    "pHYs",
    "sPLT",
    "tIME",
    "iTXt",
    "tEXt",
    "zTXt",
    "oFFs",
    "pCAL",
    "sCAL",
    "iDOT",
    "vpAg",
    "gIFg",
    "gIFt",
    "gIFx",
    "sTER",
    "dSIG",
    "fRAc",
]);
export const PNG_MAX_METADATA_BYTES_PER_CHUNK = 16 * 1024 * 1024;
export const PNG_MAX_ANCILLARY_CHUNKS = 10_000;
// One entry per registered ancillary type. A type absent from this map (including every
// unregistered ancillary type) is "anywhere" by default.
export const PNG_ORDER = new Map([
    ["cHRM", "before-plte-and-idat"],
    ["cICP", "before-plte-and-idat"],
    ["gAMA", "before-plte-and-idat"],
    ["iCCP", "before-plte-and-idat"],
    ["sBIT", "before-plte-and-idat"],
    ["sRGB", "before-plte-and-idat"],
    ["mDCV", "before-plte-and-idat"],
    ["cLLI", "before-plte-and-idat"],
    ["mDCv", "before-plte-and-idat"],
    ["cLLi", "before-plte-and-idat"],
    ["bKGD", "after-plte-before-idat"],
    ["hIST", "after-plte-before-idat"],
    ["tRNS", "after-plte-before-idat"],
    ["pHYs", "before-idat"],
    ["sPLT", "before-idat"],
    ["oFFs", "before-idat"],
    ["pCAL", "before-idat"],
    ["sCAL", "before-idat"],
    ["sTER", "before-idat"],
    ["iDOT", "before-idat"],
    ["vpAg", "before-idat"],
    ["dSIG", "before-idat"],
    ["fRAc", "before-idat"],
    ["gIFg", "before-idat"],
    ["gIFt", "before-idat"],
    ["gIFx", "before-idat"],
    ["tIME", "anywhere"],
    ["tEXt", "anywhere"],
    ["zTXt", "anywhere"],
    ["iTXt", "anywhere"],
    ["eXIf", "anywhere"],
]);
// Singleton chunk types: a second occurrence is unsafe-structure. IDAT is deliberately
// excluded (contiguous runs are required and checked separately).
const SINGLETON_CHUNK_TYPES = new Set([
    "IHDR",
    "PLTE",
    "IEND",
    "cHRM",
    "cICP",
    "gAMA",
    "iCCP",
    "sBIT",
    "sRGB",
    "mDCV",
    "cLLI",
    "mDCv",
    "cLLi",
    "bKGD",
    "hIST",
    "tRNS",
    "pHYs",
    "oFFs",
    "pCAL",
    "sCAL",
    "sTER",
    "tIME",
    "eXIf",
    "iDOT",
    "vpAg",
]);
export function isPngSignature(magic) {
    return (magic.length >= PNG_HEADER_BYTES &&
        magic.subarray(0, PNG_HEADER_BYTES).equals(PNG_SIGNATURE));
}
// CRC-32 (PNG spec Annex D / zlib polynomial). Built in-repo rather than relying on the
// zlib built-in CRC helper, which Node 22.0 and 22.1 lack while package.json engines
// admits >=22.
const CRC32_POLYNOMIAL = 0xedb88320;
let crc32Table;
function getCrc32Table() {
    if (crc32Table !== undefined)
        return crc32Table;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) === 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    crc32Table = table;
    return table;
}
function crc32Init() {
    return 0xffffffff;
}
function crc32Update(crc, data) {
    const table = getCrc32Table();
    let value = crc;
    for (let i = 0; i < data.length; i += 1) {
        value = (table[(value ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
    }
    return value;
}
function crc32Final(crc) {
    return (crc ^ 0xffffffff) >>> 0;
}
export function crc32(...parts) {
    let value = crc32Init();
    for (const part of parts)
        value = crc32Update(value, part);
    return crc32Final(value);
}
export class PngStructureError extends Error {
    kind;
    limit;
    constructor(kind, message, limit) {
        super(message);
        this.name = "PngStructureError";
        this.kind = kind;
        if (limit !== undefined)
            this.limit = limit;
    }
}
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function isAsciiLetter(byte) {
    return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}
function hasValidTypeBytes(typeBuffer) {
    return (typeBuffer.length === 4 &&
        typeBuffer[0] !== undefined &&
        isAsciiLetter(typeBuffer[0]) &&
        typeBuffer[1] !== undefined &&
        isAsciiLetter(typeBuffer[1]) &&
        typeBuffer[2] !== undefined &&
        isAsciiLetter(typeBuffer[2]) &&
        typeBuffer[3] !== undefined &&
        isAsciiLetter(typeBuffer[3]));
}
function isUpperFirstLetter(type) {
    const code = type.charCodeAt(0);
    return code >= 0x41 && code <= 0x5a;
}
/**
 * PNG-03 structural validation, run once every chunk has been read and CRC-verified
 * (Phase 1). Runs over the full chunk list so order/singleton/adjacency rules that need
 * to know the whole file (e.g. "before the first IDAT") don't have to guess the future
 * during a single forward streaming pass.
 */
function validateStructure(chunks) {
    const first = chunks[0];
    if (first === undefined || first.type !== "IHDR") {
        throw new PngStructureError("malformed-file", "PNG must begin with an IHDR chunk.");
    }
    if (first.length !== 13) {
        throw new PngStructureError("malformed-file", "IHDR chunk must be exactly 13 bytes.");
    }
    const last = chunks[chunks.length - 1];
    if (last.type !== "IEND") {
        throw new PngStructureError("malformed-file", "PNG must end with an IEND chunk.");
    }
    if (last.length !== 0) {
        throw new PngStructureError("malformed-file", "IEND chunk must be empty.");
    }
    const firstIdatIndex = chunks.findIndex((item) => item.type === "IDAT");
    const firstPlteIndex = chunks.findIndex((item) => item.type === "PLTE");
    const seenSingleton = new Set();
    let nonIdatCount = 0;
    let sawIdat = false;
    let idatEnded = false;
    for (const [index, item] of chunks.entries()) {
        const { type } = item;
        if (PNG_ANIMATION_CHUNK_TYPES.has(type)) {
            throw new PngStructureError("unsafe-structure", "Animated PNG is not supported.");
        }
        if (isUpperFirstLetter(type) && !PNG_CRITICAL_CHUNK_TYPES.has(type)) {
            throw new PngStructureError("unsafe-structure", `Unknown critical chunk ${type} cannot be sanitized safely.`);
        }
        if (SINGLETON_CHUNK_TYPES.has(type)) {
            if (seenSingleton.has(type)) {
                throw new PngStructureError("unsafe-structure", `Duplicate ${type} chunk is ambiguous.`);
            }
            seenSingleton.add(type);
        }
        if (type === "IDAT") {
            if (idatEnded) {
                throw new PngStructureError("unsafe-structure", "IDAT chunks must be contiguous.");
            }
            sawIdat = true;
        }
        else {
            if (sawIdat)
                idatEnded = true;
            nonIdatCount += 1;
            if (nonIdatCount > PNG_MAX_ANCILLARY_CHUNKS) {
                throw new PngStructureError("unsafe-structure", `PNG contains more than ${PNG_MAX_ANCILLARY_CHUNKS} ancillary chunks.`);
            }
        }
        if (type === "PLTE") {
            if (firstIdatIndex >= 0 && index > firstIdatIndex) {
                throw new PngStructureError("unsafe-structure", "PLTE must occur before the first IDAT chunk.");
            }
            continue;
        }
        if (PNG_CRITICAL_CHUNK_TYPES.has(type))
            continue;
        const orderClass = PNG_ORDER.get(type) ?? "anywhere";
        if (orderClass === "before-plte-and-idat") {
            if ((firstPlteIndex >= 0 && index > firstPlteIndex) ||
                (firstIdatIndex >= 0 && index > firstIdatIndex)) {
                throw new PngStructureError("unsafe-structure", `${type} must occur before PLTE and before the first IDAT chunk.`);
            }
        }
        else if (orderClass === "after-plte-before-idat") {
            if (firstPlteIndex >= 0 && index < firstPlteIndex) {
                throw new PngStructureError("unsafe-structure", `${type} must occur after PLTE.`);
            }
            if (firstIdatIndex >= 0 && index > firstIdatIndex) {
                throw new PngStructureError("unsafe-structure", `${type} must occur before the first IDAT chunk.`);
            }
        }
        else if (orderClass === "before-idat") {
            if (firstIdatIndex >= 0 && index > firstIdatIndex) {
                throw new PngStructureError("unsafe-structure", `${type} must occur before the first IDAT chunk.`);
            }
        }
    }
    if (!sawIdat) {
        throw new PngStructureError("malformed-file", "PNG must contain at least one IDAT chunk.");
    }
}
export async function readExactly(handle, length, position) {
    const result = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
        const next = await handle.read(result, read, length - read, position + read);
        if (next.bytesRead === 0)
            throw new PngStructureError("malformed-file", "Unexpected end of file.");
        read += next.bytesRead;
    }
    return result;
}
async function streamChunkCrc(handle, typeBuffer, dataOffset, length) {
    let crc = crc32Update(crc32Init(), typeBuffer);
    let remaining = length;
    let position = dataOffset;
    while (remaining > 0) {
        const take = Math.min(IDAT_STREAM_BLOCK_BYTES, remaining);
        const block = await readExactly(handle, take, position);
        crc = crc32Update(crc, block);
        position += take;
        remaining -= take;
    }
    return crc32Final(crc);
}
export function encodePngChunk(type, data) {
    const header = Buffer.alloc(CHUNK_HEADER_BYTES);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 4, "ascii");
    const typeBuffer = header.subarray(4, 8);
    const crc = crc32(typeBuffer, data);
    const trailer = Buffer.alloc(CHUNK_CRC_BYTES);
    trailer.writeUInt32BE(crc, 0);
    return Buffer.concat([header, data, trailer]);
}
/**
 * Parses a PNG chunk stream from an open file handle. Checks the 8-byte signature, then
 * walks chunks: reads the 8-byte header, bounds-checks dataOffset + length + 4 <= size,
 * verifies the CRC, and stops after IEND. IDAT data is CRC-checked by streaming in bounded
 * 64 KiB reads and is never buffered; every other chunk's data is buffered for the caller.
 *
 * Task 2 adds the full PNG-03 structural refusal set (type-byte validity, length ceiling,
 * trailing-data, critical/APNG/order/singleton/limit rules) on top of this shape.
 */
export async function parsePng(handle, size, signal) {
    if (isAborted(signal))
        throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    if (!Number.isSafeInteger(size) || size < PNG_HEADER_BYTES) {
        throw new PngStructureError("malformed-file", "File is too small to be a PNG.");
    }
    const magic = await readExactly(handle, PNG_HEADER_BYTES, 0);
    if (!isPngSignature(magic)) {
        throw new PngStructureError("malformed-file", "File signature is not a PNG.");
    }
    const chunks = [];
    const buffered = new Map();
    let offset = PNG_HEADER_BYTES;
    let index = 0;
    let sawIend = false;
    let nonIdatCount = 0;
    while (offset < size) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        if (size - offset < CHUNK_HEADER_BYTES) {
            throw new PngStructureError("malformed-file", "PNG chunk header is truncated.");
        }
        const header = await readExactly(handle, CHUNK_HEADER_BYTES, offset);
        const length = header.readUInt32BE(0);
        const typeBuffer = header.subarray(4, 8);
        if (!hasValidTypeBytes(typeBuffer)) {
            throw new PngStructureError("malformed-file", "Chunk type is not four ASCII letters.");
        }
        const type = typeBuffer.toString("ascii");
        // Count ancillary chunks and refuse as soon as the limit is exceeded, before this
        // chunk's data and CRC are read and before any further chunk is read at all. Checking
        // only in validateStructure (after the whole file is parsed) would let an attacker-sized
        // chunk count force unbounded reads past the limit; this bound holds regardless of how
        // many more chunks the file claims to contain.
        if (type !== "IDAT") {
            nonIdatCount += 1;
            if (nonIdatCount > PNG_MAX_ANCILLARY_CHUNKS) {
                throw new PngStructureError("unsafe-structure", `PNG contains more than ${PNG_MAX_ANCILLARY_CHUNKS} ancillary chunks.`);
            }
        }
        if (length > MAX_CHUNK_LENGTH) {
            throw new PngStructureError("malformed-file", `${type} chunk length exceeds the 2^31-1 limit.`);
        }
        const dataOffset = offset + CHUNK_HEADER_BYTES;
        if (dataOffset + length + CHUNK_CRC_BYTES > size) {
            throw new PngStructureError("malformed-file", `${type} chunk exceeds file bounds.`);
        }
        if (type !== "IDAT" && length > PNG_MAX_METADATA_BYTES_PER_CHUNK) {
            throw new PngStructureError("unsafe-structure", `${type} chunk exceeds the ${PNG_MAX_METADATA_BYTES_PER_CHUNK}-byte per-chunk limit.`, {
                chunkType: type,
                size: length,
                limit: PNG_MAX_METADATA_BYTES_PER_CHUNK,
            });
        }
        let computedCrc;
        if (type === "IDAT") {
            computedCrc = await streamChunkCrc(handle, typeBuffer, dataOffset, length);
        }
        else {
            const data = await readExactly(handle, length, dataOffset);
            buffered.set(index, data);
            computedCrc = crc32(typeBuffer, data);
        }
        const storedCrc = (await readExactly(handle, CHUNK_CRC_BYTES, dataOffset + length)).readUInt32BE(0);
        if (computedCrc !== storedCrc) {
            throw new PngStructureError("malformed-file", `${type} chunk CRC does not match its data.`);
        }
        chunks.push({ type, offset, dataOffset, length, crc: storedCrc });
        index += 1;
        offset = dataOffset + length + CHUNK_CRC_BYTES;
        if (type === "IEND") {
            sawIend = true;
            break;
        }
    }
    if (!sawIend) {
        throw new PngStructureError("malformed-file", "PNG is missing a terminating IEND chunk.");
    }
    if (offset !== size) {
        throw new PngStructureError("malformed-file", "PNG has trailing data after IEND.");
    }
    validateStructure(chunks);
    return { chunks, buffered };
}
// D-14: bounded decompression for iCCP/zTXt/compressed-iTXt payloads. The iCCP cap is the
// ICC policy ceiling itself (imported, not copied), so an inflated profile the policy would
// reject for size can never be materialized. The text cap has parity with WebP's per-chunk
// metadata buffer (MAX_BUFFERED_METADATA_BYTES in src/webp/riff.ts); the aggregate cap has
// parity with WebP's worst case of three singleton 16 MiB metadata chunks, so native never
// buffers more decompressed metadata for a PNG than it would for an admitted WebP.
export const PNG_MAX_INFLATED_ICC_BYTES = MAX_PROFILE_BYTES;
export const PNG_MAX_INFLATED_TEXT_BYTES = 16 * 1024 * 1024;
export const PNG_MAX_INFLATED_BYTES_TOTAL = 48 * 1024 * 1024;
export class InflateBudget {
    #remaining;
    constructor(total) {
        this.#remaining = total;
    }
    remaining() {
        return this.#remaining;
    }
    consume(n) {
        if (n > this.#remaining) {
            throw new PngStructureError("unsafe-structure", "Aggregate PNG decompression budget exceeded.", { chunkType: "*", size: n, limit: this.#remaining });
        }
        this.#remaining -= n;
    }
}
function isBufferTooLarge(cause) {
    return (typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ERR_BUFFER_TOO_LARGE");
}
/**
 * Inflates a zlib-compressed chunk payload under a hard output cap, both per chunk and
 * against a shared per-file aggregate budget. Never trusts a declared uncompressed size;
 * relies solely on zlib's own maxOutputLength enforcement plus a post-inflate size check
 * for the exact-boundary case. An over-cap result or invalid zlib data is always a refusal,
 * never a partial read.
 */
export function inflateBounded(data, chunkType, perChunkLimit, budget) {
    const effectiveLimit = Math.min(perChunkLimit, budget.remaining());
    let result;
    try {
        result = inflateSync(data, { maxOutputLength: effectiveLimit + 1 });
    }
    catch (cause) {
        if (isBufferTooLarge(cause)) {
            throw new PngStructureError("unsafe-structure", `${chunkType} decompresses past the ${effectiveLimit}-byte policy limit.`, { chunkType, size: effectiveLimit + 1, limit: effectiveLimit });
        }
        throw new PngStructureError("malformed-file", `${chunkType} compressed data is invalid.`);
    }
    if (result.length > effectiveLimit) {
        throw new PngStructureError("unsafe-structure", `${chunkType} decompresses past the ${effectiveLimit}-byte policy limit.`, { chunkType, size: result.length, limit: effectiveLimit });
    }
    budget.consume(result.length);
    return result;
}
//# sourceMappingURL=chunks.js.map