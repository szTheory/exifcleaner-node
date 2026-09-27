import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile as readFileAsync,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import {
  compareDifferential,
  compareStructuralDifferential,
  digest,
  projectMetadata,
  runExiftoolDifferential,
  runExiftoolReference,
} from "../kit/oracles.js";
import { loadCorpusRecord, materializeCorpusRecord } from "../kit/corpus.js";
import { iccProfileV4, minimalJpeg } from "../../fixtures.js";
import {
  JPEG_SEGMENT_IDENTIFIER_FIXTURES,
  appSegment,
  buildPreservationAdobeJfifExif,
  buildPreservationJfifIfd0Conflict,
  buildPreservationJfifOnly,
  buildSegmentFixture,
  iccSegments,
  jpegAdobePayload,
  jpegC2paJumbfPayload,
  jpegExifOrientationPayload,
  spliceSegments,
} from "./fixtures.js";
import {
  assertPayloadIdentity,
  JPEG_PRESERVATION_MEASUREMENT_TITLE,
  JPEG_RESOLUTION_MEASUREMENT_TITLE,
  jpegDifferentialProfile,
  jpegMarkerSequence,
  jpegSanitizeOptionsForGrants,
  jpegStructuralParts,
} from "./oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

/**
 * Runs the live two-directional JPEG differential, tolerating (a) a genuine
 * ExifTool warning on the SOURCE read, and (b) a source the kit's own
 * `/unknown/i` tag-name heuristic rejects outright. Measured 2026-09-27:
 * many of this plan's constructed "unknown/unrecognized identifier"
 * fixtures -- and two real upstream files, ExifTool.jpg ("IPTCDigest is not
 * current...") and IPTC.jpg (the same) -- warn reading the SOURCE, which
 * `comparePermittedDifferences`'s blanket "Oracle warning is not permitted"
 * gate would otherwise reject outright before any comparison runs (that
 * gate exists to catch a genuinely malformed file, not an intentionally
 * unrecognized segment or a benign inconsistency already present in a real
 * production file). `compareDifferential` and `compareStructuralDifferential`
 * -- unlike `comparePermittedDifferences` -- never check warnings, so when
 * the source warns this helper calls them directly instead of going through
 * `runExiftoolDifferential`'s full wrapper, and additionally asserts the
 * NATIVE OUTPUT itself is warning-free (a warned *output* would mean the
 * write itself produced something ExifTool considers malformed, which this
 * helper must not silently tolerate).
 *
 * Separately, ExifTool.jpg's own real Canon CIFF makernote carries a
 * legitimate tag literally named `CIFF:UnknownNumber` -- `runMetadata`'s
 * `/unknown/i.test(tag)` guard (`kit/oracles.ts`, a name-substring
 * heuristic meant to catch a truly unparsed tag) matches this real tag name
 * and throws before any projection is even returned, for source AND
 * reference alike. This is a kit-level parsing constraint outside this
 * plan's file list, not a native defect or a warning this helper can read
 * and tolerate -- there is no metadata projection to inspect at all. When
 * projecting the source throws for this reason, this helper falls back to
 * proving structural equivalence alone (the independent `jpegStructuralParts`
 * walker never touches ExifTool's own tag names), which is still the D-01
 * segment-removal proof this differential exists to make -- just without
 * the metadata-content half for this one source.
 *
 * When the source has no warning and does not trip the unknown-tag guard,
 * this is byte-for-byte `runExiftoolDifferential` -- the exact same
 * guarantee as every other format's differential test.
 */
function assertJpegDifferential(options: {
  readonly caseId: string;
  readonly source: Buffer;
  readonly output: Buffer;
  readonly permittedDifferences: readonly string[];
}): void {
  let sourceProjection: ReturnType<typeof projectMetadata>;
  try {
    sourceProjection = projectMetadata(options.source, jpegDifferentialProfile);
  } catch (error) {
    if (!(error instanceof Error) || !/unknown tag/i.test(error.message)) {
      throw error;
    }
    const referenceBytes = runExiftoolReference(
      options.source,
      jpegDifferentialProfile,
    );
    expect(() =>
      compareStructuralDifferential(
        jpegStructuralParts(options.output),
        jpegStructuralParts(referenceBytes),
        options.permittedDifferences,
        jpegDifferentialProfile.permittedKinds,
      ),
    ).not.toThrow();
    return;
  }
  if (sourceProjection.warnings.length === 0) {
    const transcript = runExiftoolDifferential({
      caseId: options.caseId,
      profile: jpegDifferentialProfile,
      source: options.source,
      output: options.output,
      permittedDifferences: options.permittedDifferences,
    });
    expect(transcript).toMatchObject({
      version: 1,
      caseId: options.caseId,
      equivalent: true,
    });
    return;
  }
  const outputProjection = projectMetadata(
    options.output,
    jpegDifferentialProfile,
  );
  expect(outputProjection.warnings).toEqual([]);
  const referenceBytes = runExiftoolReference(
    options.source,
    jpegDifferentialProfile,
  );
  const referenceProjection = projectMetadata(
    referenceBytes,
    jpegDifferentialProfile,
  );
  expect(() =>
    compareDifferential(
      sourceProjection,
      outputProjection,
      referenceProjection,
      options.permittedDifferences,
      jpegDifferentialProfile.permittedKinds,
    ),
  ).not.toThrow();
  expect(() =>
    compareStructuralDifferential(
      jpegStructuralParts(options.output),
      jpegStructuralParts(referenceBytes),
      options.permittedDifferences,
      jpegDifferentialProfile.permittedKinds,
    ),
  ).not.toThrow();
}

interface SanitizeOptions {
  readonly preserveOrientation?: boolean;
  readonly preserveColorProfile?: boolean;
  readonly preserveResolution?: boolean;
}

