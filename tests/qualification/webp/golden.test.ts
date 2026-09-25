import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
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
import { qualificationArbitrary, validGrammarCases } from "./generators.js";

const GOLDEN_PATH = join(__dirname, "golden-sha256.json");
const MANIFEST_PATH = join(__dirname, "../../corpus/manifest.json");
const CAPTURE_SEED = 460_046;
const CAPTURE_NUM_RUNS = 200;
const CAPTURE_REASON = "pre-FormatHandler baseline (D-22)";

interface ManifestRecordSummary {
  readonly id: string;
  readonly outcome: { readonly status: "success" | "refused" };
}

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

function setEntry(
  entries: Record<string, string>,
  key: string,
  value: string,
): void {
  if (
    Object.prototype.hasOwnProperty.call(entries, key) &&
    entries[key] !== value
  )
    throw new Error(
      `Non-deterministic golden entry: ${key} (had ${entries[key]}, now ${value})`,
    );
  entries[key] = value;
}

async function collectCorpusEntries(
  entries: Record<string, string>,
): Promise<void> {
  const manifest: { readonly records: readonly ManifestRecordSummary[] } =
    JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  for (const record of manifest.records) {
    const sourceBytes = await materializeCorpusRecord(record.id);
    for (const options of FLAG_COMBINATIONS) {
      const key = `corpus:${record.id}|${flagKey(options)}`;
      setEntry(entries, key, await sanitizeAndDigest(sourceBytes, options));
    }
  }
}

async function collectGrammarEntries(
  entries: Record<string, string>,
): Promise<void> {
  for (const grammarCase of validGrammarCases) {
    for (const options of FLAG_COMBINATIONS) {
      const key = `grammar:${grammarCase.id}|${flagKey(options)}`;
      setEntry(
        entries,
        key,
        await sanitizeAndDigest(grammarCase.bytes, options),
      );
    }
  }
}

async function collectPropertyEntries(
  entries: Record<string, string>,
): Promise<void> {
  const samples = fc.sample(qualificationArbitrary(), {
    seed: CAPTURE_SEED,
    numRuns: CAPTURE_NUM_RUNS,
  });
  for (const [index, sample] of samples.entries()) {
    const key = `property:${index}:${sample.id}|${flagKey(sample.options)}`;
    setEntry(
      entries,
      key,
      await sanitizeAndDigest(sample.bytes, sample.options),
    );
  }
}

async function collectEntries(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  await collectCorpusEntries(entries);
  await collectGrammarEntries(entries);
  await collectPropertyEntries(entries);
  return entries;
}

describe("kit golden-digest harness (KIT-02)", () => {
  it("pins the pre-refactor digests of the whole corpus, the grammar cases, and the fixed-seed samples", async () => {
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
    expect(golden.seed).toBe(CAPTURE_SEED);
    expect(golden.numRuns).toBe(CAPTURE_NUM_RUNS);
  }, 120_000);
});
