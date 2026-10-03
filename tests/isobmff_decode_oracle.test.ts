// Whole-graph libheif decode oracle proof (QUA-04, D-23, Plan 62.1-03).
//
// Linux-x64-only: `heif_decode_oracle` is a compiled C executable built once per job against the
// D-21 static HEIF stack (`scripts/qualification/build-oracles.cjs`). Every case here is gated
// `it.runIf(process.platform === "linux" && process.arch === "x64")` and is proven not-skipped by
// the container rehearsal recorded in `62.1-EVIDENCE.md`, never by a local pass on this host.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { sanitizeFile } from "../src/engine.js";
import {
  compareHeifDecodes,
  decodeHeifGraph,
} from "./isobmff-support/decode-oracle.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.avif");

const LINUX_X64 = process.platform === "linux" && process.arch === "x64";

/** The preservation flags every heif-enc-grid fixture case uses by default -- mirrors
 * `tests/isobmff_negative_controls.test.ts`'s own `DEFAULT_PRESERVATION`. */
const DEFAULT_PRESERVATION = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
} as const;

/** Every preservation flag false (D-23 behavior clause 1's second case). */
const ALL_FALSE_PRESERVATION = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
} as const;

/**
 * Produces a native output for `fixturePath` through the real, registered writer handler
 * (`createIsobmffWriterHandlerForTests`, never a stub) -- the exact engine path 62-05/62-12
 * already exercise -- with `preservation` applied, and returns the destination bytes. The
 * registry is restored and the temp directory removed in `finally` regardless of outcome.
 */
