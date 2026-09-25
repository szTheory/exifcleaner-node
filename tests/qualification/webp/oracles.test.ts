import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
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
import { comparePermittedDifferences, digest } from "../kit/oracles.js";
import { materializeCorpusRecord } from "../kit/corpus.js";
import { materializeMutationCase } from "./generators.js";
import {
  normalizeWebpInfo,
  runLibwebpOracle,
  webpDifferentialProfile,
} from "./oracles.js";
import { runExiftoolDifferential } from "../kit/oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

interface SanitizeOptions {
  readonly preserveOrientation?: boolean;
  readonly preserveColorProfile?: boolean;
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
    });
    if (!result.ok) throw new Error(`sanitize failed: ${result.error.code}`);
    return await readFile(destinationPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface ManifestRecord {
  readonly id: string;
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
      for (const record of differentialSuccessRecords()) {
        const source = await materializeCorpusRecord(record.id);
        const output = await sanitize(source);
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
