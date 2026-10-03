#!/usr/bin/env node
"use strict";

/*
 * Native vs ExifTool performance comparison (62.1-12, D-30, QUA-05).
 *
 * benchmark.cjs compares the candidate package with the pinned 0.1.1 package
 * on WebP and never runs ExifTool, so it cannot carry QUA-05 (D-30 amends
 * D20). This script compares a full native `sanitizeFile` call (every
 * preservation flag false, so the identity proof's second read of every
 * surviving item is inside the timed call) with ExifTool driven the way the
 * app drives it: one persistent `-stay_open True -@ -` session, one
 * `-all= -o <dest> <src>` command per file, each timed from the write until
 * its `{ready<N>}` line. Perl startup is outside every per-file time.
 *
 * Verdict rule (fixed in 62.1-12 before measuring): per file, 1 warm-up and
 * `--repeat` (default 5) timed runs per side, the per-file median per side.
 * Pass when the median over files of native/ExifTool time ratios is at most
 * SLACK_RATIO (0.90) AND the peak RSS ratio native/ExifTool is at most 0.90.
 * p50 and p95 per side are printed, never used as the verdict.
 *
 * The RSS side of the rule compares native's MARGINAL peak (the child's peak
 * minus its post-import, pre-work baseline) with ExifTool's whole-process
 * peak, because Node is already resident in the app and only the native work
 * is added to it (maintainer decision, 2026-10-03, QUA-05). The whole-process
 * native peak and its ratio are still reported for transparency. The time
 * rule is unchanged.
 *
 * Peak RSS: native from process.resourceUsage().maxRSS in a dedicated child;
 * ExifTool from VmHWM in /proc/<pid>/status just before closing the session
 * (linux) or `/usr/bin/time -l` maximum resident set size (darwin). Any other
 * platform exits 2.
 *
 * Usage:
 *   node scripts/qualification/native-vs-exiftool.cjs --exiftool <path>
 *     --files <a,b,...> [--repeat 5] [--json <out>] [--interpreter perl]
 *
 * Exit codes: 0 pass, 3 measured and the rule failed, 1 error, 2 unsupported
 * platform, 130 interrupted. Files run sequentially; SIGINT or an error kills
 * every child process group and removes the temp root before exiting.
 *
 * It is a measurement tool. No CI job runs it; only its unit test runs in CI.
 */

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const { percentile } = require("./benchmark-report.cjs");

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_REPEAT = 5;
const WARM_UPS = 1;
const SLACK_RATIO = 0.9;
const SUPPORTED_PLATFORMS = new Set(["linux", "darwin"]);

/** Live child process groups and temp roots, for interrupt/error cleanup. */
const liveChildren = new Set();
const liveRoots = new Set();

/**
 * Exact middle for an odd count, the upper middle for an even one. Indexed
 * directly: `percentile(values, 0.5 + 0.5 / n)` rounds up one rank for some
 * odd n (29, 87, ...) through floating point (62.1-13 WR-01). `percentile`
 * still validates the values.
 */