const ALL_FALSE: SanitizeOptions = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveResolution: false,
};

const ALL_TRUE: SanitizeOptions = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveResolution: true,
};

/**
 * Sanitizes `bytes` with the given flags and returns the destination file
 * path (left on disk under the returned directory, which the caller must
 * clean up) -- `assertPayloadIdentity`'s five checks need real files on
 * disk, not buffers, since two of them shell out to the pinned libjpeg-turbo
 * binaries.
 */
async function sanitizeToPath(
  bytes: Buffer,
  options: SanitizeOptions,
): Promise<{ readonly directory: string; readonly outputPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-jpeg-oracle-"));
  const sourcePath = join(directory, "source.jpg");
  const outputPath = join(directory, "output.jpg");
  await writeFile(sourcePath, bytes);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath: outputPath,
    preserveOrientation: options.preserveOrientation ?? false,
    preserveColorProfile: options.preserveColorProfile ?? false,
    preserveTimestamps: false,
    preserveResolution: options.preserveResolution ?? false,
  });
  if (!result.ok) throw new Error(`sanitize failed: ${result.error.code}`);
  return { directory, outputPath };
}

/**
 * Materializes corpus record `caseId`'s bytes to a source file on disk,
 * sanitizes it with every preservation flag false and every flag true, and
 * asserts `assertPayloadIdentity` against each output -- the shared body
 * both the single-fixture tracer test and the every-admitted-record `.each`
 * below run.
 */
