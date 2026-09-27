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
import { runExiftoolDifferential } from "../kit/oracles.js";
import { loadCorpusRecord, materializeCorpusRecord } from "../kit/corpus.js";
import { assertPayloadIdentity, jpegDifferentialProfile } from "./oracles.js";

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
