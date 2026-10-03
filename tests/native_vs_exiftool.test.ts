// Unit tests for scripts/qualification/native-vs-exiftool.cjs (62.1-12, D-30,
// QUA-05). No real ExifTool: the session protocol runs against
// tests/support/fake-exiftool.cjs. The file name deliberately has no
// "benchmark" token; this is a cheap unit test, not a full-scope benchmark.
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(
  packageRoot,
  "scripts",
  "qualification",
  "native-vs-exiftool.cjs",
);
const fakeExifToolPath = join(
  packageRoot,
  "tests",
  "support",
  "fake-exiftool.cjs",
);
// A vendored corpus file the native engine sanitizes (manifest outcome: success).
const corpusHeic = join(
  packageRoot,
  "tests",
  "corpus",
  "constructed",
  "heic",
  "heif-enc-grid.heic",
);

interface Session {
  sanitize(source: string, destination: string): Promise<number>;
  version(): Promise<string>;
  close(): Promise<{
    code: number | null;
    signal: string | null;
    peakRSSKiB: number;
  }>;
}
interface Verdict {
  pass: boolean;
  failures: string[];
}
interface Summary {
  timeRatio: number;
  rssRatio: number;
  marginalPeakRSSKiB: number;
  totalRssRatio: number;
  native: { p50Ms: number; p95Ms: number };
  exiftool: { p50Ms: number; p95Ms: number };
  verdict: Verdict;
}
const script = require(scriptPath) as {
  SLACK_RATIO: number;
  computeVerdict(ratios: { timeRatio: number; rssRatio: number }): Verdict;
  summarize(input: {
    files: { nativeMedianMs: number; exiftoolMedianMs: number }[];
    nativePeakRSSKiB: number;
    nativeBaselineRSSKiB: number;
    exiftoolPeakRSSKiB: number;
  }): Summary;
  marginalPeakRSS(input: {
    nativePeakRSSKiB: number;
    nativeBaselineRSSKiB: number;
  }): number;
  parseDarwinTimeRSSKiB(stderr: string): number;
  parseVmHWMKiB(status: string): number;
  openExifToolSession(options: {
    command: string[];
    platform: NodeJS.Platform;
  }): Session;
};

const supportedHost =
  process.platform === "linux" || process.platform === "darwin";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "native-vs-exiftool-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe("native-vs-exiftool verdict rule (fixed before measuring)", () => {
  it("passes at exactly 0.90 on both ratios", () => {
    expect(script.SLACK_RATIO).toBe(0.9);
    expect(script.computeVerdict({ timeRatio: 0.9, rssRatio: 0.9 })).toEqual({
      pass: true,
      failures: [],
    });
  });

  it("fails 0.9001 on either ratio and names which", () => {
    const time = script.computeVerdict({ timeRatio: 0.9001, rssRatio: 0.9 });
    expect(time.pass).toBe(false);
    expect(time.failures).toEqual(["time ratio 0.900 > 0.90 (0.9001)"]);
    const rss = script.computeVerdict({ timeRatio: 0.9, rssRatio: 0.9001 });
    expect(rss.pass).toBe(false);
    expect(rss.failures).toEqual([
      "marginal peak RSS ratio 0.900 > 0.90 (0.9001)",
    ]);
  });

  it("decides on the median per-file ratio, so a passing p95 cannot rescue a failing median", () => {
    const summary = script.summarize({
      files: [
        { nativeMedianMs: 10, exiftoolMedianMs: 10 },
        { nativeMedianMs: 10, exiftoolMedianMs: 10 },
        { nativeMedianMs: 10, exiftoolMedianMs: 10 },
        { nativeMedianMs: 10, exiftoolMedianMs: 10 },
        { nativeMedianMs: 50, exiftoolMedianMs: 100 },
      ],
      nativePeakRSSKiB: 80,
      nativeBaselineRSSKiB: 30,
      exiftoolPeakRSSKiB: 100,
    });
    // p95 over per-file medians: native 50 / ExifTool 100 = 0.5 would pass.
    expect(summary.native.p95Ms / summary.exiftool.p95Ms).toBe(0.5);
    expect(summary.native.p50Ms).toBe(10);
    expect(summary.exiftool.p50Ms).toBe(10);
    // The median of the per-file ratios [1, 1, 1, 1, 0.5] is 1.
    expect(summary.timeRatio).toBe(1);
    expect(summary.rssRatio).toBe(0.5);
    expect(summary.verdict.pass).toBe(false);
    expect(summary.verdict.failures).toEqual(["time ratio 1.000 > 0.90 (1)"]);
  });
});

