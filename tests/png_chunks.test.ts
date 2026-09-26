import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PNG_MAX_ANCILLARY_CHUNKS,
  PNG_MAX_METADATA_BYTES_PER_CHUNK,
  type PngStructureError,
  crc32,
  parsePng,
} from "../src/png/chunks.js";
import { minimalPng, png, pngChunk, pngIdat, pngIhdr } from "./fixtures.js";

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

async function expectStructureError(
  fixture: Buffer,
  kind: PngStructureError["kind"],
): Promise<void> {
  await expect(parseFixture(fixture)).rejects.toMatchObject({ kind });
}

function corruptCrc(chunkBuffer: Buffer): Buffer {
  const result = Buffer.from(chunkBuffer);
  result[result.length - 1] = (result[result.length - 1]! ^ 0xff) & 0xff;
  return result;
}

function validImage(...middleChunks: readonly Buffer[]): Buffer {
  return png([
    pngChunk("IHDR", pngIhdr()),
    ...middleChunks,
    pngChunk("IDAT", pngIdat()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function plteChunk(): Buffer {
  return pngChunk("PLTE", Buffer.from([0, 0, 0]));
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

describe("parsePng structural refusals (PNG-03)", () => {
  it("refuses a bad CRC on IHDR as malformed-file", async () => {
    const fixture = png([
      corruptCrc(pngChunk("IHDR", pngIhdr())),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses a bad CRC on an ancillary chunk as malformed-file", async () => {
    const fixture = validImage(
      corruptCrc(pngChunk("tEXt", Buffer.from("k\0v"))),
    );
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses a bad CRC on an IDAT chunk as malformed-file", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      corruptCrc(pngChunk("IDAT", pngIdat())),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses a declared chunk length of 0x80000000 as malformed-file", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0x80000000, 0);
    header.write("tEXt", 4, 4, "ascii");
    const fixture = Buffer.concat([pngChunk("IHDR", pngIhdr()), header]);
    await expectStructureError(png([fixture]), "malformed-file");
  });

  it("refuses a chunk that extends past the end of the file as malformed-file", async () => {
    const idat = pngChunk("IDAT", pngIdat());
    const truncated = idat.subarray(0, idat.length - 2);
    const fixture = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", pngIhdr()),
      truncated,
    ]);
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses one trailing byte after IEND as malformed-file", async () => {
    const fixture = Buffer.concat([minimalPng(), Buffer.from([0])]);
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses a file with no IEND at EOF as malformed-file", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IDAT", pngIdat()),
    ]);
    await expectStructureError(fixture, "malformed-file");
  });

  it("refuses an unknown critical chunk type (CgBI) as unsafe-structure", async () => {
    const fixture = validImage(pngChunk("CgBI", Buffer.alloc(4)));
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses a chunk type with a non-letter byte (t3Xt) as malformed-file", async () => {
    const fixture = validImage(pngChunk("t3Xt", Buffer.from("k\0v")));
    await expectStructureError(fixture, "malformed-file");
  });

  it.each(["acTL", "fcTL", "fdAT"] as const)(
    "refuses an APNG %s chunk as unsafe-structure",
    async (apngType) => {
      const fixture = validImage(pngChunk(apngType, Buffer.alloc(4)));
      await expectStructureError(fixture, "unsafe-structure");
    },
  );

  it("refuses IDAT, tEXt, IDAT (non-contiguous IDAT) as unsafe-structure", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IDAT", pngIdat()),
      pngChunk("tEXt", Buffer.from("k\0v")),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses PLTE after IDAT as unsafe-structure", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IDAT", pngIdat()),
      plteChunk(),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses bKGD before PLTE as unsafe-structure", async () => {
    const fixture = validImage(
      pngChunk("bKGD", Buffer.from([0, 0])),
      plteChunk(),
    );
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses cHRM after PLTE as unsafe-structure", async () => {
    const fixture = validImage(plteChunk(), pngChunk("cHRM", Buffer.alloc(32)));
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses pHYs after IDAT as unsafe-structure", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IDAT", pngIdat()),
      pngChunk("pHYs", Buffer.alloc(9)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("parses tEXt, zTXt, iTXt, tIME, eXIf, caBX and an unregistered chunk after IDAT", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IDAT", pngIdat()),
      pngChunk("tEXt", Buffer.from("k\0v")),
      pngChunk("zTXt", Buffer.from("k\0\0v")),
      pngChunk("iTXt", Buffer.from("k\0\0\0\0\0v")),
      pngChunk("tIME", Buffer.alloc(7)),
      pngChunk("eXIf", Buffer.from("Exif\0\0")),
      pngChunk("caBX", Buffer.alloc(4)),
      pngChunk("npTc", Buffer.alloc(4)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const parsed = await parseFixture(fixture);
    expect(parsed.chunks.map((chunk) => chunk.type)).toContain("npTc");
  });

  it("refuses a second IHDR as unsafe-structure", async () => {
    const fixture = validImage(pngChunk("IHDR", pngIhdr()));
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses a second PLTE as unsafe-structure", async () => {
    const fixture = validImage(plteChunk(), plteChunk());
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses a second cHRM as unsafe-structure", async () => {
    const fixture = validImage(
      pngChunk("cHRM", Buffer.alloc(32)),
      pngChunk("cHRM", Buffer.alloc(32)),
    );
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses more than PNG_MAX_ANCILLARY_CHUNKS non-IDAT chunks as unsafe-structure", async () => {
    const extra = Array.from({ length: PNG_MAX_ANCILLARY_CHUNKS + 1 }, () =>
      pngChunk("tEXt", Buffer.from("k\0v")),
    );
    const fixture = validImage(...extra);
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("refuses a non-IDAT chunk larger than PNG_MAX_METADATA_BYTES_PER_CHUNK with limit context", async () => {
    const oversized = Buffer.alloc(PNG_MAX_METADATA_BYTES_PER_CHUNK + 1);
    const fixture = validImage(pngChunk("caBX", oversized));
    await expect(parseFixture(fixture)).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: {
        chunkType: "caBX",
        size: PNG_MAX_METADATA_BYTES_PER_CHUNK + 1,
        limit: PNG_MAX_METADATA_BYTES_PER_CHUNK,
      },
    });
  });

  it("refuses a PNG with no IDAT chunk as malformed-file", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await expectStructureError(fixture, "malformed-file");
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
