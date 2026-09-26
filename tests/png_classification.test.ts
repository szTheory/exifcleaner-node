import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import {
  chunkTypeAt,
  idotPayload,
  idotSecondSegmentTarget,
  pngChunk,
  pngIdat,
  pngIhdr,
  screenshotShapedPng,
} from "./fixtures.js";
import { PNG_SIGNATURE } from "../src/png/chunks.js";

/**
 * D-06 (iDOT adjacency invariant) and D-07 (screenshot-shaped fixture,
 * constant-sourced classification assertions -- Task 3 appends those).
 */

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-png-classification-"),
  );
  directories.push(directory);
  return directory;
}

interface PreservationFlags {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
}

const ALL_FALSE: PreservationFlags = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

/**
 * Builds `IHDR`, `beforeIdot` chunks, `iDOT` (with a correctly computed
 * second-segment offset), `betweenIdotAndIdat` chunks, `IDAT`, `IDAT`,
 * `IEND`.
 */
function buildIdotFixture(
  beforeIdot: readonly (readonly [string, Buffer])[],
  betweenIdotAndIdat: readonly (readonly [string, Buffer])[],
  height = 4,
): Buffer {
  const ihdr = pngChunk("IHDR", pngIhdr(1, height));
  const before = beforeIdot.map(([type, data]) => pngChunk(type, data));
  const between = betweenIdotAndIdat.map(([type, data]) =>
    pngChunk(type, data),
  );
  const betweenSpan = between.reduce((sum, item) => sum + item.length, 0);
  const idat1 = pngChunk("IDAT", pngIdat());
  const IDOT_CHUNK_SPAN = 40;
  const offsetToSecondIdat = IDOT_CHUNK_SPAN + betweenSpan + idat1.length;
  const idot = pngChunk("iDOT", idotPayload(offsetToSecondIdat, height));
  const idat2 = pngChunk("IDAT", Buffer.from("second-idat-segment", "ascii"));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr,
    ...before,
    idot,
    ...between,
    idat1,
    idat2,
    iend,
  ]);
}

async function sanitizeToDirectory(
  source: Buffer,
  options: Partial<PreservationFlags> = {},
) {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.png");
  const destinationPath = join(directory, "destination.png");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...ALL_FALSE,
    ...options,
  });
  return { directory, sourcePath, destinationPath, result };
}

describe("PNG iDOT adjacency (D-06) and screenshot fixture (D-07)", () => {
  it("screenshot-shaped source, all flags false: ok, iDOT offset invariant holds", async () => {
    const source = screenshotShapedPng();
    const { destinationPath, result } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    const target = idotSecondSegmentTarget(destination);
    expect(target).toBeDefined();
    expect(chunkTypeAt(destination, target!)).toBe("IDAT");
  });

  it("screenshot-shaped source, preservation flags true (orientation false until Plan 06): ok, same iDOT invariant", async () => {
    const source = screenshotShapedPng();
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
      preserveResolution: true,
      preserveTimestamps: true,
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    const target = idotSecondSegmentTarget(destination);
    expect(target).toBeDefined();
    expect(chunkTypeAt(destination, target!)).toBe("IDAT");
  });

  it("IHDR iDOT tEXt IDAT IDAT IEND: declined unsafe-structure before any write, detail mentions iDOT", async () => {
    const source = buildIdotFixture([], [["tEXt", Buffer.from("k\0v")]]);
    const { result, directory } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error.detail).toContain("iDOT");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("IHDR iDOT pHYs IDAT IDAT IEND: preserveResolution true is ok (pHYs kept between)", async () => {
    const source = buildIdotFixture(
      [],
      [["pHYs", Buffer.alloc(9, 0)]],
    );
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const destination = await readFile(destinationPath);
    const target = idotSecondSegmentTarget(destination);
    expect(target).toBeDefined();
    expect(chunkTypeAt(destination, target!)).toBe("IDAT");
  });

  it("IHDR iDOT pHYs IDAT IDAT IEND: preserveResolution false is declined", async () => {
    const source = buildIdotFixture(
      [],
      [["pHYs", Buffer.alloc(9, 0)]],
    );
    const { result, directory } = await sanitizeToDirectory(source, {
      preserveResolution: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error.detail).toContain("iDOT");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("IHDR tEXt iDOT IDAT IDAT IEND: ok, tEXt before iDOT is removed and the iDOT invariant holds", async () => {
    const source = buildIdotFixture([["tEXt", Buffer.from("k\0v")]], []);
    const { result, destinationPath } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const destination = await readFile(destinationPath);
    expect(destination.includes(Buffer.from("tEXt", "ascii"))).toBe(false);
    const target = idotSecondSegmentTarget(destination);
    expect(target).toBeDefined();
    expect(chunkTypeAt(destination, target!)).toBe("IDAT");
  });
});
