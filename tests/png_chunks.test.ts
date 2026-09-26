import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { crc32, parsePng } from "../src/png/chunks.js";
import { minimalPng, pngChunk, pngIdat, pngIhdr } from "./fixtures.js";

async function parseFixture(fixture: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-"));
  const path = join(directory, "input.png");
  try {
    await writeFile(path, fixture);
    const handle = await open(path, "r");
    try {
      return await parsePng(handle, fixture.length);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("crc32", () => {
  it("matches the PNG spec reference vector for IEND", () => {
    expect(crc32(Buffer.from("IEND"))).toBe(0xae426082);
  });

  it("matches the standard CRC-32 check value for the ASCII digits 123456789", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("agrees with zlib.crc32 on random buffers, when zlib.crc32 exists", () => {
    if (typeof (zlib as { crc32?: unknown }).crc32 !== "function") return;
    const zlibCrc32 = (zlib as unknown as { crc32: (data: Buffer) => number })
      .crc32;
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const buffer = Buffer.from(bytes);
        expect(crc32(buffer)).toBe(zlibCrc32(buffer) >>> 0);
      }),
    );
  });
});

describe("parsePng", () => {
  it("parses a minimal PNG written to a temp file into IHDR, IDAT, IEND", async () => {
    const fixture = minimalPng();
    const parsed = await parseFixture(fixture);
    expect(parsed.chunks.map((chunk) => chunk.type)).toEqual([
      "IHDR",
      "IDAT",
      "IEND",
    ]);

    const sourceChunks = readPngChunkRanges(fixture);
    parsed.chunks.forEach((chunk, index) => {
      const expected = sourceChunks[index]!;
      expect(chunk.offset).toBe(expected.offset);
      expect(chunk.length).toBe(expected.length);
    });
  });

  it("round-trips: concatenating every parsed chunk range reproduces the input exactly", async () => {
    const fixture = minimalPng();
    const parsed = await parseFixture(fixture);
    const ranges = parsed.chunks.map((chunk) =>
      fixture.subarray(chunk.offset, chunk.dataOffset + chunk.length + 4),
    );
    const reconstructed = Buffer.concat([fixture.subarray(0, 8), ...ranges]);
    expect(reconstructed.equals(fixture)).toBe(true);
  });

  it("parses a hand-built IHDR chunk from the pngChunk fixture builder byte-for-byte", async () => {
    const ihdrData = pngIhdr(1, 1, 8, 2);
    const fixture = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdrData),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const parsed = await parseFixture(fixture);
    expect(parsed.chunks[0]!.type).toBe("IHDR");
    expect(parsed.chunks[0]!.length).toBe(13);
    expect(parsed.buffered.get(0)!.equals(ihdrData)).toBe(true);
  });
});

// Local re-derivation of chunk offsets from raw bytes, independent of parsePng itself,
// so the offset/length assertions above are not circular.
function readPngChunkRanges(
  file: Buffer,
): readonly { offset: number; length: number }[] {
  const ranges: { offset: number; length: number }[] = [];
  let offset = 8;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    ranges.push({ offset, length });
    offset += 8 + length + 4;
  }
  return ranges;
}