describe("native-vs-exiftool marginal peak RSS (maintainer decision 2026-10-03)", () => {
  const passingTime = [{ nativeMedianMs: 5, exiftoolMedianMs: 10 }];

  it("judges RSS on native's peak minus its post-import baseline, not the whole process", () => {
    // The plan's darwin run: 84496 - 60176 = 24320 KiB against 43840 KiB.
    const summary = script.summarize({
      files: passingTime,
      nativePeakRSSKiB: 84496,
      nativeBaselineRSSKiB: 60176,
      exiftoolPeakRSSKiB: 43840,
    });
    expect(summary.marginalPeakRSSKiB).toBe(24320);
    expect(summary.rssRatio).toBeCloseTo(24320 / 43840, 12);
    // Whole-process ratio stays in the report and would have failed.
    expect(summary.totalRssRatio).toBeCloseTo(84496 / 43840, 12);
    expect(summary.totalRssRatio).toBeGreaterThan(0.9);
    expect(summary.verdict).toEqual({ pass: true, failures: [] });
  });

  it("negative control: a marginal peak above 0.90 of ExifTool's fails", () => {
    const summary = script.summarize({
      files: passingTime,
      nativePeakRSSKiB: 160,
      nativeBaselineRSSKiB: 69,
      exiftoolPeakRSSKiB: 100,
    });
    expect(summary.marginalPeakRSSKiB).toBe(91);
    expect(summary.rssRatio).toBe(0.91);
    expect(summary.verdict.pass).toBe(false);
    expect(summary.verdict.failures).toEqual([
      "marginal peak RSS ratio 0.910 > 0.90 (0.91)",
    ]);
  });

  it("passes a marginal peak at exactly 0.90", () => {
    const summary = script.summarize({
      files: passingTime,
      nativePeakRSSKiB: 150,
      nativeBaselineRSSKiB: 60,
      exiftoolPeakRSSKiB: 100,
    });
    expect(summary.rssRatio).toBe(0.9);
    expect(summary.verdict.pass).toBe(true);
  });

  it("refuses a baseline above the peak instead of reporting a negative margin", () => {
    expect(() =>
      script.marginalPeakRSS({
        nativePeakRSSKiB: 100,
        nativeBaselineRSSKiB: 101,
      }),
    ).toThrow(/not at or below its peak/u);
  });
});

describe("native-vs-exiftool peak RSS readers", () => {
  it("reads darwin /usr/bin/time -l maximum resident set size (bytes) as KiB", () => {
    const stderr = [
      "        0.00 real         0.00 user         0.00 sys",
      "             1294336  maximum resident set size",
      "                   0  average shared memory size",
    ].join("\n");
    expect(script.parseDarwinTimeRSSKiB(stderr)).toBe(1264);
    expect(() => script.parseDarwinTimeRSSKiB("no report")).toThrow(
      /maximum resident set size/u,
    );
  });

  it("reads linux VmHWM (kB) from /proc/<pid>/status", () => {
    const status = "Name:\tperl\nVmPeak:\t  30000 kB\nVmHWM:\t   21504 kB\n";
    expect(script.parseVmHWMKiB(status)).toBe(21504);
    expect(() => script.parseVmHWMKiB("Name:\tperl\n")).toThrow(/VmHWM/u);
  });
});

describe("native-vs-exiftool stay_open session", () => {
  it.skipIf(!supportedHost)(
    "times one file through one persistent session, reads its peak RSS and closes it cleanly",
    async () => {
      await withTempDir(async (dir) => {
        const source = join(dir, "source.heic");
        const destination = join(dir, "destination.heic");
        await writeFile(source, Buffer.from("not really a heic"));
        const session = script.openExifToolSession({
          command: [process.execPath, fakeExifToolPath],
          platform: process.platform,
        });
        expect(await session.version()).toBe("13.59");
        const elapsed = await session.sanitize(source, destination);
        expect(elapsed).toBeGreaterThan(0);
        expect(existsSync(destination)).toBe(true);
        expect(readFileSync(destination)).toEqual(readFileSync(source));
        const closed = await session.close();
        expect(closed.code).toBe(0);
        expect(closed.signal).toBeNull();
        // A node process cannot peak below 1 MiB resident.
        expect(closed.peakRSSKiB).toBeGreaterThan(1024);
      });
    },
  );

  it("refuses an unsupported platform: the CLI exits 2 with a message", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `require(${JSON.stringify(scriptPath)}).main(process.argv.slice(1), { platform: "win32" }).then((code) => { process.exitCode = code; });`,
        "--",
        "--exiftool",
        fakeExifToolPath,
        "--files",
        corpusHeic,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "native-vs-exiftool: unsupported platform win32 (linux and darwin only)",
    );
  });
});

