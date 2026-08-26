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
import { sanitizeFile } from "../../dist/index.js";
import { parseWebp } from "../../src/webp/riff.js";
import {
  formatReplayRecord,
  qualificationArbitrary,
  resolveReplayConfig,
} from "./generators.js";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("replayable WebP qualification properties", () => {
  it("runs the fixed grammar/mutation corpus with complete replay identity", async () => {
    const config = resolveReplayConfig(process.env);
    let executed = 0;
    const property = fc.asyncProperty(
      qualificationArbitrary(),
      async (sample) => {
        executed += 1;
        const directory = await mkdtemp(
          join(tmpdir(), "exifcleaner-property-"),
        );
        const sourcePath = join(directory, "source.webp");
        const destinationPath = join(directory, "output.webp");
        try {
          await writeFile(sourcePath, sample.bytes);
          if (sample.expected === "success") {
            const source = await open(sourcePath, "r");
            try {
              await expect(
                parseWebp(source, sample.bytes.length),
              ).resolves.toBeDefined();
            } finally {
              await source.close();
            }
            const result = await sanitizeFile({
              sourcePath,
              destinationPath,
              preserveOrientation: false,
              preserveColorProfile: false,
              preserveTimestamps: false,
            });
            expect(result.ok).toBe(true);
            expect(await readFile(sourcePath)).toEqual(sample.bytes);
            expect(await readFile(destinationPath)).toBeInstanceOf(Buffer);
          } else {
            const result = await sanitizeFile({
              sourcePath,
              destinationPath,
              preserveOrientation: false,
              preserveColorProfile: false,
              preserveTimestamps: false,
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
  });

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
    expect(first.counterexamplePath).toBeTypeOf("string");
    const replay = fc.check(
      fc.property(arbitrary, (value) => value < 10),
      {
        seed: 460_046,
        path: first.counterexamplePath,
        numRuns: 1,
      },
    );
    expect(replay.failed).toBe(true);
    expect(replay.counterexample).toEqual(first.counterexample);
    expect(
      formatReplayRecord({
        seed: 460_046,
        path: first.counterexamplePath,
        fixtureSha256: "a".repeat(64),
        faultPlan: { operation: "stage-sync", occurrence: 1, error: "EIO" },
      }),
    ).toMatchObject({
      version: 1,
      seed: 460_046,
      path: first.counterexamplePath,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      fixtureSha256: "a".repeat(64),
      replayCommand: expect.stringContaining("FC_PATH="),
    });
  });
});
