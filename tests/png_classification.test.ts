import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import { createOrientationExif } from "../src/metadata/exif.js";
import {
  chunkTypeAt,
  exifWithOrientation,
  idotPayload,
  idotSecondSegmentTarget,
  pngChrm,
  pngChunk,
  pngCicp,
  pngIdat,
  pngIhdr,
  pngItxt,
  pngTextChunkData,
  pngTime,
  pngWithChunksBefore,
  pngZtxtChunkData,
  png,
  screenshotShapedPng,
} from "./fixtures.js";
import {
  PNG_ANIMATION_CHUNK_TYPES,
  PNG_CRITICAL_CHUNK_TYPES,
  PNG_ORDER,
  PNG_REGISTERED_CHUNK_TYPES,
  PNG_SIGNATURE,
} from "../src/png/chunks.js";
import {
  PNG_CONDITIONAL_CHUNK_TYPES,
  PNG_PRESERVED_CHUNK_TYPES,
  PNG_REMOVED_CHUNK_TYPES,
} from "../src/admission/png-handler.js";

/**
 * D-06 (iDOT adjacency invariant), D-07 (screenshot-shaped fixture,
 * constant-sourced classification assertions from Task 3).
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

  it("screenshot-shaped source with preserveOrientation true (D-13): eXIf at index 1, iDOT kept, second-segment offset still lands on IDAT", async () => {
    const source = screenshotShapedPng(4, 6);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
      preserveColorProfile: true,
      preserveResolution: true,
      preserveTimestamps: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(true);

    const destination = await readFile(destinationPath);
    const types = chunkTypesOf(destination);
    expect(types[1]).toBe("eXIf");
    expect(types).toContain("iDOT");
    const exifBytes = chunkBytesOfType(destination, "eXIf");
    const exifData = exifBytes?.subarray(8, 8 + exifBytes.readUInt32BE(0));
    expect(exifData?.equals(createOrientationExif(6))).toBe(true);

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
    const source = buildIdotFixture([], [["pHYs", Buffer.alloc(9, 0)]]);
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
    const source = buildIdotFixture([], [["pHYs", Buffer.alloc(9, 0)]]);
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

// Task 3: constant-sourced keep/strip/decline assertions and list snapshots.

function chunkBytesOfType(file: Buffer, type: string): Buffer | undefined {
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const chunkType = file.toString("ascii", offset + 4, offset + 8);
    const span = 12 + length;
    if (chunkType === type) return file.subarray(offset, offset + span);
    offset += span;
    if (chunkType === "IEND") break;
  }
  return undefined;
}

function chunkTypesOf(file: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

/**
 * Builds `IHDR`, the given chunk, `IDAT`, `IEND`, placing the chunk legally
 * per its `PNG_ORDER` class. `after-plte-before-idat` types get a palette
 * (`colorType 3`) `IHDR` and a one-entry `PLTE` ahead of them; every other
 * class is satisfied by a plain placement before `IDAT`.
 */
