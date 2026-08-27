#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const reportValidator = require("./benchmark-report.cjs");

const projectRoot = path.resolve(__dirname, "../..");
const manifestPath = path.join(projectRoot, "tests/corpus/manifest.json");
const childPath = path.join(__dirname, "benchmark-child.cjs");
const calibrationPath = path.join(__dirname, "benchmark-calibration.cjs");
const SHA256 = /^[a-f0-9]{64}$/;
const WARMUPS = 2;
const MEASUREMENTS = 15;
const BASELINE_PACKAGE_NAME = "exifcleaner-node";
const BASELINE_VERSION = "0.1.1";
const BASELINE_TARBALL_SHA256 =
  "c2fc569b553cba360814bcce61d6882a02aba062e6d6da2193323915530a34bf";
const BASELINE_EXPECTED_IDENTITY = `${BASELINE_PACKAGE_NAME}@${BASELINE_VERSION}#sha256:${BASELINE_TARBALL_SHA256}`;

const BENCHMARK_THRESHOLDS = Object.freeze({
  medianRatio: 1.2,
  medianSlackNs: 15_000_000,
  p95Ratio: 1.35,
  p95SlackNs: 30_000_000,
  peakRssSlackKiB: 16_384,
  slopeSlack: 0.1,
  slopeRangeToleranceBytes: 4 * 1024 * 1024,
});

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  )
    throw new Error(`${label} fields are not exact`);
}

function loadBenchmarkManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const benchmark = manifest.benchmarks;
  exactKeys(benchmark, ["schemaVersion", "seed", "fixtures"], "benchmarks");
  if (
    benchmark.schemaVersion !== 1 ||
    benchmark.seed !== 460_070 ||
    !Array.isArray(benchmark.fixtures) ||
    benchmark.fixtures.length !== 12
  )
    throw new Error("Benchmark manifest is not exact");
  const ids = new Set();
  for (const fixture of benchmark.fixtures) {
    exactKeys(
      fixture,
      ["id", "kind", "seed", "targetBytes", "sha256", "expected"],
      "benchmark fixture",
    );
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(fixture.id) ||
      ids.has(fixture.id) ||
      !new Set([
        "still",
        "metadata-still",
        "animation-alpha",
        "cancellation",
        "malformed",
        "metadata-sentinel",
      ]).has(fixture.kind) ||
      !Number.isSafeInteger(fixture.seed) ||
      !Number.isSafeInteger(fixture.targetBytes) ||
      fixture.targetBytes <= 0 ||
      !SHA256.test(fixture.sha256) ||
      !new Set(["success", "refused", "aborted"]).has(fixture.expected)
    )
      throw new Error(`Benchmark fixture is invalid: ${fixture.id}`);
    ids.add(fixture.id);
  }
  return benchmark;
}

function deterministicBytes(length, seed) {
  const output = Buffer.allocUnsafe(length);
  const block = Buffer.allocUnsafe(Math.min(length, 64 * 1024));
  let state = seed >>> 0;
  for (let index = 0; index < block.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    block[index] = state >>> 24;
  }
  for (let offset = 0; offset < length; offset += block.length)
    block.copy(output, offset, 0, Math.min(block.length, length - offset));
  return output;
}

function chunk(fourCc, payload) {
  const header = Buffer.alloc(8);
  header.write(fourCc, 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    ...(payload.length & 1 ? [Buffer.alloc(1)] : []),
  ]);
}

function webp(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

function vp8Payload(length, seed) {
  if (length < 10) throw new Error("VP8 benchmark payload is too small");
  const payload = deterministicBytes(length, seed);
  payload.set([0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]);
  return payload;
}

function vp8x(flags) {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  return payload;
}

function uint24(value) {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff, value >>> 16]);
}

