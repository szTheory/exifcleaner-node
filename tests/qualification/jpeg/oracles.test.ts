import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import { loadCorpusRecord, materializeCorpusRecord } from "../kit/corpus.js";
import { assertPayloadIdentity } from "./oracles.js";

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
  it.runIf(admittedHost)(
    "proves the libjpeg-turbo testorig fixture pixel-identical with every preservation flag false and every flag true",
    async () => {
      const record = await loadCorpusRecord("libjpeg-turbo-testorig");
      await assertRecordPayloadIdentity(record.id);
    },
    60_000,
  );

  it.runIf(admittedHost).each(admittedJpegRecordIds())(
    "proves %s pixel-identical with every preservation flag false and every flag true",
    async (caseId) => {
      await assertRecordPayloadIdentity(caseId);
    },
    60_000,
  );
});
