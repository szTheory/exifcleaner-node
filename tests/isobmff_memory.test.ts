// ISOBMFF-05 / BMF-05 (D-23): a real, measured RSS proof mirroring `tests/png_memory.test.ts`
// (PNG D-28/D-29). Four sparse/compact fixtures, one per `IsobmffCaps` field, each proven to
// decline its own class under the real `DEFAULT_ISOBMFF_CAPS`, and each proven to discriminate
// when that one cap alone is raised to `Number.POSITIVE_INFINITY` (the child's `capMode` argv,
// `tests/isobmff_memory_child.mjs`). The PNG precedent (56 WR-02) showed a cap that exists but
// does not gate the expensive read; only a measured negative control proves a cap discriminates.
//
// Every measured RSS figure is recorded ONLY in `61-11-SUMMARY.md` (60-CONTEXT D-29): this file
// states the ceiling-derivation RULE, never a measured number.

import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
import {
  ftypBox,
  hdlrBox,
  hvcC,
  iinfBox,
  ilocBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  ispe,
  metaBox,
  pitmBox,
} from "./isobmff-support/builder.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-rss-"));
  directories.push(directory);
  return directory;
}

async function admitFixturePath(path: string) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return await admitIsobmff(handle, size);
  } finally {
    await handle.close();
  }
}

// --- Fixture builders ---------------------------------------------------------------------
//
// Each fixture is sized to trip exactly one `DEFAULT_ISOBMFF_CAPS` field under the real caps,
// while staying comfortably under every OTHER cap -- so a negative control that raises only the
// target cap isolates that one cap's own discrimination, never a different cap's decline.

const CAP_BOX_COUNT = 65_536;

/** `cap-meta-bytes`: `meta`'s declared total size is 512 MiB -- far over `CAP_META_BYTES`.
 * Sparse: `IsobmffBudget.checkMetaSize` throws from the declared size alone, before the payload
 * is ever read, so only the 8-byte `ftyp` and 8-byte `meta` header are written for real; the
 * rest is a `truncate`d hole, provably never touched under the real default cap. */
async function writeOversizedMetaFixture(path: string): Promise<number> {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const declaredMetaTotal = 8 + 512 * 1024 * 1024; // header(8) + a 512 MiB declared payload
  const metaHeader = Buffer.alloc(8);
  metaHeader.writeUInt32BE(declaredMetaTotal, 0);
  metaHeader.write("meta", 4, 4, "ascii");
  const totalSize = ftyp.length + declaredMetaTotal;

  const handle = await open(path, "w");
  try {
    await handle.write(ftyp, 0, ftyp.length, 0);
    await handle.write(metaHeader, 0, 8, ftyp.length);
    await handle.truncate(totalSize);
  } finally {
    await handle.close();
  }
  return totalSize;
}

/** `cap-box-count`: `meta`'s only children are `count` empty `free` boxes (8 bytes each, real --
 * `checkMetaSize` passes comfortably under `CAP_META_BYTES`, so these bytes are actually read and
 * walked). `count` is chosen so the default-cap decline fires promptly (just over
 * `CAP_BOX_COUNT`) while the `no-count` run walks every box to the end, inflating RSS with a
 * `BoxHeader` object per box -- all while staying under `CAP_META_BYTES` (`count * 8` bytes). No
 * hdlr/pitm/iinf/iloc at all: the structural box-count walk runs before any item-graph
 * validation would be reached either way. */
function writeBoxCountFloodBuffer(count: number): Buffer {
  const freeBoxes = Buffer.alloc(count * 8);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 8;
    freeBoxes.writeUInt32BE(8, offset);
    freeBoxes.write("free", offset + 4, 4, "ascii");
  }
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const meta = metaBox([freeBoxes]);
  return Buffer.concat([ftyp, meta]);
}

