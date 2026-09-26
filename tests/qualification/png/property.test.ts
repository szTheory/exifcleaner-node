import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import {
  createOrientationExif,
  parseExif,
} from "../../../src/metadata/exif.js";
import { parsePng } from "../../../src/png/chunks.js";
import { ok } from "../../../src/result.js";
import { png, pngChunk } from "../../fixtures.js";
import { assertCanariesAbsent, assertPlanted } from "../kit/generators.js";
import { assertFloors, countSample, createCounters } from "../kit/floors.js";
import { pngIdatData } from "./oracles.js";
import {
  formatReplayRecord,
  pngQualificationArbitrary,
  pngQualificationArbitraryWithoutMetadataArm,
  resolveReplayConfig,
  type QualificationSample,
} from "./generators.js";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface PngChunkRecord {
  readonly type: string;
  readonly data: Buffer;
}

/**
 * A test-local PNG chunk walker (mirrors `png/oracles.ts`'s
 * `pngStructuralParts`/`pngIdatData`): never imports `src/png/chunks.ts`'s
 * own parser, so the property gate's own byte-level checks cannot share a
 * bug with the handler's parser.
 */
function readPngChunkRecords(bytes: Buffer): readonly PngChunkRecord[] {
  const records: PngChunkRecord[] = [];
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > bytes.length) break;
    records.push({
      type,
      data: bytes.subarray(dataOffset, dataOffset + length),
    });
    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }
  return records;
}

function findChunk(
  records: readonly PngChunkRecord[],
  type: string,
): Buffer | undefined {
  return records.find((item) => item.type === type)?.data;
}

/**
 * Rewrites `destinationPath` by mapping its current chunk list through
 * `transform` and re-serializing it as a PNG (mirrors
 * webp/property.test.ts's `rewriteDestination`). Every negative control that
 * needs to corrupt real sanitizer output -- rather than synthesize a buffer
 * from scratch -- reads the genuine output the real `sanitizeFile` wrote,
 * transforms it, and writes it back, so the assertion under test always runs
 * on real sanitizer output.
 */
async function rewritePngDestination(
  destinationPath: string,
  transform: (records: readonly PngChunkRecord[]) => readonly PngChunkRecord[],
): Promise<void> {
  const destination = await readFile(destinationPath);
  const rewritten = png(
    transform(readPngChunkRecords(destination)).map((item) =>
      pngChunk(item.type, item.data),
    ),
  );
  await writeFile(destinationPath, rewritten);
}

/**
 * D-05 preserve-list chunk types this gate treats as unconditional (kept
 * byte-identical regardless of any preservation flag) -- every type this
 * generator's preserve-list subset can plant except `pHYs`, which is
 * request-conditional (D-02, `preserveResolution`).
 */
const UNCONDITIONAL_PRESERVE_TYPES: readonly string[] = [
  "cHRM",
  "bKGD",
  "sBIT",
  "tRNS",
  "sPLT",
  "cICP",
  "sCAL",
  "oFFs",
];

/**
 * Labels for checkSample's own preservation assertions (D-21, mirrors
 * webp/property.test.ts's PRESERVATION_MESSAGES). Every negative control that
 * expects checkSample to reject a broken sanitizer asserts on one of these
 * strings, so a control can only pass by driving the real gate.
 */
const PRESERVATION_MESSAGES = Object.freeze({
  iccMissing:
    "checkSample: requested ICC color profile is missing from the output",
  iccBytes:
    "checkSample: preserved ICC color profile bytes differ from the source",
  orientationMissing:
    "checkSample: requested Orientation EXIF is missing from the output",
  orientationValue:
    "checkSample: preserved Orientation value differs from the planted value",
  resolutionMissing:
    "checkSample: requested pHYs resolution chunk is missing from the output",
  resolutionBytes:
    "checkSample: preserved pHYs resolution bytes differ from the source",
} as const);

/** Source mtime/atime seeded before every success sample sanitizes (D-20 timestamps). */
const SEEDED_SOURCE_TIME = new Date("2001-02-03T04:05:06.789Z");

