import { readFileSync } from "node:fs";
import {
  mkdtemp,
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
  compareStructuralDifferential,
  digest,
  projectMetadata,
  runExiftoolDifferential,
  runExiftoolReference,
} from "../kit/oracles.js";
import { loadCorpusRecord, materializeCorpusRecord } from "../kit/corpus.js";
import { iccProfileV4 } from "../../fixtures.js";
import {
  JPEG_SEGMENT_IDENTIFIER_FIXTURES,
  buildPreservationAdobeJfifExif,
  buildPreservationJfifIfd0Conflict,
  buildPreservationJfifOnly,
  buildSegmentFixture,
  iccSegments,
  jpegC2paJumbfPayload,
  jpegExifOrientationPayload,
  spliceSegments,
} from "./fixtures.js";
import {
  assertPayloadIdentity,
  JPEG_PRESERVATION_MEASUREMENT_TITLE,
  JPEG_RESOLUTION_MEASUREMENT_TITLE,
  jpegDifferentialProfile,
  jpegSanitizeOptionsForGrants,
  jpegStructuralParts,
} from "./oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

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

/**
 * The live two-directional ExifTool differential (D-01/D-02/D-04/D-06,
 * Plan 10). Task 1's tracer slice: ExifTool's own reference JPEG through the
 * full differential with every preservation flag false -- proves the D-01
 * segment-policy rule (every identifier removed except the kept APP14
 * Adobe) end to end before Task 2 adds one case per measured identifier.
 */
describe("JPEG differential", () => {
  it.runIf(admittedHost)(
    "runs the live differential against ExifTool's own reference image with every flag false",
    async () => {
      const record = await loadCorpusRecord("exiftool-jpeg-exiftool");
      const source = await materializeCorpusRecord(record.id);
      const output = await sanitizeToPath(source, ALL_FALSE);
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        const transcript = runExiftoolDifferential({
          caseId: record.id,
          profile: jpegDifferentialProfile,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
        expect(transcript).toMatchObject({
          version: 1,
          caseId: record.id,
          equivalent: true,
        });
      } finally {
        await rm(output.directory, { recursive: true, force: true });
      }
    },
    480_000,
  );
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
        const transcript = runExiftoolDifferential({
          caseId: record.id,
          profile: jpegDifferentialProfile,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
        expect(transcript).toMatchObject({
          version: 1,
          caseId: record.id,
          equivalent: true,
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
        const transcript = runExiftoolDifferential({
          caseId: record.id,
          profile: jpegDifferentialProfile,
          source,
          output: outputBytes,
          permittedDifferences: [],
        });
        expect(transcript).toMatchObject({ version: 1, equivalent: true });
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
      const output = await sanitizeToPath(withOrientation, {
        preserveOrientation: true,
        preserveColorProfile: true,
        preserveResolution: false,
      });
      try {
        const outputBytes = await readFileAsync(output.outputPath);
        const transcript = runExiftoolDifferential({
          caseId: "jpeg-preservation-orientation-icc",
          profile: jpegDifferentialProfile,
          source: withOrientation,
          output: outputBytes,
          permittedDifferences: [
            "EXIF:Orientation=6",
            `ICC_Profile:RawProfile=${digest(profile)}`,
          ],
        });
        expect(transcript).toMatchObject({ version: 1, equivalent: true });
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
        const output = await sanitizeToPath(source, {
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveResolution: true,
        });
        try {
          const outputBytes = await readFileAsync(output.outputPath);
          const transcript = runExiftoolDifferential({
            caseId: "jpeg-preservation-jfif-only",
            profile: jpegDifferentialProfile,
            source,
            output: outputBytes,
            permittedDifferences: ["Resolution:Preserved"],
          });
          expect(transcript).toMatchObject({ version: 1, equivalent: true });
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
      // other IFD0 tag is ever added).
      {
        const source = buildPreservationJfifIfd0Conflict(primary);
        const output = await sanitizeToPath(source, {
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveResolution: true,
        });
        try {
          const outputBytes = await readFileAsync(output.outputPath);
          const transcript = runExiftoolDifferential({
            caseId: "jpeg-preservation-jfif-ifd0-conflict",
            profile: jpegDifferentialProfile,
            source,
            output: outputBytes,
            permittedDifferences: ["Resolution:Preserved"],
          });
          expect(transcript).toMatchObject({ version: 1, equivalent: true });
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
   * generic grant mechanism: structural parity for the kept APP14 segment,
   * and a direct IFD0 resolution-value check against the live native
   * output's own projected metadata.
   */
  it.runIf(admittedHost)(
    "keeps IFD0 resolution and drops JFIF when Adobe APP14 forces the JFIF drop (D-06)",
    async () => {
      const primary = await materializeCorpusRecord("exiftool-jpeg-writer");
      const source = buildPreservationAdobeJfifExif(primary);
      const output = await sanitizeToPath(source, {
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: true,
      });
      try {
        const outputBytes = await readFileAsync(output.outputPath);

        // Structural parity: both native and the bare-`-all=` reference keep
        // exactly the Adobe APP14 segment among the source's three segments;
        // JFIF is absent from both.
        const reference = runExiftoolReference(source, jpegDifferentialProfile);
        expect(() =>
          compareStructuralDifferential(
            jpegStructuralParts(outputBytes),
            jpegStructuralParts(reference),
            [],
            jpegDifferentialProfile.permittedKinds,
          ),
        ).not.toThrow();
        expect(jpegStructuralParts(outputBytes)).toContain("APP14:Adobe");
        expect(jpegStructuralParts(outputBytes).join(",")).not.toMatch(
          /APP0:JFIF/,
        );

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
