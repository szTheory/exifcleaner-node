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
import { pngQualificationArbitrary, validGrammarCases } from "./generators.js";

/**
 * PNG-04's permanent golden (56-11): pins the sha256 of native output for
 * every PNG corpus success/refusal record and every validGrammarCases entry
 * under the 16 flag combinations, plus the first 50 fixed-seed property
 * samples. Mirrors webp/golden.test.ts's structure; deviates only where D-02
 * requires it (PNG varies `preserveResolution` too -- 16 flag combinations,
 * not 8 -- and the property sample count is 50, not 200, per the plan).
 */

const GOLDEN_PATH = join(__dirname, "golden-sha256.json");
const MANIFEST_PATH = join(__dirname, "../../corpus/manifest.json");
const CAPTURE_SEED = 460_046;
const CAPTURE_NUM_RUNS = 50;
const CAPTURE_REASON =
  "Phase 56 native PNG output, captured after libpng, pngcheck and ExifTool differential pre-flights passed";
const CAPTURE_ENGINE = "exifcleaner-node@0.2.2+phase-56";

interface ManifestRecordSummary {
  readonly id: string;
  readonly format: string;
  readonly outcome: { readonly status: "success" | "refused" };
}

const FLAG_COMBINATIONS: readonly PreservationOptions[] = [false, true].flatMap(
  (preserveOrientation) =>
    [false, true].flatMap((preserveColorProfile) =>
      [false, true].flatMap((preserveTimestamps) =>
        [false, true].map((preserveResolution): PreservationOptions => ({
          preserveOrientation,
          preserveColorProfile,
          preserveTimestamps,
          preserveResolution,
        })),
      ),
    ),
);

async function sanitizeAndDigest(
  sourceBytes: Buffer,
  options: PreservationOptions,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-golden-png-"));
  const sourcePath = join(directory, "source.png");
  const destinationPath = join(directory, "output.png");
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
  for (const record of manifest.records.filter(
    (item) => item.format === "png",
  )) {
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
  const samples = fc.sample(pngQualificationArbitrary(), {
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

describe("PNG golden-digest harness (PNG-04)", () => {
  it("pins the native output digests of the whole PNG corpus, the grammar cases, and the fixed-seed samples", async () => {
    const entries = await collectEntries();

    if (process.env.EXIFCLEANER_GOLDEN_CAPTURE === "1") {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const file: GoldenFile = {
        version: 1,
        reason: CAPTURE_REASON,
        capturedFrom: { commit, engine: CAPTURE_ENGINE },
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

  describe("golden negative controls (PNG)", () => {
    it("(1) fails the gate when one byte of the output changes", async () => {
      const golden = await readGolden(GOLDEN_PATH);
      const entries = Object.entries(golden.entries);
      const [firstSuccessKey] =
        entries.find(([, value]) => !value.startsWith("refused:")) ?? [];
      if (firstSuccessKey === undefined)
        throw new Error("golden file has no success entries");

      const actual = { ...golden.entries, [firstSuccessKey]: "0".repeat(64) };
      expect(() => assertGoldenMatch(actual, golden)).toThrow(
        new RegExp(firstSuccessKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });

    it("(2) fails the gate naming a missing entry with the count mismatch", async () => {
      const golden = await readGolden(GOLDEN_PATH);
      const keys = Object.keys(golden.entries);
      const droppedKey = keys[0];
      if (droppedKey === undefined) throw new Error("golden file is empty");
      const actual = { ...golden.entries };
      delete actual[droppedKey];

      expect(() => assertGoldenMatch(actual, golden)).toThrow(
        new RegExp(
          `Missing \\(1\\): ${droppedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
      expect(() => assertGoldenMatch(actual, golden)).toThrow(
        `golden has ${keys.length} entries, actual has ${keys.length - 1}`,
      );
    });

    it("(3) refuses to overwrite an existing golden file", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-golden-overwrite-png-"),
      );
      const existingPath = join(directory, "golden-sha256.json");
      try {
        await writeFile(existingPath, "{}");
        await expect(
          captureGolden(existingPath, {
            version: 1,
            reason: "test",
            capturedFrom: { commit: "0".repeat(40), engine: "test" },
            seed: 1,
            numRuns: 1,
            entries: {},
          }),
        ).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
