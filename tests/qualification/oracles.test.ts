import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../dist/index.js";
import { parseWebp } from "../../src/webp/riff.js";
import { anim, animationFrame, vp8x, webp } from "../fixtures.js";
import { materializeCorpusRecord } from "./corpus.js";
import { materializeMutationCase } from "./generators.js";
import {
  comparePermittedDifferences,
  normalizeWebpInfo,
  runExiftoolOracle,
  runLibwebpOracle,
} from "./oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

async function sanitize(bytes: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-oracle-test-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "output.webp");
  try {
    await writeFile(sourcePath, bytes);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });
    if (!result.ok) throw new Error(`sanitize failed: ${result.error.code}`);
    return await readFile(destinationPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

      expect(
        runExiftoolOracle({
          caseId: "libwebp-1.5.0-example",
          source,
          output,
          permittedDifferences: [],
        }),
      ).toMatchObject({
        version: 1,
        caseId: "libwebp-1.5.0-example",
        equivalent: true,
        source: {
          warnings: [],
          namespaces: { EXIF: [], XMP: [], ICC_Profile: [] },
        },
        output: {
          warnings: [],
          namespaces: { EXIF: [], XMP: [], ICC_Profile: [] },
        },
      });
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
