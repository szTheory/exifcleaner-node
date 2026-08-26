import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../dist/index.js";
import { parseWebp, WebpStructureError } from "../../src/webp/riff.js";
import {
  hostileMutationCases,
  materializeMutationCase,
  validGrammarCases,
  webpArbitrary,
} from "./generators.js";

async function withMaterializedCase<T>(
  id: string,
  callback: (path: string, fileSize: number, directory: string) => Promise<T>,
): Promise<T> {
  const materialized = materializeMutationCase(id);
  const directory = await mkdtemp(join(tmpdir(), "webp-parser-case-"));
  const sourcePath = join(directory, "source.webp");
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
    return await parseWebp(handle, fileSize);
  } finally {
    await handle.close();
  }
}

describe("grammar-aware WebP qualification cases", () => {
  it.each(validGrammarCases)(
    "parses $id with distinct ordered chunk boundaries",
    async ({ id, bytes }) => {
      const directory = await mkdtemp(join(tmpdir(), "webp-valid-case-"));
      const path = join(directory, "source.webp");
      try {
        await writeFile(path, bytes);
        const parsed = await parsePath(path, bytes.length);
        expect(parsed.chunks.length).toBeGreaterThan(0);
        for (let index = 1; index < parsed.chunks.length; index += 1) {
          const previous = parsed.chunks[index - 1]!;
          const current = parsed.chunks[index]!;
          expect(previous.dataOffset + previous.paddedSize).toBe(
            current.headerOffset,
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("replays the same valid grammar sample from the same seed", () => {
    const first = fc.sample(webpArbitrary(), { seed: 460046, numRuns: 8 });
    const replay = fc.sample(webpArbitrary(), { seed: 460046, numRuns: 8 });
    expect(replay.map((value) => value.toString("hex"))).toEqual(
      first.map((value) => value.toString("hex")),
    );
  });

  it("keeps hostile case IDs stable and category-complete", () => {
    expect(hostileMutationCases.map((item) => item.id)).toEqual(
      [...hostileMutationCases.map((item) => item.id)].sort(),
    );
    expect(new Set(hostileMutationCases.map((item) => item.category))).toEqual(
      new Set([
        "aggregate-limit",
        "chunk-count-limit",
        "declared-size",
        "duplicate-singleton",
        "empty-input",
        "feature-flag",
        "metadata-limit",
        "nested-animation",
        "odd-padding",
        "ordering",
        "payload-mutation",
        "private-chunk",
        "trailer",
        "truncation",
      ]),
    );
  });

  it.each(hostileMutationCases)(
    "refuses $id as $expectedKind before creating output",
    async ({ id, expectedKind }) => {
      await withMaterializedCase(
        id,
        async (sourcePath, fileSize, directory) => {
          await expect(parsePath(sourcePath, fileSize)).rejects.toMatchObject({
            name: "WebpStructureError",
            kind: expectedKind,
          } satisfies Partial<WebpStructureError>);

          const destinationPath = join(directory, "sanitized.webp");
          const sourceSize = (await stat(sourcePath)).size;
          const result = await sanitizeFile({
            sourcePath,
            destinationPath,
            preserveOrientation: false,
            preserveColorProfile: false,
            preserveTimestamps: false,
          });
          expect(result).toMatchObject({
            ok: false,
            error: { code: expectedKind, nativeWrite: "not-started" },
          });
          await expect(access(destinationPath)).rejects.toBeDefined();
          expect((await stat(sourcePath)).size).toBe(sourceSize);
        },
      );
    },
    30_000,
  );
});
