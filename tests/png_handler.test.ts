import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import {
  metadataPng,
  minimalPng,
  png,
  pngChunk,
  pngIdat,
  pngIhdr,
} from "./fixtures.js";

/**
 * End-to-end proof that a PNG travels the whole native path (56-03's
 * architectural tracer): magic selection, admission through the Plan 02
 * codec, D-05 closed-list classification, output plan, write, re-parse
 * verification, and publication -- through the public API, against the
 * built `dist/index.js` (mirrors tests/qualification/webp/golden.test.ts's
 * dist-import convention).
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
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-handler-"));
  directories.push(directory);
  return directory;
}

function readPngChunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

function readPngChunkBytes(bytes: Buffer, type: string): Buffer | undefined {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const span = 12 + length;
    if (chunkType === type) return bytes.subarray(offset, offset + span);
    offset += span;
    if (chunkType === "IEND") break;
  }
  return undefined;
}

const NO_PRESERVATION = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

describe("PNG handler end to end (56-03 tracer)", () => {
  it("(a) sanitizes a metadata-bearing PNG: destination types are exactly IHDR cHRM bKGD IDAT IEND, and each kept chunk's bytes equal the source's", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.png");
    const destinationPath = join(directory, "destination.png");
    const source = metadataPng();
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.format).toBe("png");

    const destination = await readFile(destinationPath);
    const expectedTypes = ["IHDR", "cHRM", "bKGD", "IDAT", "IEND"];
    expect(readPngChunkTypes(destination)).toEqual(expectedTypes);
    for (const type of expectedTypes) {
      const sourceChunk = readPngChunkBytes(source, type);
      const destinationChunk = readPngChunkBytes(destination, type);
      expect(sourceChunk).toBeDefined();
      expect(destinationChunk?.equals(sourceChunk!)).toBe(true);
    }
  });

  it("(b) sanitizes a minimal PNG (no removable chunks) to output bytes identical to the source", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.png");
    const destinationPath = join(directory, "destination.png");
    const source = minimalPng();
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    expect(destination.equals(source)).toBe(true);
  });

  it("(c) keeps pHYs byte-identical at the same relative position when preserveResolution is true, and removes it when false", async () => {
    const directory = await freshDirectory();
    const source = metadataPng();

    for (const preserveResolution of [true, false]) {
      const sourcePath = join(directory, `source-${String(preserveResolution)}.png`);
      const destinationPath = join(
        directory,
        `destination-${String(preserveResolution)}.png`,
      );
      await writeFile(sourcePath, source);

      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...NO_PRESERVATION,
        preserveResolution,
      });
      expect(result.ok).toBe(true);

      const destination = await readFile(destinationPath);
      const types = readPngChunkTypes(destination);
      if (preserveResolution) {
        expect(types).toEqual(["IHDR", "cHRM", "bKGD", "pHYs", "IDAT", "IEND"]);
        const sourcePhys = readPngChunkBytes(source, "pHYs");
        const destinationPhys = readPngChunkBytes(destination, "pHYs");
        expect(sourcePhys).toBeDefined();
        expect(destinationPhys?.equals(sourcePhys!)).toBe(true);
      } else {
        expect(types).not.toContain("pHYs");
      }
    }
  });

  it("(d) declines a source with an unregistered ancillary chunk as unsafe-structure, safe to fall back, leaving only the source on disk", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.png");
    const destinationPath = join(directory, "destination.png");
    const source = png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("prVt", Buffer.from("private", "ascii")),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.png"]);
    const sourceAfter = await readFile(sourcePath);
    expect(sourceAfter.equals(source)).toBe(true);
  });
});
