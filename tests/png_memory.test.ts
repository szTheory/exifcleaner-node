import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sanitizeFile } from "../dist/index.js";
import {
  BufferedBudget,
  PNG_SIGNATURE,
  copyWindowedChunk,
  crc32,
  encodePngChunk,
  parsePng,
} from "../src/png/chunks.js";
import { minimalPng, png, pngChunk, pngIhdr } from "./fixtures.js";

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

// Minimal shape both a real FileHandle and the counting wrapper below satisfy -- lets
// writeTextFloodFixture's optional byte-count instrumentation (D-27 smoke) intercept every
// real write() call without writeChunkFull/writeSparseChunk needing to know about it.
interface WritableHandle {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
}

async function writeChunkFull(
  handle: WritableHandle,
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
  handle: WritableHandle,
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
// `writeStats`, when provided, accumulates the REAL bytes passed to every write() call the
// fixture issues (D-27 smoke, 60-04 Task 2). This is a dynamic, host-filesystem-independent
// measurement of "does this fixture physically write its data regions": on at least one real
// host (macOS APFS, measured for 60-04), write()-extending a file's length materializes
// (zero-fills) any gap smaller than roughly 17 MiB, so `(await stat(path)).blocks * 512` -- the
// must_haves' literal formula -- measures this fixture as fully allocated (~512 MiB) despite
// every write() call here touching only a header or a CRC (the declared chunk data itself is
// never passed to write()). Counting the bytes THIS function actually asks the OS to write is
// what stays true regardless of how any given filesystem chooses to store (or not store) the
// untouched gaps in between; see 60-EVIDENCE.md for the full investigation.
export async function writeTextFloodFixture(
  path: string,
  writeStats?: { realBytesWritten: number },
): Promise<number> {
  const TEXT_LEN = 16 * 1024 * 1024;
  const crc = zeroCrc("tEXt", TEXT_LEN);
  const realHandle = await open(path, "w+");
  const handle: WritableHandle = writeStats
    ? {
        write: async (buffer, offset, length, position) => {
          const result = await realHandle.write(
            buffer,
            offset,
            length,
            position,
          );
          writeStats.realBytesWritten += result.bytesWritten;
          return result;
        },
      }
    : realHandle;
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
    await realHandle.truncate(pos);
    return pos;
  } finally {
    await realHandle.close();
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

const CHILD_PATH = fileURLToPath(
  new URL("./png_memory_child.mjs", import.meta.url),
);

interface ChildResult {
  outcome: "parsed" | "error";
  kind?: string;
  limit?: { chunkType: string; size: number; limit: number };
  maxRssBytes: number;
}

// PNG-05 / D-28: spawns the real measurement harness (tests/png_memory_child.mjs) and
// parses its single JSON stdout line. `fixture` is a real path or the literal `--idle`.
function runChild(
  fixture: string,
  budgetMode: "default" | "infinity",
  retainMode: "default" | "view",
): ChildResult {
  const result = spawnSync(
    process.execPath,
    [CHILD_PATH, fixture, budgetMode, retainMode],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `png_memory_child exited ${result.status}: ${result.stderr}`,
    );
  }
  const lastLine = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .pop();
  if (lastLine === undefined) {
    throw new Error(`png_memory_child produced no output: ${result.stderr}`);
  }
  return JSON.parse(lastLine) as ChildResult;
}

// PNG-05 / D-29: chosen from local measurement (node v24.19.0, Darwin arm64; see
// 60-EVIDENCE.md "## PNG-05 RSS measurement (local)"). The highest measured capped peak
// (flood, default budget) was ~85.9 MiB; the lowest measured uncapped peak (flood,
// budget infinity) was ~567.2 MiB. 256 MiB sits at >= 1.5x the capped peak (~128.8 MiB
// floor) and <= 0.6x the uncapped peak (~340.3 MiB ceiling), satisfying D-29's
// discrimination rule with headroom on both sides.
export const PNG_MEMORY_RSS_CEILING_BYTES = 256 * 1024 * 1024;

describe("child RSS harness unit sanity", () => {
  it("an idle child (no fixture) reports maxRssBytes between 16 MiB and 256 MiB", () => {
    const result = runChild("--idle", "default", "default");
    expect(result.outcome).toBe("parsed");
    expect(result.maxRssBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(result.maxRssBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});

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

describe("BufferedBudget boundaries (PNG-05, D-24 edges)", () => {
  it("boundary: an injected budget equal to the file's total non-IDAT bytes parses; one less rejects", async () => {
    // minimalPng() is IHDR (13 data bytes) + IDAT + IEND (0 data bytes) -- total non-IDAT
    // declared bytes is exactly 13.
    const fixture = minimalPng();
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    await writeFile(path, fixture);

    await parseFixturePath(path, fixture.length, new BufferedBudget(13));
    await expect(
      parseFixturePath(path, fixture.length, new BufferedBudget(12)),
    ).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "*", size: 13, limit: 12 },
    });
  });

  it("real-cap boundary: IHDR + 3 tEXt totalling exactly 48 MiB parses under the default budget; one byte more rejects", async () => {
    // IHDR 13 + tEXt 16,777,216 + tEXt 16,777,216 + tEXt 16,777,203 = 50,331,648 (exactly
    // PNG_MAX_BUFFERED_METADATA_BYTES_TOTAL).
    const buildFixture = async (
      path: string,
      lastTextLength: number,
    ): Promise<number> => {
      const handle = await open(path, "w+");
      try {
        let pos = 0;
        pos = await writeChunkFull(handle, pos, PNG_SIGNATURE);
        pos = await writeChunkFull(
          handle,
          pos,
          encodePngChunk("IHDR", ihdrData()),
        );
        pos = await writeSparseChunk(
          handle,
          pos,
          "tEXt",
          16777216,
          zeroCrc("tEXt", 16777216),
        );
        pos = await writeSparseChunk(
          handle,
          pos,
          "tEXt",
          16777216,
          zeroCrc("tEXt", 16777216),
        );
        pos = await writeSparseChunk(
          handle,
          pos,
          "tEXt",
          lastTextLength,
          zeroCrc("tEXt", lastTextLength),
        );
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
    };

    const exactDirectory = await freshDirectory();
    const exactPath = join(exactDirectory, "exact.png");
    const exactSize = await buildFixture(exactPath, 16777203);
    await parseFixturePath(exactPath, exactSize);

    const overDirectory = await freshDirectory();
    const overPath = join(overDirectory, "over.png");
    const overSize = await buildFixture(overPath, 16777204);
    await expect(parseFixturePath(overPath, overSize)).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "*", size: 50331649, limit: 50331648 },
    });
  }, 30_000);

  it("empty: minimalPng parses under BufferedBudget(13) and rejects under BufferedBudget(12); a zero-length ancillary chunk still parses under 13", async () => {
    const fixture = minimalPng();
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    await writeFile(path, fixture);

    await parseFixturePath(path, fixture.length, new BufferedBudget(13));
    await expect(
      parseFixturePath(path, fixture.length, new BufferedBudget(12)),
    ).rejects.toMatchObject({ kind: "unsafe-structure" });

    const withEmptyAncillary = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("tEXt", Buffer.alloc(0)),
      pngChunk("IDAT", Buffer.from([0])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const directory2 = await freshDirectory();
    const path2 = join(directory2, "input2.png");
    await writeFile(path2, withEmptyAncillary);
    // IHDR (13) + zero-length tEXt (0) = 13 total non-IDAT bytes, same as minimalPng().
    await parseFixturePath(
      path2,
      withEmptyAncillary.length,
      new BufferedBudget(13),
    );
  });

  it("encoding: a tEXt chunk of 100 data bytes consumes exactly 100; a 64 MiB sparse IDAT is never counted", async () => {
    const fixture = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("tEXt", Buffer.alloc(100)),
      pngChunk("IDAT", Buffer.from([0])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    await writeFile(path, fixture);

    // IHDR (13) + tEXt (100) = 113. 13 + 100 passes, 13 + 99 fails.
    await parseFixturePath(path, fixture.length, new BufferedBudget(113));
    await expect(
      parseFixturePath(path, fixture.length, new BufferedBudget(112)),
    ).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "*", size: 113, limit: 112 },
    });

    // 1,024 x 64 KiB sparse IDAT chunks (64 MiB total) must parse under the real default
    // budget: IDAT bytes are never counted toward the aggregate cap.
    const idatDirectory = await freshDirectory();
    const idatPath = join(idatDirectory, "idat.png");
    const idatHandle = await open(idatPath, "w+");
    try {
      let pos = 0;
      pos = await writeChunkFull(idatHandle, pos, PNG_SIGNATURE);
      pos = await writeChunkFull(
        idatHandle,
        pos,
        encodePngChunk("IHDR", ihdrData()),
      );
      const idatCrc = zeroCrc("IDAT", 65536);
      for (let i = 0; i < 1024; i++) {
        pos = await writeSparseChunk(idatHandle, pos, "IDAT", 65536, idatCrc);
      }
      pos = await writeChunkFull(
        idatHandle,
        pos,
        encodePngChunk("IEND", Buffer.alloc(0)),
      );
      await idatHandle.truncate(pos);
      await parseFixturePath(idatPath, pos);
    } finally {
      await idatHandle.close();
    }
  }, 30_000);

  it("precision: BufferedBudget(Number.POSITIVE_INFINITY) never throws on the text flood; consumed() equals the exact integer sum", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const size = await writeTextFloodFixture(path);

    const budget = new BufferedBudget(Number.POSITIVE_INFINITY);
    await parseFixturePath(path, size, budget);
    // IHDR (13) + 32 x 16 MiB tEXt (16,777,216 each) = 536,870,925.
    expect(budget.consumed()).toBe(536870925);
  }, 30_000);
});

