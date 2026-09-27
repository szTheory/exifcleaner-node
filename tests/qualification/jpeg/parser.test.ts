import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { getCapabilities, sanitizeFile } from "../../../dist/index.js";
import { parseJpeg } from "../../../src/jpeg/parser.js";
import { JPEG_REFUSAL_KIND, type JpegRefusal } from "../../../src/jpeg/markers.js";
import {
  hostileMutationCases,
  materializeMutationCase,
  validGrammarCases,
} from "./generators.js";

async function withMaterializedCase<T>(
  id: string,
  callback: (path: string, fileSize: number, directory: string) => Promise<T>,
): Promise<T> {
  const materialized = materializeMutationCase(id);
  const directory = await mkdtemp(join(tmpdir(), "jpeg-parser-case-"));
  const sourcePath = join(directory, "source.jpg");
  try {
    await writeFile(sourcePath, materialized.prefix);
    const handle = await open(sourcePath, "r+");
    try {
      if (materialized.fileSize !== materialized.prefix.length)
        await handle.truncate(materialized.fileSize);
    } finally {
      await handle.close();
    }
    return await callback(sourcePath, materialized.fileSize, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function parsePath(path: string, fileSize: number) {
  const handle = await open(path, "r");
  try {
    return await parseJpeg(handle, fileSize);
  } finally {
    await handle.close();
  }
}

describe("grammar-aware JPEG qualification cases", () => {
  it.each(validGrammarCases)(
    "parses $id structurally and sanitizes with all flags false",
    async ({ id, bytes }) => {
      const directory = await mkdtemp(join(tmpdir(), "jpeg-valid-case-"));
      const sourcePath = join(directory, "source.jpg");
      const destinationPath = join(directory, "output.jpg");
      try {
        await writeFile(sourcePath, bytes);
        const parsed = await parsePath(sourcePath, bytes.length);
        expect(parsed.segments.length).toBeGreaterThan(0);

        const result = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(result.ok, id).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("has unique, non-empty valid grammar case IDs", () => {
    const ids = validGrammarCases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    for (const { bytes } of validGrammarCases) {
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it("keeps hostile case IDs stable, sorted, and refusal-complete against JpegCapabilities.refuses", () => {
    expect(hostileMutationCases.map((item) => item.id)).toEqual(
      [...hostileMutationCases.map((item) => item.id)].sort(),
    );
    expect(new Set(hostileMutationCases.map((item) => item.id)).size).toBe(
      hostileMutationCases.length,
    );

    // Derived from the runtime capabilities object (not the static JpegRefusal
    // type alone) so a new refusal literal added to the capability without a
    // matching hostile case fails this test (must_haves truth 3).
    const capabilities = getCapabilities();
    const jpegCapability = capabilities.formats.find(
      (format) => format.format === "jpeg",
    );
    if (jpegCapability === undefined) throw new Error("No jpeg capability registered");
    const declaredRefusals = new Set(jpegCapability.refuses as readonly JpegRefusal[]);
    const coveredRefusals = new Set(
      hostileMutationCases.map((item) => item.expectedRefusal),
    );
    expect(coveredRefusals).toEqual(declaredRefusals);
  });

  it.each(hostileMutationCases)(
    "refuses $id as $expectedRefusal before creating output",
    async ({ id, expectedRefusal, options }) => {
      await withMaterializedCase(id, async (sourcePath, _fileSize, directory) => {
        const destinationPath = join(directory, "sanitized.jpg");
        const sourceSize = (await stat(sourcePath)).size;
        const result = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
          ...options,
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: JPEG_REFUSAL_KIND[expectedRefusal],
            phase: "admission",
            nativeWrite: "not-started",
          },
        });
        if (!result.ok) {
          expect(
            result.error.detail,
            `expected ${id} to fail with the ${expectedRefusal} refusal detail`,
          ).toBeDefined();
        }
        await expect(access(destinationPath)).rejects.toBeDefined();
        expect((await stat(sourcePath)).size).toBe(sourceSize);
        // The temp directory holds only the untouched source -- no partial
        // output, no leftover.
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(directory);
        expect(entries).toEqual(["source.jpg"]);
      });
    },
    30_000,
  );

  it("replays the same valid grammar sample from the same seed", () => {
    const arbitrary = fc.integer({ min: 0, max: 1000 });
    const first = fc.sample(arbitrary, { seed: 460046, numRuns: 8 });
    const replay = fc.sample(arbitrary, { seed: 460046, numRuns: 8 });
    expect(replay).toEqual(first);
  });
});
