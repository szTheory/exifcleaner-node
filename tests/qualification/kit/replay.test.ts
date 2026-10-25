import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  REPLAY_RECORD_KEYS,
  bytesDigest,
  checkWithReplay,
  formatReplayRecord,
  generatorHash,
  parseReplayRecord,
  resolveReplayConfig,
  type ReplayRecord,
} from "./replay.js";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SOURCES = [
  "tests/qualification/kit/replay.ts",
  "tests/qualification/kit/generators.ts",
];

/** Forces a failure on the given arbitrary and returns the printed record. */
async function forceFailure<T>(
  arbitrary: fc.Arbitrary<T>,
  options: {
    readonly format: string;
    readonly toBytes: (value: T) => Uint8Array;
    readonly sources: readonly string[];
    readonly threshold?: number;
  },
): Promise<{ record: ReplayRecord; arbitrary: fc.Arbitrary<T> }> {
  const threshold = options.threshold ?? 1;
  const config = resolveReplayConfig({ FC_SEED: "460046" });
  let message = "";
  try {
    await checkWithReplay(
      fc.asyncProperty(arbitrary, async (value) => {
        if (options.toBytes(value).length >= threshold)
          throw new Error("forced failure");
      }),
      config,
      {
        format: options.format,
        toBytes: options.toBytes,
        generatorSources: options.sources,
      },
    );
  } catch (error) {
    message = (error as Error).message;
  }
  return { record: parseReplayRecord(message), arbitrary };
}

/** Replays a record's seed and path; returns the SHA-256 of the replayed bytes. */
async function replayDigest<T>(
  record: ReplayRecord,
  arbitrary: fc.Arbitrary<T>,
  toBytes: (value: T) => Uint8Array,
  threshold = 1,
): Promise<string> {
  const config = resolveReplayConfig({
    FC_SEED: String(record.seed),
    FC_PATH: record.path,
  });
  const result = await fc.check(
    fc.asyncProperty(arbitrary, async (value) => {
      if (toBytes(value).length >= threshold) throw new Error("forced failure");
    }),
    config,
  );
  expect(result.failed).toBe(true);
  return bytesDigest(toBytes(result.counterexample?.[0] as T));
}

describe("resolveReplayConfig", () => {
  it("returns the defaults for an unset environment", () => {
    expect(resolveReplayConfig({})).toEqual({ seed: 460_046, numRuns: 200 });
  });

  it("uses one run and endOnFailure when FC_PATH is set", () => {
    expect(resolveReplayConfig({ FC_PATH: "0:1" })).toEqual({
      seed: 460_046,
      numRuns: 1,
      path: "0:1",
      endOnFailure: true,
    });
  });

  it("honours caller defaults", () => {
    expect(resolveReplayConfig({}, { seed: 7, numRuns: 20 })).toEqual({
      seed: 7,
      numRuns: 20,
    });
  });

  it("rejects an unsafe FC_PATH, naming the variable", () => {
    expect(() => resolveReplayConfig({ FC_PATH: "../../private" })).toThrow(
      "FC_PATH",
    );
    expect(() => resolveReplayConfig({ FC_PATH: "1; rm -rf /" })).toThrow(
      "FC_PATH",
    );
  });

  it("rejects empty strings for every variable", () => {
    expect(() => resolveReplayConfig({ FC_PATH: "" })).toThrow("FC_PATH");
    expect(() => resolveReplayConfig({ FC_SEED: "" })).toThrow("FC_SEED");
    expect(() => resolveReplayConfig({ FC_RUNS: "" })).toThrow("FC_RUNS");
  });

  it("keeps the numeric bounds", () => {
    expect(() => resolveReplayConfig({ FC_RUNS: "201" })).toThrow("FC_RUNS");
    expect(() => resolveReplayConfig({ FC_RUNS: "0" })).toThrow("FC_RUNS");
    expect(resolveReplayConfig({ FC_RUNS: "200" }).numRuns).toBe(200);
    expect(() => resolveReplayConfig({ FC_SEED: "-1" })).toThrow("FC_SEED");
    expect(() => resolveReplayConfig({ FC_SEED: "2147483648" })).toThrow(
      "FC_SEED",
    );
    expect(resolveReplayConfig({ FC_SEED: "2147483647" }).seed).toBe(
      0x7fff_ffff,
    );
  });
});

