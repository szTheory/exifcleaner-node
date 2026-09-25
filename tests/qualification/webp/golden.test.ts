import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import {
  assertGoldenMatch,
  captureGolden,
  digestOutput,
  flagKey,
  readGolden,
  type GoldenFile,
  type PreservationOptions,
} from "../kit/golden.js";
import { materializeCorpusRecord } from "../kit/corpus.js";

const GOLDEN_PATH = join(__dirname, "golden-sha256.json");
const CAPTURE_SEED = 460_046;
const CAPTURE_NUM_RUNS = 200;
const CAPTURE_REASON = "pre-FormatHandler baseline (D-22)";

const FLAG_COMBINATIONS: readonly PreservationOptions[] = [false, true].flatMap(
  (preserveOrientation) =>
    [false, true].flatMap((preserveColorProfile) =>
      [false, true].map((preserveTimestamps): PreservationOptions => ({
        preserveOrientation,
        preserveColorProfile,
        preserveTimestamps,
      })),
    ),
);

async function sanitizeAndDigest(
  sourceBytes: Buffer,
  options: PreservationOptions,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-golden-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "output.webp");
  try {
    await writeFile(sourcePath, sourceBytes);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...options,
    });
    if (!result.ok) return `refused:${result.error.code}`;
    return digestOutput(await readFile(destinationPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collectEntries(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const sourceBytes = await materializeCorpusRecord("exifcleaner-sample");
  for (const options of FLAG_COMBINATIONS) {
    const key = `corpus:exifcleaner-sample|${flagKey(options)}`;
    const digest = await sanitizeAndDigest(sourceBytes, options);
    if (
      Object.prototype.hasOwnProperty.call(entries, key) &&
      entries[key] !== digest
    )
      throw new Error(`Non-deterministic golden entry: ${key}`);
    entries[key] = digest;
  }
  return entries;
}

describe("kit golden-digest harness (KIT-02)", () => {
  it("round-trips the tracer corpus case through capture and assert", async () => {
    const entries = await collectEntries();

    if (process.env.EXIFCLEANER_GOLDEN_CAPTURE === "1") {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const file: GoldenFile = {
        version: 1,
        reason: CAPTURE_REASON,
        capturedFrom: { commit, engine: "pre-FormatHandler" },
        seed: CAPTURE_SEED,
        numRuns: CAPTURE_NUM_RUNS,
        entries,
      };
      await captureGolden(GOLDEN_PATH, file);
    }

    const golden = await readGolden(GOLDEN_PATH);
    assertGoldenMatch(entries, golden);
  });
});
