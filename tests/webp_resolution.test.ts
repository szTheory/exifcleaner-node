// WEBP-07 (68-05): native WebP preserves print resolution (EXIF IFD0 XResolution,
// YResolution, ResolutionUnit) through the shared minimal-EXIF writer. Everything here runs
// through the real engine (`sanitizeFile`), never a handler-only shortcut.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/index.js";
import { createMinimalExif } from "../src/metadata/exif.js";
import type { MinimalExifTags } from "../src/metadata/exif.js";
import {
  exifWithResolution,
  readChunks,
  vp8,
  vp8x,
  webp,
  type ExifResolutionFixtureOptions,
} from "./fixtures.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-webp-res-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Extended WebP: VP8X (EXIF flag), VP8 bitstream, then the given EXIF chunk payload. */
function webpWithExif(exif: Buffer): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x08) },
    { fourCc: "VP8 ", data: vp8() },
    { fourCc: "EXIF", data: exif },
  ]);
}

const RICH: ExifResolutionFixtureOptions = {
  make: "CameraCo",
  artist: "Some Artist",
  orientation: 6,
  xResolution: [300, 1],
  yResolution: [72, 1],
  resolutionUnit: 2,
};

const RICH_RESOLUTION = {
  x: { numerator: 300, denominator: 1 },
  y: { numerator: 72, denominator: 1 },
  unit: 2,
} as const;

interface Flags {
  readonly preserveOrientation: boolean;
  readonly preserveResolution: boolean;
}

async function run(
  source: Buffer,
  flags: Flags,
): Promise<{
  readonly directory: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly result: Awaited<ReturnType<typeof sanitizeFile>>;
}> {
  const directory = await workspace();
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "clean.webp");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    preserveOrientation: flags.preserveOrientation,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: flags.preserveResolution,
  });
  return { directory, sourcePath, destinationPath, result };
}

function exifChunks(output: Buffer): readonly Buffer[] {
  return readChunks(output)
    .filter((item) => item.fourCc === "EXIF")
    .map((item) => item.data);
}

describe("WEBP-07 tracer: resolution and orientation through the real engine", () => {
  it("keeps only the minimal EXIF (orientation plus the raw resolution triple) and sets the VP8X EXIF flag", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { directory, sourcePath, destinationPath, result } = await run(
      source,
      { preserveOrientation: true, preserveResolution: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    expect(result.value.preserved.orientation).toBe(true);

    const output = await readFile(destinationPath);
    const expected: MinimalExifTags = {
      orientation: 6,
      resolution: RICH_RESOLUTION,
    };
    expect(exifChunks(output)).toEqual([createMinimalExif(expected)]);
    const chunks = readChunks(output);
    expect(chunks.map((item) => item.fourCc)).toEqual(["VP8X", "VP8 ", "EXIF"]);
    expect(chunks[0]?.data[0]).toBe(0x08);
    expect(output.includes(Buffer.from("CameraCo"))).toBe(false);
    expect(output.includes(Buffer.from("Some Artist"))).toBe(false);

    expect((await readdir(directory)).sort()).toEqual([
      "clean.webp",
      "source.webp",
    ]);
    expect((await readFile(sourcePath)).equals(source)).toBe(true);
  });
});
