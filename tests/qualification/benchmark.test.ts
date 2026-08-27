import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const benchmark = require("../../scripts/qualification/benchmark.cjs") as {
  BENCHMARK_THRESHOLDS: {
    medianRatio: number;
    medianSlackNs: number;
    p95Ratio: number;
    p95SlackNs: number;
    peakRssSlackKiB: number;
    slopeSlack: number;
    slopeRangeToleranceBytes: number;
  };
  buildSchedule(
    fixtureIds: readonly string[],
    warmups: number,
    measurements: number,
  ): readonly {
    fixtureId: string;
    round: number;
    warmup: boolean;
    version: string;
  }[];
  percentile(values: readonly number[], quantile: number): number;
  rssSlope(
    aggregates: ReadonlyMap<string, { medianMaxRSSKiB: number }>,
    prefix: string,
  ): number;
  evaluatePair(input: {
    baseline: Record<string, number | string>;
    candidate: Record<string, number | string>;
  }): { pass: boolean; failures: readonly string[] };
  evaluateCancellation(input: Record<string, unknown>): {
    pass: boolean;
    failures: readonly string[];
  };
  exitCodeForMode(mode: "report" | "admit", pass: boolean): number;
  generateFixture(record: Record<string, unknown>): Buffer;
  loadBenchmarkManifest(): {
    seed: number;
    fixtures: readonly (Record<string, unknown> & {
      targetBytes: number;
      sha256: string;
    })[];
  };
  renderSummary(report: Record<string, unknown>): string;
  parseArguments(args: readonly string[]): Record<string, unknown>;
  validateBaselinePackage(
    packageJson: { name?: unknown; version?: unknown },
    sha256: string,
  ): {
    baselinePackageName: string;
    baselineVersion: string;
    baselineExpectedIdentity: string;
    baselineSha256: string;
  };
  BASELINE_TARBALL_SHA256: string;
};
const report = require("../../scripts/qualification/benchmark-report.cjs") as {
  evaluateTiming(input: {
    baselineMedianNs: number;
    candidateMedianNs: number;
    baselineP95Ns: number;
    candidateP95Ns: number;
  }): {
    pass: boolean;
    medianLimitNs: number;
    p95LimitNs: number;
    failures: string[];
  };
  deriveRunScale(input: {
    before: number[];
    after: number[];
    referenceMedianNs: number;
  }): {
    observedCalibrationNs: number;
    runScale: number;
  };
  validateCalibration(input: Record<string, unknown>): void;
};
const calibration =
  require("../../scripts/qualification/benchmark-calibration.cjs") as {
    workloadDigest(): string;
  };