describe("D-25: aggregate breach vs. ICC per-chunk policy-limit classification", () => {
  it("an aggregate breach triggered by an iCCP chunk stays unsafe-structure (not remapped) even with preserveColorProfile true", async () => {
    // Exact-cap layout (50,331,648 bytes: IHDR + 3 tEXt) followed by a 20-byte iCCP chunk,
    // which trips the cap. The iCCP's data is never read (budget.consume throws before the
    // read), so its bytes don't need a real zlib profile or a correct CRC.
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const handle = await open(path, "w+");
    let size: number;
    try {
      let pos = 0;
      pos = await writeChunkFull(handle, pos, PNG_SIGNATURE);
      pos = await writeChunkFull(
        handle,
        pos,
        encodePngChunk("IHDR", ihdrData()),
      );
      pos = await writeSparseChunk(
        handle,
        pos,
        "tEXt",
        16777216,
        zeroCrc("tEXt", 16777216),
      );
      pos = await writeSparseChunk(
        handle,
        pos,
        "tEXt",
        16777216,
        zeroCrc("tEXt", 16777216),
      );
      pos = await writeSparseChunk(
        handle,
        pos,
        "tEXt",
        16777203,
        zeroCrc("tEXt", 16777203),
      );
      // iCCP: 20 declared data bytes, garbage CRC -- never reached by the parser because
      // budget.consume(20) throws before any read for this chunk.
      const iccpHeader = Buffer.alloc(8);
      iccpHeader.writeUInt32BE(20, 0);
      iccpHeader.write("iCCP", 4, 4, "ascii");
      await handle.write(iccpHeader, 0, 8, pos);
      size = pos + 8 + 20 + 4;
      await handle.truncate(size);
    } finally {
      await handle.close();
    }

    await expect(parseFixturePath(path, size)).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: { chunkType: "*", size: 50331668, limit: 50331648 },
    });

    const destinationPath = join(directory, "destination.png");
    const result = await sanitizeFile({
      sourcePath: path,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error).not.toHaveProperty("feature");
  });

  it("control: a single oversized iCCP chunk (above the 16 MiB per-chunk limit) still maps to unsupported-feature / color-profile-preservation", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const oversizedLength = 16 * 1024 * 1024 + 1;
    const handle = await open(path, "w+");
    let size: number;
    try {
      let pos = 0;
      pos = await writeChunkFull(handle, pos, PNG_SIGNATURE);
      pos = await writeChunkFull(
        handle,
        pos,
        encodePngChunk("IHDR", ihdrData()),
      );
      // The per-chunk limit check runs before budget.consume, so this throws with
      // chunkType "iCCP" regardless of the aggregate budget -- its data is never read either.
      const iccpHeader = Buffer.alloc(8);
      iccpHeader.writeUInt32BE(oversizedLength, 0);
      iccpHeader.write("iCCP", 4, 4, "ascii");
      await handle.write(iccpHeader, 0, 8, pos);
      size = pos + 8 + oversizedLength + 4;
      await handle.truncate(size);
    } finally {
      await handle.close();
    }

    await expect(parseFixturePath(path, size)).rejects.toMatchObject({
      kind: "unsafe-structure",
      limit: {
        chunkType: "iCCP",
        size: oversizedLength,
        limit: 16 * 1024 * 1024,
      },
    });

    const destinationPath = join(directory, "destination.png");
    const result = await sanitizeFile({
      sourcePath: path,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    expect(result.error).toMatchObject({
      feature: "color-profile-preservation",
    });
  });
});

