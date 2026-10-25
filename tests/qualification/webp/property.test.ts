import {
  access,
  appendFile,
  copyFile,
  open,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { webpHandler } from "../../../src/admission/webp-handler.js";
import { sanitizeFile } from "../../../src/index.js";
import { parseExif } from "../../../src/metadata/exif.js";
import { validateIccForPreservation } from "../../../src/metadata/icc_admission.js";
import { ok } from "../../../src/result.js";
import { WebpStructureError, parseWebp } from "../../../src/webp/riff.js";
import {
  exifWithOrientation,
  readChunks,
  webp,
  type FixtureChunk,
} from "../../fixtures.js";
import { assertCanariesAbsent, assertPlanted } from "../kit/generators.js";
import {
  assertFloors,
  assertSlotRates,
  countSample,
  createCounters,
  parseStatisticsRates,
  slotRateFloors,
} from "../kit/floors.js";
import {
  INVARIANT_MESSAGES,
  assertAdmittedOutcome,
  assertCanariesDistinct,
  assertNonSuccessBlastRadius,
  assertTotal,
  withSampleWorkspace,
} from "../kit/invariants.js";
import {
  bytesDigest,
  checkWithReplay,
  formatReplayRecord,
  parseReplayRecord,
  resolveReplayConfig,
} from "../kit/replay.js";
import {
  WEBP_HOSTILE_EXAMPLES,
  qualificationArbitrary,
  qualificationArbitraryWithoutMetadataArm,
  webpMetadataArbitrary,
  type QualificationSample,
} from "./generators.js";

const WEBP_GENERATOR_SOURCES = [
  "tests/qualification/webp/generators.ts",
  "tests/qualification/kit/generators.ts",
  "tests/fixtures.ts",
  "tests/isobmff-support/builder.ts",
];

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
  payloadIdentity:
    "checkSample: image payload chunk bytes differ from the source",
} as const);

/** Non-metadata chunks whose data must survive sanitization byte for byte (PBT-02). */
const PAYLOAD_FOURCCS: ReadonlySet<string> = new Set([
  "VP8 ",
  "VP8L",
  "ALPH",
  "ANIM",
  "ANMF",
]);

function payloadChunks(file: Buffer): readonly FixtureChunk[] {
  return readChunks(file).filter((chunk) => PAYLOAD_FOURCCS.has(chunk.fourCc));
}

/**
 * The metadata kinds a sample contributes to the `kind:<K>` counters: its planted
 * kinds when it is a success sample, none otherwise. checkSample's counter keys and
 * the fc.statistics classifier both come from here, so the two cannot disagree.
 */
function countedKinds(sample: QualificationSample): readonly string[] {
  return sample.expected === "success"
    ? [...new Set(sample.planted.map((item) => item.kind))]
    : [];
}

/** Source mtime/atime seeded before every success sample sanitizes (D-20 timestamps). */
const SEEDED_SOURCE_TIME = new Date("2001-02-03T04:05:06.789Z");

/**
 * Per-sample body of the fixed-seed property (extracted so Task 2/3 can reuse it
 * against injected fakes). `sanitize` is injectable and defaults to the real src
 * `sanitizeFile` — every negative control replaces it with a deliberately broken fake.
 *
 * Returns the counter keys this sample contributes to the absolute per-arm/per-flag
 * floors (D-20): always `arm:<arm>`, plus `kind:<K>` per planted kind and
 * `flag:<name>` for each preservation flag actually exercised on a success sample.
 */
