import type { FileHandle } from "node:fs/promises";

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

export function isPngSignature(magic: Buffer): boolean {
  return (
    magic.length >= PNG_HEADER_BYTES &&
    magic.subarray(0, PNG_HEADER_BYTES).equals(PNG_SIGNATURE)
  );
}

// CRC-32 (PNG spec Annex D / zlib polynomial). Built in-repo rather than relying on the
// zlib built-in CRC helper, which Node 22.0 and 22.1 lack while package.json engines
// admits >=22.
const CRC32_POLYNOMIAL = 0xedb88320;
let crc32Table: Uint32Array | undefined;

function getCrc32Table(): Uint32Array {
  if (crc32Table !== undefined) return crc32Table;
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

function crc32Init(): number {
  return 0xffffffff;
}

function crc32Update(crc: number, data: Buffer): number {
  const table = getCrc32Table();
  let value = crc;
  for (let i = 0; i < data.length; i += 1) {
    value = (table[(value ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return value;
}

function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(...parts: readonly Buffer[]): number {
  let value = crc32Init();
  for (const part of parts) value = crc32Update(value, part);
  return crc32Final(value);
}

export interface PngLimitContext {
  readonly chunkType: string;
  readonly size: number;
  readonly limit: number;
}

export class PngStructureError extends Error {
  readonly kind: "malformed-file" | "unsafe-structure";
  readonly limit?: PngLimitContext;

  constructor(
    kind: "malformed-file" | "unsafe-structure",
    message: string,
    limit?: PngLimitContext,
  ) {
    super(message);
    this.name = "PngStructureError";
    this.kind = kind;
    if (limit !== undefined) this.limit = limit;
  }
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const next = await handle.read(
      result,
      read,
      length - read,
      position + read,
    );
    if (next.bytesRead === 0)
      throw new PngStructureError("malformed-file", "Unexpected end of file.");
    read += next.bytesRead;
  }
  return result;
}

async function streamChunkCrc(
  handle: FileHandle,
  typeBuffer: Buffer,
  dataOffset: number,
  length: number,
): Promise<number> {
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

export function encodePngChunk(type: string, data: Buffer): Buffer {
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
export async function parsePng(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<ParsedPng> {
  if (isAborted(signal))
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  if (!Number.isSafeInteger(size) || size < PNG_HEADER_BYTES) {
    throw new PngStructureError(
      "malformed-file",
      "File is too small to be a PNG.",
    );
  }
  const magic = await readExactly(handle, PNG_HEADER_BYTES, 0);
  if (!isPngSignature(magic)) {
    throw new PngStructureError(
      "malformed-file",
      "File signature is not a PNG.",
    );
  }

  const chunks: PngChunk[] = [];
  const buffered = new Map<number, Buffer>();
  let offset = PNG_HEADER_BYTES;
  let index = 0;
  let sawIend = false;
  while (offset < size) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    if (size - offset < CHUNK_HEADER_BYTES) {
      throw new PngStructureError(
        "malformed-file",
        "PNG chunk header is truncated.",
      );
    }
    const header = await readExactly(handle, CHUNK_HEADER_BYTES, offset);
    const length = header.readUInt32BE(0);
    const type = header.toString("ascii", 4, 8);
    const typeBuffer = header.subarray(4, 8);
    const dataOffset = offset + CHUNK_HEADER_BYTES;
    if (dataOffset + length + CHUNK_CRC_BYTES > size) {
      throw new PngStructureError(
        "malformed-file",
        `${type} chunk exceeds file bounds.`,
      );
    }

    let computedCrc: number;
    if (type === "IDAT") {
      computedCrc = await streamChunkCrc(
        handle,
        typeBuffer,
        dataOffset,
        length,
      );
    } else {
      const data = await readExactly(handle, length, dataOffset);
      buffered.set(index, data);
      computedCrc = crc32(typeBuffer, data);
    }
    const storedCrc = (
      await readExactly(handle, CHUNK_CRC_BYTES, dataOffset + length)
    ).readUInt32BE(0);
    if (computedCrc !== storedCrc) {
      throw new PngStructureError(
        "malformed-file",
        `${type} chunk CRC does not match its data.`,
      );
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
    throw new PngStructureError(
      "malformed-file",
      "PNG is missing a terminating IEND chunk.",
    );
  }
  if (offset !== size) {
    throw new PngStructureError(
      "malformed-file",
      "PNG has trailing data after IEND.",
    );
  }

  return { chunks, buffered };
}
