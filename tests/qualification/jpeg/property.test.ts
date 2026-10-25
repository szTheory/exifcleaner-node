import {
  access,
  appendFile,
  copyFile,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../src/index.js";
import { createMinimalExif } from "../../../src/metadata/exif.js";
import { JpegStructureError, parseJpeg } from "../../../src/jpeg/parser.js";
import { ok } from "../../../src/result.js";
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
  JPEG_HOSTILE_EXAMPLES,
  JPEG_HOSTILE_REFUSALS,
  jpegMetadataGenerator,
  jpegQualificationArbitrary,
  jpegQualificationArbitraryWithoutMetadataArm,
  type QualificationSample,
} from "./generators.js";

const JPEG_GENERATOR_SOURCES = [
  "tests/qualification/jpeg/generators.ts",
  "tests/qualification/jpeg/fixtures.ts",
  "tests/qualification/kit/generators.ts",
  "tests/fixtures.ts",
  "tests/isobmff-support/builder.ts",
];

interface JpegSegmentRecord {
  readonly marker: number;
  readonly payload: Buffer;
  /** SOS only: the entropy-coded data after the scan header, up to the next real marker. */
  readonly entropy?: Buffer;
}

/**
 * A test-local, independent JPEG segment walker (mirrors
 * `png/property.test.ts`'s `readPngChunkRecords`): never imports
 * `src/jpeg/parser.ts`'s own segment classification, so the property gate's
 * byte-level checks (canary absence, structural identity) cannot share a bug
 * with the handler's own parser. `parseJpeg` itself is still used separately
 * below, only to confirm the output re-parses structurally.
 */
function readJpegSegmentRecords(bytes: Buffer): {
  readonly segments: readonly JpegSegmentRecord[];
  readonly trailerBytes: number;
} {
  const segments: JpegSegmentRecord[] = [];
  let offset = 2; // past SOI
  let trailerBytes = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    let cursor = offset + 2;
    if (marker === 0xd9) {
      // EOI: anything after this is trailer.
      trailerBytes = bytes.length - cursor;
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      // Restart marker: no length field.
      offset = cursor;
      continue;
    }
    if (cursor + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(cursor);
    const payload = bytes.subarray(cursor + 2, cursor + length);
    offset = cursor + length;
    if (marker === 0xda) {
      // SOS: skip entropy-coded data up to (not including) the next real
      // marker -- 0xFF00 stuffing and RSTn are part of the entropy stream.
      const entropyStart = offset;
      let p = offset;
      while (p < bytes.length - 1) {
        if (bytes[p] === 0xff) {
          const next = bytes[p + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) {
            offset = p;
            break;
          }
          p += 2;
        } else {
          p += 1;
        }
      }
      segments.push({
        marker,
        payload,
        entropy: bytes.subarray(entropyStart, offset),
      });
    } else {
      segments.push({ marker, payload });
    }
  }
  return { segments, trailerBytes };
}

function findFirst(
  records: readonly JpegSegmentRecord[],
  predicate: (item: JpegSegmentRecord) => boolean,
): JpegSegmentRecord | undefined {
  return records.find(predicate);
}

const isAdobe = (item: JpegSegmentRecord): boolean =>
  item.marker === 0xee &&
  item.payload.subarray(0, 5).toString("ascii") === "Adobe";
const isJfif = (item: JpegSegmentRecord): boolean =>
  item.marker === 0xe0 &&
  item.payload.subarray(0, 5).toString("latin1") === "JFIF\0";
const isIcc = (item: JpegSegmentRecord): boolean =>
  item.marker === 0xe2 &&
  item.payload.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0";
const isExif = (item: JpegSegmentRecord): boolean =>
  item.marker === 0xe1 &&
  item.payload.subarray(0, 6).toString("latin1") === "Exif\0\0";

