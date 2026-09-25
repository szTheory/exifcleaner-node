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
import { parseExif } from "../../../src/metadata/exif.js";
import { validateIccForPreservation } from "../../../src/metadata/icc_admission.js";
import { ok } from "../../../src/result.js";
import { parseWebp } from "../../../src/webp/riff.js";
import { readChunks, webp } from "../../fixtures.js";
import { assertCanariesAbsent, assertPlanted } from "../kit/generators.js";
import { assertFloors, countSample, createCounters } from "../kit/floors.js";
import {
  formatReplayRecord,
  qualificationArbitrary,
  qualificationArbitraryWithoutMetadataArm,
  resolveReplayConfig,
  webpMetadataArbitrary,
  type QualificationSample,
} from "./generators.js";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Labels for checkSample's own preservation assertions (D-21). Every negative
 * control that expects checkSample to reject a broken sanitizer asserts on one of
 * these strings, so a control can only pass by driving the real gate — it can never
 * carry its own copy of the check (WR-03).
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
} as const);

/** Source mtime/atime seeded before every success sample sanitizes (D-20 timestamps). */
const SEEDED_SOURCE_TIME = new Date("2001-02-03T04:05:06.789Z");

/**
 * Per-sample body of the fixed-seed property (extracted so Task 2/3 can reuse it
 * against injected fakes). `sanitize` is injectable and defaults to the real dist
 * `sanitizeFile` — every negative control replaces it with a deliberately broken fake.
 *
 * Returns the counter keys this sample contributes to the absolute per-arm/per-flag
 * floors (D-20): always `arm:<arm>`, plus `kind:<K>` per planted kind and
 * `flag:<name>` for each preservation flag actually exercised on a success sample.
 */