// PNG-05 / D-28, D-29: real, measured RSS ceiling assertions via the child-process harness
// (tests/png_memory_child.mjs). USER DECISION (Option A, maintainer, 2026-09-30; see
// 60-EVIDENCE.md "## PNG-05 RSS measurement (local)" for the full rationale and figures): the
// retention-view RSS negative control originally planned here is intentionally NOT asserted --
// structurally, the retention layout's view/default RSS ratio is bounded well under 2x (any
// filler chunk large enough to force a distinct window refill is itself buffered identically
// under both retain policies, since it never goes through `retain`), so no single ceiling value
// can discriminate retain policy on the retention layout while also satisfying D-29's 1.5x/0.6x
// rule against the flood pair. D-23's discriminating negative control is the distinct-backing-
// buffer-count assertion in the "copy-on-buffer for windowed reads (D-23)" describe block above
// (committed in 60-03), not an RSS proxy.
describe("PNG aggregate memory bound (PNG-05, D-28)", () => {
  let directory: string;
  let floodPath: string;
  let floodSize: number;
  let floodWriteStats: { realBytesWritten: number };
  let retentionPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-rss-"));
    floodPath = join(directory, "flood.png");
    floodWriteStats = { realBytesWritten: 0 };
    floodSize = await writeTextFloodFixture(floodPath, floodWriteStats);
    retentionPath = join(directory, "retention.png");
    // 718 = the largest chunk count that still parses under the real 48 MiB default
    // aggregate budget with this fixture's 70,000-byte tEXt filler (measured; see
    // 60-EVIDENCE.md).
    await writeWindowRetentionFixture(retentionPath, 718);
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("flood, default budget: declines as unsafe-structure at the predicted byte, peak RSS at or below the ceiling", () => {
    const result = runChild(floodPath, "default", "default");
    expect(result.outcome).toBe("error");
    expect(result.kind).toBe("unsafe-structure");
    expect(result.limit?.size).toBe(50331661);
    expect(
      result.maxRssBytes,
      `measured ${(result.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        PNG_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(PNG_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);

  it("flood, budget infinity (negative control): peak RSS strictly above the ceiling, proving the ceiling discriminates when the cap is removed", () => {
    const result = runChild(floodPath, "infinity", "default");
    expect(result.outcome).toBe("parsed");
    expect(
      result.maxRssBytes,
      `measured ${(result.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        PNG_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeGreaterThan(PNG_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);

  it("retention, default retain: peak RSS at or below the ceiling (D-23's discriminating negative control is the distinct-backing-buffer-count test in 'copy-on-buffer for windowed reads (D-23)' above, not an RSS assertion -- see 60-EVIDENCE.md, Option A)", () => {
    const result = runChild(retentionPath, "default", "default");
    expect(result.outcome).toBe("parsed");
    expect(
      result.maxRssBytes,
      `measured ${(result.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        PNG_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(PNG_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);

  it("sparse smoke (D-27): the flood fixture's own write() calls total far fewer than 64 MiB despite a 512+ MiB logical size", async () => {
    expect(floodSize).toBeGreaterThan(512 * 1024 * 1024);
    // Deviation (Rule 1, measured): the must_haves' literal formula is `(await
    // stat(floodPath)).blocks * 512 < 64 MiB`. Measured against this exact fixture on this
    // session's host (macOS APFS, node v24.19.0): `stat(floodPath).blocks * 512` reports the
    // full ~512 MiB allocated, not <64 MiB -- because write()-extending a file's length on this
    // filesystem physically zero-fills any gap smaller than roughly 17 MiB (verified directly:
    // an isolated two-write reproducer with a 16 MiB gap materializes it; the same reproducer
    // with a 32 MiB gap stays a true sparse hole), and this fixture's tEXt chunks are 16 MiB
    // each -- just under that threshold -- for reasons this plan's own SC4 requirement fixes
    // (the third-chunk trip point at byte 50,331,661 is locked to 16 MiB chunks). That is a host
    // filesystem policy for materializing write()-created gaps, not a defect in the fixture: the
    // application itself never calls write() with the chunk's declared data, only a header and a
    // CRC per chunk (12 real bytes), which `floodWriteStats.realBytesWritten` measures directly
    // and which stays true on every host regardless of how that host's filesystem chooses to
    // store (or not store) the untouched space in between. See 60-EVIDENCE.md for the full
    // investigation (write order, pre-truncation, and directory location were all ruled out
    // before reaching this conclusion).
    expect(floodWriteStats.realBytesWritten).toBeLessThan(64 * 1024 * 1024);
    expect(floodWriteStats.realBytesWritten).toBeLessThan(1024);
  });
});

// D-23 discriminator note: the must_haves' literal `entry.buffer.byteLength <= Math.max(entry.length,
// Buffer.poolSize)` formula assumes `Buffer.poolSize` is smaller than `PNG_CHUNK_READ_WINDOW_BYTES`
// (65,536) -- true on the historical Node default (8,192) this plan was written against, but Node's
// `Buffer.poolSize` default now measures 65,536 on this runtime (`node --version`, checked live: see
// SUMMARY), exactly equal to the window size. At that coincidental equality `byteLength <= max(...)`
// is trivially true for a windowed VIEW too (65,536 <= 65,536), so the raw inequality alone cannot
// discriminate the identity-retain RED state on this runtime -- it is satisfied by both policies. The
// pass-direction assertion below (Task 3 default-policy test) is still the literal must_haves formula
// and genuinely holds; the failure-direction proof is strengthened with an environment-independent
// companion: Node's own small-buffer pool means a COPIED small buffer's backing ArrayBuffer is SHARED
// across many entries (few distinct backing buffers for many windowed entries), while an IDENTITY-retained
// windowed view's backing buffer is the window's own per-refill allocation and is NEVER shared (one
// distinct backing buffer per windowed entry, confirmed by direct measurement: 2 unique backing buffers
// across 52 windowed entries -- IHDR, the 50 tEXt markers, and IEND, every non-IDAT chunk whose declared
// length is <= the window size -- under the default copy policy, versus 52 unique backing buffers -- one
// per entry, zero sharing -- under identity retain, for this fixture). Counting distinct backing-buffer
// references is robust to whatever `Buffer.poolSize` happens to be on the host Node version.
describe("copy-on-buffer for windowed reads (D-23)", () => {
  function windowedEntries(parsed: {
    buffered: ReadonlyMap<number, Buffer>;
  }): Buffer[] {
    return [...parsed.buffered.values()].filter(
      (entry) => entry.length <= 65536,
    );
  }

  it("default parsePng: every buffered entry's backing buffer is no larger than its own length or the Buffer pool size, and windowed entries share a small number of distinct backing buffers", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const size = await writeWindowRetentionFixture(path, 50);

    const handle = await open(path, "r");
    let parsed;
    try {
      parsed = await parsePng(handle, size);
    } finally {
      await handle.close();
    }

    for (const entry of parsed.buffered.values()) {
      expect(entry.buffer.byteLength).toBeLessThanOrEqual(
        Math.max(entry.length, Buffer.poolSize),
      );
    }

    // IHDR (1) + 50 tEXt markers + IEND (1) = 52 windowed (length <= window size) entries;
    // under the default copy policy these share a small, bounded number of distinct
    // pool-backed buffers rather than one each.
    const windowed = windowedEntries(parsed);
    expect(windowed.length).toBe(52);
    const uniqueBackingBuffers = new Set(windowed.map((entry) => entry.buffer));
    expect(uniqueBackingBuffers.size).toBeLessThan(windowed.length);
    expect(uniqueBackingBuffers.size).toBeLessThanOrEqual(10);
  }, 30_000);

  it("identity retain (view) => view: every windowed entry keeps its own distinct backing buffer -- the RED state that proves the default-policy test discriminates", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const size = await writeWindowRetentionFixture(path, 50);

    const handle = await open(path, "r");
    let parsed;
    try {
      parsed = await parsePng(
        handle,
        size,
        undefined,
        undefined,
        (view) => view,
      );
    } finally {
      await handle.close();
    }

    const windowed = windowedEntries(parsed);
    expect(windowed.length).toBe(52);
    // Every windowed entry under identity retain keeps a 65,536-byte (or near-EOF-truncated)
    // backing buffer, and -- unlike the default copy policy -- almost none of them are
    // shared: each large (>window-size) filler between entries bypasses and invalidates the
    // window, forcing a fresh refill for the next windowed read. The one exception is the
    // very first pair (IHDR immediately followed by the first tEXt marker, both close enough
    // together to land inside the SAME initial window before any filler has had a chance to
    // invalidate it) -- measured at 51 of 52 unique, i.e. windowed.length - 1, not
    // windowed.length exactly.
    for (const entry of windowed) {
      expect(entry.buffer.byteLength).toBeGreaterThanOrEqual(entry.length);
    }
    const uniqueBackingBuffers = new Set(windowed.map((entry) => entry.buffer));
    expect(uniqueBackingBuffers.size).toBeGreaterThanOrEqual(
      windowed.length - 1,
    );
  }, 30_000);

  it("buffered bytes are identical under both retain policies", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "input.png");
    const size = await writeWindowRetentionFixture(path, 50);

    const defaultHandle = await open(path, "r");
    let defaultParsed;
    try {
      defaultParsed = await parsePng(defaultHandle, size);
    } finally {
      await defaultHandle.close();
    }

    const identityHandle = await open(path, "r");
    let identityParsed;
    try {
      identityParsed = await parsePng(
        identityHandle,
        size,
        undefined,
        undefined,
        (view) => view,
      );
    } finally {
      await identityHandle.close();
    }

    expect(defaultParsed.buffered.size).toBe(identityParsed.buffered.size);
    for (const [index, defaultEntry] of defaultParsed.buffered.entries()) {
      const identityEntry = identityParsed.buffered.get(index);
      expect(identityEntry).toBeDefined();
      expect(defaultEntry.equals(identityEntry!)).toBe(true);
    }
  }, 30_000);

  it("copyWindowedChunk returns a fresh copy: mutating the source does not affect the copy", () => {
    const source = Buffer.from("hello");
    const copy = copyWindowedChunk(source);
    expect(copy.equals(source)).toBe(true);
    source.fill(0);
    expect(copy.toString("ascii")).toBe("hello");
  });
});