function buildSegmentBytes(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Every negative control below corrupts real sanitizer output through
 * targeted byte surgery, never a rebuild-from-scratch: the entropy-coded scan
 * data between SOS and the primary EOI is never touched or re-serialized, so
 * a control cannot accidentally corrupt the very bytes `checkSample`'s own
 * entropy-identity assertion depends on.
 */

/** Inserts raw `segments` bytes immediately after `destinationPath`'s SOI --
 * always structurally legal (D-01 classification is content-prefix-driven,
 * not position-driven), and never touches anything after byte offset 2. */
async function insertSegmentsAfterSoi(
  destinationPath: string,
  segments: readonly Buffer[],
): Promise<void> {
  const destination = await readFile(destinationPath);
  await writeFile(
    destinationPath,
    Buffer.concat([
      destination.subarray(0, 2),
      ...segments,
      destination.subarray(2),
    ]),
  );
}

/** Replaces the first pre-SOS segment matching `predicate` with
 * `newSegmentBytes`, leaving every other byte (including the entropy-coded
 * scan region) untouched. Scans only up to the first SOS marker. */
async function replaceFirstPreSosSegment(
  destinationPath: string,
  predicate: (item: JpegSegmentRecord) => boolean,
  newSegmentBytes: Buffer,
): Promise<void> {
  const destination = await readFile(destinationPath);
  let offset = 2;
  while (offset < destination.length - 1) {
    if (destination[offset] !== 0xff)
      throw new Error(
        "replaceFirstPreSosSegment: expected a marker prefix byte",
      );
    const marker = destination[offset + 1]!;
    if (marker === 0xda) break; // stop before SOS/entropy data
    const length = destination.readUInt16BE(offset + 2);
    const payload = destination.subarray(offset + 4, offset + 2 + length);
    if (predicate({ marker, payload })) {
      await writeFile(
        destinationPath,
        Buffer.concat([
          destination.subarray(0, offset),
          newSegmentBytes,
          destination.subarray(offset + 2 + length),
        ]),
      );
      return;
    }
    offset += 2 + length;
  }
  throw new Error("replaceFirstPreSosSegment: no matching segment found");
}

/**
 * Labels for `checkSample`'s own preservation assertions (D-21). Every
 * negative control that expects `checkSample` to reject a broken sanitizer
 * asserts on one of these strings, so a control can only pass by driving the
 * real gate.
 */
const PRESERVATION_MESSAGES = Object.freeze({
  trailerPresent: "checkSample: output carries trailer bytes",
  adobeMissing: "checkSample: source Adobe APP14 is missing from the output",
  adobeBytes: "checkSample: Adobe APP14 bytes differ from the source",
  jfifUnexpected:
    "checkSample: JFIF is present in the output when it must be dropped (D-06)",
  jfifMissing:
    "checkSample: requested JFIF resolution preservation is missing from the output",
  iccMissing:
    "checkSample: requested ICC color profile is missing from the output",
  exifMissing: "checkSample: requested APP1 Exif is missing from the output",
  exifBytes:
    "checkSample: APP1 Exif TIFF bytes differ from the recomputed createMinimalExif bytes",
  payloadIdentity: "checkSample: scan payload bytes differ from the source",
} as const);

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

/**
 * Per-sample body of the fixed-seed property (extracted so Task 3 reuses it
 * against injected fakes). `sanitize` is injectable and defaults to the real
 * dist `sanitizeFile` -- every negative control replaces it with a
 * deliberately broken fake.
 *
 * Returns the counter keys this sample contributes to the absolute per-arm/
 * per-kind/per-flag/per-hostile floors: always `arm:<arm>`, plus `kind:<K>`
 * per planted kind and `flag:<name>` for each preservation flag actually
 * exercised on a success sample, or `hostile:<refusal>` on a hostile sample.
 */
async function checkSample(
  sample: QualificationSample,
  sanitize: typeof sanitizeFile = sanitizeFile,
  parse: typeof parseJpeg = parseJpeg,
): Promise<readonly string[]> {
  const counterKeys: string[] = [`arm:${sample.arm}`];
  await withSampleWorkspace(
    "source.jpg",
    "output.jpg",
    sample.bytes,
    async ({ directory, sourcePath, destinationPath }) => {
      const totalityHandle = await open(sourcePath, "r");
      try {
        await assertTotal(
          () => parse(totalityHandle, sample.bytes.length),
          (error) => error instanceof JpegStructureError,
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

        const result = await sanitize({
          sourcePath,
          destinationPath,
          ...sample.options,
        });
        assertAdmittedOutcome(result);
        expect(result.ok, JSON.stringify(result)).toBe(true);

        const preserveColorProfile =
          sample.options.preserveColorProfile && plantedKinds.has("ICC");
        const preserveOrientation =
          sample.options.preserveOrientation &&
          sample.plantedOrientation !== undefined;
        const preserveResolution =
          sample.options.preserveResolution &&
          sample.plantedResolution !== undefined;
        const preservedKinds = preserveColorProfile ? ["ICC"] : [];

        const output = await readFile(destinationPath);
        assertCanariesAbsent(output, sample.planted, preservedKinds);

        // Validity: the output re-parses structurally.
        const destinationHandle = await open(destinationPath, "r");
        try {
          await expect(
            parseJpeg(destinationHandle, output.length),
          ).resolves.toBeDefined();
        } finally {
          await destinationHandle.close();
        }

        const sourceRecords = readJpegSegmentRecords(sample.bytes);
        const outputRecords = readJpegSegmentRecords(output);

        // Zero trailer bytes in the output, always.
        expect(
          outputRecords.trailerBytes,
          PRESERVATION_MESSAGES.trailerPresent,
        ).toBe(0);

        // Every scan is byte-identical: the SOS header AND the entropy-coded
        // data it brackets, both read by the independent walker.
        const sourceScans = sourceRecords.segments.filter(
          (s) => s.marker === 0xda,
        );
        const outputScans = outputRecords.segments.filter(
          (s) => s.marker === 0xda,
        );
        expect(outputScans.length).toBe(sourceScans.length);
        outputScans.forEach((scan, index) => {
          const sourceScan = sourceScans[index]!;
          expect(
            scan.payload.equals(sourceScan.payload) &&
              scan.entropy !== undefined &&
              sourceScan.entropy !== undefined &&
              scan.entropy.equals(sourceScan.entropy),
            PRESERVATION_MESSAGES.payloadIdentity,
          ).toBe(true);
        });

        // APP14 Adobe is byte-identical when present in the source.
        const sourceAdobe = findFirst(sourceRecords.segments, isAdobe);
        if (sample.plantedAdobe) {
          counterKeys.push("flag:adobe");
          const outputAdobe = findFirst(outputRecords.segments, isAdobe);
          expect(outputAdobe, PRESERVATION_MESSAGES.adobeMissing).toBeDefined();
          expect(
            outputAdobe!.payload.equals(sourceAdobe!.payload),
            PRESERVATION_MESSAGES.adobeBytes,
          ).toBe(true);
        } else {
          expect(findFirst(outputRecords.segments, isAdobe)).toBeUndefined();
        }

        // JFIF is present exactly when preserveResolution is true and no
        // APP14 is planted (D-06).
        if (sample.plantedJfif) {
          const outputJfif = findFirst(outputRecords.segments, isJfif);
          const expectJfif =
            sample.options.preserveResolution && !sample.plantedAdobe;
          if (expectJfif) {
            counterKeys.push("flag:preserveResolutionJfif");
            expect(outputJfif, PRESERVATION_MESSAGES.jfifMissing).toBeDefined();
          } else {
            expect(
              outputJfif,
              PRESERVATION_MESSAGES.jfifUnexpected,
            ).toBeUndefined();
          }
        }

        // ICC segments are present and byte-identical (in order) exactly when
        // preserveColorProfile is true.
        if (preserveColorProfile) {
          counterKeys.push("flag:preserveColorProfile");
          const sourceIcc = sourceRecords.segments.filter(isIcc);
          const outputIcc = outputRecords.segments.filter(isIcc);
          expect(outputIcc.length, PRESERVATION_MESSAGES.iccMissing).toBe(
            sourceIcc.length,
          );
          outputIcc.forEach((item, index) => {
            expect(item.payload).toEqual(sourceIcc[index]!.payload);
          });
        } else {
          expect(outputRecords.segments.filter(isIcc)).toHaveLength(0);
        }

        // Any APP1 Exif in the output equals the recomputed
        // createMinimalExif bytes.
        const outputExif = findFirst(outputRecords.segments, isExif);
        if (preserveOrientation || preserveResolution) {
          if (preserveOrientation) counterKeys.push("flag:preserveOrientation");
          if (preserveResolution) counterKeys.push("flag:preserveResolution");
          expect(outputExif, PRESERVATION_MESSAGES.exifMissing).toBeDefined();
          const expectedTiff = createMinimalExif({
            ...(preserveOrientation
              ? { orientation: sample.plantedOrientation! }
              : {}),
            ...(preserveResolution
              ? {
                  resolution: {
                    x: {
                      numerator: sample.plantedResolution!.x,
                      denominator: 1,
                    },
                    y: {
                      numerator: sample.plantedResolution!.y,
                      denominator: 1,
                    },
                    unit: sample.plantedResolution!.unit,
                  },
                }
              : {}),
          });
          expect(
            outputExif!.payload.subarray(6).equals(expectedTiff),
            PRESERVATION_MESSAGES.exifBytes,
          ).toBe(true);
        } else {
          expect(outputExif).toBeUndefined();
        }

        if (sample.options.preserveTimestamps) {
          counterKeys.push("flag:preserveTimestamps");
        }

        expect(await readFile(sourcePath)).toEqual(sample.bytes);
      } else if (sample.expected === "any") {
        // Mutation arm and zero-byte example: success or any typed refusal is admitted.
        const preservedKinds =
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "ICC")
            ? ["ICC"]
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
              parseJpeg(destinationHandle, output.length),
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
        if (sample.hostileRefusal !== undefined)
          counterKeys.push(`hostile:${sample.hostileRefusal}`);
      }
    },
  );
  return counterKeys;
}

/**
 * 66-13 re-measurement after the generator change: the fixed hostile fixtures now
 * run first as fast-check `examples` (26 buffered cases plus a zero-byte sample, all
 * counted inside the 200 runs: 26 count as `hostile:<refusal>` and the zero-byte
 * sample counts under `arm:hostile` only, so `arm:hostile` is 27) and a generated
 * mutation arm (weight 3;
 * metadata 10, no-metadata 2) replaced the random hostile arm. Each `hostile:*`
 * counter is therefore the fixed number of fixtures in that refusal (the same at
 * every seed); `arm:hostile` 32 -> 13 (rule: half of 27) and hostile:dnl-marker,
 * hostile:hierarchical-frame, hostile:non-8-bit-precision (each 2 -> 1) and
 * hostile:non-t81-frame (3 -> 1) follow the rule because the counter became a fixed
 * fixture count of 1, not because a gate failed; hostile:malformed-container rose
 * 1 -> 3. Every counter still drawn at random keeps `max(existing floor, rule
 * value)`: none was lowered; arm:metadata, flag:preserveColorProfile,
 * flag:preserveResolution, flag:preserveTimestamps and the kind floors that were
 * below their rule value were raised. `arm:mutation` is new. Measured
 * distributions at seeds 460046, 1, 2, 3 (rule value = max(1, floor(min / 2))):
 *
 *   seed 460046: metadata 117, no-metadata 27, mutation 29, hostile 27;
 *     preserveOrientation 36, preserveColorProfile 36, preserveResolution 36,
 *     preserveTimestamps 71; kind min 29 (APP12, APP2-FPXR), APP11-JUMBF 35, ICC 68
 *   seed 1:      metadata 123, no-metadata 15, mutation 35, hostile 27;
 *     preserveOrientation 24, preserveColorProfile 27, preserveResolution 22,
 *     preserveTimestamps 68; kind min 29 (APP8), APP11-JUMBF 35, ICC 63
 *   seed 2:      metadata 114, no-metadata 25, mutation 34, hostile 27;
 *     preserveOrientation 19, preserveColorProfile 33, preserveResolution 31,
 *     preserveTimestamps 78; kind min 27 (APP8, APP13-PHOTOSHOP, APP14-NON-ADOBE), APP11-JUMBF 30, ICC 53
 *   seed 3:      metadata 119, no-metadata 17, mutation 37, hostile 27;
 *     preserveOrientation 26, preserveColorProfile 35, preserveResolution 31,
 *     preserveTimestamps 74; kind min 25 (APP0-JFXX, COM), APP11-JUMBF 33, ICC 66
 *   hostile (all seeds): arithmetic-frame 1, dnl-marker 1, hierarchical-frame 1,
 *     lossless-frame 1, malformed-container 7, mpf-secondary-image 1,
 *     non-8-bit-precision 1, non-t81-frame 1, resource-limits 5, truncation 3,
 *     undefined-table-reference 3, unsupported-component-count 1
 *
 * The statistics gate below derives each slot's minimum printed rate from these same
 * kind floors (floor / 200), so a rate and its counter floor cannot drift apart.
 *
 * Earlier (Phase 57) record, before the generator change, for history:
 *
 * Absolute per-arm/per-kind/per-flag/per-hostile-refusal floors, measured
 * over four seeds (460046, 1, 2, 3) at FC_RUNS=200. Each floor is
 * `max(1, floor(min-across-four-seeds / 2))` -- never lowered to fit a low
 * measurement; if a key ever falls below its floor at the fixed seed, the
 * generator's weighting is the thing to fix (56-16/PITFALLS 10 precedent).
 * Binds only at FC_SEED 460046 / FC_RUNS 200 (55-REVIEW WR-01) -- see the
 * guard below. Measured 200-run distributions (key -> count) at each seed:
 *
 *   seed 460046: arm:metadata 98, arm:no-metadata 18, arm:hostile 84;
 *     flag:preserveOrientation 33, flag:preserveColorProfile 19,
 *     flag:preserveResolution 26, flag:preserveTimestamps 51;
 *     kind:APP0-JFXX 25, kind:APP0-OTHER 32, kind:APP1-EXIF 80,
 *     kind:APP1-EXTENDED-XMP 29, kind:APP1-XMP 31, kind:APP10 36,
 *     kind:APP11-JUMBF 31, kind:APP12 28, kind:APP13-PHOTOSHOP 24,
 *     kind:APP14-NON-ADOBE 25, kind:APP15 29, kind:APP2-FPXR 29,
 *     kind:APP2-MPF 30, kind:APP2-OTHER 30, kind:APP3 34, kind:APP4 38,
 *     kind:APP5 29, kind:APP6 33, kind:APP7 29, kind:APP8 31, kind:APP9 24,
 *     kind:COM 32, kind:ICC 54, kind:TRAILER 51;
 *     hostile:arithmetic-frame 10, hostile:dnl-marker 7,
 *     hostile:hierarchical-frame 10, hostile:lossless-frame 3,
 *     hostile:malformed-container 6, hostile:mpf-secondary-image 7,
 *     hostile:non-8-bit-precision 4, hostile:non-t81-frame 9,
 *     hostile:resource-limits 7, hostile:truncation 5,
 *     hostile:undefined-table-reference 9, hostile:unsupported-component-count 7
 *   seed 1: arm:metadata 107, arm:no-metadata 28, arm:hostile 65;
 *     flag:preserveOrientation 23, flag:preserveColorProfile 31,
 *     flag:preserveResolution 19, flag:preserveTimestamps 50;
 *     kind:APP0-JFXX 38, kind:APP0-OTHER 26, kind:APP1-EXIF 82,
 *     kind:APP1-EXTENDED-XMP 27, kind:APP1-XMP 33, kind:APP10 39,
 *     kind:APP11-JUMBF 31, kind:APP12 36, kind:APP13-PHOTOSHOP 33,
 *     kind:APP14-NON-ADOBE 27, kind:APP15 27, kind:APP2-FPXR 31,
 *     kind:APP2-MPF 29, kind:APP2-OTHER 37, kind:APP3 35, kind:APP4 34,
 *     kind:APP5 34, kind:APP6 34, kind:APP7 41, kind:APP8 28, kind:APP9 28,
 *     kind:COM 36, kind:ICC 63, kind:TRAILER 52;
 *     hostile:arithmetic-frame 3, hostile:dnl-marker 4,
 *     hostile:hierarchical-frame 7, hostile:lossless-frame 1,
 *     hostile:malformed-container 8, hostile:mpf-secondary-image 2,
 *     hostile:non-8-bit-precision 7, hostile:non-t81-frame 7,
 *     hostile:resource-limits 5, hostile:truncation 9,
 *     hostile:undefined-table-reference 3, hostile:unsupported-component-count 9
 *   seed 2: arm:metadata 101, arm:no-metadata 27, arm:hostile 72;
 *     flag:preserveOrientation 22, flag:preserveColorProfile 27,
 *     flag:preserveResolution 35, flag:preserveTimestamps 52;
 *     kind:APP0-JFXX 29, kind:APP0-OTHER 33, kind:APP1-EXIF 83,
 *     kind:APP1-EXTENDED-XMP 26, kind:APP1-XMP 32, kind:APP10 32,
 *     kind:APP11-JUMBF 22, kind:APP12 25, kind:APP13-PHOTOSHOP 26,
 *     kind:APP14-NON-ADOBE 30, kind:APP15 34, kind:APP2-FPXR 32,
 *     kind:APP2-MPF 36, kind:APP2-OTHER 27, kind:APP3 32, kind:APP4 28,
 *     kind:APP5 31, kind:APP6 35, kind:APP7 33, kind:APP8 28, kind:APP9 27,
 *     kind:COM 34, kind:ICC 45, kind:TRAILER 55;
 *     hostile:arithmetic-frame 4, hostile:dnl-marker 9,
 *     hostile:hierarchical-frame 5, hostile:lossless-frame 6,
 *     hostile:malformed-container 1, hostile:mpf-secondary-image 10,
 *     hostile:non-8-bit-precision 5, hostile:non-t81-frame 9,
 *     hostile:resource-limits 5, hostile:truncation 6,
 *     hostile:undefined-table-reference 4, hostile:unsupported-component-count 8
 *   seed 3: arm:metadata 110, arm:no-metadata 21, arm:hostile 69;
 *     flag:preserveOrientation 25, flag:preserveColorProfile 31,
 *     flag:preserveResolution 26, flag:preserveTimestamps 50;
 *     kind:APP0-JFXX 25, kind:APP0-OTHER 36, kind:APP1-EXIF 84,
 *     kind:APP1-EXTENDED-XMP 33, kind:APP1-XMP 33, kind:APP10 33,
 *     kind:APP11-JUMBF 33, kind:APP12 35, kind:APP13-PHOTOSHOP 38,
 *     kind:APP14-NON-ADOBE 40, kind:APP15 37, kind:APP2-FPXR 36,
 *     kind:APP2-MPF 34, kind:APP2-OTHER 34, kind:APP3 30, kind:APP4 26,
 *     kind:APP5 32, kind:APP6 35, kind:APP7 30, kind:APP8 40, kind:APP9 30,
 *     kind:COM 30, kind:ICC 57, kind:TRAILER 55;
 *     hostile:arithmetic-frame 4, hostile:dnl-marker 7,
 *     hostile:hierarchical-frame 6, hostile:lossless-frame 3,
 *     hostile:malformed-container 5, hostile:mpf-secondary-image 11,
 *     hostile:non-8-bit-precision 4, hostile:non-t81-frame 6,
 *     hostile:resource-limits 6, hostile:truncation 5,
 *     hostile:undefined-table-reference 9, hostile:unsupported-component-count 3
 *
 * `flag:adobe` and `flag:preserveResolutionJfif` are counted by `checkSample`
 * above but intentionally excluded from the pinned floor table: they are
 * structural-element coverage signals (an Adobe/JFIF segment was planted and
 * exercised at all), not part of the D-01 canary-kind/preservation-flag
 * contract this floor table pins.
 */
const JPEG_FIXED_SEED_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  "arm:metadata": 57,
  "arm:no-metadata": 9,
  "arm:hostile": 13,
  "arm:mutation": 14,
  "flag:preserveOrientation": 11,
  "flag:preserveColorProfile": 13,
  "flag:preserveResolution": 11,
  "flag:preserveTimestamps": 34,
  "kind:APP0-JFXX": 12,
  "kind:APP0-OTHER": 15,
  "kind:APP1-EXIF": 44,
  "kind:APP1-EXTENDED-XMP": 15,
  "kind:APP1-XMP": 15,
  "kind:APP10": 17,
  "kind:APP11-JUMBF": 15,
  "kind:APP12": 14,
  "kind:APP13-PHOTOSHOP": 13,
  "kind:APP14-NON-ADOBE": 13,
  "kind:APP15": 13,
  "kind:APP2-FPXR": 14,
  "kind:APP2-MPF": 16,
  "kind:APP2-OTHER": 15,
  "kind:APP3": 15,
  "kind:APP4": 17,
  "kind:APP5": 15,
  "kind:APP6": 16,
  "kind:APP7": 15,
  "kind:APP8": 14,
  "kind:APP9": 16,
  "kind:COM": 15,
  "kind:ICC": 26,
  "kind:TRAILER": 29,
  "hostile:arithmetic-frame": 1,
  "hostile:dnl-marker": 1,
  "hostile:hierarchical-frame": 1,
  "hostile:lossless-frame": 1,
  "hostile:malformed-container": 3,
  "hostile:mpf-secondary-image": 1,
  "hostile:non-8-bit-precision": 1,
  "hostile:non-t81-frame": 1,
  "hostile:resource-limits": 2,
  "hostile:truncation": 2,
  "hostile:undefined-table-reference": 1,
  "hostile:unsupported-component-count": 1,
});

