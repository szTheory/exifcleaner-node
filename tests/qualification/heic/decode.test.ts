// HEIC corpus whole-graph decode compare (62.1-09, QUA-04 decode leg, D-23). The independent
// libheif oracle decodes every image of the source and of the native output (primary, other
// top-level images, thumbnails, auxiliary images) and the two transcripts must agree. Linux x64
// only: the oracle is built by build-oracles.cjs; the proof is the container rehearsal and the
// hosted qualification-linux job, never a local skip.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../src/engine.js";
import {
  compareHeifDecodes,
  compareHeifTranscripts,
  decodeHeifGraph,
  type HeifGraphImage,
  type HeifGraphTranscript,
} from "../../isobmff-support/decode-oracle.js";
import {
  downloadGate,
  tracerRecords,
} from "../../isobmff-support/corpus-tracer.js";
import { inventoryIsobmff } from "../../isobmff-support/inventory.js";
import { loadCorpusRecord, materializeRecord } from "../kit/corpus.js";
import { HEIC_DEFAULT_SETTINGS_REFUSALS } from "./oracles.js";

const LINUX_X64 = process.platform === "linux" && process.arch === "x64";
const IPHONE_RECORD = "ianare-exif-samples-iphone-13-pro-max";
const HDR_GAIN_MAP_URN = "urn:com:apple:photo:2020:aux:hdrgainmap";
const DECODE_TIMEOUT_MS = 240_000;

/** The preservation settings the decode leg runs: default, and colour profile not preserved. */
const COLOR_PROFILE_CASES = [true, false] as const;

type SanitizeOutcome =
  | { readonly ok: true; readonly output: Buffer }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

