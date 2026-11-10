import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../src/index.js";
import { parseWebp } from "../../../src/webp/riff.js";
import {
  anim,
  animationFrame,
  iccProfile,
  metadataWebp,
  readChunks,
  vp8x,
  webp,
} from "../../fixtures.js";
import {
  comparePermittedDifferences,
  compareDifferential,
  digest,
  projectMetadata,
  runExiftoolReference,
  type MetadataProjection,
} from "../kit/oracles.js";
import { materializeCorpusRecord } from "../kit/corpus.js";
import {
  materializeMutationCase,
  webpWithExifResolution,
} from "./generators.js";
import {
  compareWebpResolutionPreservation,
  normalizeWebpInfo,
  runLibwebpOracle,
  webpDifferentialProfile,
  type WebpResolutionExpectation,
} from "./oracles.js";
import { runExiftoolDifferential } from "../kit/oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

interface SanitizeOptions {
  readonly preserveOrientation?: boolean;
  readonly preserveColorProfile?: boolean;
  readonly preserveResolution?: boolean;
}

async function sanitize(
  bytes: Buffer,
  options: SanitizeOptions = {},
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-oracle-test-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "output.webp");
  try {
    await writeFile(sourcePath, bytes);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: options.preserveOrientation ?? false,
      preserveColorProfile: options.preserveColorProfile ?? false,
      preserveTimestamps: false,
      preserveResolution: options.preserveResolution ?? false,
    });
    if (!result.ok) throw new Error(`sanitize failed: ${result.error.code}`);
    return await readFile(destinationPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * WR-07 (D-16, D-10): derives sanitize preservation options from a corpus record's
 * `permittedDifferences` grants, so granting an existing kind to one more fixture is a
 * one-line manifest data change (docs/format-admission.md) rather than a hand-wired
 * options object per record.
 */
function sanitizeOptionsForGrants(grants: readonly string[]): SanitizeOptions {
  return {
    preserveOrientation: grants.some((grant) =>
      grant.startsWith("EXIF:Orientation="),
    ),
    preserveColorProfile: grants.some((grant) =>
      grant.startsWith("ICC_Profile:RawProfile="),
    ),
  };
}

interface ManifestRecord {
  readonly id: string;
  readonly format: string;
  readonly roles: readonly string[];
  readonly outcome: { readonly status: string };
  readonly permittedDifferences: readonly string[];
}

function differentialSuccessRecords(): readonly ManifestRecord[] {
  const manifestPath = fileURLToPath(
    new URL("../../corpus/manifest.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly records: readonly ManifestRecord[];
  };
  return manifest.records.filter(
    (record) =>
      record.format === "webp" &&
      record.roles.includes("differential") &&
      record.outcome.status === "success",
  );
}

describe("pinned external WebP oracles", () => {
  it("normalizes bounded webpinfo structure without paths or prose", () => {
    expect(
      normalizeWebpInfo(`File: /private/source.webp
RIFF HEADER:
  File size:   4880
Chunk VP8  at offset     12, length   4868
  Width: 128
  Height: 128
  Alpha: 0
  Animation: 0
  Format: Lossy (1)
No error detected.
`),
    ).toEqual({
      status: "success",
      warnings: [],
      width: 128,
      height: 128,
      alpha: false,
      animation: false,
      chunks: [
        {
          fourCc: "VP8 ",
          headerOffset: 12,
          payloadBytes: 4_860,
          spanBytes: 4_868,
        },
      ],
    });
  });

  it("keeps the metadata-difference contract closed", () => {
    expect(
      comparePermittedDifferences(
        { warnings: [], namespaces: { EXIF: [], XMP: [], ICC_Profile: [] } },
        { warnings: [], namespaces: { EXIF: [], XMP: [], ICC_Profile: [] } },
        [],
      ),
    ).toEqual([]);
    expect(() =>
      comparePermittedDifferences(
        { warnings: [], namespaces: { EXIF: [], XMP: [], ICC_Profile: [] } },
        {
          warnings: [],
          namespaces: { EXIF: [{ MysteryTag: 1 }], XMP: [], ICC_Profile: [] },
        },
        [],
      ),
    ).toThrow("Unpermitted metadata difference");
    expect(() =>
      comparePermittedDifferences(
        {
          warnings: ["decoder warning"],
          namespaces: { EXIF: [], XMP: [], ICC_Profile: [] },
        },
        { warnings: [], namespaces: { EXIF: [], XMP: [], ICC_Profile: [] } },
        [],
      ),
    ).toThrow("Oracle warning");
    expect(() =>
      comparePermittedDifferences(
        {
          warnings: [],
          namespaces: { EXIF: [{ Orientation: 6 }], XMP: [], ICC_Profile: [] },
        },
        { warnings: [], namespaces: { EXIF: [], XMP: [], ICC_Profile: [] } },
        ["EXIF:Orientation=6"],
      ),
    ).toThrow("Requested Orientation was not preserved");
    expect(
      comparePermittedDifferences(
        {
          warnings: [],
          namespaces: {
            EXIF: [],
            XMP: [],
            ICC_Profile: [{ ProfileDescription: "test" }, { RedTRC: 1 }],
          },
          rawIccSha256: "a".repeat(64),
        },
        {
          warnings: [],
          namespaces: {
            EXIF: [],
            XMP: [],
            ICC_Profile: [{ ProfileDescription: "test" }, { RedTRC: 1 }],
          },
          rawIccSha256: "a".repeat(64),
        },
        [`ICC_Profile:RawProfile=${"a".repeat(64)}`],
      ),
    ).toEqual([]);
    expect(() =>
      comparePermittedDifferences(
        {
          warnings: [],
          namespaces: {
            EXIF: [],
            XMP: [],
            ICC_Profile: [{ Duplicate: 1 }, { Duplicate: 1 }],
          },
          rawIccSha256: "b".repeat(64),
        },
        {
          warnings: [],
          namespaces: {
            EXIF: [],
            XMP: [],
            ICC_Profile: [{ Duplicate: 1 }],
          },
          rawIccSha256: "b".repeat(64),
        },
        [`ICC_Profile:RawProfile=${"b".repeat(64)}`],
      ),
    ).toThrow("Requested ICC profile was not preserved");
  });

  it.runIf(admittedHost)(
    "proves the official fixture through identical decode, structure, and metadata evidence",
    async () => {
      const source = await materializeCorpusRecord("libwebp-1.5.0-example");
      const output = await sanitize(source);
      const libwebp = runLibwebpOracle({
        caseId: "libwebp-1.5.0-example",
        kind: "still",
        source,
        output,
      });
      expect(libwebp).toMatchObject({
        version: 1,
        caseId: "libwebp-1.5.0-example",
        kind: "still",
        equivalent: true,
        source: {
          decode: {
            status: "success",
            width: 128,
            height: 128,
            format: "lossy",
            pamSha256:
              "ff7c5b6f529f2800154e87e3a56f708f9de842cda7ffff2b7284821cc1a9848a",
          },
          structure: {
            status: "success",
            warnings: [],
            chunks: [{ fourCc: "VP8 ", headerOffset: 12, spanBytes: 4_868 }],
          },
        },
      });
      expect(JSON.stringify(libwebp)).not.toMatch(/\/(?:home|tmp|Users)\//);
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "runs the live two-directional differential against every differential-role corpus record",
    async () => {
      const records = differentialSuccessRecords();
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const source = await materializeCorpusRecord(record.id);
        const output = await sanitize(
          source,
          sanitizeOptionsForGrants(record.permittedDifferences),
        );
        const transcript = runExiftoolDifferential({
          caseId: record.id,
          profile: webpDifferentialProfile,
          source,
          output,
          permittedDifferences: record.permittedDifferences,
        });
        expect(transcript).toMatchObject({
          version: 1,
          caseId: record.id,
          equivalent: true,
        });
        expect(JSON.stringify(transcript)).not.toMatch(
          /\/(?:home|tmp|Users)\//,
        );
      }
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "measures orientation and ICC preservation as the only permitted WebP differences",
    async () => {
      const source = metadataWebp();
      const output = await sanitize(source, {
        preserveOrientation: true,
        preserveColorProfile: true,
      });
      const transcript = runExiftoolDifferential({
        caseId: "metadata-webp-orientation-icc",
        profile: webpDifferentialProfile,
        source,
        output,
        permittedDifferences: [
          "EXIF:Orientation=6",
          `ICC_Profile:RawProfile=${digest(iccProfile())}`,
        ],
      });
      expect(transcript).toMatchObject({
        version: 1,
        caseId: "metadata-webp-orientation-icc",
        equivalent: true,
      });
    },
    180_000,
  );

  it("pins the differential-role corpus selection to an exact, non-empty ID set", () => {
    expect(differentialSuccessRecords().map((record) => record.id)).toEqual([
      "exifcleaner-sample",
      "libwebp-1.5.0-example",
    ]);
  });

  it("derives sanitize preservation options from a record's grants", () => {
    expect(sanitizeOptionsForGrants([])).toEqual({
      preserveOrientation: false,
      preserveColorProfile: false,
    });
    expect(sanitizeOptionsForGrants(["EXIF:Orientation=6"])).toEqual({
      preserveOrientation: true,
      preserveColorProfile: false,
    });
    expect(
      sanitizeOptionsForGrants([`ICC_Profile:RawProfile=${"a".repeat(64)}`]),
    ).toEqual({
      preserveOrientation: false,
      preserveColorProfile: true,
    });
  });

  it("cites the exact live test title that measures every permitted WebP difference kind", () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const testFileText = readFileSync(testFilePath, "utf8");
    for (const kind of webpDifferentialProfile.permittedKinds) {
      expect(kind.measurement).toBe(
        "measures orientation and ICC preservation as the only permitted WebP differences",
      );
      expect(testFileText).toContain(kind.measurement);
    }
  });

  it.runIf(admittedHost)(
    "rejects an injected metadata leak through the live differential",
    async () => {
      const source = metadataWebp();
      const output = await sanitize(source);
      // KIT-08 collapses this no-preservation output to simple-format WebP
      // (a single VP8 chunk, no VP8X). Re-append the source's XMP chunk and
      // rebuild a VP8X container with the XMP bit set so the tampered file
      // stays structurally valid -- the leak is the reappearance of XMP
      // itself, not the container shape.
      const outputImage = readChunks(output).find(
        (item) => item.fourCc === "VP8 " || item.fourCc === "VP8L",
      );
      const sourceXmp = readChunks(source).find(
        (item) => item.fourCc === "XMP ",
      );
      if (outputImage === undefined || sourceXmp === undefined)
        throw new Error("Fixture invariant violated: missing VP8 or XMP.");
      const tampered = webp([
        { fourCc: "VP8X", data: vp8x(0x04) },
        { fourCc: outputImage.fourCc, data: outputImage.data },
        { fourCc: "XMP ", data: sourceXmp.data },
      ]);

      expect(() =>
        runExiftoolDifferential({
          caseId: "injected-leak",
          profile: webpDifferentialProfile,
          source,
          output: tampered,
          permittedDifferences: [],
        }),
      ).toThrow("Unpermitted metadata difference");
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "rejects a leak outside EXIF/XMP/ICC through the two-directional differential",
    async () => {
      const source = metadataWebp();
      const output = await sanitize(source);

      // Positive twin: the real sanitized output passes both directions of the
      // differential with no grants.
      const positiveTwin = runExiftoolDifferential({
        caseId: "riff-leak-positive-twin",
        profile: webpDifferentialProfile,
        source,
        output,
        permittedDifferences: [],
      });
      expect(positiveTwin).toMatchObject({ equivalent: true });

      // Leak: wrap the same VP8/VP8L image in a VP8X container with flags 0,
      // no EXIF, XMP or ICC added. comparePermittedDifferences can only name
      // EXIF, XMP or ICC_Profile (kit/oracles.ts:307-337), so a thrown message
      // naming RIFF proves compareDifferential -- not that older check --
      // caught this leak.
      const outputImage = readChunks(output).find(
        (item) => item.fourCc === "VP8 " || item.fourCc === "VP8L",
      );
      if (outputImage === undefined)
        throw new Error("Fixture invariant violated: missing VP8 or VP8L.");
      const tampered = webp([
        { fourCc: "VP8X", data: vp8x(0x00) },
        { fourCc: outputImage.fourCc, data: outputImage.data },
      ]);

      expect(() =>
        runExiftoolDifferential({
          caseId: "riff-leak",
          profile: webpDifferentialProfile,
          source,
          output: tampered,
          permittedDifferences: [],
        }),
      ).toThrow("Unpermitted metadata difference: RIFF");
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "rejects an over-strip of a namespace ExifTool keeps, on live projections",
    async () => {
      const source = await materializeCorpusRecord("libwebp-1.5.0-example");
      const output = await sanitize(source);
      const transcript = runExiftoolDifferential({
        caseId: "over-strip-source",
        profile: webpDifferentialProfile,
        source,
        output,
        permittedDifferences: [],
      });

      const namespace = Object.keys(transcript.reference.namespaces)
        .filter(
          (name) => name !== "EXIF" && name !== "XMP" && name !== "ICC_Profile",
        )
        .filter(
          (name) => (transcript.reference.namespaces[name]?.length ?? 0) > 0,
        )
        .sort()[0];
      expect(namespace).toBeDefined();
      if (namespace === undefined)
        throw new Error(
          "Fixture invariant violated: no non-EXIF/XMP/ICC namespace.",
        );

      expect(
        compareDifferential(
          transcript.source,
          transcript.output,
          transcript.reference,
          [],
          webpDifferentialProfile.permittedKinds,
        ),
      ).toEqual([]);

      const strippedEntries = transcript.output.namespaces[namespace] ?? [];
      const overStripped: MetadataProjection = {
        ...transcript.output,
        namespaces: {
          ...transcript.output.namespaces,
          [namespace]: strippedEntries.slice(1),
        },
      };
      expect(() =>
        compareDifferential(
          transcript.source,
          overStripped,
          transcript.reference,
          [],
          webpDifferentialProfile.permittedKinds,
        ),
      ).toThrow(`Over-strip: ${namespace}`);
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "proves animation canvas, timing, and frame hashes in both directions",
    async () => {
      const still = await materializeCorpusRecord("libwebp-1.5.0-example");
      const payloadSize = still.readUInt32LE(16);
      const payload = still.subarray(20, 20 + payloadSize);
      const source = webp([
        { fourCc: "VP8X", data: vp8x(0x02, 128, 128) },
        { fourCc: "ANIM", data: anim(0xff00_00ff, 2) },
        {
          fourCc: "ANMF",
          data: animationFrame({
            width: 128,
            height: 128,
            duration: 40,
            chunks: [{ fourCc: "VP8 ", data: payload }],
          }),
        },
        {
          fourCc: "ANMF",
          data: animationFrame({
            width: 128,
            height: 128,
            duration: 60,
            chunks: [{ fourCc: "VP8 ", data: payload }],
          }),
        },
      ]);
      const output = await sanitize(source);
      const transcript = runLibwebpOracle({
        caseId: "generated-two-frame-animation",
        kind: "animation",
        source,
        output,
      });
      expect(transcript).toMatchObject({
        equivalent: true,
        source: {
          decode: {
            status: "success",
            canvasWidth: 128,
            canvasHeight: 128,
            frameCount: 2,
            loopCount: 2,
            frames: [{ timestampMs: 40 }, { timestampMs: 100 }],
          },
        },
      });
    },
    30_000,
  );

  it.runIf(admittedHost)(
    "rejects a shallow VP8 admission that the independent decoder cannot decode",
    async () => {
      const malformed = webp([
        {
          fourCc: "VP8 ",
          data: Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0]),
        },
      ]);
      const directory = await mkdtemp(join(tmpdir(), "exifcleaner-shallow-"));
      const sourcePath = join(directory, "source.webp");
      try {
        await writeFile(sourcePath, malformed);
        const handle = await open(sourcePath, "r");
        try {
          await expect(
            parseWebp(handle, malformed.length),
          ).resolves.toBeDefined();
        } finally {
          await handle.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      expect(() =>
        runLibwebpOracle({
          caseId: "shallow-admission-decode-rejection",
          kind: "still",
          source: malformed,
          output: malformed,
        }),
      ).toThrow("libwebp oracle rejected");
    },
    30_000,
  );

  it.runIf(admittedHost)(
    "rejects malformed ordering and padding through the structural oracle",
    () => {
      for (const caseId of [
        "nonzero-odd-padding",
        "ordered-iccp-after-image",
      ]) {
        const { prefix } = materializeMutationCase(caseId);
        expect(() =>
          runLibwebpOracle({
            caseId,
            kind: "still",
            source: prefix,
            output: prefix,
          }),
        ).toThrow("libwebp oracle rejected");
      }
    },
    30_000,
  );
});

/**
 * WEBP-07 resolution differential. WebP keeps print resolution in the EXIF chunk's IFD0, so
 * these rows use the WebP-local assertions of `compareWebpResolutionPreservation` (the JPEG
 * D-06 precedent) instead of a kit grant, and the shared qualification kit is unchanged.
 */
describe("WebP resolution preservation against ExifTool (WEBP-07)", () => {
  const RICH = {
    make: "CameraCo",
    artist: "Ann",
    orientation: 6,
    xResolution: [300, 1],
    yResolution: [72, 1],
    resolutionUnit: 2,
  } as const;
  const RIFF_BASE = [
    { HorizontalScale: 0 },
    { ImageHeight: 1 },
    { ImageWidth: 1 },
    { VP8Version: 0 },
    { VerticalScale: 0 },
  ];
  const projection = (
    exif: MetadataProjection["namespaces"][string],
    riff: MetadataProjection["namespaces"][string] = RIFF_BASE,
    warnings: readonly string[] = [],
  ): MetadataProjection => ({
    warnings,
    namespaces: { EXIF: exif, XMP: [], ICC_Profile: [], RIFF: riff },
  });
  const SOURCE = projection(
    [
      { Artist: "Ann" },
      { Make: "CameraCo" },
      { Orientation: 6 },
      { ResolutionUnit: 2 },
      { XResolution: 300 },
      { YResolution: 72 },
    ],
    [{ WebP_Flags: 8 }, ...RIFF_BASE],
  );
  const REFERENCE = projection([]);
  const RESOLUTION = [
    { ResolutionUnit: 2 },
    { XResolution: 300 },
    { YResolution: 72 },
  ];
  const WITH_FLAGS = [{ WebP_Flags: 8 }, ...RIFF_BASE];
  const requested = (
    orientation: boolean,
    resolution: boolean,
  ): WebpResolutionExpectation => ({ orientation, resolution });

  describe("compareWebpResolutionPreservation (pure, every host)", () => {
    it("accepts exactly the source resolution tags plus the EXIF flag bit", () => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          projection(RESOLUTION, WITH_FLAGS),
          REFERENCE,
          requested(false, true),
        ),
      ).not.toThrow();
    });

    it("accepts resolution together with orientation", () => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          projection([{ Orientation: 6 }, ...RESOLUTION], WITH_FLAGS),
          REFERENCE,
          requested(true, true),
        ),
      ).not.toThrow();
    });

    it("accepts orientation only and a missing unit that the source never had", () => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          projection([{ Orientation: 6 }], WITH_FLAGS),
          REFERENCE,
          requested(true, false),
        ),
      ).not.toThrow();
      const noUnit = projection(
        [{ XResolution: 300 }, { YResolution: 300 }],
        [{ WebP_Flags: 8 }, ...RIFF_BASE],
      );
      expect(() =>
        compareWebpResolutionPreservation(
          noUnit,
          projection([{ XResolution: 300 }, { YResolution: 300 }], WITH_FLAGS),
          REFERENCE,
          requested(false, true),
        ),
      ).not.toThrow();
    });

    it("accepts no EXIF and no flags when nothing was requested or the source has no resolution", () => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          projection([]),
          REFERENCE,
          requested(false, false),
        ),
      ).not.toThrow();
      const noResolution = projection(
        [{ Make: "CameraCo" }, { Orientation: 6 }],
        [{ WebP_Flags: 8 }, ...RIFF_BASE],
      );
      expect(() =>
        compareWebpResolutionPreservation(
          noResolution,
          projection([]),
          REFERENCE,
          requested(false, true),
        ),
      ).not.toThrow();
    });

    const rejected: readonly (readonly [
      string,
      MetadataProjection,
      WebpResolutionExpectation,
      string,
    ])[] = [
      [
        "a missing resolution (nothing kept)",
        projection([]),
        requested(false, true),
        "Missing IFD0 tag: XResolution",
      ],
      [
        "a missing YResolution",
        projection([{ ResolutionUnit: 2 }, { XResolution: 300 }], WITH_FLAGS),
        requested(false, true),
        "Missing IFD0 tag: YResolution",
      ],
      [
        "swapped X and Y resolution",
        projection(
          [{ ResolutionUnit: 2 }, { XResolution: 72 }, { YResolution: 300 }],
          WITH_FLAGS,
        ),
        requested(false, true),
        "IFD0 XResolution mismatch: expected 300, got 72",
      ],
      [
        "a mismatched unit",
        projection(
          [{ ResolutionUnit: 3 }, { XResolution: 300 }, { YResolution: 72 }],
          WITH_FLAGS,
        ),
        requested(false, true),
        "IFD0 ResolutionUnit mismatch: expected 2, got 3",
      ],
      [
        "a dropped unit",
        projection([{ XResolution: 300 }, { YResolution: 72 }], WITH_FLAGS),
        requested(false, true),
        "Missing IFD0 tag: ResolutionUnit",
      ],
      [
        "an extra YCbCrPositioning (the -tagsfromfile reference shape)",
        projection([...RESOLUTION, { YCbCrPositioning: 1 }], WITH_FLAGS),
        requested(false, true),
        "Unexpected IFD0 tag: YCbCrPositioning",
      ],
      [
        "a leaked Make",
        projection([{ Make: "CameraCo" }, ...RESOLUTION], WITH_FLAGS),
        requested(false, true),
        "Unexpected IFD0 tag: Make",
      ],
      [
        "an orientation that was not requested",
        projection([{ Orientation: 6 }, ...RESOLUTION], WITH_FLAGS),
        requested(false, true),
        "Unexpected IFD0 tag: Orientation",
      ],
      [
        "a requested orientation that is missing",
        projection(RESOLUTION, WITH_FLAGS),
        requested(true, true),
        "Missing IFD0 tag: Orientation",
      ],
      [
        "a resolution that was not requested",
        projection(RESOLUTION, WITH_FLAGS),
        requested(true, false),
        "Unexpected IFD0 tag: ResolutionUnit",
      ],
      [
        "an EXIF flag bit missing from the container",
        projection(RESOLUTION, RIFF_BASE),
        requested(false, true),
        "RIFF:WebP_Flags mismatch",
      ],
      [
        "an extra flag bit in the container",
        projection(RESOLUTION, [{ WebP_Flags: 0x28 }, ...RIFF_BASE]),
        requested(false, true),
        "RIFF:WebP_Flags mismatch",
      ],
      [
        "a flags value with nothing kept",
        projection([], WITH_FLAGS),
        requested(false, false),
        "RIFF:WebP_Flags mismatch",
      ],
      [
        "a difference outside EXIF and the flags",
        projection(RESOLUTION, [
          ...WITH_FLAGS.filter((entry) => !("ImageWidth" in entry)),
          { ImageWidth: 2 },
        ]),
        requested(false, true),
        "Unpermitted metadata difference: RIFF",
      ],
      [
        "an oracle warning on the output",
        projection(RESOLUTION, WITH_FLAGS, ["Truncated EXIF"]),
        requested(false, true),
        "Oracle warning: output",
      ],
    ];
    it.each(rejected)("rejects %s", (_name, output, expectation, message) => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          output,
          REFERENCE,
          expectation,
        ),
      ).toThrow(message);
    });

    it("rejects a reference that kept IFD0 tags and a warning on the source", () => {
      expect(() =>
        compareWebpResolutionPreservation(
          SOURCE,
          projection(RESOLUTION, WITH_FLAGS),
          projection([{ YCbCrPositioning: 1 }]),
          requested(false, true),
        ),
      ).toThrow("Reference kept IFD0 tags: YCbCrPositioning");
      expect(() =>
        compareWebpResolutionPreservation(
          { ...SOURCE, warnings: ["Prefix"] },
          projection(RESOLUTION, WITH_FLAGS),
          REFERENCE,
          requested(false, true),
        ),
      ).toThrow("Oracle warning: source");
    });
  });

  const sanitizeOptionsFor = (
    expectation: WebpResolutionExpectation,
  ): SanitizeOptions => ({
    preserveOrientation: expectation.orientation,
    preserveResolution: expectation.resolution,
  });

  it.runIf(admittedHost)(
    "confirms the ExifTool reference facts the local assertions encode",
    async () => {
      const source = webpWithExifResolution(RICH);
      const kitReference = projectMetadata(
        runExiftoolReference(source, webpDifferentialProfile),
        webpDifferentialProfile,
      );
      const tagsFromFile = projectMetadata(
        runExiftoolReference(source, webpDifferentialProfile, [
          "-TagsFromFile",
          "@",
          "-XResolution",
          "-YResolution",
          "-ResolutionUnit",
        ]),
        webpDifferentialProfile,
      );
      const native = projectMetadata(
        await sanitize(source, {
          preserveOrientation: false,
          preserveResolution: true,
        }),
        webpDifferentialProfile,
      );
      // The kit reference (bare -all=) keeps no IFD0 tag and no container flags.
      expect(kitReference.namespaces.EXIF).toEqual([]);
      expect(JSON.stringify(kitReference.namespaces.RIFF)).not.toContain(
        "WebP_Flags",
      );
      // The -tagsfromfile reference keeps the three values and adds YCbCrPositioning.
      expect(tagsFromFile.namespaces.EXIF).toEqual([
        { ResolutionUnit: 2 },
        { XResolution: 300 },
        { YCbCrPositioning: 1 },
        { YResolution: 72 },
      ]);
      // Native carries the same three values and no YCbCrPositioning.
      expect(native.namespaces.EXIF).toEqual([
        { ResolutionUnit: 2 },
        { XResolution: 300 },
        { YResolution: 72 },
      ]);
      expect(native.namespaces.RIFF).toContainEqual({ WebP_Flags: 8 });
    },
    180_000,
  );

  const rows: readonly (readonly [
    string,
    Buffer,
    WebpResolutionExpectation,
  ])[] = [
    ["resolution only", webpWithExifResolution(RICH), requested(false, true)],
    [
      "resolution plus orientation",
      webpWithExifResolution(RICH),
      requested(true, true),
    ],
    [
      "resolution requested but the source has none",
      webpWithExifResolution({ make: "CameraCo", orientation: 6 }),
      requested(false, true),
    ],
    [
      "resolution with an absent unit",
      webpWithExifResolution({
        make: "CameraCo",
        xResolution: [300, 1],
        yResolution: [300, 1],
      }),
      requested(false, true),
    ],
    ["orientation only", webpWithExifResolution(RICH), requested(true, false)],
    [
      "no preservation requested",
      webpWithExifResolution(RICH),
      requested(false, false),
    ],
  ];
  it.runIf(admittedHost).each(rows)(
    "matches ExifTool for %s",
    async (_name, source, expectation) => {
      const output = await sanitize(source, sanitizeOptionsFor(expectation));
      const sourceProjection = projectMetadata(source, webpDifferentialProfile);
      const outputProjection = projectMetadata(output, webpDifferentialProfile);
      const reference = projectMetadata(
        runExiftoolReference(source, webpDifferentialProfile),
        webpDifferentialProfile,
      );
      compareWebpResolutionPreservation(
        sourceProjection,
        outputProjection,
        reference,
        expectation,
      );
      // The assertion is not vacuous: what the row asked for is really in the output.
      const names = (outputProjection.namespaces.EXIF ?? []).flatMap((entry) =>
        Object.keys(entry),
      );
      const sourceNames = new Set(
        (sourceProjection.namespaces.EXIF ?? []).flatMap((entry) =>
          Object.keys(entry),
        ),
      );
      expect(names.includes("XResolution")).toBe(
        expectation.resolution && sourceNames.has("XResolution"),
      );
      expect(names.includes("Orientation")).toBe(
        expectation.orientation && sourceNames.has("Orientation"),
      );
    },
    180_000,
  );
});