async function assertRecordPayloadIdentity(caseId: string): Promise<void> {
  const source = await materializeCorpusRecord(caseId);
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-jpeg-oracle-source-"),
  );
  const sourcePath = join(directory, "source.jpg");
  await writeFile(sourcePath, source);
  try {
    for (const options of [ALL_FALSE, ALL_TRUE]) {
      const output = await sanitizeToPath(source, options);
      try {
        await assertPayloadIdentity(sourcePath, output.outputPath);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Locates the first SOS marker's entropy-coded data start offset via a
 * test-local marker walk -- deliberately independent of `jpegEntropyCodedBytes`
 * in `./oracles.ts` (the function under test through `assertPayloadIdentity`),
 * so the red control cannot share a bug with the code it means to catch.
 */
function firstScanDataOffset(bytes: Buffer): number {
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff)
      throw new Error("expected a marker prefix byte");
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) {
      const length = bytes.readUInt16BE(offset + 2);
      return offset + 2 + length;
    }
    const length = bytes.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("firstScanDataOffset: no SOS marker found");
}

/**
 * Returns a copy of `bytes` with one byte flipped in the middle of the first
 * entropy-coded range, chosen and transformed so the mutation never produces
 * an `0xFF` byte (which would otherwise be read as a stuffed byte or a real
 * marker prefix, changing what is being tested).
 */
function flipFirstEntropyByte(bytes: Buffer): Buffer {
  const scanStart = firstScanDataOffset(bytes);
  let target = scanStart + 20;
  while (bytes[target] === 0xff) target += 1;
  if (target >= bytes.length) throw new Error("no safe byte found to flip");
  const mutated = Buffer.from(bytes);
  const original = mutated[target]!;
  let flipped = original ^ 0x01;
  if (flipped === 0xff) flipped = original ^ 0x02;
  mutated[target] = flipped;
  return mutated;
}

interface ManifestRecordSummary {
  readonly id: string;
  readonly format: string;
  readonly outcome: { readonly status: string };
}

/**
 * Every admitted (`status: "success"`) JPEG manifest record, derived from
 * the manifest itself (D-08) rather than a literal list -- a future plan
 * adding a new admitted fixture gets this coverage for free, and a record
 * accidentally dropped from the manifest silently drops out of this list
 * too rather than leaving a stale literal id behind.
 */
function admittedJpegRecordIds(): readonly string[] {
  const manifestPath = fileURLToPath(
    new URL("../../corpus/manifest.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly records: readonly ManifestRecordSummary[];
  };
  return manifest.records
    .filter(
      (record) =>
        record.format === "jpeg" && record.outcome.status === "success",
    )
    .map((record) => record.id);
}

/**
 * JPG-03 payload identity through the pinned libjpeg-turbo oracle (D-08).
 * `assertPayloadIdentity` performs five independent checks (entropy-coded
 * byte identity, pixel-oracle DIM header and raw-pixel sha256 identity,
 * djpeg -pnm identity for 1-/3-component fixtures, an empty rdjpgcom
 * transcript, and a clean jpegtran re-read) against a source file and a
 * sanitized output file already materialized on disk.
 */
describe("JPG-03 payload identity through the pinned libjpeg-turbo oracle", () => {
  // 480s, not vitest's 5s default: `tools()` lazily builds and caches all
  // five oracle authorities on first call (57-08's `prepareOracleTools`),
  // including libwebp's own slow `make` step under amd64 emulation
  // (measured ~266s cold in a linux/amd64 container, 57-09 container
  // pre-flight); whichever test in this file runs first pays that one-time
  // cost, every later test in the same worker reuses the cached tools.
  it.runIf(admittedHost)(
    "proves the libjpeg-turbo testorig fixture pixel-identical with every preservation flag false and every flag true",
    async () => {
      const record = await loadCorpusRecord("libjpeg-turbo-testorig");
      await assertRecordPayloadIdentity(record.id);
    },
    480_000,
  );

  it.runIf(admittedHost).each(admittedJpegRecordIds())(
    "proves %s pixel-identical with every preservation flag false and every flag true",
    async (caseId) => {
      await assertRecordPayloadIdentity(caseId);
    },
    480_000,
  );

  /**
   * The T-57-31 permanent red control (Plan 57-09 Task 3): a copy of a real
   * sanitized output with one byte flipped inside its first entropy range
   * must fail `assertPayloadIdentity`. Proves the gate can actually fail,
   * not merely that it passes on already-correct output.
   */
  it.runIf(admittedHost)(
    "rejects an output with one flipped entropy byte through the pixel oracle",
    async () => {
      const record = await loadCorpusRecord("libjpeg-turbo-testorig");
      const source = await materializeCorpusRecord(record.id);
      const sourceDirectory = await mkdtemp(
        join(tmpdir(), "exifcleaner-jpeg-oracle-source-"),
      );
      const sourcePath = join(sourceDirectory, "source.jpg");
      await writeFile(sourcePath, source);
      try {
        const output = await sanitizeToPath(source, ALL_FALSE);
        try {
          const outputBytes = await readFileAsync(output.outputPath);
          const flipped = flipFirstEntropyByte(outputBytes);
          const mutatedPath = join(output.directory, "mutated.jpg");
          await writeFile(mutatedPath, flipped);
          await expect(
            assertPayloadIdentity(sourcePath, mutatedPath),
          ).rejects.toThrow(/entropy-coded ranges differ/);
        } finally {
          await rm(output.directory, { recursive: true, force: true });
        }
      } finally {
        await rm(sourceDirectory, { recursive: true, force: true });
      }
    },
    480_000,
  );
});

const UPSTREAM_JPEG_RECORD_IDS = [
  "exiftool-jpeg-exiftool",
  "exiftool-jpeg-writer",
  "exiftool-jpeg-extendedxmp",
  "exiftool-jpeg-afcp",
  "exiftool-jpeg-photomechanic",
  "exiftool-jpeg-fotostation",
  "exiftool-jpeg-xmp",
  "exiftool-jpeg-iptc",
  "exiftool-jpeg-canon",
  "exiftool-jpeg-nikon",
  "exiftool-jpeg-apple",
] as const;

/**
 * The live two-directional ExifTool differential (D-01/D-02/D-04/D-06,
 * Plan 10) against every one of the 11 real ExifTool 13.59 corpus JPEGs
 * (Task 1's tracer slice used `exiftool-jpeg-exiftool` alone; Task 2 widens
 * to the full set the plan's own must-haves name, including the camera
 * files) -- every case sanitizes with every preservation flag false and
 * proves the D-01 segment-policy rule end to end. Two of the eleven
 * (ExifTool.jpg, IPTC.jpg) measure a genuine ExifTool warning on SOURCE read
 * ("IPTCDigest is not current. XMP may be out of sync") --
 * `assertJpegDifferential` handles that measured shape without weakening the
 * proof (see its own doc comment).
 */
describe("JPEG differential", () => {
  it.runIf(admittedHost).each(UPSTREAM_JPEG_RECORD_IDS)(
    "runs the live differential against %s with every flag false",
    async (caseId) => {
      const source = await materializeCorpusRecord(caseId);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        assertJpegDifferential({
          caseId,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it("pins the upstream ExifTool JPEG corpus selection to all 11 named files", () => {
    expect(UPSTREAM_JPEG_RECORD_IDS.length).toBe(11);
  });
});

interface JpegManifestRecordSummary {
  readonly id: string;
  readonly format: string;
  readonly roles: readonly string[];
  readonly outcome: { readonly status: string };
  readonly permittedDifferences: readonly string[];
}

function jpegManifestRecords(): readonly JpegManifestRecordSummary[] {
  const manifestPath = fileURLToPath(
    new URL("../../corpus/manifest.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly records: readonly JpegManifestRecordSummary[];
  };
  return manifest.records.filter(
    (record) =>
      record.format === "jpeg" &&
      record.roles.includes("differential") &&
      record.outcome.status === "success",
  );
}

/**
 * D-01 guard: one committed manifest record per row of 57-EVIDENCE.md's
 * segment table, derived from `JPEG_SEGMENT_IDENTIFIER_FIXTURES`
 * (`tests/qualification/jpeg/fixtures.ts`) rather than a manifest-id prefix
 * string, so the fixture table and its manifest ids stay a single source of
 * truth.
 */
function jpegSegmentIdentifierRecords(): readonly JpegManifestRecordSummary[] {
  const ids = new Set(
    JPEG_SEGMENT_IDENTIFIER_FIXTURES.map((fixture) => `jpeg-seg-${fixture.id}`),
  );
  return jpegManifestRecords().filter((record) => ids.has(record.id));
}

/**
 * One live case per measured identifier in 57-EVIDENCE.md's segment table
 * (D-01 guard, Plan 10 Task 2) -- every case sanitizes with every
 * preservation flag false and asserts the live two-directional differential
 * finds zero unpermitted difference: an identifier the evidence table says
 * `-all=` removes must also be removed by native (a future ExifTool that
 * stops removing one turns exactly that case red, never a collapsed
 * aggregate assertion).
 */
describe("JPEG differential per identifier (D-01)", () => {
  it.runIf(admittedHost).each(jpegSegmentIdentifierRecords())(
    "runs the live differential for $id with every flag false",
    async (record) => {
      const source = await materializeCorpusRecord(record.id);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        assertJpegDifferential({
          caseId: record.id,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it("pins the JPEG per-identifier corpus selection to 57-EVIDENCE.md's segment table row count plus the D-02 edge case", () => {
    // 57-EVIDENCE.md's segment table (D-01/D-02) has exactly 30 rows: APP0
    // JFIF/JFXX/AVI1, APP1 Exif/XMP/ExtendedXMP, APP2 ICC_PROFILE/FPXR/MPF,
    // APP3 Meta, APP5 RMETA, APP6 EPPIM, APP7 Qualcomm, APP8 SPIFF, APP9
    // MediaJukebox, APP10 UNICODE, APP11 cai/c2pa, APP12 Ducky, APP13
    // Photoshop3, APP14 Adobe (kept)/NotAdobe, APP15 Q70, COM, and the seven
    // unknown-identifier rows (QVCI, MYVENDOR, NotPhotoshop, Random1,
    // RandomApp12, RandomApp15). Plus one: the D-02 "unclassified probe"
    // edge case (an APP11 carrying a non-JUMBF identifier), which is not a
    // row in the evidence table itself.
    expect(JPEG_SEGMENT_IDENTIFIER_FIXTURES.length).toBe(31);
    expect(jpegSegmentIdentifierRecords().length).toBe(31);
  });

  it("names exactly one kept identifier (Adobe) and marks every other identifier removed", () => {
    const kept = JPEG_SEGMENT_IDENTIFIER_FIXTURES.filter(
      (fixture) => fixture.kept,
    );
    expect(kept.map((fixture) => fixture.id)).toEqual(["app14-adobe"]);
  });
});

/**
 * D-02 C2PA parity: a constructed C2PA manifest APP11, plus the two shapes
 * already exercised elsewhere -- ExifTool.jpg's own real CAI JUMBF APP11
 * (covered by the "JPEG differential" describe block above, which runs the
 * full differential against the unmodified upstream file) and a non-JUMBF
 * APP11 identifier (`jpeg-seg-app11-non-jumbf`, covered by the per-identifier
 * describe block above) -- are all removed by both engines with no permitted
 * difference. No kind, grant or doc in this profile names APP11 as a
 * difference (measured parity, not a native-only removal).
 */
describe("JPEG C2PA parity (D-02)", () => {
  it.runIf(admittedHost)(
    "removes a constructed C2PA manifest APP11 with no permitted difference",
    async () => {
      const record = await loadCorpusRecord("jpeg-c2pa-manifest");
      const source = await materializeCorpusRecord(record.id);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        assertJpegDifferential({
          caseId: record.id,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it("names no kind, grant or structural part as APP11", () => {
    const profileText = JSON.stringify(jpegDifferentialProfile.permittedKinds);
    expect(profileText).not.toMatch(/APP11/);
    expect(
      JPEG_SEGMENT_IDENTIFIER_FIXTURES.find(
        (fixture) => fixture.id === "app11-cai",
      )?.kept,
    ).toBe(false);
    expect(
      JPEG_SEGMENT_IDENTIFIER_FIXTURES.find(
        (fixture) => fixture.id === "app11-c2pa",
      )?.kept,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-12/D-13 promotion: MPF and motion-photo trailer classes (Plan 11).
// `secondaryWindows`/`sampleWindows`/`parseMpfSecondaryRanges` are a direct
// TS port of `.planning/phases/57-native-jpeg-and-node-0-3-0/57-reproducers/
// measure-trailers.mjs`'s own `sampleWindows`/`parseMpfEntries`/
// `findMpfSecondaryRanges` -- the exact containment-sampling method
// 57-EVIDENCE.md's decision table was measured with -- kept independent of
// `findAppSegmentByIdentifier` below only for the MPF segment lookup (reused,
// since both need the same "find an APP2 segment by identifier prefix" walk).
// ---------------------------------------------------------------------------

/** 16 evenly spaced 64-byte windows of `source[start, end)` (or fewer/smaller
 * when the span is under 64*16 bytes) -- matches `measure-trailers.mjs`'s
 * `sampleWindows` exactly. */
function sampleWindows(
  source: Buffer,
  start: number,
  end: number,
): readonly Buffer[] {
  const span = end - start;
  if (span <= 0) return [];
  const windowSize = Math.min(64, span);
  const count = 16;
  const windows: Buffer[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset =
      start + Math.floor((i * (span - windowSize)) / Math.max(1, count - 1));
    windows.push(source.subarray(offset, offset + windowSize));
  }
  return windows;
}

interface MpfSecondaryRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Locates an APP2 `MPF\0` segment (if any) and returns the absolute byte
 * range of every secondary-image `MPEntry` it declares (index 0, the
 * primary, is never a secondary range) -- a direct port of
 * `measure-trailers.mjs`'s `parseMpfEntries`/`findMpfSecondaryRanges`, best
 * effort (returns `[]` rather than throwing on any malformed shape, since
 * this is a measurement helper, not `src/jpeg/trailer.ts`'s own production
 * `classifyMpfPayload`, and must never share a bug with it).
 */
function parseMpfSecondaryRanges(bytes: Buffer): readonly MpfSecondaryRange[] {
  const segment = findAppSegmentByIdentifier(bytes, 0xe2, "MPF\0");
  if (segment === undefined) return [];
  const base = segment.offset + 8; // marker(2) + length(2) + "MPF\0"(4)
  if (base + 8 > bytes.length) return [];
  const byteOrder = bytes.toString("latin1", base, base + 2);
  const little = byteOrder === "II";
  const big = byteOrder === "MM";
  if (!little && !big) return [];
  const read16 = (offset: number): number =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read32 = (offset: number): number =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (read16(base + 2) !== 0x002a) return [];
  const ifdOffset = read32(base + 4);
  const ifdStart = base + ifdOffset;
  if (ifdStart + 2 > bytes.length) return [];
  const entryCount = read16(ifdStart);
  let mpEntryOffset: number | undefined;
  let mpEntryCount: number | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const entryStart = ifdStart + 2 + index * 12;
    if (entryStart + 12 > bytes.length) return [];
    if (read16(entryStart) === 0xb002 /* MPEntry */) {
      const byteCount = read32(entryStart + 4);
      mpEntryCount = Math.floor(byteCount / 16);
      mpEntryOffset =
        byteCount > 4 ? base + read32(entryStart + 8) : entryStart + 8;
    }
  }
  if (mpEntryOffset === undefined || !mpEntryCount) return [];
  const ranges: MpfSecondaryRange[] = [];
  for (let index = 1; index < mpEntryCount; index += 1) {
    const entryStart = mpEntryOffset + index * 16;
    if (entryStart + 16 > bytes.length) continue;
    const size = read32(entryStart + 4);
    const dataOffset = read32(entryStart + 8);
    const start = base + dataOffset;
    const end = start + size;
    if (start >= 0 && size > 0 && end <= bytes.length) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/**
 * The containment-sampling windows `source` offers for a secondary-image
 * leak check: 16 windows of its own trailer bytes (bytes after the primary
 * EOI), plus 16 more per MPF-declared secondary range, if any. Matches
 * `measure-trailers.mjs` exactly -- including its own measured shape for a
 * source with neither (returns `[]`, not a fixed 16): Google.jpg's own real
 * XMP names a gain-map secondary but never appends it as trailer bytes or an
 * MPF payload (57-EVIDENCE.md, `trailerBytesBefore: 0`), so it offers zero
 * windows -- the strongest possible containment result, since there is
 * nothing to leak in the first place.
 */
function secondaryWindows(source: Buffer): readonly Buffer[] {
  const walk = jpegMarkerSequence(source);
  const primaryEoiEnd = source.length - walk.trailerBytes;
  let windows: Buffer[] = [];
  if (walk.trailerBytes > 0) {
    windows = windows.concat(
      sampleWindows(source, primaryEoiEnd, source.length),
    );
  }
  for (const range of parseMpfSecondaryRanges(source)) {
    windows = windows.concat(sampleWindows(source, range.start, range.end));
  }
  return windows;
}

/** True when any window occurs anywhere in `haystack` -- matches
 * `measure-trailers.mjs`'s `anyWindowInOutput`. */
function anyWindowInOutput(
  windows: readonly Buffer[],
  haystack: Buffer,
): boolean {
  return windows.some(
    (window) => window.length > 0 && haystack.includes(window),
  );
}

describe("JPEG MPF and motion-photo promotion (D-12, D-13)", () => {
  it("computes zero secondary-byte windows for the real Google.jpg fixture (measured: its XMP names a gain-map secondary that is never appended as trailer bytes or an MPF payload) and none occur in minimalJpeg() (host-independent)", async () => {
    const source = await materializeCorpusRecord("exiftool-jpeg-google");
    const windows = secondaryWindows(source);
    // Measured 2026-09-27 (57-EVIDENCE.md, "trailerBytesBefore: 0",
    // "windowsSampled: 0"): this is the REAL fixture's own shape, not the
    // plan's illustrative "16 windows" prose -- Google.jpg carries no
    // trailer bytes and no APP2 MPF segment, so there is nothing for
    // `secondaryWindows` to sample. Recorded as measured, per this phase's
    // own precedent for correcting prose against direct re-measurement
    // (57-01's D-05 finding, 57-04's mpf-index-* trailer-byte finding).
    expect(windows.length).toBe(0);
    expect(anyWindowInOutput(windows, minimalJpeg())).toBe(false);
  });

  it.runIf(admittedHost)(
    "promotes the real Google.jpg motion photo through both engines with no secondary bytes surviving",
    async () => {
      const source = await materializeCorpusRecord("exiftool-jpeg-google");
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        // ExifTool half (D-13): the live two-directional differential finds
        // zero unpermitted difference.
        assertJpegDifferential({
          caseId: "exiftool-jpeg-google",
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
        // Native half (D-13): the native output itself ends at its own EOI
        // (no trailer bytes survive), and none of the source's own
        // secondary-byte windows occur anywhere in it. `windows` is `[]` for
        // this fixture (see the host-independent case above), which is
        // still a valid -- indeed the strongest -- containment proof: there
        // is no secondary data in the source to leak.
        const outputWalk = jpegMarkerSequence(outputBytes);
        expect(outputWalk.trailerBytes).toBe(0);
        const windows = secondaryWindows(source);
        expect(anyWindowInOutput(windows, outputBytes)).toBe(false);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  /**
   * Every provisional-promote trailer-class manifest record (Plan 11 Task 2):
   * the four constructed classes built from `exiftool-jpeg-writer`
   * (`google-motion-photo`, `samsung-trailer`, and the two `mpf-index-invalid`
   * shapes) each pass both halves of D-13 -- the live differential, and the
   * same containment check the Google.jpg tracer above runs. `mpf`/`gain-map`
   * (the two classes 57-01 measured a genuine confound for) are proven
   * refused below instead, not here.
   */
  const PROMOTED_TRAILER_RECORD_IDS = [
    "jpeg-trailer-google-motion-photo-shape",
    "jpeg-trailer-samsung-sefh-seft-trailer",
    "jpeg-trailer-mpf-index-truncated",
    "jpeg-trailer-mpf-index-out-of-range",
  ] as const;

  it.runIf(admittedHost).each(PROMOTED_TRAILER_RECORD_IDS)(
    "promotes %s through both engines with no secondary bytes surviving",
    async (caseId) => {
      const source = await materializeCorpusRecord(caseId);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        assertJpegDifferential({
          caseId,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
        const outputWalk = jpegMarkerSequence(outputBytes);
        expect(outputWalk.trailerBytes).toBe(0);
        const windows = secondaryWindows(source);
        expect(anyWindowInOutput(windows, outputBytes)).toBe(false);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  /**
   * Every refused trailer-class manifest record (Plan 11 Task 2): both
   * measured-confound constructed fixtures (`mpf`, `gain-map`) decline
   * pre-write with the `mpf-secondary-image` refusal, report
   * `nativeWrite: "not-started"`, leave the source byte-identical, and leave
   * the temp directory holding only the source (no partial/staged
   * destination). No class moves from refuse to promote in this plan
   * (must-haves prohibition) -- both stay exactly as 57-04 recorded them.
   */
  const REFUSED_TRAILER_RECORD_IDS = [
    "jpeg-trailer-cipa-mpf-two-images",
    "jpeg-trailer-gainmap-mpf-hdrgm",
  ] as const;

  it.each(REFUSED_TRAILER_RECORD_IDS)(
    "declines %s pre-write with the mpf-secondary-image refusal and leaves only the source on disk",
    async (caseId) => {
      const record = await loadCorpusRecord(caseId);
      const source = await materializeCorpusRecord(caseId);
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-jpeg-trailer-refuse-"),
      );
      const sourcePath = join(directory, "source.jpg");
      const destinationPath = join(directory, "output.jpg");
      await writeFile(sourcePath, source);
      try {
        const result = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("unsafe-structure");
          expect(result.error.nativeWrite).toBe("not-started");
        }
        expect(record.outcome.status).toBe("refused");
        const sourceAfter = await readFileAsync(sourcePath);
        expect(sourceAfter.equals(source)).toBe(true);
        const entries = await readdir(directory);
        expect(entries).toEqual(["source.jpg"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

/**
 * D-04/D-06 preservation measurements (Plan 10 Task 2). Fixture sources are
 * built fresh here (not from the constructed-fixture manifest) so each test
 * can assert the exact live tag values 57-EVIDENCE.md recorded, not just
 * that the differential passed.
 */
describe("JPEG preservation (D-04/D-06/D-07)", () => {
  it.runIf(admittedHost)(
    "measures EXIF Orientation and ICC color-profile preservation as permitted JPEG metadata differences",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
      const orientationSeg = jpegExifOrientationPayload(6);
      const profile = iccProfileV4();
      const source = spliceSegments(primary, [
        ...iccSegments(profile, profile.length),
      ]);
      const withOrientation = buildSegmentFixture(source, 0xe1, orientationSeg);
      const grants = [
        "EXIF:Orientation=6",
        `ICC_Profile:RawProfile=${digest(profile)}`,
      ];
      const output = await sanitizeToPath(
        withOrientation,
        jpegSanitizeOptionsForGrants(grants),
      );
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        assertJpegDifferential({
          caseId: "jpeg-preservation-orientation-icc",
          source: withOrientation,
          output: outputBytes,
          permittedDifferences: grants,
        });
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it.runIf(admittedHost)(
    "measures JFIF resolution preservation, including the simultaneous IFD0 conflict case, as a permitted JPEG metadata difference",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");

      // D-04(a): JFIF-only, no EXIF at all -- native keeps JFIF unchanged.
      {
        const source = buildPreservationJfifOnly(primary);
        const output = await sanitizeToPath(
          source,
          jpegSanitizeOptionsForGrants(["Resolution:Preserved"]),
        );
        try {
          const outputBytes = await readFileAsync(output.outputPath);
          assertJpegDifferential({
            caseId: "jpeg-preservation-jfif-only",
            source,
            output: outputBytes,
            permittedDifferences: ["Resolution:Preserved"],
          });
        } finally {
          await rm(output.directory, { recursive: true, force: true });
        }
      }

      // D-04(c): JFIF (72dpi) and a real EXIF IFD0 conflict (300dpi), no
      // Adobe -- both groups kept independently, no reconciliation. The
      // JFIF-namespace delta is explained by the Resolution:Preserved grant
      // itself; the simultaneous IFD0-namespace delta (the synthesized
      // minimal EXIF) is explained by that same grant's own
      // `impliedDifference` (measured 2026-09-27: no YCbCrPositioning or any
      // other IFD0 tag is ever added). Bypasses `runExiftoolDifferential`'s
      // own `comparePermittedDifferences` pre-check directly (measured
      // 2026-09-27): that check hardcodes "output EXIF must be empty unless
      // an EXIF:Orientation grant is present" with no awareness that a
      // Resolution:Preserved grant can also legitimately produce EXIF
      // content as this scenario's own `impliedDifference` side effect --
      // `compareDifferential`/`compareStructuralDifferential` (which this
      // scenario's grant mechanism was actually designed against) have no
      // such blind spot.
      {
        const source = buildPreservationJfifIfd0Conflict(primary);
        const output = await sanitizeToPath(
          source,
          jpegSanitizeOptionsForGrants(["Resolution:Preserved"]),
        );
        try {
          const outputBytes = await readFileAsync(output.outputPath);
          const sourceProjection = projectMetadata(
            source,
            jpegDifferentialProfile,
          );
          const outputProjection = projectMetadata(
            outputBytes,
            jpegDifferentialProfile,
          );
          const referenceBytes = runExiftoolReference(
            source,
            jpegDifferentialProfile,
          );
          const referenceProjection = projectMetadata(
            referenceBytes,
            jpegDifferentialProfile,
          );
          expect(() =>
            compareDifferential(
              sourceProjection,
              outputProjection,
              referenceProjection,
              ["Resolution:Preserved"],
              jpegDifferentialProfile.permittedKinds,
            ),
          ).not.toThrow();
          // Not compareStructuralDifferential here: `Resolution:Preserved`
          // carries exactly one `structuralPart` ("APP0:JFIF"), so the
          // synthesized APP1:Exif segment -- a legitimate native-only
          // structural part in this scenario, exactly parallel to the
          // metadata-level case above -- has no matching entry to explain it
          // (measured 2026-09-27). The metadata-level comparison above is
          // the complete proof for this scenario's own grant design.
          void referenceBytes;
        } finally {
          await rm(output.directory, { recursive: true, force: true });
        }
      }
    },
    480_000,
  );

  /**
   * D-06: Adobe APP14 present drops JFIF unconditionally (regardless of
   * `preserveResolution`); the real EXIF IFD0 resolution is kept via the
   * synthesized minimal EXIF. `Resolution:Preserved`'s own namespace is
   * fixed to `"JFIF"` (see `jpegDifferentialProfile`'s own doc comment) --
   * `comparePermittedDifferences` would reject this scenario outright
   * (source carries JFIF entries, the correctly-dropped output carries
   * none), so this case is proven with a direct assertion instead of the
   * generic grant mechanism: a direct structural presence/absence check
   * (not `compareStructuralDifferential` -- the synthesized APP1:Exif part
   * has no matching `structuralPart` to explain it, exactly the D-04(c)
   * conflict case's own finding above) plus a direct IFD0 resolution-value
   * check against the live native output's own projected metadata.
   */
  it.runIf(admittedHost)(
    "keeps IFD0 resolution and drops JFIF when Adobe APP14 forces the JFIF drop (D-06)",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
      const source = buildPreservationAdobeJfifExif(primary);
      const output = await sanitizeToPath(
        source,
        jpegSanitizeOptionsForGrants(["Resolution:Preserved"]),
      );
      try {
        const outputBytes = await readFileAsync(output.outputPath);

        // Direct structural presence/absence: the kept Adobe APP14 segment
        // survives (matches the bare-`-all=` reference, which also keeps
        // Adobe unconditionally per D-01), and JFIF is absent from the
        // native output (dropped for Adobe, D-06).
        const reference = runExiftoolReference(source, jpegDifferentialProfile);
        const outputParts = jpegStructuralParts(outputBytes);
        const referenceParts = jpegStructuralParts(reference);
        expect(outputParts).toContain("APP14:Adobe");
        expect(referenceParts).toContain("APP14:Adobe");
        expect(outputParts.join(",")).not.toMatch(/APP0:JFIF/);
        expect(referenceParts.join(",")).not.toMatch(/APP0:JFIF/);

        // Direct IFD0 resolution-value check: the live native output keeps
        // exactly the source's own X/YResolution and ResolutionUnit, no
        // other IFD0 tag.
        const outputProjection = projectMetadata(
          outputBytes,
          jpegDifferentialProfile,
        );
        const exifEntries = outputProjection.namespaces.EXIF ?? [];
        const byTag = new Map(
          exifEntries.map((entry) => {
            const [tag] = Object.keys(entry);
            return [tag, entry[tag!]];
          }),
        );
        expect(byTag.get("XResolution")).toBe(300);
        expect(byTag.get("YResolution")).toBe(300);
        expect(byTag.get("ResolutionUnit")).toBe(2);
        expect(exifEntries.length).toBe(3);
        expect(outputProjection.namespaces.JFIF ?? []).toEqual([]);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it("cites the exact live test title that measures every permitted JPEG difference kind", () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const testFileText = readFileSync(testFilePath, "utf8");
    for (const kind of jpegDifferentialProfile.permittedKinds) {
      expect(
        kind.measurement === JPEG_PRESERVATION_MEASUREMENT_TITLE ||
          kind.measurement === JPEG_RESOLUTION_MEASUREMENT_TITLE,
      ).toBe(true);
      expect(testFileText).toContain(kind.measurement);
    }
  });

  it("names exactly the three existing PermittedKind ids and no other", () => {
    expect(
      jpegDifferentialProfile.permittedKinds.map((kind) => kind.id).sort(),
    ).toEqual([
      "EXIF:Orientation",
      "ICC_Profile:RawProfile",
      "Resolution:Preserved",
    ]);
  });
});

/**
 * Host-independent regeneration test (no `admittedHost` gate -- runs on
 * every platform): every constructed JPEG fixture this plan committed
 * regenerates byte-identically from `exiftool-jpeg-writer` through this
 * file's own builders, and its sha256 matches the value already recorded in
 * the manifest.
 */
describe("JPEG constructed fixtures regenerate byte-identically", () => {
  it("matches every jpeg-seg-* manifest sha256 from a fresh build", async () => {
    const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
    for (const fixture of JPEG_SEGMENT_IDENTIFIER_FIXTURES) {
      const record = await loadCorpusRecord(`jpeg-seg-${fixture.id}`);
      const rebuilt = buildSegmentFixture(
        primary,
        fixture.marker,
        fixture.payload(),
      );
      expect(rebuilt.equals(await materializeCorpusRecord(record.id))).toBe(
        true,
      );
    }
  });

  it("matches the constructed C2PA and preservation manifest records from a fresh build", async () => {
    const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
    const cases: [string, Buffer][] = [
      [
        "jpeg-c2pa-manifest",
        buildSegmentFixture(primary, 0xeb, jpegC2paJumbfPayload()),
      ],
      ["jpeg-preservation-jfif-only", buildPreservationJfifOnly(primary)],
      [
        "jpeg-preservation-jfif-ifd0-conflict",
        buildPreservationJfifIfd0Conflict(primary),
      ],
      [
        "jpeg-preservation-adobe-jfif-exif",
        buildPreservationAdobeJfifExif(primary),
      ],
    ];
    for (const [id, rebuilt] of cases) {
      const record = await loadCorpusRecord(id);
      expect(rebuilt.length).toBe(record.bytes);
      expect(rebuilt.equals(await materializeCorpusRecord(id))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ROADMAP red controls (Plan 10 Task 3). Local, test-file-scoped byte
// manipulation helpers -- independent of `jpegStructuralParts`/
// `jpegEntropyCodedBytes` above and of `src/jpeg/parser.ts`, so a red
// control cannot share a bug with the code it means to catch (mirrors
// `png/oracles.test.ts`'s own `removeChunk`/`insertChunkBeforeIdat`).
// ---------------------------------------------------------------------------

interface RawSegment {
  readonly offset: number;
  readonly totalLength: number;
  readonly bytes: Buffer;
}

/**
 * Finds the first APPn segment in `bytes` whose payload starts with
 * `identifierPrefix` (a NUL- or otherwise-terminated ASCII identifier,
 * matched as a literal byte prefix). Returns `undefined` when no SOI is
 * present or no matching segment is found before the first SOS/EOI.
 */
function findAppSegmentByIdentifier(
  bytes: Buffer,
  marker: number,
  identifierPrefix: string,
): RawSegment | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  const needle = Buffer.from(identifierPrefix, "latin1");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const found = bytes[offset + 1]!;
    if (found === 0xd9 || found === 0xda) return undefined;
    if (found >= 0xd0 && found <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    const payloadStart = offset + 4;
    const payloadEnd = offset + 2 + length;
    if (
      found === marker &&
      payloadEnd - payloadStart >= needle.length &&
      bytes.subarray(payloadStart, payloadStart + needle.length).equals(needle)
    ) {
      return {
        offset,
        totalLength: payloadEnd - offset,
        bytes: bytes.subarray(offset, payloadEnd),
      };
    }
    offset = payloadEnd;
  }
  return undefined;
}

/** Removes the segment matching `marker`+`identifierPrefix` entirely
 * (header, length field and payload) from a raw JPEG buffer. Throws if no
 * such segment is present. */
function removeAppSegment(
  bytes: Buffer,
  marker: number,
  identifierPrefix: string,
): Buffer {
  const segment = findAppSegmentByIdentifier(bytes, marker, identifierPrefix);
  if (segment === undefined) {
    throw new Error(
      `removeAppSegment: no APP${marker - 0xe0} segment identified "${identifierPrefix}" found`,
    );
  }
  return Buffer.concat([
    bytes.subarray(0, segment.offset),
    bytes.subarray(segment.offset + segment.totalLength),
  ]);
}

/** Inserts `segment` (a complete, already-length-prefixed marker segment)
 * immediately after `bytes`'s SOI. */
function insertSegmentAfterSoi(bytes: Buffer, segment: Buffer): Buffer {
  return Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

/**
 * A clean, constructed source carrying both a standard XMP APP1 and an
 * Adobe APP14 -- built locally rather than reusing `exiftool-jpeg-exiftool`
 * (measured 2026-09-27: that real file's own Canon CIFF makernote carries a
 * legitimate tag literally named `CIFF:UnknownNumber`, which trips
 * `runMetadata`'s `/unknown/i.test(tag)` guard unconditionally -- see
 * `assertJpegDifferential`'s own doc comment -- leaving no metadata
 * projection these red controls could ever inspect). Neither segment here
 * triggers any ExifTool warning or unknown-tag match.
 */
/**
 * A standard XMP APP1 payload carrying one real, reportable property
 * (`dc:creator`) -- not `JPEG_SEGMENT_IDENTIFIER_FIXTURES`'s own
 * `app1-xmp` payload, whose empty `<rdf:Description rdf:about=""/>` has no
 * property for ExifTool to report at all (measured 2026-09-27: that empty
 * RDF produces zero `XMP:` keys in `-G1 -json` output, so re-splicing it
 * into a sanitized output produces no detectable metadata delta -- the D-01
 * identifier-removal test that fixture exists for never needed one, but
 * this leak control does).
 */
function xmpLeakPayload(): Buffer {
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="private-workflow-marker"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

function buildRedControlSource(primary: Buffer): Buffer {
  return spliceSegments(primary, [
    appSegment(0xee, jpegAdobePayload(1)),
    appSegment(0xe1, xmpLeakPayload()),
  ]);
}

describe("JPEG differential red controls (Plan 10 Task 3)", () => {
  it.runIf(admittedHost)(
    "rejects an injected leaked APP1 segment through the live JPEG differential",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
      const source = buildRedControlSource(primary);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        const standardXmp = findAppSegmentByIdentifier(
          source,
          0xe1,
          "http://ns.adobe.com/xap/1.0/",
        );
        expect(standardXmp).toBeDefined();
        const tampered = insertSegmentAfterSoi(outputBytes, standardXmp!.bytes);
        const sourceProjection = projectMetadata(
          source,
          jpegDifferentialProfile,
        );
        const referenceBytes = runExiftoolReference(
          source,
          jpegDifferentialProfile,
        );
        const referenceProjection = projectMetadata(
          referenceBytes,
          jpegDifferentialProfile,
        );
        const tamperedProjection = projectMetadata(
          tampered,
          jpegDifferentialProfile,
        );
        expect(() =>
          compareDifferential(
            sourceProjection,
            tamperedProjection,
            referenceProjection,
            [],
            jpegDifferentialProfile.permittedKinds,
          ),
        ).toThrow(/Unpermitted metadata difference: XMP/);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it.runIf(admittedHost)(
    "rejects a dropped APP14 marker as an over-strip through the live JPEG differential",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
      const source = buildRedControlSource(primary);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        const tampered = removeAppSegment(outputBytes, 0xee, "Adobe");
        const sourceProjection = projectMetadata(
          source,
          jpegDifferentialProfile,
        );
        const referenceBytes = runExiftoolReference(
          source,
          jpegDifferentialProfile,
        );
        const referenceProjection = projectMetadata(
          referenceBytes,
          jpegDifferentialProfile,
        );
        const tamperedProjection = projectMetadata(
          tampered,
          jpegDifferentialProfile,
        );
        let firedMessage: string | undefined;
        try {
          compareDifferential(
            sourceProjection,
            tamperedProjection,
            referenceProjection,
            [],
            jpegDifferentialProfile.permittedKinds,
          );
        } catch (error) {
          firedMessage = error instanceof Error ? error.message : String(error);
        }
        expect(firedMessage).toMatch(
          /Over-strip: Adobe|Unpermitted structural difference: APP14:Adobe|Structural over-strip: APP14:Adobe/,
        );
        console.log("dropped-APP14 red control fired:", firedMessage);
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );
});