async function produceNativeOutput(
  brand: "heic" | "avif",
  fixturePath: string,
  preservation: typeof DEFAULT_PRESERVATION | typeof ALL_FALSE_PRESERVATION,
): Promise<Buffer> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-heif-decode-native-"),
  );
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests(brand),
  ]);
  try {
    const destinationPath = join(directory, `destination.${brand}`);
    const result = await sanitizeFile({
      sourcePath: fixturePath,
      destinationPath,
      ...preservation,
    });
    if (!result.ok) {
      throw new Error(
        `produceNativeOutput: sanitizeFile failed: ${result.error.code}`,
      );
    }
    return await readFile(destinationPath);
  } finally {
    restore();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("decodeHeifGraph (62.1-03, D-23)", () => {
  it.runIf(LINUX_X64)(
    "heif-enc-grid.heic yields a top-level image and a thumbnail with stable hashes",
    async () => {
      const bytes = await readFile(HEIC_FIXTURE);

      const first = decodeHeifGraph(bytes);
      expect(first.outcome).toBe("decoded");
      expect(first.images.length).toBeGreaterThanOrEqual(2);

      const topLevel = first.images.find(
        (image) => image.role === "primary" || image.role === "toplevel",
      );
      const thumbnail = first.images.find(
        (image) => image.role === "thumbnail",
      );
      expect(topLevel).toBeDefined();
      expect(thumbnail).toBeDefined();
      expect(topLevel?.planesSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(thumbnail?.planesSha256).toMatch(/^[a-f0-9]{64}$/);

      // Stability: decoding the same bytes again produces the exact same ordered transcript.
      const second = decodeHeifGraph(bytes);
      expect(second).toEqual(first);
    },
  );
});

describe("compareHeifDecodes (62.1-03, D-23)", () => {
  it.runIf(LINUX_X64)(
    "heif-enc-grid.heic and .avif native outputs (default settings and all preservation flags false) compare equal to their sources",
    async () => {
      const cases: readonly [
        "heic" | "avif",
        string,
        typeof DEFAULT_PRESERVATION | typeof ALL_FALSE_PRESERVATION,
      ][] = [
        ["heic", HEIC_FIXTURE, DEFAULT_PRESERVATION],
        ["heic", HEIC_FIXTURE, ALL_FALSE_PRESERVATION],
        ["avif", AVIF_FIXTURE, DEFAULT_PRESERVATION],
        ["avif", AVIF_FIXTURE, ALL_FALSE_PRESERVATION],
      ];
      for (const [brand, fixturePath, preservation] of cases) {
        const sourceBytes = await readFile(fixturePath);
        const outputBytes = await produceNativeOutput(
          brand,
          fixturePath,
          preservation,
        );
        expect(() =>
          compareHeifDecodes(sourceBytes, outputBytes),
        ).not.toThrow();
      }
    },
  );

  it.runIf(LINUX_X64)(
    "a flipped byte inside the thumbnail item's extent is caught naming the thumbnail, while a primary-only comparison of the same pair stays green (D-23 negative control)",
    async () => {
      const sourceBytes = await readFile(HEIC_FIXTURE);
      const outputBytes = await produceNativeOutput(
        "heic",
        HEIC_FIXTURE,
        DEFAULT_PRESERVATION,
      );

      // Locate the thumbnail's extent through the independent inventory walker (never the
      // engine, per this plan's own instruction): the "thmb" iref record's `from` field is the
      // thumbnail item's own id (tests/isobmff-support/generator.ts:330's own convention,
      // confirmed against docs/isobmff.md's "item 8 is a visible thumbnail referenced by a
      // thmb reference").
      const inventory = inventoryIsobmff(outputBytes);
      const thumbnailRef = inventory.references.find(
        (reference) => reference.type === "thmb",
      );
      expect(thumbnailRef).toBeDefined();
      const thumbnailItem = inventory.items.find(
        (item) => item.id === thumbnailRef?.from,
      );
      expect(thumbnailItem).toBeDefined();
      if (thumbnailItem === undefined) throw new Error("unreachable");
      // The LAST byte of the LAST extent, not the first: the first byte of an HEVC/AV1 bitstream
      // extent is its NAL/OBU header, and flipping that structural byte makes the whole decode
      // fail outright (measured) rather than merely corrupting this one image's pixels -- which
      // would make `compareHeifDecodes` report a decode-outcome mismatch for the WHOLE graph
      // instead of a per-image pixel-hash mismatch naming the thumbnail, defeating the point of
      // this control (D-23: prove a primary-only check misses a decodable-but-corrupt thumbnail).
      const lastExtent =
        thumbnailItem.extents[thumbnailItem.extents.length - 1];
      expect(lastExtent).toBeDefined();
      if (lastExtent === undefined) throw new Error("unreachable");
      const lastByteIndex = lastExtent.offset + lastExtent.length - 1;

      let absoluteOffset: number;
      if (thumbnailItem.constructionMethod === 1) {
        if (inventory.idat === undefined) {
          throw new Error(
            "thumbnail item is construction_method 1 but no idat box was found",
          );
        }
        absoluteOffset =
          inventory.idat.offset + thumbnailItem.baseOffset + lastByteIndex;
      } else if (thumbnailItem.constructionMethod === 0) {
        absoluteOffset = thumbnailItem.baseOffset + lastByteIndex;
      } else {
        throw new Error(
          `unsupported construction_method ${thumbnailItem.constructionMethod}`,
        );
      }

      const flipped = Buffer.from(outputBytes);
      flipped[absoluteOffset] = (flipped[absoluteOffset] ?? 0) ^ 0xff;

      expect(() => compareHeifDecodes(sourceBytes, flipped)).toThrow(
        /thumbnail/,
      );
      // The same pair, restricted to the primary/top-level image only, stays green -- proving
      // the whole-graph scope above is load-bearing, not incidental.
      expect(() =>
        compareHeifDecodes(sourceBytes, flipped, { primaryOnly: true }),
      ).not.toThrow();
    },
  );

  it.runIf(LINUX_X64)(
    "a truncated output makes the oracle exit non-zero, and the compare reports the decode-outcome difference",
    async () => {
      const sourceBytes = await readFile(HEIC_FIXTURE);
      const outputBytes = await produceNativeOutput(
        "heic",
        HEIC_FIXTURE,
        DEFAULT_PRESERVATION,
      );
      const truncated = outputBytes.subarray(
        0,
        Math.floor(outputBytes.length / 2),
      );

      const truncatedTranscript = decodeHeifGraph(truncated);
      expect(truncatedTranscript.outcome).toBe("rejected");

      expect(() => compareHeifDecodes(sourceBytes, truncated)).toThrow(
        /decode outcome differs/,
      );
    },
  );
});
