import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import { createOrientationExif, parseExif } from "../src/metadata/exif.js";
import { PNG_MAX_INFLATED_TEXT_BYTES } from "../src/png/chunks.js";
import {
  exifWithOrientation,
  pngItxt,
  pngTextChunkData,
  pngWithChunksBefore,
  pngZtxtChunkData,
  rawProfileExifText,
  xmpPacket,
  xmpWithOrientation,
  XMP_ITXT_KEYWORD,
} from "./fixtures.js";

/**
 * D-11/D-13: eXIf Orientation is preserved as a minimal eXIf (Orientation
 * only, via createOrientationExif) placed immediately after IHDR, and is
 * verified byte-for-byte and by re-parse before publish. Task 2 adds the
 * non-eXIf-source decline behavior (D-11/D-12) alongside these.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-png-orientation-"),
  );
  directories.push(directory);
  return directory;
}

const ALL_FALSE = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

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

function chunkDataOfType(file: Buffer, type: string): Buffer | undefined {
  const bytes = chunkBytesOfType(file, type);
  if (bytes === undefined) return undefined;
  const length = bytes.readUInt32BE(0);
  return bytes.subarray(8, 8 + length);
}

async function sanitizeToDirectory(
  source: Buffer,
  options: Partial<typeof ALL_FALSE> = {},
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

describe("PNG orientation: eXIf preserved as a minimal eXIf after IHDR (D-11, D-13)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "orientation %d: output eXIf is at index 1, byte-identical to createOrientationExif(n), preserved.orientation true",
    async (value) => {
      const source = pngWithChunksBefore([
        ["eXIf", exifWithOrientation(value)],
      ]);
      const { destinationPath, result } = await sanitizeToDirectory(source, {
        preserveOrientation: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.preserved.orientation).toBe(true);

      const destination = await readFile(destinationPath);
      expect(chunkTypesOf(destination)[1]).toBe("eXIf");
      const exifData = chunkDataOfType(destination, "eXIf");
      expect(exifData).toBeDefined();
      expect(exifData!.equals(createOrientationExif(value))).toBe(true);
      const reparsed = parseExif(exifData!);
      expect(reparsed.orientation).toEqual({ status: "valid", value });
      expect(reparsed.entries).toHaveLength(1);
    },
  );

  it("preserveOrientation false: no eXIf in the output, EXIF in removedNamespaces", async () => {
    const source = pngWithChunksBefore([["eXIf", exifWithOrientation(6)]]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(false);
    expect(result.value.removedNamespaces).toContain("EXIF");

    const destination = await readFile(destinationPath);
    expect(chunkTypesOf(destination)).not.toContain("eXIf");
  });
});

describe("PNG orientation: non-eXIf sources decline when missing or disagreeing (D-11, D-12)", () => {
  it("XMP-only Orientation 6, preserveOrientation true: declined orientation-preservation, no destination", async () => {
    const source = pngWithChunksBefore([
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpWithOrientation(6))],
    ]);
    const { directory, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if (result.error.code !== "unsupported-feature")
      throw new Error("unreachable");
    expect(result.error.feature).toBe("orientation-preservation");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("XMP-only Orientation 6, preserveOrientation false: success, XMP removed", async () => {
    const source = pngWithChunksBefore([
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpWithOrientation(6))],
    ]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).toContain("XMP");

    const destination = await readFile(destinationPath);
    expect(chunkTypesOf(destination)).not.toContain("iTXt");
  });

  it("eXIf 6 plus agreeing XMP 6: success, output eXIf equals createOrientationExif(6)", async () => {
    const source = pngWithChunksBefore([
      ["eXIf", exifWithOrientation(6)],
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpWithOrientation(6))],
    ]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(true);

    const destination = await readFile(destinationPath);
    const exifData = chunkDataOfType(destination, "eXIf");
    expect(exifData?.equals(createOrientationExif(6))).toBe(true);
  });

  it("eXIf 6 plus disagreeing XMP 3, preserveOrientation true: declined", async () => {
    const source = pngWithChunksBefore([
      ["eXIf", exifWithOrientation(6)],
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpWithOrientation(3))],
    ]);
    const { directory, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if (result.error.code !== "unsupported-feature")
      throw new Error("unreachable");
    expect(result.error.feature).toBe("orientation-preservation");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("Same eXIf 6 plus disagreeing XMP 3 file, preserveOrientation false: succeeds", async () => {
    const source = pngWithChunksBefore([
      ["eXIf", exifWithOrientation(6)],
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpWithOrientation(3))],
    ]);
    const { result } = await sanitizeToDirectory(source, {
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);
  });

  it("raw-profile-only (tEXt \"Raw profile type exif\", Orientation 8), preserveOrientation true: declined", async () => {
    const source = pngWithChunksBefore([
      [
        "tEXt",
        pngTextChunkData(
          "Raw profile type exif",
          rawProfileExifText(exifWithOrientation(8)),
        ),
      ],
    ]);
    const { directory, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if (result.error.code !== "unsupported-feature")
      throw new Error("unreachable");
    expect(result.error.feature).toBe("orientation-preservation");
    expect(await readdir(directory)).toEqual(["source.png"]);
  });

  it("Same raw-profile-only file, preserveOrientation false: succeeds", async () => {
    const source = pngWithChunksBefore([
      [
        "tEXt",
        pngTextChunkData(
          "Raw profile type exif",
          rawProfileExifText(exifWithOrientation(8)),
        ),
      ],
    ]);
    const { result } = await sanitizeToDirectory(source, {
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);
  });

  it("raw-profile in zTXt (\"Raw profile type APP1\") agreeing with eXIf: success", async () => {
    const source = pngWithChunksBefore([
      ["eXIf", exifWithOrientation(4)],
      [
        "zTXt",
        pngZtxtChunkData(
          "Raw profile type APP1",
          rawProfileExifText(exifWithOrientation(4)),
        ),
      ],
    ]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(true);

    const destination = await readFile(destinationPath);
    const exifData = chunkDataOfType(destination, "eXIf");
    expect(exifData?.equals(createOrientationExif(4))).toBe(true);
  });

  it("XMP without any Orientation plus eXIf 6: success", async () => {
    const source = pngWithChunksBefore([
      ["eXIf", exifWithOrientation(6)],
      ["iTXt", pngItxt(XMP_ITXT_KEYWORD, xmpPacket())],
    ]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(true);

    const destination = await readFile(destinationPath);
    const exifData = chunkDataOfType(destination, "eXIf");
    expect(exifData?.equals(createOrientationExif(6))).toBe(true);
  });

  it("no orientation anywhere, preserveOrientation true: success, no eXIf, preserved.orientation false", async () => {
    const source = pngWithChunksBefore([]);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(false);

    const destination = await readFile(destinationPath);
    expect(chunkTypesOf(destination)).not.toContain("eXIf");
  });

  it.each([true, false])(
    "raw profile declaring a length over PNG_MAX_INFLATED_TEXT_BYTES declines unsafe-structure regardless of preserveOrientation=%s",
    async (preserveOrientation) => {
      const overBoundText = `\nexif\n${String(
        PNG_MAX_INFLATED_TEXT_BYTES + 1,
      ).padStart(8, " ")}\nAA\n`;
      const source = pngWithChunksBefore([
        ["tEXt", pngTextChunkData("Raw profile type exif", overBoundText)],
      ]);
      const { directory, result } = await sanitizeToDirectory(source, {
        preserveOrientation,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("unsafe-structure");
      expect(result.error.nativeWrite).toBe("not-started");
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");
      expect(await readdir(directory)).toEqual(["source.png"]);
    },
  );
});
