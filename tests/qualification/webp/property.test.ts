import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import { parseWebp } from "../../../src/webp/riff.js";
import { assertCanariesAbsent, assertPlanted } from "../kit/generators.js";
import {
  formatReplayRecord,
  qualificationArbitrary,
  resolveReplayConfig,
  type QualificationSample,
} from "./generators.js";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Per-sample body of the fixed-seed property (extracted so Task 2/3 can reuse it
 * against injected fakes). `sanitize` is injectable and defaults to the real dist
 * `sanitizeFile` — every negative control replaces it with a deliberately broken fake.
 */
async function checkSample(
  sample: QualificationSample,
  sanitize: typeof sanitizeFile = sanitizeFile,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-property-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "output.webp");
  try {
    await writeFile(sourcePath, sample.bytes);
    if (sample.expected === "success") {
      assertPlanted(sample.bytes, sample.planted);
      const source = await open(sourcePath, "r");
      try {
        await expect(
          parseWebp(source, sample.bytes.length),
        ).resolves.toBeDefined();
      } finally {
        await source.close();
      }
      const result = await sanitize({
        sourcePath,
        destinationPath,
        ...sample.options,
      });
      expect(result.ok).toBe(true);
      const preservedKinds = sample.options.preserveColorProfile
        ? ["ICCP"]
        : [];
      assertCanariesAbsent(
        await readFile(destinationPath),
        sample.planted,
        preservedKinds,
      );
      expect(await readFile(sourcePath)).toEqual(sample.bytes);
      expect(await readFile(destinationPath)).toBeInstanceOf(Buffer);
    } else {
      const result = await sanitize({
        sourcePath,
        destinationPath,
        ...sample.options,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: sample.expected,
          phase: "admission",
          nativeWrite: "not-started",
        },
      });
      await expect(access(destinationPath)).rejects.toBeDefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("replayable WebP qualification properties", () => {
  it("defaults focused runs to 200 and exact-path replay to one", () => {
    expect(resolveReplayConfig({})).toEqual({ seed: 460_046, numRuns: 200 });
    expect(resolveReplayConfig({ FC_PATH: "0:1" })).toEqual({
      seed: 460_046,
      path: "0:1",
      numRuns: 1,
    });
    expect(() => resolveReplayConfig({ FC_PATH: "../../private" })).toThrow(
      "FC_PATH",
    );
    expect(() => resolveReplayConfig({ FC_RUNS: "201" })).toThrow("FC_RUNS");
  });

  it("runs the fixed grammar/mutation corpus with complete replay identity", async () => {
    const config = resolveReplayConfig(process.env);
    let executed = 0;
    const property = fc.asyncProperty(
      qualificationArbitrary(),
      async (sample) => {
        executed += 1;
        await checkSample(sample);
      },
    );
    const result = await fc.check(property, config);
    if (result.failed) {
      throw new Error(
        JSON.stringify(
          formatReplayRecord({
            seed: config.seed,
            path: result.counterexamplePath,
            fixtureSha256: digest(
              Buffer.from(JSON.stringify(result.counterexample)),
            ),
            faultPlan: null,
          }),
        ),
      );
    }
    expect(executed).toBe(config.numRuns);
  }, 30_000);

  it("replays the exact minimized path emitted for an injected failure", () => {
    const arbitrary = fc.integer({ min: 0, max: 100 });
    const first = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      {
        seed: 460_046,
        numRuns: 200,
      },
    );
    expect(first.failed).toBe(true);
    if (!first.failed || first.counterexamplePath === null)
      throw new Error("Expected an injected shrink failure");
    const replayPath = first.counterexamplePath;
    const replay = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      {
        seed: 460_046,
        path: replayPath,
        numRuns: 1,
      },
    );
    expect(replay.failed).toBe(true);
    expect(replay.counterexample).toEqual(first.counterexample);
    expect(
      formatReplayRecord({
        seed: 460_046,
        path: replayPath,
        fixtureSha256: "a".repeat(64),
        faultPlan: { operation: "stage-sync", occurrence: 1, error: "EIO" },
      }),
    ).toMatchObject({
      version: 1,
      seed: 460_046,
      path: replayPath,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      fixtureSha256: "a".repeat(64),
      replayCommand: expect.stringContaining("FC_PATH="),
    });
  });
});