describe("paired benchmark admission", () => {
  it("uses one common calibration scale that cancels a global runner factor", () => {
    const referenceMedianNs = 100;
    const normal = report.deriveRunScale({
      before: [100, 100, 100],
      after: [100, 100, 100],
      referenceMedianNs,
    });
    const slowerRunner = report.deriveRunScale({
      before: [200, 200, 200],
      after: [200, 200, 200],
      referenceMedianNs,
    });
    expect(100 * normal.runScale).toBe(200 * slowerRunner.runScale);
    expect(120 * normal.runScale).toBe(240 * slowerRunner.runScale);
  });

  it("uses the exact D-23 Math.max boundaries and rejects one nanosecond over", () => {
    const factor = report.evaluateTiming({
      baselineMedianNs: 100_000_000,
      candidateMedianNs: 120_000_000,
      baselineP95Ns: 100_000_000,
      candidateP95Ns: 135_000_000,
    });
    expect(factor).toMatchObject({
      pass: true,
      medianLimitNs: 120_000_000,
      p95LimitNs: 135_000_000,
    });
    expect(
      report.evaluateTiming({
        baselineMedianNs: 100_000_000,
        candidateMedianNs: 120_000_001,
        baselineP95Ns: 100_000_000,
        candidateP95Ns: 135_000_000,
      }).pass,
    ).toBe(false);
    const slack = report.evaluateTiming({
      baselineMedianNs: 10_000_000,
      candidateMedianNs: 25_000_000,
      baselineP95Ns: 10_000_000,
      candidateP95Ns: 40_000_000,
    });
    expect(slack).toMatchObject({
      pass: true,
      medianLimitNs: 25_000_000,
      p95LimitNs: 40_000_000,
    });
    expect(
      report.evaluateTiming({
        baselineMedianNs: 10_000_000,
        candidateMedianNs: 25_000_001,
        baselineP95Ns: 10_000_000,
        candidateP95Ns: 40_000_000,
      }).pass,
    ).toBe(false);
  });

  it("fails closed for calibration drift, side-specific fields, and malformed authority output", () => {
    const authority = {
      schemaVersion: 1,
      algorithmId: "exifcleaner-run-calibration-v1",
      nodeMajor: Number(process.versions.node.split(".")[0]),
      trials: [100, 100, 100],
      workloadDigest: calibration.workloadDigest(),
      process: { execPath: process.execPath, clean: true },
    };
    expect(() => report.validateCalibration(authority)).not.toThrow();
    expect(() =>
      report.validateCalibration({ ...authority, candidateCalibration: 1 }),
    ).toThrow();
    expect(() =>
      report.validateCalibration({ ...authority, trials: [0, 100, 100] }),
    ).toThrow();
    expect(() =>
      report.deriveRunScale({
        before: [100, 100, 100],
        after: [111, 111, 111],
        referenceMedianNs: 100,
      }),
    ).toThrow();
  });
  it("alternates baseline/candidate in fresh-child order with locked 2/15 counts", () => {
    const schedule = benchmark.buildSchedule(["still-64k"], 2, 15);
    expect(schedule).toHaveLength(34);
    expect(schedule.filter((item) => item.warmup)).toHaveLength(4);
    expect(schedule.filter((item) => !item.warmup)).toHaveLength(30);
    expect(schedule.slice(0, 8).map((item) => item.version)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
  });

  it("calculates locked nearest-rank percentiles", () => {
    expect(benchmark.percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(benchmark.percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it("calculates byte-per-byte RSS slope after the locked 4 MiB tolerance", () => {
    const mib = 1024 * 1024;
    const slope = benchmark.rssSlope(
      new Map([
        ["still-1m", { medianMaxRSSKiB: (100 * mib) / 1024 }],
        ["still-16m", { medianMaxRSSKiB: (105 * mib) / 1024 }],
        ["still-64m", { medianMaxRSSKiB: (110 * mib) / 1024 }],
      ]),
      "still",
    );
    expect(slope).toBe((6 * mib) / (63 * mib));
  });

  it("passes exact performance boundaries and fails one-unit exceedance", () => {
    expect(benchmark.BENCHMARK_THRESHOLDS).toEqual({
      medianRatio: 1.2,
      medianSlackNs: 15_000_000,
      p95Ratio: 1.35,
      p95SlackNs: 30_000_000,
      peakRssSlackKiB: 16_384,
      slopeSlack: 0.1,
      slopeRangeToleranceBytes: 4 * 1024 * 1024,
    });
    const baseline = {
      correctnessKey: "same",
      medianElapsedNs: 100_000_000,
      p95ElapsedNs: 100_000_000,
      medianMaxRSSKiB: 100_000,
      rssSlope: 0.2,
    };
    const boundary = {
      correctnessKey: "same",
      medianElapsedNs: 120_000_000,
      p95ElapsedNs: 135_000_000,
      medianMaxRSSKiB: 116_384,
      rssSlope: 0.3,
    };
    expect(benchmark.evaluatePair({ baseline, candidate: boundary })).toEqual({
      pass: true,
      failures: [],
    });
    for (const field of [
      "medianElapsedNs",
      "p95ElapsedNs",
      "medianMaxRSSKiB",
      "rssSlope",
    ] as const) {
      const candidate = { ...boundary, [field]: boundary[field] + 1 };
      expect(benchmark.evaluatePair({ baseline, candidate }).pass).toBe(false);
    }
  });

  it("fails correctness before considering numeric performance", () => {
    const result = benchmark.evaluatePair({
      baseline: {
        correctnessKey: "baseline-output",
        medianElapsedNs: 100,
        p95ElapsedNs: 100,
        medianMaxRSSKiB: 100,
        rssSlope: 0,
      },
      candidate: {
        correctnessKey: "different-output",
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: 1,
        rssSlope: 0,
      },
    });
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain("correctness");
  });

  it("enforces exact cancellation and truthful-finalization boundaries", () => {
    const boundary = {
      code: "aborted",
      destinationAbsent: true,
      finalizationTruthful: true,
      secondWriter: false,
      finalizationStartMs: 250,
      terminalMs: 2_000,
    };
    expect(benchmark.evaluateCancellation(boundary)).toEqual({
      pass: true,
      failures: [],
    });
    for (const field of ["finalizationStartMs", "terminalMs"] as const)
      expect(
        benchmark.evaluateCancellation({
          ...boundary,
          [field]: boundary[field] + 0.001,
        }).pass,
      ).toBe(false);
    expect(
      benchmark.evaluateCancellation({
        ...boundary,
        finalization: "truthful-residue",
      }).pass,
    ).toBe(true);
    expect(
      benchmark.evaluateCancellation({ ...boundary, secondWriter: true }).pass,
    ).toBe(false);
  });

  it("binds every deterministic fixture to the committed manifest", () => {
    const manifest = benchmark.loadBenchmarkManifest();
    expect(manifest.seed).toBe(460_070);
    expect(manifest.fixtures).toHaveLength(12);
    for (const record of manifest.fixtures) {
      const fixture = benchmark.generateFixture(record);
      expect(fixture).toHaveLength(record.targetBytes);
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(
        record.sha256,
      );
    }
  });

  it("keeps the 16 MiB animation fixture bounded and retains the additive Node 22 ceiling", async () => {
    const manifest = benchmark.loadBenchmarkManifest();
    const animation = manifest.fixtures.find(
      (fixture) => fixture.id === "animation-alpha-16m",
    );
    expect(animation).toMatchObject({
      targetBytes: 16 * 1024 * 1024,
      sha256:
        "73fc89a949c4632c4797d10fd10ef7abeec1f35e7ba5959918bd4d580fba5908",
    });
    expect(benchmark.BENCHMARK_THRESHOLDS.peakRssSlackKiB).toBe(16_384);
    expect(153_500).toBeLessThanOrEqual(
      137_116 + benchmark.BENCHMARK_THRESHOLDS.peakRssSlackKiB,
    );
    const child = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-child.cjs"),
      "utf8",
    );
    expect(child).toContain("materializeFixture");
    expect(child).toContain("package-load");
    expect(child).toContain("fixture-materialized");
    expect(child).toContain("sanitize-complete");
    expect(child).toContain("correctness-complete");
    expect(child).not.toContain("generateFixture(options.fixture)");
    expect(child).not.toMatch(/readFileSync\(destinationPath\)/u);
    expect(child).not.toMatch(/readFileSync\(sourcePath\)/u);
    expect(child).not.toMatch(/global\.gc|process\.gc/u);
  });

  it("uses a bounded MiB payload I/O window to avoid hundreds of scheduler-sensitive file operations", async () => {
    const riff = await readFile(
      join(projectRoot, "src", "webp", "riff.ts"),
      "utf8",
    );
    const handler = await readFile(
      join(projectRoot, "src", "admission", "webp-handler.ts"),
      "utf8",
    );
    expect(riff).toContain("export const COPY_BLOCK_BYTES = 1024 * 1024");
    expect(riff).not.toContain("COPY_BLOCK_BYTES = 64 * 1024");
    expect(handler).toContain("const left = await sourceHandle.read(");
    expect(handler).toContain("const right = await destinationHandle.read(");
    expect(handler).not.toContain("const [left, right] = await Promise.all");
  });

  it("requires explicit packed baseline/candidate inputs and fresh child execution", async () => {
    expect(() => benchmark.parseArguments([])).toThrow("--baseline-tarball");
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark.cjs"),
      "utf8",
    );
    expect(source).toContain("benchmark-child.cjs");
    expect(source).toContain("spawnSync");
    expect(source).not.toMatch(/git\s+(?:show|checkout)|checkout source/u);
  });

  it("rejects a baseline package whose installed name is not exifcleaner-node", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "impostor-package",
          version: "0.1.1",
        },
        "a".repeat(64),
      ),
    ).toThrow("Baseline package name is not exifcleaner-node");
  });

  it("rejects a baseline package whose installed version is not exactly 0.1.1", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.2",
        },
        "a".repeat(64),
      ),
    ).toThrow("Baseline package is not v0.1.1");
  });

  it("rejects a repacked baseline with the trusted name and version", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.1",
        },
        "0".repeat(64),
      ),
    ).toThrow("Baseline tarball digest does not match the trusted artifact");
  });

  it("emits the complete digest-bound baseline identity contract", () => {
    expect(
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.1",
        },
        benchmark.BASELINE_TARBALL_SHA256,
      ),
    ).toEqual({
      baselinePackageName: "exifcleaner-node",
      baselineVersion: "0.1.1",
      baselineExpectedIdentity: `exifcleaner-node@0.1.1#sha256:${benchmark.BASELINE_TARBALL_SHA256}`,
      baselineSha256: benchmark.BASELINE_TARBALL_SHA256,
    });
  });

  it("keeps report mode informational and admit mode hard-failing", () => {
    expect(benchmark.exitCodeForMode("report", false)).toBe(0);
    expect(benchmark.exitCodeForMode("admit", false)).toBe(1);
    expect(benchmark.exitCodeForMode("admit", true)).toBe(0);
    const summary = benchmark.renderSummary({
      pass: false,
      baselineSha256: "a".repeat(64),
      candidateSha256: "b".repeat(64),
      failures: ["median threshold"],
    });
    expect(summary).toContain("NOT ADMITTED");
    expect(summary).toContain("median threshold");
    expect(summary).not.toMatch(/awesome|celebrat|blazing/iu);
  });

  it("publishes the locked baseline, formulas, replay, and bounded claims", async () => {
    const documentation = await readFile(
      join(projectRoot, "docs", "benchmark-admission.md"),
      "utf8",
    );
    const normalized = documentation.replace(/\s+/gu, " ");
    for (const claim of [
      "packed `v0.1.1` baseline",
      "fifteen measurements",
      "baseline median × 1.20",
      "baseline p95 × 1.35",
      "16 MiB",
      "250 ms",
      "2 seconds",
      "--fixture still-64k",
      "Node.js 22 and 24",
      "does not prove decoder or color correctness",
    ])
      expect(normalized).toContain(claim);
  });
});