interface CliReport {
  native: {
    peakRSSKiB: number;
    baselineMaxRSSKiB: number;
    marginalPeakRSSKiB: number;
  };
  exiftool: { peakRSSKiB: number };
  summary: Summary;
}

describe("native-vs-exiftool cleanup", () => {
  async function runCli(
    env: Record<string, string>,
    whileRunning?: (pidFile: string) => Promise<NodeJS.Signals | undefined>,
  ) {
    return withTempDir(async (scratch) => {
      const jsonPath = join(scratch, "report.json");
      const runTmp = join(scratch, "tmp");
      const pidFile = join(scratch, "fake.pid");
      await mkdir(runTmp);
      const child = spawn(
        process.execPath,
        [
          scriptPath,
          "--exiftool",
          fakeExifToolPath,
          "--interpreter",
          process.execPath,
          "--files",
          corpusHeic,
          "--repeat",
          "1",
          "--json",
          jsonPath,
        ],
        {
          env: {
            ...process.env,
            TMPDIR: runTmp,
            FAKE_EXIFTOOL_PID_FILE: pidFile,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (code) => resolve(code)),
      );
      if (whileRunning !== undefined) {
        const signal = await whileRunning(pidFile);
        if (signal !== undefined) child.kill(signal);
      }
      const code = await exited;
      const fakePid = existsSync(pidFile)
        ? Number(readFileSync(pidFile, "utf8"))
        : undefined;
      return {
        code,
        stderr,
        stdout,
        report: existsSync(jsonPath)
          ? (JSON.parse(readFileSync(jsonPath, "utf8")) as CliReport)
          : undefined,
        leftovers: await readdir(runTmp),
        fakePid,
      };
    });
  }

  it.skipIf(!supportedHost)(
    "SIGINT mid-file kills the ExifTool child, removes the temp root and exits non-zero",
    async () => {
      const result = await runCli(
        { FAKE_EXIFTOOL_HANG: "1" },
        async (pidFile) => {
          expect(await waitFor(() => existsSync(pidFile), 20_000)).toBe(true);
          return "SIGINT";
        },
      );
      expect(result.code).toBe(130);
      expect(result.stderr).toContain("interrupted");
      expect(result.leftovers).toEqual([]);
      expect(result.fakePid).toBeGreaterThan(0);
      expect(isAlive(result.fakePid as number)).toBe(false);
    },
    30_000,
  );

  it.skipIf(!supportedHost)(
    "a full run against the fake ExifTool reports and judges the marginal native peak",
    async () => {
      const result = await runCli({});
      expect([0, 3]).toContain(result.code);
      expect(result.leftovers).toEqual([]);
      expect(isAlive(result.fakePid as number)).toBe(false);
      const report = result.report as CliReport;
      expect(report.native.marginalPeakRSSKiB).toBe(
        report.native.peakRSSKiB - report.native.baselineMaxRSSKiB,
      );
      expect(report.summary.marginalPeakRSSKiB).toBe(
        report.native.marginalPeakRSSKiB,
      );
      expect(report.summary.rssRatio).toBe(
        report.native.marginalPeakRSSKiB / report.exiftool.peakRSSKiB,
      );
      expect(report.summary.totalRssRatio).toBe(
        report.native.peakRSSKiB / report.exiftool.peakRSSKiB,
      );
      expect(result.stdout).toContain(
        "marginal peak RSS ratio native/ExifTool (verdict):",
      );
      expect(result.stdout).toContain(
        "whole-process peak RSS ratio native/ExifTool (informative):",
      );
    },
    30_000,
  );

  it.skipIf(!supportedHost)(
    "an ExifTool error mid-run kills the child, removes the temp root and exits 1",
    async () => {
      const result = await runCli({ FAKE_EXIFTOOL_SKIP_OUTPUT: "1" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ExifTool did not create");
      expect(result.leftovers).toEqual([]);
      expect(result.fakePid).toBeGreaterThan(0);
      expect(isAlive(result.fakePid as number)).toBe(false);
    },
    30_000,
  );
});
