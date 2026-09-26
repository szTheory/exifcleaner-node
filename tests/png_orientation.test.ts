import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../dist/index.js";
import { createOrientationExif, parseExif } from "../src/metadata/exif.js";
import { exifWithOrientation, pngWithChunksBefore } from "./fixtures.js";

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
