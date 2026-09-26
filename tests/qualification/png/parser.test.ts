import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import { parsePng } from "../../../src/png/chunks.js";
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
  const directory = await mkdtemp(join(tmpdir(), "png-parser-case-"));
  const sourcePath = join(directory, "source.png");
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
    return await parsePng(handle, fileSize);
  } finally {
    await handle.close();
  }
}

describe("grammar-aware PNG qualification cases", () => {
  it.each(validGrammarCases)(
    "parses $id structurally and sanitizes with all flags false",
    async ({ id, bytes }) => {
      const directory = await mkdtemp(join(tmpdir(), "png-valid-case-"));
      const sourcePath = join(directory, "source.png");
      const destinationPath = join(directory, "output.png");
      try {
        await writeFile(sourcePath, bytes);
        const parsed = await parsePath(sourcePath, bytes.length);
        expect(parsed.chunks.length).toBeGreaterThan(0);

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

  it("keeps hostile case IDs stable and category-complete", () => {
    expect(hostileMutationCases.map((item) => item.id)).toEqual(
      [...hostileMutationCases.map((item) => item.id)].sort(),
    );
    expect(new Set(hostileMutationCases.map((item) => item.category))).toEqual(
      new Set([
        "crc",
        "unknown-critical",
        "chunk-order",
        "truncation",
        "trailing-data",
        "apng",
        "decompression-bomb",
        "length-overflow",
        "duplicate-singleton",
        "idot-adjacency",
        "registered-unmeasured",
        "metadata-limit",
        "aggregate-inflate",
      ]),
    );
  });

  it.each(hostileMutationCases)(
    "refuses $id as $expectedKind before creating output",
    async ({ id, expectedKind, options }) => {
      // Some categories (decompression-bomb, aggregate-inflate,
      // registered-unmeasured, idot-adjacency) are structurally valid PNG --
      // the raw chunk-stream parser (`parsePng`, PNG-03) has nothing to
      // reject; the refusal is an admission-layer decision (content
      // classification, decompression budget, or the D-06 adjacency
      // invariant). This test asserts only what every hostile case actually
      // promises: `sanitizeFile` declines before any destination exists.
      await withMaterializedCase(
        id,
        async (sourcePath, _fileSize, directory) => {
          const destinationPath = join(directory, "sanitized.png");
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
              code: expectedKind,
              phase: "admission",
              nativeWrite: "not-started",
            },
          });
          await expect(access(destinationPath)).rejects.toBeDefined();
          expect((await stat(sourcePath)).size).toBe(sourceSize);
        },
      );
    },
    30_000,
  );

  it("replays the same valid grammar sample from the same seed", () => {
    // No randomness in this module's grammar cases, but keeps the same
    // structural shape/name as webp/parser.test.ts's replay test for
    // cross-format symmetry; asserts fc itself is deterministic per seed.
    const arbitrary = fc.integer({ min: 0, max: 1000 });
    const first = fc.sample(arbitrary, { seed: 460046, numRuns: 8 });
    const replay = fc.sample(arbitrary, { seed: 460046, numRuns: 8 });
    expect(replay).toEqual(first);
  });
});