async function checkSample(
  sample: QualificationSample,
  sanitize: typeof sanitizeFile = sanitizeFile,
): Promise<readonly string[]> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-property-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "output.webp");
  const counterKeys: string[] = [`arm:${sample.arm}`];
  try {
    await writeFile(sourcePath, sample.bytes);
    if (sample.expected === "success") {
      assertPlanted(sample.bytes, sample.planted);
      const source = await open(sourcePath, "r");
      try {
        await expect(
          parseWebp(source, sample.bytes.length),
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
        sample.options.preserveColorProfile && plantedKinds.has("ICCP");
      const preserveOrientation =
        sample.options.preserveOrientation && plantedKinds.has("EXIF");
      const preservedKinds = preserveColorProfile ? ["ICCP"] : [];

      const output = await readFile(destinationPath);
      assertCanariesAbsent(output, sample.planted, preservedKinds);

      // Validity: the output parses as WebP and its RIFF size equals the file length.
      const destinationHandle = await open(destinationPath, "r");
      try {
        await expect(
          parseWebp(destinationHandle, output.length),
        ).resolves.toBeDefined();
      } finally {
        await destinationHandle.close();
      }
      expect(output.readUInt32LE(4) + 8).toBe(output.length);

      const outputChunks = readChunks(output);

      if (preserveColorProfile) {
        counterKeys.push("flag:preserveColorProfile");
        const sourceIccChunk = readChunks(sample.bytes).find(
          (chunk) => chunk.fourCc === "ICCP",
        );
        const destinationIccChunk = outputChunks.find(
          (chunk) => chunk.fourCc === "ICCP",
        );
        expect(destinationIccChunk, PRESERVATION_MESSAGES.iccMissing).toBeDefined();
        expect(destinationIccChunk?.data, PRESERVATION_MESSAGES.iccBytes).toEqual(
          sourceIccChunk?.data,
        );
      }

      if (preserveOrientation) {
        counterKeys.push("flag:preserveOrientation");
        const destinationExifChunks = outputChunks.filter(
          (chunk) => chunk.fourCc === "EXIF",
        );
        expect(
          destinationExifChunks,
          PRESERVATION_MESSAGES.orientationMissing,
        ).toHaveLength(1);
        const parsedExif = parseExif(destinationExifChunks[0]!.data);
        expect(
          parsedExif.orientation,
          PRESERVATION_MESSAGES.orientationValue,
        ).toMatchObject({
          status: "valid",
          value: sample.plantedOrientation,
        });
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
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return counterKeys;
}

/**
 * Absolute per-arm/per-flag floors (D-20), measured over 200 runs each at seed
 * 460046 and at seeds 1, 2 and 3 (FC_SEED). Each floor is half the minimum measured
 * count across those four seeds, rounded down, with a hard minimum of 10 (none hit
 * it here). The metadata-arm weight was raised from 4 to 6 after an initial
 * measurement put `flag:preserveOrientation` at 18 on seed 2 — below the 20
 * re-measure threshold — per D-20 ("raise weight and re-measure", never lower the
 * floor). Measured distributions (arm/kind/flag -> count), 200 runs each:
 *
 *   seed 460046: metadata 116, no-metadata 40, hostile 44; EXIF 66, XMP 76, ICCP 65;
 *                preserveOrientation 33, preserveColorProfile 33, preserveTimestamps 75
 *   seed 1:      metadata 121, no-metadata 32, hostile 47; EXIF 76, XMP 71, ICCP 65;
 *                preserveOrientation 32, preserveColorProfile 34, preserveTimestamps 82
 *   seed 2:      metadata 115, no-metadata 40, hostile 45; EXIF 62, XMP 74, ICCP 59;
 *                preserveOrientation 31, preserveColorProfile 26, preserveTimestamps 87
 *   seed 3:      metadata 119, no-metadata 34, hostile 47; EXIF 65, XMP 79, ICCP 69;
 *                preserveOrientation 34, preserveColorProfile 40, preserveTimestamps 83
 */
const FIXED_SEED_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  "kind:EXIF": 31,
  "kind:XMP": 35,
  "kind:ICCP": 29,
  "arm:no-metadata": 16,
  "arm:hostile": 22,
  "flag:preserveOrientation": 15,
  "flag:preserveColorProfile": 13,
  "flag:preserveTimestamps": 37,
});

describe("replayable WebP qualification properties", () => {
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

  it("runs the fixed grammar/mutation corpus with complete replay identity", async () => {
    const config = resolveReplayConfig(process.env);
    let executed = 0;
    const counters = createCounters();
    const property = fc.asyncProperty(
      qualificationArbitrary(),
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
    // A focused FC_PATH replay (config.path defined) or a non-default FC_RUNS has
    // no floor — floors only bind the full fixed-seed 200-run sweep (D-20).
    if (config.path === undefined && config.numRuns === 200) {
      assertFloors(counters, FIXED_SEED_FLOORS);
    }
  }, 30_000);

  it("accepts a generated ICC canary profile for color-profile preservation", () => {
    fc.assert(
      fc.property(
        webpMetadataArbitrary().filter((sample) =>
          sample.planted.some((item) => item.kind === "ICCP"),
        ),
        (sample) => {
          const iccChunk = readChunks(sample.bytes).find(
            (chunk) => chunk.fourCc === "ICCP",
          );
          expect(iccChunk).toBeDefined();
          expect(validateIccForPreservation(iccChunk!.data)).toMatchObject({
            ok: true,
          });
        },
      ),
      { seed: 460_046, numRuns: 50 },
    );
  });

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

  describe("negative controls (D-21)", () => {
    const REPLAY_PARAMS = {
      seed: 460_046,
      numRuns: 200,
      endOnFailure: true,
    } as const;

    it("(1) fails a pure-copy sanitizer via the canary absence check", async () => {
      const pureCopySanitize: typeof sanitizeFile = async (options) => {
        await copyFile(options.sourcePath, options.destinationPath);
        return ok({
          format: "webp",
          destinationPath: options.destinationPath,
          removedNamespaces: [],
          preserved: {
            orientation: false,
            colorProfile: false,
            timestamps: false,
          },
          warnings: [],
          postCommitResidue: { state: "none" },
        });
      };
      const arbitrary = qualificationArbitrary().filter(
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

    it("(2) fails a sanitizer that strips every metadata kind except XMP", () => {
      const arbitrary = webpMetadataArbitrary().filter((sample) =>
        sample.planted.some((item) => item.kind === "XMP"),
      );
      const result = fc.check(
        fc.property(arbitrary, (sample) => {
          const keptXmpChunks = readChunks(sample.bytes).filter(
            (chunk) => chunk.fourCc === "XMP ",
          );
          const rebuilt = webp(
            keptXmpChunks.map((chunk) => ({
              fourCc: chunk.fourCc,
              data: chunk.data,
            })),
          );
          // Every kind except XMP is gone; XMP's canary must still be absent to pass.
          assertCanariesAbsent(rebuilt, sample.planted, []);
          return true;
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain("kind XMP");
    });

    it("(3) fails a generator with no metadata arm on the floor assertion itself", () => {
      const samples = fc.sample(qualificationArbitraryWithoutMetadataArm(), {
        seed: 460_046,
        numRuns: 200,
      });
      const counters = createCounters();
      for (const sample of samples)
        countSample(counters, [`arm:${sample.arm}`]);
      expect(() => assertFloors(counters, FIXED_SEED_FLOORS)).toThrow(
        /kind:EXIF/,
      );
    });

    it("(4a) fails a sanitizer that ignores a requested color-profile preservation", async () => {
      // The fake calls the real dist sanitizeFile but forces preserveColorProfile
      // to false regardless of what the caller requested. Every other option,
      // including preserveTimestamps, passes through unchanged, so the timestamp
      // expect cannot be what makes this control red (D-21 (4), WR-03 root cause).
      const ignoresColorProfile: typeof sanitizeFile = (options) =>
        sanitizeFile({ ...options, preserveColorProfile: false });
      const arbitrary = qualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "ICCP"),
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

    it("(4b) fails a sanitizer that ignores a requested orientation preservation", async () => {
      // Same shape as (4a): only preserveOrientation is forced off.
      const ignoresOrientation: typeof sanitizeFile = (options) =>
        sanitizeFile({ ...options, preserveOrientation: false });
      const arbitrary = qualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveOrientation &&
          sample.planted.some((item) => item.kind === "EXIF"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, ignoresOrientation);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.orientationMissing,
      );
    });
  });
});