describe("generatorHash", () => {
  it("is independent of the order of the file list", () => {
    expect(generatorHash([SOURCES[0]!, SOURCES[1]!])).toBe(
      generatorHash([SOURCES[1]!, SOURCES[0]!]),
    );
  });

  it("holds no host path and is 64 hex characters", () => {
    expect(generatorHash(SOURCES)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("formatReplayRecord", () => {
  const base = {
    format: "sample",
    seed: 460_046,
    path: "0:1",
    bytes: Buffer.from("abc"),
    generatorSources: SOURCES,
    faultPlan: null,
  };

  it("has exactly the version 2 keys and no host path", () => {
    const record = formatReplayRecord(base);
    expect(Object.keys(record).sort()).toEqual([...REPLAY_RECORD_KEYS]);
    expect(record.version).toBe(2);
    expect(record.fastCheckVersion).toBe(fc.__version);
    expect(record.fixtureSha256).toBe(bytesDigest(Buffer.from("abc")));
    expect(record.note).toContain("generatorHash");
    const text = JSON.stringify(record);
    expect(text).not.toContain(PACKAGE_ROOT);
    expect(text).not.toContain(tmpdir());
  });

  it("rejects a null path, an unsafe path, a negative seed and a bad format", () => {
    expect(() => formatReplayRecord({ ...base, path: null })).toThrow(
      "incomplete",
    );
    expect(() => formatReplayRecord({ ...base, path: "../x" })).toThrow(
      "incomplete",
    );
    expect(() => formatReplayRecord({ ...base, seed: -1 })).toThrow(
      "incomplete",
    );
    expect(() => formatReplayRecord({ ...base, format: "../x" })).toThrow(
      "incomplete",
    );
  });

  it("parseReplayRecord rejects a record with an extra key", () => {
    const record = { ...formatReplayRecord(base), hostPath: "/Users/x" };
    expect(() => parseReplayRecord(JSON.stringify(record))).toThrow("keys");
  });
});

describe("generatorHash adjacency", () => {
  it("changes when one byte of a generator file changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-hash-"));
    try {
      const original = resolve(PACKAGE_ROOT, SOURCES[1]!);
      const copy = join(directory, "generators.ts");
      copyFileSync(original, copy);
      const bytes = readFileSync(copy);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      writeFileSync(copy, bytes);
      // Hash the copy through a path relative to the package root.
      const changed = generatorHash([relativeFromRoot(copy)]);
      const unchanged = generatorHash([SOURCES[1]!]);
      expect(changed).not.toBe(unchanged);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function relativeFromRoot(absolute: string): string {
  const parts = absolute.split("/").filter(Boolean);
  const rootParts = PACKAGE_ROOT.split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < parts.length &&
    shared < rootParts.length &&
    parts[shared] === rootParts[shared]
  )
    shared += 1;
  return [
    ...Array<string>(rootParts.length - shared).fill(".."),
    ...parts.slice(shared),
  ].join("/");
}

describe("record reproduction on a format-neutral arbitrary (PBT-04)", () => {
  const toBytes = (sample: Buffer) => sample;
  const sampleArbitrary = () =>
    fc.uint8Array({ minLength: 0, maxLength: 400 }).map((a) => Buffer.from(a));

  it("replays the printed seed and path to the same bytes", async () => {
    const { record, arbitrary } = await forceFailure(sampleArbitrary(), {
      format: "sample",
      toBytes,
      sources: SOURCES,
    });
    expect(await replayDigest(record, arbitrary, toBytes)).toBe(
      record.fixtureSha256,
    );
  }, 30_000);

  it("fails the comparison when one digest character is flipped", async () => {
    const { record, arbitrary } = await forceFailure(sampleArbitrary(), {
      format: "sample",
      toBytes,
      sources: SOURCES,
    });
    const flipped = record.fixtureSha256.startsWith("a")
      ? `b${record.fixtureSha256.slice(1)}`
      : `a${record.fixtureSha256.slice(1)}`;
    expect(await replayDigest(record, arbitrary, toBytes)).not.toBe(flipped);
  }, 30_000);
});
