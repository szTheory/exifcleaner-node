import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { deflateSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InflateBudget,
  PNG_CHUNK_READ_WINDOW_BYTES,
  PNG_MAX_ANCILLARY_CHUNKS,
  PNG_MAX_INFLATED_BYTES_TOTAL,
  PNG_MAX_INFLATED_ICC_BYTES,
  PNG_MAX_METADATA_BYTES_PER_CHUNK,
  type PngStructureError,
  crc32,
  inflateBounded,
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

  it("refuses the ancillary-chunk limit before reading any chunk past it (bounded work)", async () => {
    // A chunk that would throw a *different* error (malformed-file, bad CRC) is placed
    // immediately after the chunk that pushes the count over the limit. If parsePng read
    // every chunk before checking the count (the pre-fix behaviour: the check lived only in
    // validateStructure, which ran after the whole file was parsed), this corrupt chunk
    // would be reached and its distinct error would win. Getting unsafe-structure instead
    // proves the count is checked, and the file stops being read, as soon as it is exceeded
    // -- not after unboundedly more chunks have been read past it.
    const extra = Array.from({ length: PNG_MAX_ANCILLARY_CHUNKS + 1 }, () =>
      pngChunk("tEXt", Buffer.from("k\0v")),
    );
    const fixture = validImage(
      ...extra,
      corruptCrc(pngChunk("tEXt", Buffer.from("k\0v"))),
    );
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

// D-16 gap fix (post-56-12): parsePng's chunk-header/data/CRC reads must be bounded by file
// size, not by chunk count. Before the fix each chunk cost ~3 separate `handle.read` round
// trips (header, data, CRC); a file at PNG_MAX_ANCILLARY_CHUNKS drove ~30,000 libuv
// threadpool round trips, which intermittently exceeded vitest's 5000ms timeout under
// parallel-worker contention (measured in 56-09 and 56-12's `npm run verify`). The bound
// below -- proportional to ceil(size / PNG_CHUNK_READ_WINDOW_BYTES) plus a small constant --
// is what a bounded read-ahead window buys; a per-chunk read cost would blow through it.
describe("parsePng read cost (bounded chunk-header reads)", () => {
  // Generous constant term: magic-byte read, the read-ahead window's own final partial
  // fill, and the IDAT chunk's streamed header/data/CRC reads (bounded by IDAT size, not
  // chunk count, and already parity-tested elsewhere).
  const FIXED_READ_OVERHEAD = 20;

  async function countReads(
    fixture: Buffer,
  ): Promise<{ readCount: number; size: number; error: unknown }> {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-cost-"));
    const path = join(directory, "input.png");
    try {
      await writeFile(path, fixture);
      const handle = await open(path, "r");
      let readCount = 0;
      const originalRead = handle.read.bind(handle);
      // @ts-expect-error -- intentionally wrapping the real read for instrumentation only.
      handle.read = (...args: Parameters<typeof originalRead>) => {
        readCount += 1;
        return originalRead(...args);
      };
      let error: unknown;
      try {
        await parsePng(handle, fixture.length);
      } catch (caught) {
        error = caught;
      } finally {
        await handle.close();
      }
      return { readCount, size: fixture.length, error };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("bounds handle.read calls by file size, not chunk count, for the over-limit fixture", async () => {
    const extra = Array.from({ length: PNG_MAX_ANCILLARY_CHUNKS + 1 }, () =>
      pngChunk("tEXt", Buffer.from("k\0v")),
    );
    const fixture = validImage(...extra);
    const { readCount, size, error } = await countReads(fixture);

    expect(error).toMatchObject({ kind: "unsafe-structure" });
    const expectedBound =
      Math.ceil(size / PNG_CHUNK_READ_WINDOW_BYTES) + FIXED_READ_OVERHEAD;
    expect(readCount).toBeLessThanOrEqual(expectedBound);
    // Sanity: the naive per-chunk cost this fixture would have cost pre-fix, so the bound
    // above is meaningfully tighter and this assertion can't pass by accident.
    expect(readCount).toBeLessThan(PNG_MAX_ANCILLARY_CHUNKS);
  });

  it("bounds handle.read calls for a normal many-small-chunks valid PNG", async () => {
    const smallChunks = Array.from({ length: 500 }, (_, index) =>
      pngChunk("tEXt", Buffer.from(`k${index}\0v`)),
    );
    const fixture = validImage(...smallChunks);
    const { readCount, size, error } = await countReads(fixture);

    expect(error).toBeUndefined();
    const expectedBound =
      Math.ceil(size / PNG_CHUNK_READ_WINDOW_BYTES) + FIXED_READ_OVERHEAD;
    expect(readCount).toBeLessThanOrEqual(expectedBound);
  });
});

describe("inflateBounded (D-14)", () => {
  it("inflates valid deflate data below the cap and returns the exact bytes", () => {
    const source = Buffer.from("hello bounded inflate");
    const compressed = deflateSync(source);
    const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);
    const result = inflateBounded(
      compressed,
      "zTXt",
      PNG_MAX_INFLATED_ICC_BYTES,
      budget,
    );
    expect(result.equals(source)).toBe(true);
  });

  it("refuses a decompression bomb past a 16 MiB cap in under 2000ms, with limit.chunkType set", () => {
    const bomb = deflateSync(Buffer.alloc(17 * 1024 * 1024, 0));
    const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);
    const start = process.hrtime.bigint();
    let caught: unknown;
    try {
      inflateBounded(bomb, "iCCP", PNG_MAX_INFLATED_ICC_BYTES, budget);
    } catch (error) {
      caught = error;
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(elapsedMs).toBeLessThan(2000);
    expect(caught).toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "iCCP" },
    });
  });

  it("refuses invalid zlib data as malformed-file", () => {
    const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);
    expect(() =>
      inflateBounded(
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        "zTXt",
        PNG_MAX_INFLATED_ICC_BYTES,
        budget,
      ),
    ).toThrow(expect.objectContaining({ kind: "malformed-file" }));
  });

  it("an InflateBudget with 48 MiB total refuses a third 16 MiB consumption after 32 MiB plus one byte", () => {
    const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);
    budget.consume(16 * 1024 * 1024);
    budget.consume(16 * 1024 * 1024 + 1);
    expect(() => budget.consume(16 * 1024 * 1024)).toThrow(
      expect.objectContaining({ kind: "unsafe-structure" }),
    );
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
