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
 * Usage:
 *   node scripts/qualification/native-vs-exiftool.cjs --exiftool <path>
 *     --files <a,b,...> [--repeat 5] [--json <out>] [--interpreter perl]
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

/** Exact middle for an odd count, the upper middle for an even one. */
function median(values) {
  return percentile(values, 0.5 + 0.5 / values.length);
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

/* ---------------------------------------------------------------- native */

/** Runs inside the dedicated native child (the benchmark-child.cjs maxRSS pattern). */
async function nativeChildMain(spec) {
  const { sanitizeFile } = await import(
    pathToFileURL(path.join(spec.packageRoot, "dist", "index.js")).href
  );
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
    // Node reports resourceUsage().maxRSS in KiB on every platform (libuv
    // divides darwin's byte count). Measured on Node 24.19 darwin-arm64: a
    // 200 MB buffer gave maxRSS 238496 against memoryUsage().rss / 1024 238560,
    // so benchmark-child.cjs's darwin "/ 1024" would under-report 1024-fold.
    maxRSSKiB: process.resourceUsage().maxRSS,
  };
}

function runNativeChild(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [__filename, "--native-child", JSON.stringify(spec)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0)
        return reject(
          new Error(
            `native child failed (${code ?? signal}): ${stderr.trim()}`,
          ),
        );
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`native child output is not JSON: ${error.message}`));
      }
    });
  });
}

/* -------------------------------------------------------------- exiftool */

/**
 * One persistent ExifTool session, spawned with the app's argument shape
 * (`-stay_open True -@ -`, ExiftoolProcess.ts). Commands are written one
 * argument per line and end with `-execute<N>`; the reply ends with
 * `{ready<N>}`.
 */
function openExifToolSession({ command }) {
  const child = spawn(
    command[0],
    [...command.slice(1), "-stay_open", "True", "-@", "-"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let counter = 0;
  let pending = null;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
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
    child.stdin.write("-stay_open\nFalse\n");
    child.stdin.end();
    return exited;
  }

  return { child, sanitize, version, close, stderr: () => stderr };
}

async function measureExifTool({ command, files, repeat, outputDir }) {
  const session = openExifToolSession({ command });
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
    await session.close();
    return { exiftoolVersion, files: measured };
  } finally {
    if (session.child.exitCode === null && session.child.signalCode === null)
      session.child.kill("SIGKILL");
  }
}

/* ------------------------------------------------------------------ main */

async function run(options) {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "native-vs-exiftool-"),
  );
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
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
      },
      node: process.version,
      exiftoolVersion: exiftool.exiftoolVersion,
      repeat: options.repeat,
      warmUps: WARM_UPS,
      files,
      native: { maxRSSKiB: native.maxRSSKiB },
    };
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

async function main(args) {
  const options = parseArguments(args);
  const report = await run(options);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json !== undefined) fs.writeFileSync(options.json, text);
  process.stdout.write(text);
  return 0;
}

module.exports = {
  median,
  openExifToolSession,
  parseArguments,
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
    main(process.argv.slice(2)).then(
      (code) => (process.exitCode = code),
      (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      },
    );
  }
}