function generateFixture(record) {
  const target = Number(record.targetBytes);
  let bytes;
  if (record.kind === "still" || record.kind === "cancellation") {
    bytes = webp([chunk("VP8 ", vp8Payload(target - 20, record.seed))]);
  } else if (record.kind === "metadata-still") {
    const metadataLength = target - 56;
    bytes = webp([
      chunk("VP8X", vp8x(0x08)),
      chunk("VP8 ", vp8Payload(10, record.seed)),
      chunk("EXIF", deterministicBytes(metadataLength, record.seed + 1)),
    ]);
  } else if (record.kind === "animation-alpha") {
    const alphaLength = target - 94;
    const alpha = deterministicBytes(alphaLength, record.seed);
    alpha[0] = 1;
    const anim = Buffer.alloc(6);
    const frame = Buffer.concat([
      uint24(0),
      uint24(0),
      uint24(0),
      uint24(0),
      uint24(40),
      Buffer.alloc(1),
      chunk("ALPH", alpha),
      chunk("VP8 ", vp8Payload(10, record.seed + 1)),
    ]);
    bytes = webp([
      chunk("VP8X", vp8x(0x12)),
      chunk("ANIM", anim),
      chunk("ANMF", frame),
    ]);
  } else if (record.kind === "malformed") {
    bytes = Buffer.alloc(target);
    bytes.write("RIFF", 0, 4, "ascii");
    bytes.writeUInt32LE(4, 4);
    bytes.write("WEBP", 8, 4, "ascii");
  } else if (record.kind === "metadata-sentinel") {
    const metadataLength = 16 * 1024 * 1024 + 1;
    bytes = webp([
      chunk("VP8X", vp8x(0x20)),
      chunk("ICCP", deterministicBytes(metadataLength, record.seed)),
      chunk("VP8 ", vp8Payload(10, record.seed + 1)),
    ]);
  } else throw new Error(`Unknown benchmark fixture kind: ${record.kind}`);
  if (bytes.length !== target)
    throw new Error(`Benchmark fixture size drift: ${record.id}`);
  return bytes;
}

function deterministicBlock(length, seed) {
  const block = Buffer.allocUnsafe(Math.min(length, 64 * 1024));
  let state = seed >>> 0;
  for (let index = 0; index < block.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    block[index] = state >>> 24;
  }
  return block;
}

function materializeFixture(record, destinationPath) {
  const target = Number(record.targetBytes);
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(destinationPath, "wx");
  let bytesWritten = 0;
  const write = (bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (written === 0) throw new Error("Fixture write made no progress");
      offset += written;
    }
    hash.update(bytes);
    bytesWritten += bytes.length;
  };
  const writeHeader = (fourCc, size) => {
    const header = Buffer.allocUnsafe(8);
    header.write(fourCc, 0, 4, "ascii");
    header.writeUInt32LE(size, 4);
    write(header);
  };
  const writeDeterministic = (length, seed, mutations = []) => {
    const block = deterministicBlock(length, seed);
    const first = Buffer.from(block);
    for (const [offset, value] of mutations) {
      if (offset < first.length) first[offset] = value;
    }
    write(first);
    for (let offset = block.length; offset < length; offset += block.length)
      write(block.subarray(0, Math.min(block.length, length - offset)));
  };
  const writeChunk = (fourCc, size, payload) => {
    writeHeader(fourCc, size);
    payload();
    if (size & 1) write(Buffer.alloc(1));
  };
  try {
    const riff = Buffer.allocUnsafe(12);
    riff.write("RIFF", 0, 4, "ascii");
    riff.writeUInt32LE(target - 8, 4);
    riff.write("WEBP", 8, 4, "ascii");
    if (record.kind !== "malformed") write(riff);
    if (record.kind === "still" || record.kind === "cancellation") {
      const payloadLength = target - 20;
      writeChunk("VP8 ", payloadLength, () => {
        const block = deterministicBlock(payloadLength, record.seed);
        const first = Buffer.from(block);
        first.set([0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]);
        write(first);
        for (
          let offset = block.length;
          offset < payloadLength;
          offset += block.length
        )
          write(
            block.subarray(0, Math.min(block.length, payloadLength - offset)),
          );
      });
    } else if (record.kind === "metadata-still") {
      writeChunk("VP8X", 10, () => write(vp8x(0x08)));
      writeChunk("VP8 ", 10, () => write(vp8Payload(10, record.seed)));
      writeChunk("EXIF", target - 56, () =>
        writeDeterministic(target - 56, record.seed + 1),
      );
    } else if (record.kind === "animation-alpha") {
      writeChunk("VP8X", 10, () => write(vp8x(0x12)));
      writeChunk("ANIM", 6, () => write(Buffer.alloc(6)));
      const alphaLength = target - 94;
      writeHeader("ANMF", alphaLength + 42);
      write(
        Buffer.concat([
          uint24(0),
          uint24(0),
          uint24(0),
          uint24(0),
          uint24(40),
          Buffer.alloc(1),
        ]),
      );
      writeChunk("ALPH", alphaLength, () =>
        writeDeterministic(alphaLength, record.seed, [[0, 1]]),
      );
      writeChunk("VP8 ", 10, () => write(vp8Payload(10, record.seed + 1)));
    } else if (record.kind === "malformed") {
      const bytes = Buffer.alloc(target);
      bytes.write("RIFF", 0, 4, "ascii");
      bytes.writeUInt32LE(4, 4);
      bytes.write("WEBP", 8, 4, "ascii");
      write(bytes);
    } else if (record.kind === "metadata-sentinel") {
      writeChunk("VP8X", 10, () => write(vp8x(0x20)));
      writeChunk("ICCP", 16 * 1024 * 1024 + 1, () =>
        writeDeterministic(16 * 1024 * 1024 + 1, record.seed),
      );
      writeChunk("VP8 ", 10, () => write(vp8Payload(10, record.seed + 1)));
    } else throw new Error(`Unknown benchmark fixture kind: ${record.kind}`);
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytesWritten !== target)
    throw new Error(`Benchmark fixture size drift: ${record.id}`);
  const sha256 = hash.digest("hex");
  if (sha256 !== record.sha256)
    throw new Error(`Benchmark fixture digest drift: ${record.id}`);
  return { bytes: bytesWritten, sha256 };
}