async function sanitizeRegistered(
  source: Buffer,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
): Promise<SanitizeOutcome> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-heic-decode-"));
  try {
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation,
      preserveColorProfile,
      preserveTimestamps: true,
      preserveResolution: true,
    });
    if (!result.ok)
      return {
        ok: false,
        error: { ...result.error } as Record<string, unknown>,
      };
    return { ok: true, output: await readFile(destinationPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The native output for `source`, or a throw naming the refusal. */
async function sanitizedOutput(
  source: Buffer,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
): Promise<Buffer> {
  const outcome = await sanitizeRegistered(
    source,
    preserveOrientation,
    preserveColorProfile,
  );
  if (!outcome.ok)
    throw new Error(`sanitizeRegistered: ${String(outcome.error.code)}`);
  return outcome.output;
}

/**
 * The decode leg for one record and one preserveColorProfile value. preserveColorProfile false on
 * an ICC-bearing source uses the exact `expectIccRemoved` mode (maintainer decision 2026-10-03);
 * every other case is the strict whole-graph equality.
 */
function compareDecodeLeg(
  source: Buffer,
  sourceTranscript: HeifGraphTranscript,
  output: Buffer,
  preserveColorProfile: boolean,
): void {
  const sourceHasIcc = sourceTranscript.images.some((image) => image.icc);
  compareHeifDecodes(source, output, {
    expectIccRemoved: !preserveColorProfile && sourceHasIcc,
  });
}

/** The item id of the auxiliary image whose `auxC` names the Apple HDR gain map. */
function gainMapItemId(bytes: Buffer): number {
  const inventory = inventoryIsobmff(bytes);
  const gainMapProperties = new Set(
    inventory.properties
      .filter((property) => property.auxUrn === HDR_GAIN_MAP_URN)
      .map((property) => property.index),
  );
  const items = inventory.associations.filter((association) =>
    association.associations.some((entry) =>
      gainMapProperties.has(entry.propertyIndex),
    ),
  );
  if (items.length !== 1)
    throw new Error(`expected one hdrgainmap item, found ${items.length}`);
  return items[0]!.itemId;
}

/** A copy of `bytes` with one byte flipped in the middle of `itemId`'s (single, file-addressed)
 * extent, located with the independent inventory. */
function flipItemByte(bytes: Buffer, itemId: number): Buffer {
  const inventory = inventoryIsobmff(bytes);
  const item = inventory.items.find((candidate) => candidate.id === itemId);
  if (item === undefined || item.constructionMethod !== 0)
    throw new Error(`item ${itemId} is not a file-addressed item`);
  const extent = item.extents[0];
  if (extent === undefined || extent.length < 2)
    throw new Error(`item ${itemId} has no usable extent`);
  const position =
    item.baseOffset + extent.offset + Math.floor(extent.length / 2);
  const flipped = Buffer.from(bytes);
  flipped[position] = flipped[position]! ^ 0xff;
  return flipped;
}

/** Registers `title` for `recordId` honouring the download-only gate (KIT-10). */
function corpusIt(
  recordId: string,
  title: string,
  body: () => Promise<void>,
): void {
  const tracer = tracerRecords("heic").find((record) => record.id === recordId);
  if (tracer === undefined) throw new Error(`no HEIC record ${recordId}`);
  const gate = downloadGate(tracer);
  if (gate.kind === "fail") {
    it(`${title} (download-only record needs the fetch cache in CI)`, () => {
      throw new Error(gate.reason);
    });
    return;
  }
  if (gate.kind === "skip") {
    console.warn(`skipping ${gate.reason}`);
    it.skip(`${title} (download-only, no local fetch cache)`, () => {});
    return;
  }
  it.runIf(LINUX_X64)(title, body, DECODE_TIMEOUT_MS);
}

describe("HEIC corpus decode compare (62.1-09)", () => {
  const admitted = tracerRecords("heic").filter(
    (record) => record.outcome.status === "success",
  );

  it("iterates every admitted HEIC corpus record, the iPhone sample included", () => {
    expect(admitted.map((record) => record.id)).toContain(IPHONE_RECORD);
    expect(admitted.map((record) => record.id)).toContain("heif-enc-grid-heic");
  });

  for (const tracer of admitted) {
    const refusal = HEIC_DEFAULT_SETTINGS_REFUSALS[tracer.id];
    corpusIt(
      tracer.id,
      refusal === undefined
        ? `${tracer.id}: the whole-graph decode of the native output matches the source (preserveColorProfile true and false)`
        : `${tracer.id}: refuses with orientation preserved (pinned), and the whole-graph decode matches with orientation not preserved (preserveColorProfile true and false)`,
      async () => {
        const source = await materializeRecord(
          await loadCorpusRecord(tracer.id),
        );
        const sourceTranscript = decodeHeifGraph(source);
        expect(sourceTranscript.outcome).toBe("decoded");
        // A record with a pinned default-settings refusal (c034) refuses exactly that way
        // whenever orientation is preserved, and is decoded with orientation not preserved.
        const preserveOrientation = refusal === undefined;
        for (const preserveColorProfile of COLOR_PROFILE_CASES) {
          if (refusal !== undefined) {
            const refused = await sanitizeRegistered(
              source,
              true,
              preserveColorProfile,
            );
            expect(refused.ok).toBe(false);
            if (!refused.ok)
              expect(refused.error).toMatchObject({
                ...refusal,
                phase: "admission",
                nativeWrite: "not-started",
              });
          }
          const output = await sanitizedOutput(
            source,
            preserveOrientation,
            preserveColorProfile,
          );
          compareDecodeLeg(
            source,
            sourceTranscript,
            output,
            preserveColorProfile,
          );
        }
      },
    );
  }

  corpusIt(
    IPHONE_RECORD,
    "iPhone: the transcript carries the hdrgainmap auxiliary image and the thumbnail; preserveColorProfile false keeps every pixel hash and drops only ICC",
    async () => {
      const source = await materializeRecord(
        await loadCorpusRecord(IPHONE_RECORD),
      );
      const gainMap = gainMapItemId(source);
      const sourceTranscript = decodeHeifGraph(source);
      const roles = sourceTranscript.images.map(
        (image) => `${image.role}:${image.itemId}`,
      );
      expect(roles).toContain(`auxiliary:${gainMap}`);
      expect(
        sourceTranscript.images.some((image) => image.role === "thumbnail"),
      ).toBe(true);

      const kept = decodeHeifGraph(await sanitizedOutput(source, true, true));
      expect(kept).toEqual(sourceTranscript);

      const output = await sanitizedOutput(source, true, false);
      const dropped = decodeHeifGraph(output);
      expect(dropped.images.map((image) => image.planesSha256)).toEqual(
        sourceTranscript.images.map((image) => image.planesSha256),
      );
      expect(dropped.images.map((image) => image.icc)).not.toEqual(
        sourceTranscript.images.map((image) => image.icc),
      );
      expect(dropped.images.every((image) => !image.icc)).toBe(true);
      // The strict comparison sees the ICC difference; only the exact mode admits it.
      expect(() => compareHeifDecodes(source, output)).toThrow(
        /^compareHeifDecodes: image 0 \(role primary, item \d+\) differs$/,
      );
      compareHeifDecodes(source, output, { expectIccRemoved: true });
    },
  );

  corpusIt(
    IPHONE_RECORD,
    "D-23 negative control: one byte flipped in the iPhone output's gain-map extent turns the compare red naming the auxiliary image",
    async () => {
      const source = await materializeRecord(
        await loadCorpusRecord(IPHONE_RECORD),
      );
      const output = await sanitizedOutput(source, true, true);
      const gainMap = gainMapItemId(output);
      compareHeifDecodes(source, output);
      const flipped = flipItemByte(output, gainMap);
      expect(() => compareHeifDecodes(source, flipped)).toThrow(
        new RegExp(
          `^compareHeifDecodes: image \\d+ \\(role auxiliary, item ${gainMap}\\) differs$`,
        ),
      );
    },
  );
});

describe("compareHeifTranscripts expectIccRemoved: pure negative controls (no oracle)", () => {
  const image = (overrides: Partial<HeifGraphImage> = {}): HeifGraphImage => ({
    role: "primary",
    itemId: 49,
    width: 4032,
    height: 3024,
    chroma: 1,
    bitDepth: 8,
    alpha: false,
    nclx: false,
    icc: true,
    planesSha256: "a".repeat(64),
    ...overrides,
  });
  const transcript = (
    images: readonly HeifGraphImage[],
  ): HeifGraphTranscript => ({ outcome: "decoded", images });
  const source = transcript([
    image(),
    image({ role: "thumbnail", itemId: 50 }),
    image({ role: "auxiliary", itemId: 51, icc: false }),
  ]);
  const removed = transcript(
    source.images.map((entry) => ({ ...entry, icc: false })),
  );

  it("passes when ICC goes true -> false exactly where the source had it and nothing else changes", () => {
    expect(() =>
      compareHeifTranscripts(source, removed, { expectIccRemoved: true }),
    ).not.toThrow();
  });

  it("the strict mode still rejects the same ICC removal", () => {
    expect(() => compareHeifTranscripts(source, removed)).toThrow(
      "compareHeifDecodes: image 0 (role primary, item 49) differs",
    );
  });

  it("throws when the source carries no ICC at all (removal where the source had none)", () => {
    const noIcc = transcript(
      source.images.map((entry) => ({ ...entry, icc: false })),
    );
    expect(() =>
      compareHeifTranscripts(noIcc, noIcc, { expectIccRemoved: true }),
    ).toThrow(
      "compareHeifDecodes: expectIccRemoved, but the source reports no ICC on any image",
    );
  });

  it("throws when ICC appears on an image whose source had none", () => {
    const appeared = transcript([
      ...removed.images.slice(0, 2),
      { ...removed.images[2]!, icc: true },
    ]);
    expect(() =>
      compareHeifTranscripts(source, appeared, { expectIccRemoved: true }),
    ).toThrow("compareHeifDecodes: image 2 (role auxiliary, item 51) differs");
  });

  it("throws when a pixel hash changes alongside the ICC removal", () => {
    const changed = transcript([
      removed.images[0]!,
      { ...removed.images[1]!, planesSha256: "b".repeat(64) },
      removed.images[2]!,
    ]);
    expect(() =>
      compareHeifTranscripts(source, changed, { expectIccRemoved: true }),
    ).toThrow("compareHeifDecodes: image 1 (role thumbnail, item 50) differs");
  });

  it("throws when ICC is kept where removal was expected", () => {
    const kept = transcript([
      removed.images[0]!,
      source.images[1]!,
      removed.images[2]!,
    ]);
    expect(() =>
      compareHeifTranscripts(source, kept, { expectIccRemoved: true }),
    ).toThrow("compareHeifDecodes: image 1 (role thumbnail, item 50) differs");
    expect(() =>
      compareHeifTranscripts(source, source, { expectIccRemoved: true }),
    ).toThrow("compareHeifDecodes: image 0 (role primary, item 49) differs");
  });
});