function median(values) {
  percentile(values, 1);
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function computeVerdict({ timeRatio, rssRatio }) {
  const failures = [];
  if (!(timeRatio <= SLACK_RATIO))
    failures.push(`time ratio ${timeRatio.toFixed(3)} > 0.90 (${timeRatio})`);
  if (!(rssRatio <= SLACK_RATIO))
    failures.push(
      `marginal peak RSS ratio ${rssRatio.toFixed(3)} > 0.90 (${rssRatio})`,
    );
  return { pass: failures.length === 0, failures };
}

/** Native peak minus the post-import Node footprint: what native work adds. */
function marginalPeakRSS({ nativePeakRSSKiB, nativeBaselineRSSKiB }) {
  if (
    !Number.isFinite(nativePeakRSSKiB) ||
    !Number.isFinite(nativeBaselineRSSKiB) ||
    nativeBaselineRSSKiB > nativePeakRSSKiB
  )
    throw new Error(
      `native baseline RSS ${nativeBaselineRSSKiB} KiB is not at or below its peak ${nativePeakRSSKiB} KiB`,
    );
  return nativePeakRSSKiB - nativeBaselineRSSKiB;
}

function summarize({
  files,
  nativePeakRSSKiB,
  nativeBaselineRSSKiB,
  exiftoolPeakRSSKiB,
}) {
  const nativeMedians = files.map((file) => file.nativeMedianMs);
  const exiftoolMedians = files.map((file) => file.exiftoolMedianMs);
  const timeRatio = median(
    files.map((file) => file.nativeMedianMs / file.exiftoolMedianMs),
  );
  const marginalPeakRSSKiB = marginalPeakRSS({
    nativePeakRSSKiB,
    nativeBaselineRSSKiB,
  });
  const rssRatio = marginalPeakRSSKiB / exiftoolPeakRSSKiB;
  return {
    timeRatio,
    rssRatio,
    marginalPeakRSSKiB,
    totalRssRatio: nativePeakRSSKiB / exiftoolPeakRSSKiB,
    native: {
      p50Ms: median(nativeMedians),
      p95Ms: percentile(nativeMedians, 0.95),
    },
    exiftool: {
      p50Ms: median(exiftoolMedians),
      p95Ms: percentile(exiftoolMedians, 0.95),
    },
    verdict: computeVerdict({ timeRatio, rssRatio }),
  };
}

/** darwin `/usr/bin/time -l` reports maximum resident set size in bytes. */
function parseDarwinTimeRSSKiB(stderr) {
  const match = /(\d+)\s+maximum resident set size/u.exec(stderr);
  if (match === null)
    throw new Error("no maximum resident set size in /usr/bin/time -l output");
  return Number(match[1]) / 1024;
}

/** linux /proc/<pid>/status VmHWM is the peak resident set size in kB. */
function parseVmHWMKiB(status) {
  const match = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(status);
  if (match === null) throw new Error("no VmHWM line in /proc/<pid>/status");
  return Number(match[1]);
}

function unsupportedPlatform(platform) {
  return `native-vs-exiftool: unsupported platform ${platform} (linux and darwin only)`;
}

function parseArguments(args) {
  const options = {
    exiftool: undefined,
    files: undefined,
    repeat: DEFAULT_REPEAT,
    json: undefined,
    interpreter: "perl",
    packageRoot: PACKAGE_ROOT,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--exiftool") options.exiftool = path.resolve(value);
    else if (flag === "--files")
      options.files = value
        .split(",")
        .filter((entry) => entry.length > 0)
        .map((entry) => path.resolve(entry));
    else if (flag === "--repeat") options.repeat = Number(value);
    else if (flag === "--json") options.json = path.resolve(value);
    else if (flag === "--interpreter") options.interpreter = value;
    else if (flag === "--package-root")
      options.packageRoot = path.resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (options.exiftool === undefined) throw new Error("--exiftool is required");
  if (options.files === undefined || options.files.length === 0)
    throw new Error("--files needs at least one file");
  if (
    !Number.isInteger(options.repeat) ||
    options.repeat < 1 ||
    options.repeat % 2 === 0
  )
    throw new Error("--repeat must be an odd positive integer");
  return options;
}

function destinationName(fileIndex, run, source) {
  return `${fileIndex}-${run}${path.extname(source)}`;
}

/* -------------------------------------------------------- child tracking */

/**
 * Spawns `file args` as its own process group so a kill reaches every
 * descendant (darwin's `/usr/bin/time` wrapper and the perl under it).
 */
function spawnTracked(file, args) {
  const child = spawn(file, args, {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  const entry = { child, exited };
  liveChildren.add(entry);
  exited.then(() => liveChildren.delete(entry));
  return entry;
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** SIGKILLs the whole group and waits until the leader is reaped and the group is empty. */
async function killTracked(entry) {
  const { child, exited } = entry;
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  await exited;
  const deadline = Date.now() + 5000;
  while (groupAlive(child.pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

async function cleanupAll() {
  await Promise.all([...liveChildren].map((entry) => killTracked(entry)));
  await Promise.all(
    [...liveRoots].map((root) =>
      fsPromises.rm(root, { recursive: true, force: true }),
    ),
  );
  liveRoots.clear();
}

/* ---------------------------------------------------------------- native */

/** Runs inside the dedicated native child (the benchmark-child.cjs maxRSS pattern). */
async function nativeChildMain(spec) {
  const { sanitizeFile } = await import(
    pathToFileURL(path.join(spec.packageRoot, "dist", "index.js")).href
  );
  // Node reports resourceUsage().maxRSS in KiB on every platform (libuv
  // divides darwin's byte count). Measured on Node 24.19 darwin-arm64: a
  // 200 MB buffer gave maxRSS 238496 against memoryUsage().rss / 1024 238560,
  // so benchmark-child.cjs's darwin "/ 1024" would under-report 1024-fold.
  const baselineMaxRSSKiB = process.resourceUsage().maxRSS;
  const files = [];
  for (const [fileIndex, source] of spec.files.entries()) {
    const ms = [];
    for (let run = 0; run < WARM_UPS + spec.repeat; run += 1) {
      const destinationPath = path.join(
        spec.outputDir,
        destinationName(fileIndex, run, source),
      );
      const started = performance.now();
      const result = await sanitizeFile({
        sourcePath: source,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      const elapsed = performance.now() - started;
      if (!result.ok)
        throw new Error(
          `native sanitize refused ${source}: ${JSON.stringify(result.error)}`,
        );
      await fsPromises.rm(destinationPath, { force: true });
      if (run >= WARM_UPS) ms.push(elapsed);
    }
    files.push({ path: source, ms });
  }
  return {
    files,
    baselineMaxRSSKiB,
    maxRSSKiB: process.resourceUsage().maxRSS,
  };
}

async function runNativeChild(spec) {
  const entry = spawnTracked(process.execPath, [
    __filename,
    "--native-child",
    JSON.stringify(spec),
  ]);
  const { child } = entry;
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const { code, signal } = await entry.exited;
  if (code !== 0)
    throw new Error(
      `native child failed (${code ?? signal}): ${stderr.trim()}`,
    );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`native child output is not JSON: ${error.message}`);
  }
}

/* -------------------------------------------------------------- exiftool */

/**
 * One persistent ExifTool session, spawned with the app's argument shape
 * (`-stay_open True -@ -`, ExiftoolProcess.ts). Commands are written one
 * argument per line and end with `-execute<N>`; the reply ends with
 * `{ready<N>}`. On darwin the session runs under `/usr/bin/time -l` so its
 * peak RSS is reported when it exits.
 */
function openExifToolSession({ command, platform }) {
  if (!SUPPORTED_PLATFORMS.has(platform))
    throw new Error(unsupportedPlatform(platform));
  const sessionArgs = [...command, "-stay_open", "True", "-@", "-"];
  const entry =
    platform === "darwin"
      ? spawnTracked("/usr/bin/time", ["-l", ...sessionArgs])
      : spawnTracked(sessionArgs[0], sessionArgs.slice(1));
  const { child, exited } = entry;
  let stdout = "";
  let stderr = "";
  let counter = 0;
  let pending = null;
  child.on("error", (error) => pending?.reject(error));
  child.stdin.on("error", (error) => pending?.reject(error));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (pending === null) return;
    const marker = `{ready${pending.number}}`;
    const at = stdout.indexOf(marker);
    if (at === -1) return;
    const output = stdout.slice(0, at);
    stdout = stdout.slice(at + marker.length).replace(/^\r?\n/u, "");
    const done = pending;
    pending = null;
    done.resolve({ output, at: performance.now() });
  });
  exited.then(({ code, signal }) =>
    pending?.reject(
      new Error(
        `ExifTool exited mid-command (${code ?? signal}): ${stderr.trim()}`,
      ),
    ),
  );

  function send(args) {
    if (pending !== null) throw new Error("one ExifTool command at a time");
    const number = counter;
    counter += 1;
    return new Promise((resolve, reject) => {
      pending = { number, resolve, reject };
      child.stdin.write(`${[...args, `-execute${number}`].join("\n")}\n`);
    });
  }

  async function sanitize(source, destination) {
    const started = performance.now();
    const { output, at } = await send(["-all=", "-o", destination, source]);
    const elapsed = at - started;
    if (!fs.existsSync(destination))
      throw new Error(
        `ExifTool did not create ${destination}: ${output.trim()} ${stderr.trim()}`,
      );
    return elapsed;
  }

  async function version() {
    const { output } = await send(["-ver"]);
    return output.trim();
  }

  async function close() {
    const linuxPeak =
      platform === "linux"
        ? parseVmHWMKiB(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"))
        : undefined;
    child.stdin.write("-stay_open\nFalse\n");
    child.stdin.end();
    const { code, signal } = await exited;
    return {
      code,
      signal,
      peakRSSKiB: linuxPeak ?? parseDarwinTimeRSSKiB(stderr),
    };
  }

  return { child, sanitize, version, close, kill: () => killTracked(entry) };
}

async function measureExifTool({
  command,
  platform,
  files,
  repeat,
  outputDir,
}) {
  const session = openExifToolSession({ command, platform });
  try {
    const exiftoolVersion = await session.version();
    const measured = [];
    for (const [fileIndex, source] of files.entries()) {
      const ms = [];
      for (let run = 0; run < WARM_UPS + repeat; run += 1) {
        const destination = path.join(
          outputDir,
          destinationName(fileIndex, run, source),
        );
        const elapsed = await session.sanitize(source, destination);
        await fsPromises.rm(destination, { force: true });
        if (run >= WARM_UPS) ms.push(elapsed);
      }
      measured.push({ path: source, ms });
    }
    const closed = await session.close();
    if (closed.code !== 0)
      throw new Error(
        `ExifTool session closed with ${closed.code ?? closed.signal}`,
      );
    return { exiftoolVersion, files: measured, peakRSSKiB: closed.peakRSSKiB };
  } finally {
    await session.kill();
  }
}

/* ------------------------------------------------------------------ main */

async function run(options, platform) {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "native-vs-exiftool-"),
  );
  liveRoots.add(root);
  try {
    const nativeDir = path.join(root, "native");
    const exiftoolDir = path.join(root, "exiftool");
    await fsPromises.mkdir(nativeDir);
    await fsPromises.mkdir(exiftoolDir);
    const native = await runNativeChild({
      packageRoot: options.packageRoot,
      files: options.files,
      repeat: options.repeat,
      outputDir: nativeDir,
    });
    const exiftool = await measureExifTool({
      command: [options.interpreter, options.exiftool],
      platform,
      files: options.files,
      repeat: options.repeat,
      outputDir: exiftoolDir,
    });
    const files = options.files.map((source, index) => {
      const nativeMedianMs = median(native.files[index].ms);
      const exiftoolMedianMs = median(exiftool.files[index].ms);
      return {
        path: source,
        bytes: fs.statSync(source).size,
        nativeMs: native.files[index].ms,
        exiftoolMs: exiftool.files[index].ms,
        nativeMedianMs,
        exiftoolMedianMs,
        ratio: nativeMedianMs / exiftoolMedianMs,
      };
    });
    return {
      machine: {
        platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
      },
      node: process.version,
      exiftoolVersion: exiftool.exiftoolVersion,
      repeat: options.repeat,
      warmUps: WARM_UPS,
      slackRatio: SLACK_RATIO,
      files,
      native: {
        peakRSSKiB: native.maxRSSKiB,
        baselineMaxRSSKiB: native.baselineMaxRSSKiB,
        marginalPeakRSSKiB: marginalPeakRSS({
          nativePeakRSSKiB: native.maxRSSKiB,
          nativeBaselineRSSKiB: native.baselineMaxRSSKiB,
        }),
      },
      exiftool: { peakRSSKiB: exiftool.peakRSSKiB },
      summary: summarize({
        files,
        nativePeakRSSKiB: native.maxRSSKiB,
        nativeBaselineRSSKiB: native.baselineMaxRSSKiB,
        exiftoolPeakRSSKiB: exiftool.peakRSSKiB,
      }),
    };
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
    liveRoots.delete(root);
  }
}

function formatReport(report) {
  const { summary } = report;
  const lines = [
    `native vs ExifTool ${report.exiftoolVersion} (-stay_open), ${report.files.length} file(s), ${report.warmUps} warm-up + ${report.repeat} timed run(s) per side`,
    `machine: ${report.machine.cpu} x${report.machine.cpus}, ${report.machine.platform}-${report.machine.arch}, node ${report.node}, loadavg ${report.machine.loadavg.map((value) => value.toFixed(2)).join(" ")}`,
    "",
    "file | bytes | native median ms | ExifTool median ms | ratio",
    ...report.files.map(
      (file) =>
        `${path.basename(file.path)} | ${file.bytes} | ${file.nativeMedianMs.toFixed(3)} | ${file.exiftoolMedianMs.toFixed(3)} | ${file.ratio.toFixed(3)}`,
    ),
    "",
    `native   p50 ${summary.native.p50Ms.toFixed(3)} ms, p95 ${summary.native.p95Ms.toFixed(3)} ms, marginal peak RSS ${report.native.marginalPeakRSSKiB} KiB (process peak ${report.native.peakRSSKiB} KiB minus post-import baseline ${report.native.baselineMaxRSSKiB} KiB)`,
    `ExifTool p50 ${summary.exiftool.p50Ms.toFixed(3)} ms, p95 ${summary.exiftool.p95Ms.toFixed(3)} ms, peak RSS ${report.exiftool.peakRSSKiB} KiB`,
    `median time ratio native/ExifTool: ${summary.timeRatio.toFixed(3)}`,
    `marginal peak RSS ratio native/ExifTool (verdict): ${summary.rssRatio.toFixed(3)}`,
    `whole-process peak RSS ratio native/ExifTool (informative): ${summary.totalRssRatio.toFixed(3)}`,
    `verdict: ${summary.verdict.pass ? "pass" : `fail (${summary.verdict.failures.join("; ")})`}`,
  ];
  return `${lines.join("\n")}\n`;
}

let interrupted = false;

function onInterrupt() {
  interrupted = true;
  process.stderr.write(
    "native-vs-exiftool: interrupted; stopping child processes and removing temp files\n",
  );
  cleanupAll().finally(() => process.exit(130));
}

async function main(args, { platform = process.platform } = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    process.stderr.write(`${unsupportedPlatform(platform)}\n`);
    return 2;
  }
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    const options = parseArguments(args);
    const report = await run(options, platform);
    if (options.json !== undefined)
      fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(formatReport(report));
    return report.summary.verdict.pass ? 0 : 3;
  } catch (error) {
    await cleanupAll();
    // An interrupt rejects the in-flight command; onInterrupt reports and exits.
    if (interrupted) return 130;
    process.stderr.write(`native-vs-exiftool: ${error.message}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

module.exports = {
  SLACK_RATIO,
  computeVerdict,
  main,
  marginalPeakRSS,
  median,
  openExifToolSession,
  parseArguments,
  parseDarwinTimeRSSKiB,
  parseVmHWMKiB,
  summarize,
};

if (require.main === module) {
  if (process.argv[2] === "--native-child") {
    nativeChildMain(JSON.parse(process.argv[3])).then(
      (result) => process.stdout.write(JSON.stringify(result)),
      (error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    main(process.argv.slice(2)).then((code) => (process.exitCode = code));
  }
}