/** Minimum printed rate per slot, derived from the counter floors (PBT-01, D-09). */
const JPEG_SLOT_LABELS: readonly string[] = jpegMetadataGenerator.metadataKinds;
const JPEG_SLOT_RATE_FLOORS = slotRateFloors(
  JPEG_FIXED_SEED_FLOORS,
  JPEG_SLOT_LABELS,
  (kind) => `kind:${kind}`,
);

/** Runs fc.statistics over `arbitrary` and returns the printed lines. */
function captureStatistics(
  arbitrary: ReturnType<typeof jpegQualificationArbitrary>,
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
  return JPEG_SLOT_LABELS.filter((label) => !present.has(label));
}

describe("replayable JPEG qualification properties", () => {
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

  it("runs the fixed JPEG grammar and mutation corpus with complete replay identity", async () => {
    const config = resolveReplayConfig(process.env);
    let executed = 0;
    const counters = createCounters();
    const property = fc.asyncProperty(
      jpegQualificationArbitrary(),
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
        examples: JPEG_HOSTILE_EXAMPLES.map((example) => [...example]),
      }),
      {
        format: "jpeg",
        toBytes: (sample) => sample.bytes,
        generatorSources: JPEG_GENERATOR_SOURCES,
      },
    );
    expect(executed).toBe(config.numRuns);
    console.info(`jpeg counters: ${JSON.stringify(counters)}`);
    if (
      config.path === undefined &&
      config.numRuns === 200 &&
      config.seed === 460_046
    ) {
      assertFloors(counters, JPEG_FIXED_SEED_FLOORS);
    }
  }, 60_000);

  it("slot distribution (fc.statistics, PBT-01)", () => {
    const config = resolveReplayConfig(process.env);
    const lines = captureStatistics(
      jpegQualificationArbitrary(),
      (sample) => [...countedKinds(sample)],
      config,
    );
    console.info(lines.join("\n"));
    // Every JpegMetadataKind label (APP11-JUMBF is the C2PA slot) appears in the table.
    expect(missingSlotLabels(lines)).toEqual([]);
    if (config.path === undefined && config.numRuns === 200) {
      assertSlotRates(lines, JPEG_SLOT_RATE_FLOORS);
    }
  }, 60_000);

  it("an empty classifier leaves every slot label absent (PBT-01 empty)", () => {
    const lines = captureStatistics(jpegQualificationArbitrary(), () => [], {
      seed: 460_046,
      numRuns: 200,
    });
    expect(missingSlotLabels(lines)).toEqual([...JPEG_SLOT_LABELS]);
  }, 60_000);

  it("statistics gate goes red on a generator missing a slot", () => {
    const config = { seed: 460_046, numRuns: 200 };
    const dropJumbf = jpegQualificationArbitrary().map(
      (sample): QualificationSample => ({
        ...sample,
        planted: sample.planted.filter((item) => item.kind !== "APP11-JUMBF"),
      }),
    );
    const classify = (sample: QualificationSample) => [...countedKinds(sample)];
    expect(() =>
      assertSlotRates(
        captureStatistics(jpegQualificationArbitrary(), classify, config),
        JPEG_SLOT_RATE_FLOORS,
      ),
    ).not.toThrow();
    expect(() =>
      assertSlotRates(
        captureStatistics(dropJumbf, classify, config),
        JPEG_SLOT_RATE_FLOORS,
      ),
    ).toThrow(/slot APP11-JUMBF/);
  }, 60_000);

  it("replays the exact minimized path emitted for an injected failure", () => {
    const arbitrary = fc.integer({ min: 0, max: 100 });
    const first = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      { seed: 460_046, numRuns: 200 },
    );
    expect(first.failed).toBe(true);
    if (!first.failed || first.counterexamplePath === null)
      throw new Error("Expected an injected shrink failure");
    const replayPath = first.counterexamplePath;
    const replay = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      { seed: 460_046, path: replayPath, numRuns: 1 },
    );
    expect(replay.failed).toBe(true);
    expect(replay.counterexample).toEqual(first.counterexample);
    expect(
      formatReplayRecord({
        format: "jpeg",
        seed: 460_046,
        path: replayPath,
        bytes: Buffer.from("fixture"),
        generatorSources: JPEG_GENERATOR_SOURCES,
        faultPlan: { operation: "stage-sync", occurrence: 1, error: "EIO" },
      }),
    ).toMatchObject({
      version: 2,
      format: "jpeg",
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
      fc.asyncProperty(jpegQualificationArbitrary(), async (sample) => {
        if (sample.bytes.length >= 100) throw new Error("forced");
      });
    let message = "";
    try {
      await checkWithReplay(forced(), resolveReplayConfig({}), {
        format: "jpeg",
        toBytes: (sample) => sample.bytes,
        generatorSources: JPEG_GENERATOR_SOURCES,
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
    expect(bytesDigest(sample.bytes)).not.toBe(
      `${record.fixtureSha256.startsWith("a") ? "b" : "a"}${record.fixtureSha256.slice(1)}`,
    );
  }, 60_000);

  describe("PBT-03 non-success drills", () => {
    const DRILL_PARAMS = {
      seed: 460_046,
      numRuns: 200,
      endOnFailure: true,
    } as const;

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
        fc.asyncProperty(
          jpegQualificationArbitrary().filter(
            (sample) => sample.expected !== "success",
          ),
          async (sample) => {
            await checkSample(sample, fake);
          },
        ),
        DRILL_PARAMS,
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
    const stub: typeof parseJpeg = async () => {
      calls += 1;
      throw new Error("untyped parser stub");
    };
    const result = await fc.check(
      fc.asyncProperty(
        jpegQualificationArbitrary().filter(
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
    const stub: typeof parseJpeg = async () => {
      calls += 1;
      throw new Error("untyped parser stub");
    };
    const result = await fc.check(
      fc.asyncProperty(
        jpegQualificationArbitrary().filter(
          (sample) => sample.arm === "mutation",
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

  it("JPEG_HOSTILE_EXAMPLES cover every sampled refusal", () => {
    const refusalsOf = (
      examples: readonly (readonly [QualificationSample])[],
    ): Set<string> =>
      new Set(
        examples
          .map(([sample]) => sample)
          .filter((sample) => sample.id !== "zero-byte")
          .map((sample) => sample.hostileRefusal as string),
      );
    expect(JPEG_HOSTILE_REFUSALS.length).toBeGreaterThan(0);
    expect(refusalsOf(JPEG_HOSTILE_EXAMPLES)).toEqual(
      new Set(JPEG_HOSTILE_REFUSALS),
    );
    // Dropping every example of one refusal makes the equality fail naming it.
    const dropped = JPEG_HOSTILE_REFUSALS[0]!;
    const withoutDropped = JPEG_HOSTILE_EXAMPLES.filter(
      ([sample]) => sample.hostileRefusal !== dropped,
    );
    const missing = JPEG_HOSTILE_REFUSALS.filter(
      (refusal) => !refusalsOf(withoutDropped).has(refusal),
    );
    expect(missing).toEqual([dropped]);
  });

  describe("strip-but-corrupt drill (PBT-02)", () => {
    let corrupted = 0;
    /**
     * Real sanitizer, then one bit of one entropy-coded scan byte is flipped.
     * The byte is the first at or after the middle of the first scan's entropy
     * data that is not 0xFF, is not preceded by 0xFF and does not become 0xFF
     * when its lowest bit is flipped, so no marker or stuffing byte is created
     * and the corrupted file still parses. Deterministic per sample.
     */
    const corruptingSanitize: typeof sanitizeFile = async (options) => {
      const outcome = await sanitizeFile(options);
      if (!outcome.ok) return outcome;
      const mutated = Buffer.from(await readFile(options.destinationPath));
      const scan = readJpegSegmentRecords(mutated).segments.find(
        (item) => item.marker === 0xda,
      );
      if (scan?.entropy === undefined) return outcome;
      const start = scan.entropy.byteOffset - mutated.byteOffset;
      const end = start + scan.entropy.length;
      for (
        let index = start + Math.floor((end - start) / 2);
        index < end;
        index += 1
      ) {
        const value = mutated[index]!;
        if (value === 0xff || (value ^ 0x01) === 0xff) continue;
        if (index > 0 && mutated[index - 1] === 0xff) continue;
        mutated[index] = value ^ 0x01;
        await writeFile(options.destinationPath, mutated);
        corrupted += 1;
        return outcome;
      }
      return outcome;
    };

    it("strip-but-corrupt sanitizer turns the suite red (PBT-02)", async () => {
      const before = corrupted;
      const result = await fc.check(
        fc.asyncProperty(
          jpegQualificationArbitrary().filter(
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
        jpegQualificationArbitrary().filter(
          (candidate) => candidate.expected === "success",
        ),
        { seed: 460_046, numRuns: 1 },
      );
      await withSampleWorkspace(
        "source.jpg",
        "output.jpg",
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
          const sourceScan = readJpegSegmentRecords(
            sample!.bytes,
          ).segments.find((item) => item.marker === 0xda);
          const outputScan = readJpegSegmentRecords(output).segments.find(
            (item) => item.marker === 0xda,
          );
          expect(outputScan!.entropy!.equals(sourceScan!.entropy!)).toBe(false);
          const handle = await open(destinationPath, "r");
          try {
            await expect(
              parseJpeg(handle, output.length),
            ).resolves.toBeDefined();
          } finally {
            await handle.close();
          }
        },
      );
    });
  });

  describe("negative controls (JPEG)", () => {
    const REPLAY_PARAMS = {
      seed: 460_046,
      numRuns: 200,
      endOnFailure: true,
    } as const;

    const successBytesResult = (destinationPath: string) =>
      ok({
        format: "jpeg" as const,
        destinationPath,
        removedNamespaces: [],
        preserved: {
          orientation: false,
          colorProfile: false,
          timestamps: false,
          resolution: false,
        },
        warnings: [],
        postCommitResidue: { state: "none" as const },
      });

    it("(1) fails a pure-copy sanitizer via the canary absence check", async () => {
      const pureCopySanitize: typeof sanitizeFile = async (options) => {
        await copyFile(options.sourcePath, options.destinationPath);
        return successBytesResult(options.destinationPath);
      };
      const arbitrary = jpegQualificationArbitrary().filter(
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

    it("(2) fails a sanitizer that keeps COM", async () => {
      const comKeepingSanitize: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        const sourceCom = readJpegSegmentRecords(
          await readFile(options.sourcePath),
        ).segments.filter((item) => item.marker === 0xfe);
        await insertSegmentsAfterSoi(
          options.destinationPath,
          sourceCom.map((item) => buildSegmentBytes(item.marker, item.payload)),
        );
        return outcome;
      };
      const arbitrary = jpegQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.planted.some((item) => item.kind === "COM"),
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, comKeepingSanitize);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain("kind COM");
      expect(String(result.errorInstance)).toContain("EXIFCLEANER-CANARY-");
    });

    it("(3) fails a sanitizer that keeps the trailer", async () => {
      // Appends a fixed, non-canary byte run rather than the source's own
      // trailer bytes -- this isolates the trailer-byte-count assertion from
      // the canary-absence check (control (1)'s own proof), so this control
      // fails for a distinct reason.
      const trailerKeepingSanitize: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        const destination = await readFile(options.destinationPath);
        await writeFile(
          options.destinationPath,
          Buffer.concat([destination, Buffer.alloc(8, 0xab)]),
        );
        return outcome;
      };
      const arbitrary = jpegQualificationArbitrary().filter(
        (sample) => sample.expected === "success",
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, trailerKeepingSanitize);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.trailerPresent,
      );
    });

    it("(4) fails a generator with no metadata arm on the floor assertion itself", () => {
      const samples = fc.sample(
        jpegQualificationArbitraryWithoutMetadataArm(),
        {
          seed: 460_046,
          numRuns: 200,
        },
      );
      const counters = createCounters();
      for (const sample of samples)
        countSample(counters, [`arm:${sample.arm}`]);
      expect(() => assertFloors(counters, JPEG_FIXED_SEED_FLOORS)).toThrow(
        /kind:ICC/,
      );
    });

    it("(5) fails a sanitizer that ignores a requested color-profile preservation", async () => {
      const ignoresColorProfile: typeof sanitizeFile = (options) =>
        sanitizeFile({ ...options, preserveColorProfile: false });
      const arbitrary = jpegQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.options.preserveColorProfile &&
          sample.planted.some((item) => item.kind === "ICC"),
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

    it("(6) fails a sanitizer that keeps JFIF when APP14 Adobe is present (D-06)", async () => {
      const keepsJfifWithAdobe: typeof sanitizeFile = async (options) => {
        const outcome = await sanitizeFile(options);
        if (!outcome.ok) return outcome;
        const sourceJfif = readJpegSegmentRecords(
          await readFile(options.sourcePath),
        ).segments.filter(isJfif);
        if (sourceJfif.length === 0) return outcome;
        await insertSegmentsAfterSoi(
          options.destinationPath,
          sourceJfif.map((item) =>
            buildSegmentBytes(item.marker, item.payload),
          ),
        );
        return outcome;
      };
      const arbitrary = jpegQualificationArbitrary().filter(
        (sample) =>
          sample.expected === "success" &&
          sample.plantedJfif &&
          sample.plantedAdobe,
      );
      const result = await fc.check(
        fc.asyncProperty(arbitrary, async (sample) => {
          await checkSample(sample, keepsJfifWithAdobe);
        }),
        REPLAY_PARAMS,
      );
      expect(result.failed).toBe(true);
      expect(String(result.errorInstance)).toContain(
        PRESERVATION_MESSAGES.jfifUnexpected,
      );
    });

    it("(7) fails a sanitizer that writes a different Orientation value", async () => {
      const arbitrary = jpegQualificationArbitrary().filter(
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
            const wrongTiff = createMinimalExif({
              orientation: other,
              ...(sample.options.preserveResolution &&
              sample.plantedResolution !== undefined
                ? {
                    resolution: {
                      x: {
                        numerator: sample.plantedResolution.x,
                        denominator: 1,
                      },
                      y: {
                        numerator: sample.plantedResolution.y,
                        denominator: 1,
                      },
                      unit: sample.plantedResolution.unit,
                    },
                  }
                : {}),
            });
            await replaceFirstPreSosSegment(
              options.destinationPath,
              isExif,
              buildSegmentBytes(
                0xe1,
                Buffer.concat([Buffer.from("Exif\0\0", "ascii"), wrongTiff]),
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
        PRESERVATION_MESSAGES.exifBytes,
      );
    });

    it("(8) fails a sanitizer that admits an SOF9 (arithmetic-frame) hostile file", async () => {
      const admitsCorruptFile: typeof sanitizeFile = async (options) => {
        await copyFile(options.sourcePath, options.destinationPath);
        return successBytesResult(options.destinationPath);
      };
      const arbitrary = fc.constantFrom(
        ...JPEG_HOSTILE_EXAMPLES.map(([sample]) => sample).filter(
          (sample) => sample.hostileRefusal === "arithmetic-frame",
        ),
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