function buildChunkFixture(type: string, data: Buffer): Buffer {
  const orderClass = PNG_ORDER.get(type) ?? "anywhere";
  if (orderClass === "after-plte-before-idat") {
    return png([
      pngChunk("IHDR", pngIhdr(1, 1, 8, 3)),
      pngChunk("PLTE", Buffer.from([0, 0, 0])),
      pngChunk(type, data),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }
  return pngWithChunksBefore([[type, data]]);
}

const PRESERVED_PAYLOADS: Readonly<Record<string, Buffer>> = {
  tRNS: Buffer.from([255]),
  cHRM: pngChrm(),
  bKGD: Buffer.from([0]),
  sBIT: Buffer.from([8, 8, 8]),
  sPLT: Buffer.concat([
    Buffer.from("sp", "latin1"),
    Buffer.from([0]),
    Buffer.from([8]),
    Buffer.alloc(10),
  ]),
  hIST: Buffer.alloc(2),
  cICP: pngCicp(),
  mDCv: Buffer.alloc(24),
  cLLi: Buffer.alloc(4),
  sCAL: Buffer.from("1\x0010.0\x0010.0", "ascii"),
  oFFs: Buffer.alloc(9),
  pCAL: Buffer.concat([
    Buffer.from("cal", "latin1"),
    Buffer.from([0]),
    Buffer.alloc(9),
    Buffer.from([0]),
    Buffer.from([0]),
  ]),
  sTER: Buffer.from([0]),
  iDOT: Buffer.alloc(28),
  vpAg: Buffer.alloc(9),
};

const REMOVED_PAYLOADS: Readonly<Record<string, Buffer>> = {
  tEXt: pngTextChunkData("Comment", "private workflow"),
  zTXt: pngZtxtChunkData("Comment", "private workflow"),
  iTXt: pngItxt("Comment", Buffer.from("private workflow", "utf8")),
  eXIf: exifWithOrientation(1),
  tIME: pngTime(),
  caBX: Buffer.from("c2pa-manifest-placeholder", "ascii"),
  gAMA: Buffer.alloc(4),
  sRGB: Buffer.from([0]),
};

const registeredUnmeasured = [...PNG_REGISTERED_CHUNK_TYPES].filter(
  (type) =>
    !PNG_CRITICAL_CHUNK_TYPES.has(type) &&
    !PNG_ANIMATION_CHUNK_TYPES.has(type) &&
    !PNG_PRESERVED_CHUNK_TYPES.has(type) &&
    !PNG_REMOVED_CHUNK_TYPES.has(type) &&
    !PNG_CONDITIONAL_CHUNK_TYPES.has(type),
);

describe("PNG classification: constant-sourced keep/strip/decline (D-05, D-08)", () => {
  it.each([...PNG_PRESERVED_CHUNK_TYPES])(
    "keeps %s byte-identical (D-05)",
    async (type) => {
      const data = PRESERVED_PAYLOADS[type] ?? Buffer.alloc(4);
      const source = buildChunkFixture(type, data);
      const { destinationPath, result } = await sanitizeToDirectory(source);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      const destination = await readFile(destinationPath);
      const sourceChunk = chunkBytesOfType(source, type);
      const destinationChunk = chunkBytesOfType(destination, type);
      expect(sourceChunk).toBeDefined();
      expect(destinationChunk).toBeDefined();
      expect(destinationChunk!.equals(sourceChunk!)).toBe(true);
      expect(chunkTypesOf(destination)).toContain(type);
    },
  );

  it.each([...PNG_REMOVED_CHUNK_TYPES])(
    "removes %s (D-05, D-08)",
    async (type) => {
      const data = REMOVED_PAYLOADS[type] ?? Buffer.alloc(4);
      const source = buildChunkFixture(type, data);
      const { destinationPath, result } = await sanitizeToDirectory(source);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      const destination = await readFile(destinationPath);
      expect(chunkTypesOf(destination)).not.toContain(type);
    },
  );

  it("registeredUnmeasured is non-empty and contains gIFg", () => {
    expect(registeredUnmeasured.length).toBeGreaterThan(0);
    expect(registeredUnmeasured).toContain("gIFg");
  });

  it.each(registeredUnmeasured)("declines %s (D-05)", async (type) => {
    const source = buildChunkFixture(type, Buffer.alloc(4));
    const { result, directory } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error.detail).toContain(type);
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("PNG_PRESERVED_CHUNK_TYPES matches the pinned D-05 list (negative control: deleting cHRM fails this assertion)", () => {
    expect([...PNG_PRESERVED_CHUNK_TYPES].sort()).toEqual(
      [
        "tRNS",
        "cHRM",
        "bKGD",
        "sBIT",
        "sPLT",
        "hIST",
        "cICP",
        "mDCv",
        "cLLi",
        "sCAL",
        "oFFs",
        "pCAL",
        "sTER",
        "iDOT",
        "vpAg",
      ].sort(),
    );
  });

  it("PNG_REMOVED_CHUNK_TYPES matches the pinned D-05 list", () => {
    expect([...PNG_REMOVED_CHUNK_TYPES].sort()).toEqual(
      ["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "caBX", "gAMA", "sRGB"].sort(),
    );
  });

  it("PNG_CONDITIONAL_CHUNK_TYPES keys are exactly iCCP and pHYs", () => {
    expect([...PNG_CONDITIONAL_CHUNK_TYPES.keys()].sort()).toEqual(
      ["iCCP", "pHYs"].sort(),
    );
  });
});
