import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../dist/index.js";
import {
  BufferedBudget,
  PNG_SIGNATURE,
  crc32,
  encodePngChunk,
  parsePng,
} from "../src/png/chunks.js";

// PNG-05 (56 WR-02, D-23/D-24/D-25): deterministic, sparse-file coverage of the aggregate
// buffered-metadata budget and the window-view-retention copy fix. Fixtures use the D-27
// technique: open the file, write only chunk headers and CRCs at their real offsets, and
// `truncate` to the final size -- the unwritten data regions are sparse holes that read back
// as zeros, so a CRC precomputed once (per distinct length) over an all-zero buffer matches.
// This keeps disk/CPU cost proportional to chunk *count*, not declared chunk *size*, even for
// a fixture whose logical size is hundreds of megabytes.

const NO_PRESERVATION = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-memory-"));
  directories.push(directory);
  return directory;
}

function ihdrData(): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(1, 0);
  data.writeUInt32BE(1, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // color type: truecolor
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return data;
}

async function writeChunkFull(
  handle: import("node:fs/promises").FileHandle,
  position: number,
  buffer: Buffer,
): Promise<number> {
  await handle.write(buffer, 0, buffer.length, position);
  return position + buffer.length;
}

// Writes only the 8-byte header and the 4-byte CRC at their real file offsets; the data
// region between them is left as a sparse hole, which reads back as all zeros. `crc` must be
// precomputed over an all-zero buffer of `length` bytes (crc32(typeBuffer, Buffer.alloc(length)))
// for this to round-trip through parsePng's own CRC check.
async function writeSparseChunk(
  handle: import("node:fs/promises").FileHandle,
  position: number,
  type: string,
  length: number,
  crc: number,
): Promise<number> {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(length, 0);
  header.write(type, 4, 4, "ascii");
  await handle.write(header, 0, 8, position);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  await handle.write(crcBuffer, 0, 4, position + 8 + length);
  return position + 8 + length + 4;
}

const zeroCrcCache = new Map<string, number>();

function zeroCrc(type: string, length: number): number {
  const key = `${type}:${length}`;
  let crc = zeroCrcCache.get(key);
  if (crc === undefined) {
    crc = crc32(Buffer.from(type, "ascii"), Buffer.alloc(length));
    zeroCrcCache.set(key, crc);
  }
  return crc;
}

// Text flood (D-24, SC4 deterministic half): IHDR, 32 x 16 MiB tEXt (sparse, CRC over zeros),
// a minimal real IDAT, IEND. Total non-IDAT declared bytes is 13 (IHDR) + 32 x 16,777,216 =
// 536,870,925, well past the 48 MiB aggregate cap -- every tEXt chunk's CRC is precomputed
// correctly (not a garbage tail) so an uncapped parse (an injected Number.POSITIVE_INFINITY
// budget) parses the whole 512 MiB fixture cleanly rather than failing on a bad CRC; the test
// discriminates on the cap, not on fixture validity.
export async function writeTextFloodFixture(path: string): Promise<number> {
  const TEXT_LEN = 16 * 1024 * 1024;
  const crc = zeroCrc("tEXt", TEXT_LEN);
  const handle = await open(path, "w+");
  try {
    let pos = 0;
    pos = await writeChunkFull(handle, pos, PNG_SIGNATURE);
    pos = await writeChunkFull(handle, pos, encodePngChunk("IHDR", ihdrData()));
    for (let i = 0; i < 32; i++) {
      pos = await writeSparseChunk(handle, pos, "tEXt", TEXT_LEN, crc);
    }
    pos = await writeChunkFull(
      handle,
      pos,
      encodePngChunk("IDAT", Buffer.from([0])),
    );
    pos = await writeChunkFull(
      handle,
      pos,
      encodePngChunk("IEND", Buffer.alloc(0)),
    );
    await handle.truncate(pos);
    return pos;
  } finally {
    await handle.close();
  }
}

// Window-retention (D-23): IHDR, `count` x [4-byte tEXt + 70,000-byte sparse tEXt filler], a
// single real IDAT, IEND. The 70,000-byte filler is deliberately a second `tEXt` chunk, not an
// IDAT: PNG (and this parser's validateStructure) requires every IDAT chunk to sit in one
// contiguous run, so a real IDAT cannot be interleaved between ancillary chunks without
// tripping the (correct, pre-existing, out of scope for this plan) "IDAT chunks must be
// contiguous" refusal. A large non-IDAT filler chunk reproduces the same window-retention
// mechanism `readWindowed` is vulnerable to: any read longer than PNG_CHUNK_READ_WINDOW_BYTES
// (65,536) bypasses the shared window entirely without advancing window.start/window.end, so
// the next small chunk's read always falls outside the stale window bounds and forces a fresh
// window-buffer allocation -- exactly the per-entry distinct-backing-buffer scenario D-23 is
// about. Every non-IDAT chunk here (the small tEXt marker + the 70,000-byte tEXt filler)
// counts toward the aggregate budget, so `count` is kept well under
// PNG_MAX_BUFFERED_METADATA_BYTES_TOTAL / 70,004 and under PNG_MAX_ANCILLARY_CHUNKS / 2 so the
// fixture parses under the real default budget.
export async function writeWindowRetentionFixture(
  path: string,
  count: number,
): Promise<number> {
  const FILLER_LEN = 70000;
  const fillerCrc = zeroCrc("tEXt", FILLER_LEN);
  const marker = encodePngChunk("tEXt", Buffer.alloc(4));
  const handle = await open(path, "w+");
  try {
    let pos = 0;
    pos = await writeChunkFull(handle, pos, PNG_SIGNATURE);
    pos = await writeChunkFull(handle, pos, encodePngChunk("IHDR", ihdrData()));
    for (let i = 0; i < count; i++) {
      pos = await writeChunkFull(handle, pos, marker);
      pos = await writeSparseChunk(handle, pos, "tEXt", FILLER_LEN, fillerCrc);
    }
    pos = await writeChunkFull(
      handle,
      pos,
      encodePngChunk("IDAT", Buffer.from([0])),
    );
    pos = await writeChunkFull(
      handle,
      pos,
      encodePngChunk("IEND", Buffer.alloc(0)),
    );
    await handle.truncate(pos);
    return pos;
  } finally {
    await handle.close();
  }
}

async function parseFixturePath(
  path: string,
  size: number,
  budget?: BufferedBudget,
) {
  const handle = await open(path, "r");
  try {
    return budget === undefined
      ? await parsePng(handle, size)
      : await parsePng(handle, size, undefined, budget);
  } finally {
    await handle.close();
  }
}

describe("PNG aggregate buffered-metadata budget (PNG-05, D-24)", () => {
  it("declines the 512 MiB text flood as unsafe-structure through sanitizeFile, and rejects at the third tEXt through parsePng directly", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.png");
    const destinationPath = join(directory, "destination.png");
    const size = await writeTextFloodFixture(sourcePath);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");

    // IHDR's 13 data bytes count toward the budget first, so the third 16 MiB tEXt chunk is
    // what trips the 48 MiB (50,331,648-byte) cap: 13 + 3 x 16,777,216 = 50,331,661.
    await expect(parseFixturePath(sourcePath, size)).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "*", size: 50331661, limit: 50331648 },
    });
  }, 60_000);
});