/**
 * Per-sample body of the fixed-seed property (extracted so Task 3 reuses it
 * against injected fakes). `sanitize` is injectable and defaults to the real
 * dist `sanitizeFile` -- every negative control replaces it with a
 * deliberately broken fake.
 *
 * Returns the counter keys this sample contributes to the absolute per-arm/
 * per-flag floors (D-20): always `arm:<arm>`, plus `kind:<K>` per planted
 * kind and `flag:<name>` for each preservation flag actually exercised on a
 * success sample.
 */
async function checkSample(
  sample: QualificationSample,
  sanitize: typeof sanitizeFile = sanitizeFile,
): Promise<readonly string[]> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-png-property-"));
  const sourcePath = join(directory, "source.png");
  const destinationPath = join(directory, "output.png");
  const counterKeys: string[] = [`arm:${sample.arm}`];
  try {
    await writeFile(sourcePath, sample.bytes);
    if (sample.expected === "success") {
      assertPlanted(sample.bytes, sample.planted);
      const source = await open(sourcePath, "r");
      try {
        await expect(
          parsePng(source, sample.bytes.length),
        ).resolves.toBeDefined();
      } finally {
        await source.close();
      }
      const plantedKinds = new Set(sample.planted.map((item) => item.kind));
      for (const kind of plantedKinds) counterKeys.push(`kind:${kind}`);
      await utimes(sourcePath, SEEDED_SOURCE_TIME, SEEDED_SOURCE_TIME);

      const result = await sanitize({
        sourcePath,
        destinationPath,
        ...sample.options,
      });
      expect(result.ok).toBe(true);

      const preserveColorProfile =
        sample.options.preserveColorProfile && plantedKinds.has("iCCP");
      const preserveOrientation =
        sample.options.preserveOrientation &&
        sample.plantedOrientation !== undefined;
      const preservedKinds = preserveColorProfile ? ["iCCP"] : [];

      const output = await readFile(destinationPath);
      assertCanariesAbsent(output, sample.planted, preservedKinds);

      // Validity: the output re-parses structurally.
      const destinationHandle = await open(destinationPath, "r");
      try {
        await expect(
          parsePng(destinationHandle, output.length),
        ).resolves.toBeDefined();
      } finally {
        await destinationHandle.close();
      }

      // IDAT data bytes are identical.
      expect(pngIdatData(output)).toEqual(pngIdatData(sample.bytes));

      const sourceChunks = readPngChunkRecords(sample.bytes);
      const outputChunks = readPngChunkRecords(output);

      // Every unconditional preserve-list chunk present in the source is
      // byte-identical in the output, regardless of any flag.
      for (const type of UNCONDITIONAL_PRESERVE_TYPES) {
        const sourceData = findChunk(sourceChunks, type);
        if (sourceData === undefined) continue;
        expect(
          findChunk(outputChunks, type),
          `checkSample: preserve-list chunk ${type} missing or changed in the output`,
        ).toEqual(sourceData);
      }

      // pHYs presence matches the resolution-preservation request (D-02).
      const sourcePhys = findChunk(sourceChunks, "pHYs");
      if (sourcePhys !== undefined) {
        if (sample.options.preserveResolution) {
          counterKeys.push("flag:preserveResolution");
          expect(
            findChunk(outputChunks, "pHYs"),
            PRESERVATION_MESSAGES.resolutionMissing,
          ).toBeDefined();
          expect(
            findChunk(outputChunks, "pHYs"),
            PRESERVATION_MESSAGES.resolutionBytes,
          ).toEqual(sourcePhys);
        } else {
          expect(findChunk(outputChunks, "pHYs")).toBeUndefined();
        }
      }

      // iCCP presence matches the color-profile-preservation request.
      if (preserveColorProfile) {
        counterKeys.push("flag:preserveColorProfile");
        const sourceIcc = findChunk(sourceChunks, "iCCP");
        expect(
          findChunk(outputChunks, "iCCP"),
          PRESERVATION_MESSAGES.iccMissing,
        ).toBeDefined();
        expect(
          findChunk(outputChunks, "iCCP"),
          PRESERVATION_MESSAGES.iccBytes,
        ).toEqual(sourceIcc);
      } else {
        expect(findChunk(outputChunks, "iCCP")).toBeUndefined();
      }

      // eXIf is exactly createOrientationExif(plantedOrientation) when
      // orientation is preserved; otherwise absent (D-11's minimal write,
      // never the ImageDescription canary a planted eXIf source carried).
      if (preserveOrientation) {
        counterKeys.push("flag:preserveOrientation");
        const destinationExifChunks = outputChunks.filter(
          (item) => item.type === "eXIf",
        );
        expect(
          destinationExifChunks,
          PRESERVATION_MESSAGES.orientationMissing,
        ).toHaveLength(1);
        const expectedData = createOrientationExif(sample.plantedOrientation!);
        expect(
          destinationExifChunks[0]!.data.equals(expectedData),
          PRESERVATION_MESSAGES.orientationValue,
        ).toBe(true);
        const parsedExif = parseExif(destinationExifChunks[0]!.data);
        expect(
          parsedExif.orientation,
          PRESERVATION_MESSAGES.orientationValue,
        ).toMatchObject({
          status: "valid",
          value: sample.plantedOrientation,
        });
      } else {
        expect(findChunk(outputChunks, "eXIf")).toBeUndefined();
      }

      if (sample.options.preserveTimestamps) {
        counterKeys.push("flag:preserveTimestamps");
        const destinationStats = await stat(destinationPath);
        expect(destinationStats.mtime.getTime()).toBe(
          SEEDED_SOURCE_TIME.getTime(),
        );
      }

      expect(await readFile(sourcePath)).toEqual(sample.bytes);
      expect(output).toBeInstanceOf(Buffer);
    } else {
      const result = await sanitize({
        sourcePath,
        destinationPath,
        ...sample.options,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: sample.expected,
          phase: "admission",
          nativeWrite: "not-started",
        },
      });
      await expect(access(destinationPath)).rejects.toBeDefined();
      if (sample.hostileCategory !== undefined)
        counterKeys.push(`hostile:${sample.hostileCategory}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return counterKeys;
}

/**
 * Absolute per-arm/per-flag floors (D-20). Plan 10 Task 1 wires the counting
 * mechanism; Task 3 measures the real distribution at the fixed seed and
 * pins `PNG_FIXED_SEED_FLOORS` here.
 */
/**
 * Absolute per-arm/per-kind/per-flag/per-hostile-category floors (D-20).
 * Each floor is half the minimum measured count across four seeds (460046,
 * 1, 2, 3), rounded down, with a hard minimum of 1 -- never lowered to fit
 * a low measurement; if a category ever measures under its floor, the
 * generator's weighting is the thing to fix (Task 3's own re-measure of
 * `flag:preserveOrientation` and the hostile-arm category-uniform draw are
 * both examples already folded into `generators.ts`). Binds only at
 * FC_SEED 460046 / FC_RUNS 200 (55-REVIEW WR-01) -- see the guard below.
 * Re-measured in 56-14 after `trailing-data` grew from 2 to 4 cases
 * (CR-01's iCCP/zTXt/compressed-iTXt fixtures): every number was unchanged
 * at all four seeds, because `buildHostileArm` draws the category
 * uniformly first and only then a case within it, so growing a category's
 * case count does not change how often that category itself is drawn.
 *
 * Re-measured again in 56-16 after `chunk-count` (CR-02's IDAT/ancillary
 * flood cases) added a 13th hostile category: the per-category uniform
 * draw now gives every OTHER category ~1/13 of the hostile arm instead of
 * ~1/12, diluting each one's count. At the unchanged top-level hostile-arm
 * weight (6 of 18), that dilution alone pushed `hostile:chunk-order`
 * (measured 2) and `hostile:duplicate-singleton` (measured 1) below their
 * existing floors (3 and 2) at the binding seed 460046. Per this file's own
 * rule -- fix the generator's weighting, never lower a floor -- the
 * top-level hostile-arm weight in `pngQualificationArbitrary` was raised
 * from 6 to 7 (metadata 10, no-metadata 2, hostile 7), which increases
 * every hostile category's raw count roughly proportionally without
 * changing their relative within-arm ratios, and restores both floors
 * (chunk-order 3, duplicate-singleton 4 at 460046) with no other existing
 * floor number changed. Measured 200-run distributions (arm/kind/flag/
 * hostile -> count) at the new weight:
 *
 *   seed 460046: metadata 98, no-metadata 18, hostile 84;
 *                tEXt 35, zTXt 28, iTXt 31, iTXtCompressed 34, XMP 35,
 *                eXIf 35, caBX 27, private 18, iCCP 32;
 *                preserveOrientation 18, preserveColorProfile 17,
 *                preserveResolution 17, preserveTimestamps 52;
 *                crc 8, unknown-critical 7, chunk-order 3, truncation 2,
 *                trailing-data 5, apng 6, decompression-bomb 11,
 *                length-overflow 4, duplicate-singleton 7,
 *                idot-adjacency 7, registered-unmeasured 10,
 *                aggregate-inflate 7, chunk-count 7
 *   seed 1:      metadata 107, no-metadata 28, hostile 65;
 *                tEXt 31, zTXt 43, iTXt 38, iTXtCompressed 41, XMP 32,
 *                eXIf 28, caBX 33, private 35, iCCP 39;
 *                preserveOrientation 13, preserveColorProfile 15,
 *                preserveResolution 15, preserveTimestamps 69;
 *                crc 2, unknown-critical 6, chunk-order 7, truncation 8,
 *                trailing-data 4, apng 6, decompression-bomb 4,
 *                length-overflow 6, duplicate-singleton 5,
 *                idot-adjacency 5, registered-unmeasured 0,
 *                aggregate-inflate 5, chunk-count 7
 *   seed 2:      metadata 101, no-metadata 27, hostile 72;
 *                tEXt 28, zTXt 25, iTXt 33, iTXtCompressed 30, XMP 37,
 *                eXIf 29, caBX 35, private 35, iCCP 36;
 *                preserveOrientation 11, preserveColorProfile 18,
 *                preserveResolution 18, preserveTimestamps 69;
 *                crc 4, unknown-critical 8, chunk-order 7, truncation 5,
 *                trailing-data 2, apng 10, decompression-bomb 2,
 *                length-overflow 7, duplicate-singleton 4,
 *                idot-adjacency 4, registered-unmeasured 14,
 *                aggregate-inflate 3, chunk-count 2
 *   seed 3:      metadata 110, no-metadata 21, hostile 69;
 *                tEXt 39, zTXt 37, iTXt 31, iTXtCompressed 35, XMP 32,
 *                eXIf 36, caBX 31, private 31, iCCP 36;
 *                preserveOrientation 17, preserveColorProfile 20,
 *                preserveResolution 23, preserveTimestamps 65;
 *                crc 8, unknown-critical 6, chunk-order 8, truncation 5,
 *                trailing-data 3, apng 3, decompression-bomb 4,
 *                length-overflow 5, duplicate-singleton 7,
 *                idot-adjacency 6, registered-unmeasured 4,
 *                aggregate-inflate 7, chunk-count 3
 *
 * `hostile:chunk-count`'s floor is floor(min(7, 7, 2, 3) / 2) = 1 (the D-20
 * hard minimum). `hostile:registered-unmeasured` measures 0 at seed 1, but
 * -- like every seed other than 460046 -- that seed is never asserted
 * against a floor (D-20/55-REVIEW WR-01 binds only at FC_SEED 460046); its
 * own floor (1) is satisfied at 460046 (measured 10).
 */
const PNG_FIXED_SEED_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  "arm:metadata": 52,
  "arm:no-metadata": 11,
  "arm:hostile": 31,
  "kind:tEXt": 17,
  "kind:zTXt": 14,
  "kind:iTXt": 16,
  "kind:iTXtCompressed": 16,
  "kind:XMP": 13,
  "kind:eXIf": 16,
  "kind:caBX": 16,
  "kind:private": 14,
  "kind:iCCP": 16,
  "flag:preserveOrientation": 7,
  "flag:preserveColorProfile": 8,
  "flag:preserveResolution": 7,
  "flag:preserveTimestamps": 33,
  "hostile:crc": 1,
  "hostile:unknown-critical": 3,
  "hostile:chunk-order": 3,
  "hostile:truncation": 2,
  "hostile:trailing-data": 2,
  "hostile:apng": 2,
  "hostile:decompression-bomb": 1,
  "hostile:length-overflow": 1,
  "hostile:duplicate-singleton": 2,
  "hostile:idot-adjacency": 1,
  "hostile:registered-unmeasured": 1,
  "hostile:aggregate-inflate": 1,
  "hostile:chunk-count": 1,
});

describe("replayable PNG qualification properties", () => {
  it("defaults focused runs to 200 and exact-path replay to one", () => {
    expect(resolveReplayConfig({})).toEqual({ seed: 460_046, numRuns: 200 });
    expect(resolveReplayConfig({ FC_PATH: "0:1" })).toEqual({
      seed: 460_046,
      path: "0:1",
      numRuns: 1,
    });
    expect(() => resolveReplayConfig({ FC_PATH: "../../private" })).toThrow(
      "FC_PATH",
    );
    expect(() => resolveReplayConfig({ FC_RUNS: "201" })).toThrow("FC_RUNS");
  });

  it("runs the fixed PNG grammar and mutation corpus with complete replay identity", async () => {
    const config = resolveReplayConfig(process.env);
    let executed = 0;
    const counters = createCounters();
    const property = fc.asyncProperty(
      pngQualificationArbitrary(),
      async (sample) => {
        executed += 1;
        const keys = await checkSample(sample);
        countSample(counters, keys);
      },
    );
    const result = await fc.check(property, config);
    if (result.failed) {
      throw new Error(
        JSON.stringify(
          formatReplayRecord({
            seed: config.seed,
            path: result.counterexamplePath,
            fixtureSha256: digest(
              Buffer.from(JSON.stringify(result.counterexample)),
            ),
            faultPlan: null,
          }),
        ),
      );
    }
    expect(executed).toBe(config.numRuns);
    // A focused FC_PATH replay (config.path defined) or a non-default FC_RUNS
    // has no floor -- floors only bind the full fixed-seed 200-run sweep at
    // the fixed seed itself (D-20, 55-REVIEW WR-01).
    if (
      config.path === undefined &&
      config.numRuns === 200 &&
      config.seed === 460_046
    ) {
      assertFloors(counters, PNG_FIXED_SEED_FLOORS);
    }
  }, 30_000);

  it("replays the exact minimized path emitted for an injected failure", () => {
    const arbitrary = fc.integer({ min: 0, max: 100 });
    const first = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      {
        seed: 460_046,
        numRuns: 200,
      },
    );
    expect(first.failed).toBe(true);
    if (!first.failed || first.counterexamplePath === null)
      throw new Error("Expected an injected shrink failure");
    const replayPath = first.counterexamplePath;
    const replay = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      {
        seed: 460_046,
        path: replayPath,
        numRuns: 1,
      },
    );
    expect(replay.failed).toBe(true);
    expect(replay.counterexample).toEqual(first.counterexample);
    expect(
      formatReplayRecord({
        seed: 460_046,
        path: replayPath,
        fixtureSha256: "a".repeat(64),
        faultPlan: { operation: "stage-sync", occurrence: 1, error: "EIO" },
      }),
    ).toMatchObject({
      version: 1,
      seed: 460_046,
      path: replayPath,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      fixtureSha256: "a".repeat(64),
      replayCommand: expect.stringContaining("FC_PATH="),
    });
  });

  describe("negative controls (PNG)", () => {
    const REPLAY_PARAMS = {
      seed: 460_046,
      numRuns: 200,
      endOnFailure: true,
    } as const;

    it("(1) fails a pure-copy sanitizer via the canary absence check", async () => {
      const pureCopySanitize: typeof sanitizeFile = async (options) => {
        await copyFile(options.sourcePath, options.destinationPath);
        return ok({
          format: "png",
          destinationPath: options.destinationPath,
          removedNamespaces: [],
          preserved: {
            orientation: false,
            colorProfile: false,
            timestamps: false,
            resolution: false,
          },
          warnings: [],
          postCommitResidue: { state: "none" },
        });
      };
      const arbitrary = pngQualificationArbitrary().filter(
        (sample) => sample.expected === "success" && sample.planted.length > 0,
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, pureCopySanitize);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain("EXIFCLEANER-CANARY-");
    });

    it("(2) fails a sanitizer that keeps zTXt", async () => {
      // The fake calls the real dist sanitizeFile, then appends the
      // source's zTXt chunk(s) back onto the genuine output, so the canary
      // check runs against real sanitizer output that leaks exactly one
      // metadata kind.
      const ztxtKeepingSanitize: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        const sourceZtxtChunks = readPngChunkRecords(
          await readFile(options.sourcePath),
        ).filter((item) => item.type === "zTXt");
        await rewritePngDestination(options.destinationPath, (records) => [
          ...records,
          ...sourceZtxtChunks,
        ]);
        return outcome;
      };
      const arbitrary = pngQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.planted.some((item) => item.kind === "zTXt"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, ztxtKeepingSanitize);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain("kind zTXt");
      expect(String(result.errorInstance)).toContain("EXIFCLEANER-CANARY-");
    });

    it("(3) fails a generator with no metadata arm on the floor assertion itself", () => {
      const samples = fc.sample(pngQualificationArbitraryWithoutMetadataArm(), {
        seed: 460_046,
        numRuns: 200,
      });
      const counters = createCounters();
      for (const sample of samples)
        countSample(counters, [`arm:${sample.arm}`]);
      expect(() => assertFloors(counters, PNG_FIXED_SEED_FLOORS)).toThrow(
        /kind:eXIf/,
      );
    });

    it("(4a) fails a sanitizer that ignores a requested color-profile preservation", async () => {
      const ignoresColorProfile: typeof sanitizeFile = (options) =>
        sanitizeFile({ ...options, preserveColorProfile: false });
      const arbitrary = pngQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "iCCP"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, ignoresColorProfile);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.iccMissing,
      );
    });

    it("(4b) fails a sanitizer that drops pHYs despite a requested resolution preservation", async () => {
      // The fake honors every flag via the real sanitizeFile, then strips
      // any pHYs chunk the real output carries.
      const dropsResolution: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        await rewritePngDestination(options.destinationPath, (records) =>
          records.filter((item) => item.type !== "pHYs"),
        );
        return outcome;
      };
      const arbitrary = pngQualificationArbitrary().filter((sample) => {
        if (sample.expected !== "success" || !sample.options.preserveResolution)
          return false;
        return (
          findChunk(readPngChunkRecords(sample.bytes), "pHYs") !== undefined
        );
      });
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, dropsResolution);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.resolutionMissing,
      );
    });

    it("(4c) fails a sanitizer that writes a different Orientation value", async () => {
      const arbitrary = pngQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveOrientation &&
          sample.plantedOrientation !== undefined,
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          const other = sample.plantedOrientation === 1 ? 2 : 1;
          const writesWrongOrientation: typeof sanitizeFile = async (
            options,
          ) => {
            const outcome = await sanitizeFile(options);
            if (!outcome.ok) return outcome;
            await rewritePngDestination(options.destinationPath, (records) =>
              records.map((item) =>
                item.type === "eXIf"
                  ? { ...item, data: createOrientationExif(other) }
                  : item,
              ),
            );
            return outcome;
          };
          await checkSample(sample, writesWrongOrientation);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.orientationValue,
      );
    });

    it("(5) fails a sanitizer that admits a CRC-corrupt file", async () => {
      const admitsCorruptFile: typeof sanitizeFile = async (options) => {
        await copyFile(options.sourcePath, options.destinationPath);
        return ok({
          format: "png",
          destinationPath: options.destinationPath,
          removedNamespaces: [],
          preserved: {
            orientation: false,
            colorProfile: false,
            timestamps: false,
            resolution: false,
          },
          warnings: [],
          postCommitResidue: { state: "none" },
        });
      };
      const arbitrary = pngQualificationArbitrary().filter(
        (sample) =>
          sample.arm === "hostile" && sample.hostileCategory === "crc",
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, admitsCorruptFile);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
    });
  });
});