function buildSchedule(
  fixtureIds,
  warmups = WARMUPS,
  measurements = MEASUREMENTS,
) {
  const schedule = [];
  for (const fixtureId of fixtureIds) {
    const rounds = warmups + measurements;
    for (let round = 0; round < rounds; round += 1) {
      const versions =
        round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const version of versions)
        schedule.push({
          fixtureId,
          round,
          warmup: round < warmups,
          version,
        });
    }
  }
  return schedule;
}

function percentile(values, quantile) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !(quantile > 0 && quantile <= 1)
  )
    throw new Error("Percentile input is invalid");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

function evaluatePair({ baseline, candidate }) {
  const failures = [];
  if (baseline.correctnessKey !== candidate.correctnessKey)
    return { pass: false, failures: ["correctness mismatch"] };
  const timing = reportValidator.evaluateTiming({
    baselineMedianNs: baseline.medianElapsedNs,
    candidateMedianNs: candidate.medianElapsedNs,
    baselineP95Ns: baseline.p95ElapsedNs,
    candidateP95Ns: candidate.p95ElapsedNs,
  });
  failures.push(...timing.failures);
  if (
    candidate.medianMaxRSSKiB >
    baseline.medianMaxRSSKiB + BENCHMARK_THRESHOLDS.peakRssSlackKiB
  )
    failures.push("peak RSS threshold exceeded");
  if (candidate.rssSlope > baseline.rssSlope + BENCHMARK_THRESHOLDS.slopeSlack)
    failures.push("RSS slope threshold exceeded");
  return { pass: failures.length === 0, failures };
}

function evaluateCancellation(input) {
  const failures = [];
  if (input.code !== "aborted")
    failures.push("cancellation was not typed aborted");
  if (input.destinationAbsent !== true)
    failures.push("cancellation created a public destination");
  if (input.finalizationTruthful !== true)
    failures.push("cancellation finalization was untruthful");
  if (input.secondWriter !== false)
    failures.push("cancellation started a second writer");
  if (input.finalizationStartMs > 250)
    failures.push("finalization start exceeded 250 ms");
  if (input.terminalMs > 2_000)
    failures.push("terminal cancellation exceeded 2 s");
  return { pass: failures.length === 0, failures };
}

function exitCodeForMode(mode, pass) {
  if (mode !== "report" && mode !== "admit")
    throw new Error("Benchmark mode must be report or admit");
  return mode === "admit" && !pass ? 1 : 0;
}