/** `cap-box-depth`: `meta`'s only child is a chain of `depth` nested `dinf` boxes (meta itself is
 * depth 1; the innermost `dinf`'s own empty payload is processed at depth `depth + 1`). `depth`
 * is chosen deep enough that removing the depth cap alone either exhausts the JS call stack
 * (`walkContainer` recurses once per nesting level) or measurably grows RSS, while staying under
 * `CAP_BOX_COUNT` (one box per level) so the box-count cap never fires first under `no-depth`. */
function writeDepthChainBuffer(depth: number): Buffer {
  let nested = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("dinf")]);
  for (let level = 1; level < depth; level += 1) {
    const size = 8 + nested.length;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size, 0);
    header.write("dinf", 4, 4, "ascii");
    nested = Buffer.concat([header, nested]);
  }
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const meta = metaBox([nested]);
  return Buffer.concat([ftyp, meta]);
}

/** `cap-buffered-bytes`: a fully valid, fully admitted item graph (a surviving `hvc1` primary
 * plus a removable `Exif` item) whose `Exif` extent is 512 MiB. Sparse -- `mdat`'s payload is a
 * `truncate`d hole; `admitIsobmff`'s `budget.consumeBuffered(extent.length)` must throw before
 * the matching `readExactly` call ever executes under the real default cap, so the 512 MiB
 * region is provably never allocated or read; under `no-buffered` the full 512 MiB IS read back
 * (as zeros, from the sparse hole), which is the fixture's actual memory cost. */
async function writeOversizedExifFixture(path: string): Promise<number> {
  const primaryPayloadLength = 4;
  const exifExtentLength = 512 * 1024 * 1024;

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infePrimary = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infeExif = infeBox({
      version: 2,
      itemId: 2,
      itemType: "Exif",
      hidden: true,
    });
    const iinf = iinfBox(0, [infePrimary, infeExif]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: true },
          ],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: 0, length: primaryPayloadLength }],
        },
        {
          itemId: 2,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: primaryPayloadLength, length: exifExtentLength }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    return Buffer.concat([ftyp, meta]);
  };

  const headerOnly = build(0);
  const mdatPayloadStart = headerOnly.length + 8;
  const header = build(mdatPayloadStart);
  if (header.length !== headerOnly.length) {
    throw new Error(
      "writeOversizedExifFixture: header length changed between placeholder and final passes",
    );
  }

  const mdatPayloadLength = primaryPayloadLength + exifExtentLength;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + mdatPayloadLength, 0);
  mdatHeader.write("mdat", 4, 4, "ascii");
  const primaryPayload = Buffer.from([1, 2, 3, 4]);
  const totalSize = header.length + 8 + mdatPayloadLength;

  const handle = await open(path, "w");
  try {
    await handle.write(header, 0, header.length, 0);
    await handle.write(mdatHeader, 0, 8, header.length);
    await handle.write(
      primaryPayload,
      0,
      primaryPayload.length,
      header.length + 8,
    );
    await handle.truncate(totalSize);
  } finally {
    await handle.close();
  }
  return totalSize;
}

// --- Child RSS harness spawn/parse ---------------------------------------------------------

const CHILD_PATH = fileURLToPath(
  new URL("./isobmff_memory_child.mjs", import.meta.url),
);

type CapMode = "default" | "no-meta" | "no-count" | "no-depth" | "no-buffered";

interface ChildResult {
  outcome: "admitted" | "error" | "crash";
  declineClass?: string;
  kind?: string;
  errorName?: string;
  maxRssBytes: number;
}

// ISOBMFF-05 / D-23: spawns the real measurement harness (tests/isobmff_memory_child.mjs) and
// parses its single JSON stdout line.
function runChild(fixture: string, capMode: CapMode): ChildResult {
  const result = spawnSync(process.execPath, [CHILD_PATH, fixture, capMode], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `isobmff_memory_child exited ${result.status}: ${result.stderr}`,
    );
  }
  const lastLine = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .pop();
  if (lastLine === undefined) {
    throw new Error(
      `isobmff_memory_child produced no output: ${result.stderr}`,
    );
  }
  return JSON.parse(lastLine) as ChildResult;
}