async function checkSample(
  sample: QualificationSample,
  sanitize: typeof sanitizeFile = sanitizeFile,
  parse: typeof parseWebp = parseWebp,
): Promise<readonly string[]> {
  const counterKeys: string[] = [`arm:${sample.arm}`];
  await withSampleWorkspace(
    "source.webp",
    "output.webp",
    sample.bytes,
    async ({ directory, sourcePath, destinationPath }) => {
      // Parser totality for every sample (PBT-03): resolve, or throw the typed error.
      const totalityHandle = await open(sourcePath, "r");
      try {
        await assertTotal(
          () => parse(totalityHandle, sample.bytes.length),
          (error) => error instanceof WebpStructureError,
        );
      } finally {
        await totalityHandle.close();
      }
      if (sample.expected === "success") {
        assertPlanted(sample.bytes, sample.planted);
        assertCanariesDistinct(sample.planted);
        const source = await open(sourcePath, "r");
        try {
          await expect(
            parse(source, sample.bytes.length),
          ).resolves.toBeDefined();
        } finally {
          await source.close();
        }
        const plantedKinds = new Set(countedKinds(sample));
        for (const kind of plantedKinds) counterKeys.push(`kind:${kind}`);
        await utimes(sourcePath, SEEDED_SOURCE_TIME, SEEDED_SOURCE_TIME);

        const result = await sanitize({
          sourcePath,
          destinationPath,
          ...sample.options,
        });
        assertAdmittedOutcome(result);
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

        // Payload identity (PBT-02): every image payload chunk survives byte for byte.
        expect(
          payloadChunks(output).map((chunk) => [chunk.fourCc, chunk.data]),
          PRESERVATION_MESSAGES.payloadIdentity,
        ).toEqual(
          payloadChunks(sample.bytes).map((chunk) => [
            chunk.fourCc,
            chunk.data,
          ]),
        );

        if (preserveColorProfile) {
          counterKeys.push("flag:preserveColorProfile");
          const sourceIccChunk = readChunks(sample.bytes).find(
            (chunk) => chunk.fourCc === "ICCP",
          );
          const destinationIccChunk = outputChunks.find(
            (chunk) => chunk.fourCc === "ICCP",
          );
          expect(
            destinationIccChunk,
            PRESERVATION_MESSAGES.iccMissing,
          ).toBeDefined();
          expect(
            destinationIccChunk?.data,
            PRESERVATION_MESSAGES.iccBytes,
          ).toEqual(sourceIccChunk?.data);
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
      } else if (sample.expected === "any") {
        // Mutation arm and zero-byte example: success or any typed refusal is admitted.
        const preservedKinds =
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "ICCP")
            ? ["ICCP"]
            : [];
        assertCanariesDistinct(sample.planted);
        const result = await sanitize({
          sourcePath,
          destinationPath,
          ...sample.options,
        });
        assertAdmittedOutcome(result);
        if (result.ok) {
          const output = await readFile(destinationPath);
          assertCanariesAbsent(output, sample.planted, preservedKinds);
          const destinationHandle = await open(destinationPath, "r");
          try {
            await expect(
              parseWebp(destinationHandle, output.length),
            ).resolves.toBeDefined();
          } finally {
            await destinationHandle.close();
          }
          expect(await readFile(sourcePath)).toEqual(sample.bytes);
        } else {
          await assertNonSuccessBlastRadius({
            directory,
            sourcePath,
            sourceBytes: sample.bytes,
          });
          await expect(access(destinationPath)).rejects.toBeDefined();
        }
      } else {
        const result = await sanitize({
          sourcePath,
          destinationPath,
          ...sample.options,
        });
        assertAdmittedOutcome(result);
        await assertNonSuccessBlastRadius({
          directory,
          sourcePath,
          sourceBytes: sample.bytes,
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
    },
  );
  return counterKeys;
}

/**
 * Rewrites `destinationPath` by mapping its current chunk list through `transform`
 * and re-serializing it as WebP. Every D-21 control that needs to corrupt real
 * sanitizer output — rather than synthesize a buffer from scratch — reads the
 * genuine output the real `sanitizeFile` wrote, transforms it, and writes it back.
 * The canary and value checks in these controls therefore always run on real
 * sanitizer output, never a hand-built one.
 */
async function rewriteDestination(
  destinationPath: string,
  transform: (chunks: readonly FixtureChunk[]) => readonly FixtureChunk[],
): Promise<void> {
  const destination = await readFile(destinationPath);
  const rewritten = webp(transform(readChunks(destination)));
  await writeFile(destinationPath, rewritten);
}

/**
 * Absolute per-arm/per-flag floors (D-20), measured over 200 runs each at seed
 * 460046 and at seeds 1, 2 and 3 (FC_SEED). Each floor is half the minimum measured
 * count across those four seeds, rounded down, with a hard minimum of 10. The
 * metadata-arm weight was raised from 4 to 6 in an earlier measurement per D-20
 * ("raise weight and re-measure", never lower the floor).
 *
 * 66-11 re-measurement after the generator change: the fixed hostile fixtures now
 * run first as fast-check `examples` (13 of the 200 runs, all counted as `hostile`)
 * and a generated mutation arm (weight 2) replaced the constantFrom hostile arm.
 * `arm:hostile` is therefore the fixed example count (13), so its rule value is the
 * hard minimum 10 (it was 22 when it was drawn at random). Every other counter's
 * rule value (half of the minimum below, rounded down: EXIF 29, XMP 33, ICCP 27,
 * no-metadata 16, mutation 19, preserveOrientation 14, preserveColorProfile 11,
 * preserveTimestamps 35) is at or below the floor already set, so those floors are
 * kept: none was lowered. Measured distributions (arm/kind/flag -> count):
 *
 *   seed 460046: metadata 111, no-metadata 37, mutation 39, hostile 13; EXIF 63, XMP 73,
 *                ICCP 63; preserveOrientation 31, preserveColorProfile 31, preserveTimestamps 71
 *   seed 1:      metadata 111, no-metadata 32, mutation 44, hostile 13; EXIF 69, XMP 66,
 *                ICCP 61; preserveOrientation 28, preserveColorProfile 32, preserveTimestamps 75
 *   seed 2:      metadata 109, no-metadata 38, mutation 40, hostile 13; EXIF 59, XMP 70,
 *                ICCP 54; preserveOrientation 31, preserveColorProfile 22, preserveTimestamps 83
 *   seed 3:      metadata 111, no-metadata 32, mutation 44, hostile 13; EXIF 59, XMP 73,
 *                ICCP 67; preserveOrientation 30, preserveColorProfile 39, preserveTimestamps 78
 */
const FIXED_SEED_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  "kind:EXIF": 31,
  "kind:XMP": 35,
  "kind:ICCP": 29,
  "arm:no-metadata": 16,
  "arm:hostile": 10,
  "arm:mutation": 19,
  "flag:preserveOrientation": 15,
  "flag:preserveColorProfile": 13,
  "flag:preserveTimestamps": 37,
});

/** Minimum printed rate per slot, derived from the counter floors (PBT-01, D-09). */
const WEBP_SLOT_LABELS = ["EXIF", "XMP", "ICCP"] as const;
const WEBP_SLOT_RATE_FLOORS = slotRateFloors(
  FIXED_SEED_FLOORS,
  WEBP_SLOT_LABELS,
  (kind) => `kind:${kind}`,
);

/** Runs fc.statistics over `arbitrary` and returns the printed lines. */
function captureStatistics(
  arbitrary: ReturnType<typeof qualificationArbitrary>,
  classify: (sample: QualificationSample) => string[],
  config: { readonly seed: number; readonly numRuns: number },
): string[] {
  const lines: string[] = [];
  fc.statistics(arbitrary, classify, {
    seed: config.seed,
    numRuns: config.numRuns,
    logger: (line) => lines.push(line),
  });
  return lines;
}

/** Label presence by set membership: order of printed rows never matters. */
function missingSlotLabels(lines: readonly string[]): string[] {
  const present = new Set(parseStatisticsRates(lines).keys());
  return WEBP_SLOT_LABELS.filter((label) => !present.has(label));
}

/** C2PA is not applicable to WebP: no C2PA generator slot exists (PBT-01). */
function assertNoC2paRemoval(capability: {
  readonly removes: readonly string[];
}): void {
  if (capability.removes.includes("C2PA")) {
    throw new Error("WebP gained C2PA: add a C2PA generator slot (PBT-01)");
  }
}

describe("replayable WebP qualification properties", () => {
  it("defaults focused runs to 200 and exact-path replay to one", () => {
    expect(resolveReplayConfig({})).toEqual({ seed: 460_046, numRuns: 200 });
    expect(resolveReplayConfig({ FC_PATH: "0:1" })).toEqual({
      seed: 460_046,
      path: "0:1",
      numRuns: 1,
      endOnFailure: true,
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
    // The fixed hostile fixtures run first as examples and count inside numRuns.
    await checkWithReplay(
      property,
      Object.assign({}, config, {
        examples: WEBP_HOSTILE_EXAMPLES.map((example) => [...example]),
      }),
      {
        format: "webp",
        toBytes: (sample) => sample.bytes,
        generatorSources: WEBP_GENERATOR_SOURCES,
      },
    );
    expect(executed).toBe(config.numRuns);
    console.info(`webp counters: ${JSON.stringify(counters)}`);
    // A focused FC_PATH replay (config.path defined) or a non-default FC_RUNS has
    // no floor — floors only bind the full fixed-seed 200-run sweep (D-20).
    if (config.path === undefined && config.numRuns === 200) {
      assertFloors(counters, FIXED_SEED_FLOORS);
    }
  }, 30_000);

  it("slot distribution (fc.statistics, PBT-01)", () => {
    const config = resolveReplayConfig(process.env);
    const lines = captureStatistics(
      qualificationArbitrary(),
      (sample) => [...countedKinds(sample)],
      config,
    );
    console.info(lines.join("\n"));
    expect(missingSlotLabels(lines)).toEqual([]);
    if (config.path === undefined && config.numRuns === 200) {
      assertSlotRates(lines, WEBP_SLOT_RATE_FLOORS);
    }
  });

  it("an empty classifier leaves every slot label absent (PBT-01 empty)", () => {
    const lines = captureStatistics(qualificationArbitrary(), () => [], {
      seed: 460_046,
      numRuns: 200,
    });
    expect(missingSlotLabels(lines)).toEqual([...WEBP_SLOT_LABELS]);
  });

  it("statistics gate goes red on a generator missing a slot", () => {
    const config = { seed: 460_046, numRuns: 200 };
    const dropXmp = qualificationArbitrary().map(
      (sample): QualificationSample => ({
        ...sample,
        planted: sample.planted.filter((item) => item.kind !== "XMP"),
      }),
    );
    const classify = (sample: QualificationSample) => [...countedKinds(sample)];
    expect(() =>
      assertSlotRates(
        captureStatistics(qualificationArbitrary(), classify, config),
        WEBP_SLOT_RATE_FLOORS,
      ),
    ).not.toThrow();
    expect(() =>
      assertSlotRates(
        captureStatistics(dropXmp, classify, config),
        WEBP_SLOT_RATE_FLOORS,
      ),
    ).toThrow(/slot XMP/);
  });

  it("WebP declares no C2PA removal (C2PA not applicable)", () => {
    expect(() => assertNoC2paRemoval(webpHandler.capability)).not.toThrow();
  });

  it("the C2PA gate goes red on a capability that gained C2PA", () => {
    const real = webpHandler.capability;
    const mutated = { ...real, removes: [...real.removes, "C2PA"] };
    expect(mutated.removes).not.toEqual(real.removes);
    expect(() => assertNoC2paRemoval(mutated)).toThrow(
      "WebP gained C2PA: add a C2PA generator slot (PBT-01)",
    );
  });

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
        format: "webp",
        seed: 460_046,
        path: replayPath,
        bytes: Buffer.from("fixture"),
        generatorSources: WEBP_GENERATOR_SOURCES,
        faultPlan: { operation: "stage-sync", occurrence: 1, error: "EIO" },
      }),
    ).toMatchObject({
      version: 2,
      format: "webp",
      seed: 460_046,
      path: replayPath,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      fixtureSha256: bytesDigest(Buffer.from("fixture")),
      replayCommand: expect.stringContaining("FC_PATH="),
    });
  });

  it("prints a record whose replay yields the same bytes on the real arbitrary", async () => {
    const forced = () =>
      fc.asyncProperty(qualificationArbitrary(), async (sample) => {
        if (sample.bytes.length >= 100) throw new Error("forced");
      });
    let message = "";
    try {
      await checkWithReplay(forced(), resolveReplayConfig({}), {
        format: "webp",
        toBytes: (sample) => sample.bytes,
        generatorSources: WEBP_GENERATOR_SOURCES,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    const record = parseReplayRecord(message);
    const replayed = await fc.check(
      forced(),
      resolveReplayConfig({
        FC_SEED: String(record.seed),
        FC_PATH: record.path,
      }),
    );
    expect(replayed.failed).toBe(true);
    const sample = replayed.counterexample?.[0] as QualificationSample;
    expect(bytesDigest(sample.bytes)).toBe(record.fixtureSha256);
  }, 30_000);

  describe("PBT-03 non-success drills", () => {
    const REPLAY_PARAMS = {
      seed: 460_046,
      numRuns: 200,
      endOnFailure: true,
    } as const;
    const hostile = () =>
      qualificationArbitrary().filter(
        (sample) => sample.expected !== "success",
      );

    const drill = async (
      label: string,
      wrap: (
        real: typeof sanitizeFile,
        seen: { count: number },
      ) => typeof sanitizeFile,
    ) => {
      const seen = { count: 0 };
      const fake = wrap(sanitizeFile, seen);
      const result = await fc.check(
        fc.asyncProperty(hostile(), async (sample) => {
          await checkSample(sample, fake);
        }),
        REPLAY_PARAMS,
      );
      expect(seen.count).toBeGreaterThan(0);
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(label);
    };

    it("a refusal that leaves a stage file turns the suite red (residue)", async () => {
      await drill(
        INVARIANT_MESSAGES.residue,
        (real, seen) => async (options) => {
          seen.count += 1;
          const outcome = await real(options);
          await writeFile(`${options.destinationPath}.stage`, "x");
          return outcome;
        },
      );
    });

    it("a refusal that changes the source turns the suite red (sourceChanged)", async () => {
      await drill(
        INVARIANT_MESSAGES.sourceChanged,
        (real, seen) => async (options) => {
          seen.count += 1;
          const outcome = await real(options);
          await appendFile(options.sourcePath, Buffer.from([0]));
          return outcome;
        },
      );
    });

    it("a verification-failed result turns the suite red (verificationFailed)", async () => {
      await drill(
        INVARIANT_MESSAGES.verificationFailed,
        (real, seen) => async (options) => {
          seen.count += 1;
          const outcome = await real(options);
          if (outcome.ok) return outcome;
          return {
            ok: false,
            error: { ...outcome.error, code: "verification-failed" },
          } as typeof outcome;
        },
      );
    });

    it("a read-failed result on a readable source turns the suite red (untypedThrow)", async () => {
      await drill(
        INVARIANT_MESSAGES.untypedThrow,
        (real, seen) => async (options) => {
          seen.count += 1;
          const outcome = await real(options);
          if (outcome.ok) return outcome;
          return {
            ok: false,
            error: { ...outcome.error, code: "read-failed" },
          } as typeof outcome;
        },
      );
    });
  });

  it("untyped parser throw turns the suite red (PBT-03 totality)", async () => {
    let calls = 0;
    const stub: typeof parseWebp = async () => {
      calls += 1;
      throw new Error("untyped parser stub");
    };
    const result = await fc.check(
      fc.asyncProperty(
        qualificationArbitrary().filter(
          (sample) => sample.expected === "success",
        ),
        async (sample) => {
          await checkSample(sample, sanitizeFile, stub);
        },
      ),
      { seed: 460_046, numRuns: 200, endOnFailure: true },
    );
    expect(calls).toBeGreaterThan(0);
    expect(result.failed).toBe(true);
    expect(String(result.errorInstance)).toContain(
      INVARIANT_MESSAGES.untypedParserThrow,
    );
  });

  it("untyped parser throw on a mutation sample turns the suite red (PBT-03 totality)", async () => {
    let calls = 0;
    const stub: typeof parseWebp = async () => {
      calls += 1;
      throw new Error("untyped parser stub");
    };
    const result = await fc.check(
      fc.asyncProperty(
        qualificationArbitrary().filter((sample) => sample.arm === "mutation"),
        async (sample) => {
          await checkSample(sample, sanitizeFile, stub);
        },
      ),
      { seed: 460_046, numRuns: 200, endOnFailure: true },
    );
    expect(calls).toBeGreaterThan(0);
    expect(result.failed).toBe(true);
    expect(String(result.errorInstance)).toContain(
      INVARIANT_MESSAGES.untypedParserThrow,
    );
  });

  describe("strip-but-corrupt drill (PBT-02)", () => {
    let corrupted = 0;
    /**
     * Real sanitizer, then one byte flipped (XOR 0x80) strictly inside the first
     * payload chunk's data region whose corruption the parser still accepts. The
     * candidate order is deterministic: the middle byte first, then ascending from
     * the start of the data. Payload fixtures are tiny headers (a VP8 key-frame
     * signature sits at the middle byte), so the first candidate the parser rejects
     * is skipped; a corrupted file therefore always still parses, and the drill can
     * only go red on payload identity.
     */
    const corruptingSanitize: typeof sanitizeFile = async (options) => {
      const outcome = await sanitizeFile(options);
      if (!outcome.ok) return outcome;
      const original = await readFile(options.destinationPath);
      let offset = 12;
      while (offset + 8 <= original.length) {
        const fourCc = original.toString("ascii", offset, offset + 4);
        const size = original.readUInt32LE(offset + 4);
        if (PAYLOAD_FOURCCS.has(fourCc) && size > 0) {
          const dataOffset = offset + 8;
          const candidates = [
            Math.floor(size / 2),
            ...Array.from({ length: size }, (_, index) => index),
          ];
          for (const candidate of candidates) {
            const mutated = Buffer.from(original);
            const index = dataOffset + candidate;
            mutated[index] = (mutated[index] ?? 0) ^ 0x80;
            await writeFile(options.destinationPath, mutated);
            const handle = await open(options.destinationPath, "r");
            try {
              await parseWebp(handle, mutated.length);
              corrupted += 1;
              return outcome;
            } catch (error) {
              if (!(error instanceof WebpStructureError)) throw error;
            } finally {
              await handle.close();
            }
          }
          await writeFile(options.destinationPath, original);
        }
        offset += 8 + size + (size & 1);
      }
      return outcome;
    };

    it("strip-but-corrupt sanitizer turns the suite red (PBT-02)", async () => {
      const before = corrupted;
      const result = await fc.check(
        fc.asyncProperty(
          qualificationArbitrary().filter(
            (sample) => sample.expected === "success",
          ),
          async (sample) => {
            await checkSample(sample, corruptingSanitize);
          },
        ),
        { seed: 460_046, numRuns: 200, endOnFailure: true },
      );
      expect(corrupted).toBeGreaterThan(before);
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.payloadIdentity,
      );
      expect(String(result.errorInstance)).not.toContain("EXIFCLEANER-CANARY-");
    });

    it("the corrupted destination still parses, so red can only be payload identity", async () => {
      const [sample] = fc.sample(
        qualificationArbitrary().filter(
          (candidate) => candidate.expected === "success",
        ),
        { seed: 460_046, numRuns: 1 },
      );
      await withSampleWorkspace(
        "source.webp",
        "output.webp",
        sample!.bytes,
        async ({ sourcePath, destinationPath }) => {
          const before = corrupted;
          await corruptingSanitize({
            sourcePath,
            destinationPath,
            ...sample!.options,
          });
          expect(corrupted).toBe(before + 1);
          const output = await readFile(destinationPath);
          const handle = await open(destinationPath, "r");
          try {
            await expect(
              parseWebp(handle, output.length),
            ).resolves.toBeDefined();
          } finally {
            await handle.close();
          }
        },
      );
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
            resolution: false,
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

    it("(2) fails a sanitizer that strips every metadata kind except XMP", async () => {
      // The fake calls the real src sanitizeFile, then appends the source's XMP
      // chunk(s) back onto the genuine output, so the canary check runs against
      // real sanitizer output that leaks exactly one metadata kind (D-21 (2)).
      const xmpKeepingSanitize: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        const sourceXmpChunks = readChunks(
          await readFile(options.sourcePath),
        ).filter((chunk) => chunk.fourCc === "XMP ");
        await rewriteDestination(options.destinationPath, (chunks) => {
          const withXmpFlag = chunks.map((chunk) => {
            if (chunk.fourCc !== "VP8X") return chunk;
            const data = Buffer.from(chunk.data);
            data[0] = (data[0] ?? 0) | 0x04;
            return { ...chunk, data };
          });
          return [...withXmpFlag, ...sourceXmpChunks];
        });
        return outcome;
      };
      const arbitrary = qualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.planted.some((item) => item.kind === "XMP"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, xmpKeepingSanitize);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain("kind XMP");
      expect(String(result.errorInstance)).toContain("EXIFCLEANER-CANARY-");
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
      // The fake calls the real src sanitizeFile but forces preserveColorProfile
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

    it("(4c) fails a sanitizer that writes a different Orientation value", async () => {
      const arbitrary = qualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveOrientation &&
          sample.planted.some((item) => item.kind === "EXIF"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          // The fake honors every flag, then rewrites the real output's EXIF
          // chunk with a different Orientation value. It closes over `sample`
          // to compute the "other" value (D-19 c: Orientation checked by value).
          const other = sample.plantedOrientation === 1 ? 2 : 1;
          const writesWrongOrientation: typeof sanitizeFile = async (
            options,
          ) => {
            const outcome = await sanitizeFile(options);
            if (!outcome.ok) return outcome;
            await rewriteDestination(options.destinationPath, (chunks) =>
              chunks.map((chunk) =>
                chunk.fourCc === "EXIF"
                  ? { ...chunk, data: exifWithOrientation(other) }
                  : chunk,
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

    it("(4d) fails a sanitizer that corrupts the preserved ICC profile bytes", async () => {
      const arbitrary = qualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "ICCP"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          // The fake honors every flag, then XORs the last byte of the real
          // output's ICCP chunk data, keeping the same length (D-19 c: ICC
          // checked byte-for-byte).
          const corruptsIccBytes: typeof sanitizeFile = async (options) => {
            const outcome = await sanitizeFile(options);
            if (!outcome.ok) return outcome;
            await rewriteDestination(options.destinationPath, (chunks) =>
              chunks.map((chunk) => {
                if (chunk.fourCc !== "ICCP") return chunk;
                const data = Buffer.from(chunk.data);
                const lastIndex = data.length - 1;
                data[lastIndex] = (data[lastIndex] ?? 0) ^ 0xff;
                return { ...chunk, data };
              }),
            );
            return outcome;
          };
          await checkSample(sample, corruptsIccBytes);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.iccBytes,
      );
    });
  });
});