function renderSummary(report) {
  const lines = [
    `# WebP benchmark: ${report.pass ? "ADMITTED" : "NOT ADMITTED"}`,
    "",
    `Baseline: ${report.baselineSha256}`,
    `Candidate: ${report.candidateSha256}`,
  ];
  if (Array.isArray(report.failures) && report.failures.length > 0) {
    lines.push("", "Failures:");
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(args) {
  const normalized = args.flatMap((argument) => {
    const equals = argument.match(/^(--[^=]+)=(.*)$/);
    return equals === null ? [argument] : [equals[1], equals[2]];
  });
  const values = {};
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error("Benchmark arguments must be flag/value pairs");
    if (
      !new Set([
        "--baseline-tarball",
        "--candidate-tarball",
        "--fixture",
        "--mode",
        "--output",
      ]).has(flag)
    )
      throw new Error(`Unknown benchmark option ${flag}`);
    if (Object.hasOwn(values, flag))
      throw new Error(`Duplicate benchmark option ${flag}`);
    values[flag] = value;
  }
  if (values["--baseline-tarball"] === undefined)
    throw new Error("--baseline-tarball is required");
  if (values["--candidate-tarball"] === undefined)
    throw new Error("--candidate-tarball is required");
  const mode = values["--mode"] ?? "report";
  if (mode !== "report" && mode !== "admit")
    throw new Error("--mode must be report or admit");
  return {
    baselineTarball: path.resolve(values["--baseline-tarball"]),
    candidateTarball: path.resolve(values["--candidate-tarball"]),
    fixture: values["--fixture"],
    mode,
    output: path.resolve(values["--output"] ?? "qualification-benchmark.json"),
  };
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${options.label ?? "benchmark process"} failed`);
  return result.stdout;
}

function validateBaselinePackage(packageJson, sha256) {
  if (packageJson?.name !== BASELINE_PACKAGE_NAME)
    throw new Error("Baseline package name is not exifcleaner-node");
  if (packageJson.version !== BASELINE_VERSION)
    throw new Error("Baseline package is not v0.1.1");
  if (!SHA256.test(sha256))
    throw new Error("Baseline tarball digest is not SHA-256");
  if (sha256 !== BASELINE_TARBALL_SHA256)
    throw new Error(
      "Baseline tarball digest does not match the trusted artifact",
    );
  return {
    baselinePackageName: packageJson.name,
    baselineVersion: packageJson.version,
    baselineExpectedIdentity: BASELINE_EXPECTED_IDENTITY,
    baselineSha256: sha256,
  };
}

function installTarball(tarball, root, label) {
  if (!fs.statSync(tarball).isFile())
    throw new Error(`${label} tarball missing`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: `benchmark-${label}`,
      private: true,
      type: "module",
    }),
  );
  run(
    npmCommand(),
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, label: `${label} install` },
  );
  const packageRoot = path.join(root, "node_modules/exifcleaner-node");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const installed = { packageRoot, sha256: digest(fs.readFileSync(tarball)) };
  return label === "baseline"
    ? {
        ...installed,
        ...validateBaselinePackage(packageJson, installed.sha256),
      }
    : installed;
}

function measureChild(version, installed, fixture) {
  const encoded = Buffer.from(JSON.stringify(fixture), "utf8").toString(
    "base64",
  );
  const runToken = crypto.randomBytes(16).toString("hex");
  const result = spawnSync(
    process.execPath,
    [
      childPath,
      "--package-root",
      installed.packageRoot,
      "--package-sha",
      installed.sha256,
      "--version",
      version,
      "--fixture",
      encoded,
      "--run-token",
      runToken,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      detached: process.platform !== "win32",
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.stderr !== "")
    throw new Error(`${version}:${fixture.id} process contract failed`);
  if (process.platform !== "win32" && result.pid !== undefined) {
    try {
      process.kill(-result.pid, 0);
      throw new Error(`${version}:${fixture.id} left a process-group member`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const record = JSON.parse(result.stdout);
  const expectedPhases = [
    "package-load",
    "fixture-materialized",
    "sanitize-complete",
    "correctness-complete",
  ];
  const validAllocationPhases =
    Array.isArray(record.allocationPhases) &&
    record.allocationPhases.length === expectedPhases.length &&
    record.allocationPhases.every(
      (snapshot, index) =>
        snapshot?.phase === expectedPhases[index] &&
        ["rss", "heapUsed", "external", "arrayBuffers", "maxRSSKiB"].every(
          (field) => Number.isFinite(snapshot[field]) && snapshot[field] >= 0,
        ),
    );
  if (
    record.schemaVersion !== 1 ||
    record.version !== version ||
    record.fixtureId !== fixture.id ||
    record.packageSha !== installed.sha256 ||
    record.runToken !== runToken ||
    !Number.isFinite(record.elapsedNs) ||
    record.elapsedNs < 0 ||
    !Number.isFinite(record.maxRSSKiB) ||
    record.maxRSSKiB < 0 ||
    !Number.isFinite(record.startedRss) ||
    record.startedRss < 0 ||
    !Number.isFinite(record.endedRss) ||
    record.endedRss < 0 ||
    !SHA256.test(record.correctnessKey) ||
    !validAllocationPhases ||
    record.environment?.nodeVersion !== process.version ||
    record.environment?.platform !== process.platform ||
    record.environment?.architecture !== process.arch
  )
    throw new Error(`${version}:${fixture.id} emitted invalid evidence`);
  return record;
}

function measureCalibration(sandbox, position) {
  const calibrationSandbox = path.join(sandbox, `calibration-${position}`);
  fs.mkdirSync(calibrationSandbox, { recursive: true });
  const result = spawnSync(process.execPath, [calibrationPath], {
    cwd: calibrationSandbox,
    env: { PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024,
  });
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    !result.stdout.endsWith("\n") ||
    result.stdout.indexOf("\n") !== result.stdout.length - 1
  )
    throw new Error(`calibration ${position} process contract failed`);
  let authority;
  try {
    authority = JSON.parse(result.stdout);
  } catch {
    throw new Error(`calibration ${position} emitted invalid JSON`);
  }
  reportValidator.validateCalibration(
    authority,
    reportValidator.loadReference(),
  );
  if (
    authority.process.execPath !== process.execPath ||
    fs.readdirSync(calibrationSandbox).length !== 0
  )
    throw new Error(`calibration ${position} identity or cleanup failed`);
  return authority;
}

function aggregate(samples) {
  const elapsed = samples.map((sample) => sample.elapsedNs);
  const maxRss = samples.map((sample) => sample.maxRSSKiB);
  const keys = new Set(samples.map((sample) => sample.correctnessKey));
  if (keys.size !== 1) throw new Error("Benchmark correctness was unstable");
  return {
    correctnessKey: [...keys][0],
    medianElapsedNs: percentile(elapsed, 0.5),
    p95ElapsedNs: percentile(elapsed, 0.95),
    medianMaxRSSKiB: percentile(maxRss, 0.5),
    samples,
  };
}

function rssSlope(aggregates, prefix) {
  const points = [1, 16, 64].map((mib) => ({
    bytes: mib * 1024 * 1024,
    rss: aggregates.get(`${prefix}-${mib}m`).medianMaxRSSKiB * 1024,
  }));
  const range = Math.max(
    0,
    points[2].rss -
      points[0].rss -
      BENCHMARK_THRESHOLDS.slopeRangeToleranceBytes,
  );
  return range / (points[2].bytes - points[0].bytes);
}

async function executeBenchmark(options) {
  const manifest = loadBenchmarkManifest();
  const fixtures = manifest.fixtures.filter(
    (fixture) =>
      options.fixture === undefined || fixture.id === options.fixture,
  );
  if (fixtures.length === 0) throw new Error("Unknown benchmark fixture");
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "exifcleaner-benchmark-"),
  );
  try {
    const installed = {
      baseline: installTarball(
        options.baselineTarball,
        path.join(sandbox, "baseline"),
        "baseline",
      ),
      candidate: installTarball(
        options.candidateTarball,
        path.join(sandbox, "candidate"),
        "candidate",
      ),
    };
    if (installed.baseline.sha256 === installed.candidate.sha256)
      throw new Error("Baseline and candidate tarballs are identical");
    const calibrationBefore = measureCalibration(sandbox, "before");
    const retained = new Map();
    const rawSchedule = [];
    for (const item of buildSchedule(fixtures.map((fixture) => fixture.id))) {
      const fixture = fixtures.find(
        (candidate) => candidate.id === item.fixtureId,
      );
      const sample = measureChild(
        item.version,
        installed[item.version],
        fixture,
      );
      rawSchedule.push({ ...item, sample });
      if (!item.warmup) {
        const key = `${item.version}:${item.fixtureId}`;
        retained.set(key, [...(retained.get(key) ?? []), sample]);
      }
    }
    const calibrationAfter = measureCalibration(sandbox, "after");
    const reference = reportValidator.loadReference();
    const calibrationDerived = reportValidator.deriveRunScale({
      before: calibrationBefore.observations,
      after: calibrationAfter.observations,
      referenceMedianNs:
        reference.referenceMedianNs[String(calibrationBefore.nodeMajor)],
    });
    const aggregates = new Map();
    for (const [key, samples] of retained) {
      const scaledSamples = samples.map((sample) => ({
        ...sample,
        scaledElapsedNs: sample.elapsedNs * calibrationDerived.runScale,
      }));
      const rawAggregate = aggregate(samples);
      aggregates.set(key, {
        ...rawAggregate,
        medianElapsedNs: percentile(
          scaledSamples.map((sample) => sample.scaledElapsedNs),
          0.5,
        ),
        p95ElapsedNs: percentile(
          scaledSamples.map((sample) => sample.scaledElapsedNs),
          0.95,
        ),
        samples: scaledSamples,
      });
    }
    const slopes = { baseline: 0, candidate: 0 };
    if (options.fixture === undefined)
      for (const version of ["baseline", "candidate"])
        slopes[version] = rssSlope(
          new Map(
            [...aggregates]
              .filter(([key]) => key.startsWith(`${version}:`))
              .map(([key, value]) => [key.slice(version.length + 1), value]),
          ),
          "still",
        );
    const failures = [];
    const comparisons = [];
    for (const fixture of fixtures) {
      if (fixture.kind === "cancellation") continue;
      const baseline = {
        ...aggregates.get(`baseline:${fixture.id}`),
        rssSlope: slopes.baseline,
      };
      const candidate = {
        ...aggregates.get(`candidate:${fixture.id}`),
        rssSlope: slopes.candidate,
      };
      const verdict = evaluatePair({ baseline, candidate });
      const timing = reportValidator.evaluateTiming({
        baselineMedianNs: baseline.medianElapsedNs,
        candidateMedianNs: candidate.medianElapsedNs,
        baselineP95Ns: baseline.p95ElapsedNs,
        candidateP95Ns: candidate.p95ElapsedNs,
      });
      comparisons.push({
        fixtureId: fixture.id,
        baseline,
        candidate,
        timing,
        verdict,
      });
      failures.push(
        ...verdict.failures.map((failure) => `${fixture.id}: ${failure}`),
      );
    }
    const cancellationFixture = fixtures.find(
      (fixture) => fixture.kind === "cancellation",
    );
    let cancellation;
    if (cancellationFixture !== undefined) {
      const sample = retained.get(`candidate:${cancellationFixture.id}`)[0];
      const verdict = evaluateCancellation(sample.cancellation);
      cancellation = { sample: sample.cancellation, verdict };
      failures.push(...verdict.failures);
    }
    const report = {
      version: 1,
      mode: options.mode,
      pass: failures.length === 0,
      baselinePackageName: installed.baseline.baselinePackageName,
      baselineVersion: installed.baseline.baselineVersion,
      baselineExpectedIdentity: installed.baseline.baselineExpectedIdentity,
      baselineSha256: installed.baseline.baselineSha256,
      candidateSha256: installed.candidate.sha256,
      warmups: WARMUPS,
      measurements: MEASUREMENTS,
      thresholds: BENCHMARK_THRESHOLDS,
      calibration: {
        before: calibrationBefore,
        after: calibrationAfter,
        reference,
        derived: calibrationDerived,
      },
      rawSchedule,
      collection: { retries: 0, discarded: 0 },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        runner: process.env.ImageOS ?? "local",
        cpu: os.cpus()[0]?.model ?? "unknown",
      },
      comparisons,
      cancellation,
      failures,
    };
    reportValidator.validateReport(report);
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(`${options.output}.md`, renderSummary(report));
    return report;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

module.exports = {
  BASELINE_TARBALL_SHA256,
  BENCHMARK_THRESHOLDS,
  buildSchedule,
  evaluateCancellation,
  evaluatePair,
  executeBenchmark,
  exitCodeForMode,
  generateFixture,
  materializeFixture,
  loadBenchmarkManifest,
  parseArguments,
  percentile,
  renderSummary,
  rssSlope,
  validateBaselinePackage,
};

if (require.main === module) {
  executeBenchmark(parseArguments(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(renderSummary(report));
      process.exitCode = exitCodeForMode(report.mode, report.pass);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    });
}