// ISOBMFF-05 / D-29: chosen from local measurement (see 61-11-SUMMARY.md "Memory measurement"
// for the recorded figures and host/runtime details -- this file states only the derivation
// rule, never the measured numbers, per 60-CONTEXT D-29). The ceiling sits at or above 1.5x the
// highest measured capped-run peak and at or below 0.6x the lowest measured uncapped-run peak
// among the RSS-discriminating controls (no-meta, no-count, no-buffered), with headroom on both
// sides.
export const ISOBMFF_MEMORY_RSS_CEILING_BYTES = 256 * 1024 * 1024;

describe("child RSS harness unit sanity", () => {
  it("an idle child (no fixture) reports maxRssBytes between 16 MiB and 256 MiB", () => {
    const result = runChild("--idle", "default");
    expect(result.outcome).toBe("admitted");
    expect(result.maxRssBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(result.maxRssBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});

describe("ISOBMFF memory caps (BMF-05, D-23): oversized meta end to end under default caps", () => {
  it("declines the 512 MiB declared meta as unsafe-structure/cap-meta-bytes through admitIsobmff directly", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "oversized-meta.heic");
    await writeOversizedMetaFixture(path);

    await expect(admitFixturePath(path)).rejects.toMatchObject({
      kind: "unsafe-structure",
      declineClass: "cap-meta-bytes",
    });
  });

  it("the same fixture declines through the real measurement child under capMode default (ceiling asserted in Task 2's describe block below)", async () => {
    const directory = await freshDirectory();
    const path = join(directory, "oversized-meta.heic");
    await writeOversizedMetaFixture(path);

    const result = runChild(path, "default");
    expect(result.outcome).toBe("error");
    expect(result.declineClass).toBe("cap-meta-bytes");
    expect(result.kind).toBe("unsafe-structure");
  }, 60_000);
});

describe("ISOBMFF memory caps (BMF-05, D-23): every cap's own fixture and negative control", () => {
  let directory: string;
  let oversizedMetaPath: string;
  let boxCountFloodPath: string;
  let depthChainPath: string;
  let oversizedExifPath: string;

  // Far more boxes than CAP_BOX_COUNT (but still well under CAP_META_BYTES / 8 bytes-per-box ~=
  // 2,097,152): the default-cap run still declines promptly at box CAP_BOX_COUNT + 1, while the
  // no-count run must walk every one of these boxes to the end, inflating RSS with a BoxHeader
  // object per box -- the actual memory cost this fixture is designed to measure.
  const BOX_COUNT_FLOOD_COUNT = 2_000_000;
  const DEPTH_CHAIN_DEPTH = CAP_BOX_COUNT - 1000; // comfortably under CAP_BOX_COUNT, deep enough
  // to exhaust the JS call stack once the depth cap is removed (walkContainer recurses once per
  // nesting level) -- see docs/isobmff.md "## Memory caps" and 61-11-SUMMARY.md for which
  // outcome ("crash" or an above-ceiling "admitted"/"error") this repo's run actually measured.

  async function freshFixtures(): Promise<void> {
    directory = await freshDirectory();
    oversizedMetaPath = join(directory, "oversized-meta.heic");
    await writeOversizedMetaFixture(oversizedMetaPath);

    boxCountFloodPath = join(directory, "box-count-flood.heic");
    await (async () => {
      const handle = await open(boxCountFloodPath, "w");
      try {
        const bytes = writeBoxCountFloodBuffer(BOX_COUNT_FLOOD_COUNT);
        await handle.write(bytes, 0, bytes.length, 0);
      } finally {
        await handle.close();
      }
    })();

    depthChainPath = join(directory, "depth-chain.heic");
    await (async () => {
      const handle = await open(depthChainPath, "w");
      try {
        const bytes = writeDepthChainBuffer(DEPTH_CHAIN_DEPTH);
        await handle.write(bytes, 0, bytes.length, 0);
      } finally {
        await handle.close();
      }
    })();

    oversizedExifPath = join(directory, "oversized-exif.heic");
    await writeOversizedExifFixture(oversizedExifPath);
  }

  it("cap-meta-bytes: default declines at or below the ceiling; no-meta (negative control) exceeds it", async () => {
    await freshFixtures();

    const capped = runChild(oversizedMetaPath, "default");
    expect(capped.outcome).toBe("error");
    expect(capped.declineClass).toBe("cap-meta-bytes");
    expect(
      capped.maxRssBytes,
      `measured ${(capped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(ISOBMFF_MEMORY_RSS_CEILING_BYTES);

    const uncapped = runChild(oversizedMetaPath, "no-meta");
    expect(
      uncapped.maxRssBytes,
      `measured ${(uncapped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeGreaterThan(ISOBMFF_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);

  it("cap-box-count: default declines at or below the ceiling; no-count (negative control) exceeds it", async () => {
    await freshFixtures();

    const capped = runChild(boxCountFloodPath, "default");
    expect(capped.outcome).toBe("error");
    expect(capped.declineClass).toBe("cap-box-count");
    expect(
      capped.maxRssBytes,
      `measured ${(capped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(ISOBMFF_MEMORY_RSS_CEILING_BYTES);

    const uncapped = runChild(boxCountFloodPath, "no-count");
    expect(
      uncapped.maxRssBytes,
      `measured ${(uncapped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeGreaterThan(ISOBMFF_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);

  it("cap-box-depth: default declines at or below the ceiling; no-depth (negative control) exceeds it OR crashes (stack exhaustion)", async () => {
    await freshFixtures();

    const capped = runChild(depthChainPath, "default");
    expect(capped.outcome).toBe("error");
    expect(capped.declineClass).toBe("cap-box-depth");
    expect(
      capped.maxRssBytes,
      `measured ${(capped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(ISOBMFF_MEMORY_RSS_CEILING_BYTES);

    const uncapped = runChild(depthChainPath, "no-depth");
    // D-23 (depth, flagged assumption): removing the depth cap either grows RSS past the ceiling
    // or exhausts the call stack (a "crash" outcome, never a typed cap-box-depth decline). Both
    // prove the cap is load-bearing; which one this run measured is recorded in 61-11-SUMMARY.md.
    if (uncapped.outcome === "crash") {
      expect(uncapped.declineClass).toBeUndefined();
      expect(uncapped.errorName).toBeDefined();
    } else {
      expect(uncapped.declineClass).not.toBe("cap-box-depth");
      expect(
        uncapped.maxRssBytes,
        `measured ${(uncapped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
          ISOBMFF_MEMORY_RSS_CEILING_BYTES /
          (1024 * 1024)
        ).toFixed(2)} MiB`,
      ).toBeGreaterThan(ISOBMFF_MEMORY_RSS_CEILING_BYTES);
    }
  }, 120_000);

  it("cap-buffered-bytes: default declines at or below the ceiling; no-buffered (negative control) exceeds it", async () => {
    await freshFixtures();

    const capped = runChild(oversizedExifPath, "default");
    expect(capped.outcome).toBe("error");
    expect(capped.declineClass).toBe("cap-buffered-bytes");
    expect(
      capped.maxRssBytes,
      `measured ${(capped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeLessThanOrEqual(ISOBMFF_MEMORY_RSS_CEILING_BYTES);

    const uncapped = runChild(oversizedExifPath, "no-buffered");
    expect(
      uncapped.maxRssBytes,
      `measured ${(uncapped.maxRssBytes / (1024 * 1024)).toFixed(2)} MiB, ceiling ${(
        ISOBMFF_MEMORY_RSS_CEILING_BYTES /
        (1024 * 1024)
      ).toFixed(2)} MiB`,
    ).toBeGreaterThan(ISOBMFF_MEMORY_RSS_CEILING_BYTES);
  }, 120_000);
});
