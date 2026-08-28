#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  ALGORITHM_ID,
  OBSERVATION_COUNT,
  WORKLOAD_UNIT_COUNT,
  workloadDigest,
  workloadResultDigest,
} = require("./benchmark-calibration.cjs");
const {
  deriveCorrectnessKey,
  deriveFinalizationKey,
} = require("./benchmark-correctness.cjs");

const SHA256 = /^[a-f0-9]{64}$/;
const MEDIAN_RATIO = 1.2;
const MEDIAN_SLACK_NS = 15_000_000;
const P95_RATIO = 1.35;
const P95_SLACK_NS = 30_000_000;
const WARMUPS = 2;
const MEASUREMENTS = 15;
const RECORDS_PER_FIXTURE = (WARMUPS + MEASUREMENTS) * 2;

function expectedBenchmarkEvidence() {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../tests/corpus/manifest.json"),
      "utf8",
    ),
  );
  const benchmark = manifest.benchmarks;
  exactKeys(benchmark, ["schemaVersion", "seed", "fixtures"], "benchmarks");
  if (
    benchmark.schemaVersion !== 1 ||
    benchmark.seed !== 460_070 ||
    !Array.isArray(benchmark.fixtures) ||
    benchmark.fixtures.length !== 12
  )
    throw new Error("benchmark manifest is not exact");
  const fixtureIds = new Set();
  const fixtures = benchmark.fixtures.map((fixture) => {
    exactKeys(
      fixture,
      ["id", "kind", "seed", "targetBytes", "sha256", "expected"],
      "benchmark fixture",
    );
    if (
      typeof fixture.id !== "string" ||
      fixtureIds.has(fixture.id) ||
      ![
        "still",
        "metadata-still",
        "animation-alpha",
        "cancellation",
        "malformed",
        "metadata-sentinel",
      ].includes(fixture.kind) ||
      !["success", "aborted", "refused"].includes(fixture.expected)
    )
      throw new Error("benchmark manifest fixture is invalid");
    fixtureIds.add(fixture.id);
    return fixture;
  });
  const cancellation = fixtures.filter(
    (fixture) => fixture.kind === "cancellation",
  );
  if (cancellation.length !== 1)
    throw new Error("benchmark manifest cancellation fixture is invalid");
  const rawSchedule = [];
  for (const fixture of fixtures)
    for (let round = 0; round < WARMUPS + MEASUREMENTS; round += 1) {
      const versions =
        round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const version of versions)
        rawSchedule.push({
          fixtureId: fixture.id,
          round,
          warmup: round < WARMUPS,
          version,
        });
    }
  if (rawSchedule.length !== fixtures.length * RECORDS_PER_FIXTURE)
    throw new Error("benchmark raw schedule contract is invalid");
  return {
    fixtures,
    comparisonFixtureIds: fixtures
      .filter((fixture) => fixture.kind !== "cancellation")
      .map((fixture) => fixture.id),
    cancellationFixtureId: cancellation[0].id,
    rawSchedule,
  };
}

function exactKeys(value, expected, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  )
    throw new Error(`${label} fields are not exact`);
}
function percentile(values, quantile, allowZero = false) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some(
      (value) =>
        !Number.isFinite(value) || value < 0 || (!allowZero && value === 0),
    )
  )
    throw new Error("timing values are invalid");
  return [...values].sort((a, b) => a - b)[
    Math.ceil(values.length * quantile) - 1
  ];
}
function performanceP95(values) {
  if (
    !Array.isArray(values) ||
    values.length !== MEASUREMENTS ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  )
    throw new Error("performance p95 values are invalid");
  const sorted = [...values].sort((left, right) => left - right);
  const h = (sorted.length - 1) * 0.95;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}
function deriveBlockEstimate(values) {
  if (
    !Array.isArray(values) ||
    values.length !== OBSERVATION_COUNT ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  )
    throw new Error("calibration block is invalid");
  const medianNs = percentile(values, 0.5);
  const madNs = percentile(
    values.map((value) => Math.abs(value - medianNs)),
    0.5,
    true,
  );
  const madRatio = madNs / medianNs;
  const sorted = [...values].sort((a, b) => a - b);
  const centralValues = sorted.slice(2, -2);
  const centralRangeRatio = centralValues.at(-1) / centralValues[0];
  return { medianNs, madNs, madRatio, centralValues, centralRangeRatio };
}
function validateBlock(block, reference) {
  const estimate = deriveBlockEstimate(block);
  if (estimate.madRatio > reference.madRatioLimit)
    throw new Error("calibration MAD threshold exceeded");
  if (estimate.centralRangeRatio > reference.centralRangeRatioLimit)
    throw new Error("calibration central-eleven threshold exceeded");
  return estimate;
}
function normalizedValues(value) {
  if (!Array.isArray(value))
    throw new Error("calibration observations are invalid");
  return value.map((item) =>
    typeof item === "number" ? item : item?.normalizedNs,
  );
}
function deriveRunScale({ before, after, referenceMedianNs }) {
  const reference = loadReference();
  const beforeEstimate = validateBlock(normalizedValues(before), reference);
  const afterEstimate = validateBlock(normalizedValues(after), reference);
  if (!Number.isFinite(referenceMedianNs) || referenceMedianNs <= 0)
    throw new Error("calibration reference is invalid");
  const driftRatio =
    Math.max(beforeEstimate.medianNs, afterEstimate.medianNs) /
    Math.min(beforeEstimate.medianNs, afterEstimate.medianNs);
  if (driftRatio > reference.maxDriftRatio)
    throw new Error("calibration drift threshold exceeded");
  const observedCalibrationNs = Math.sqrt(
    beforeEstimate.medianNs * afterEstimate.medianNs,
  );
  const runScale = referenceMedianNs / observedCalibrationNs;
  if (!Number.isFinite(runScale) || runScale <= 0)
    throw new Error("run scale is invalid");
  return {
    before: beforeEstimate,
    after: afterEstimate,
    beforeMedianNs: beforeEstimate.medianNs,
    afterMedianNs: afterEstimate.medianNs,
    driftRatio,
    observedCalibrationNs,
    runScale,
  };
}
function evaluateTiming({
  baselineMedianNs,
  candidateMedianNs,
  baselineP95Ns,
  candidateP95Ns,
}) {
  for (const value of [
    baselineMedianNs,
    candidateMedianNs,
    baselineP95Ns,
    candidateP95Ns,
  ])
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("D-23 input is invalid");
  const medianLimitNs = Math.max(
    baselineMedianNs * MEDIAN_RATIO,
    baselineMedianNs + MEDIAN_SLACK_NS,
  );
  const p95LimitNs = Math.max(
    baselineP95Ns * P95_RATIO,
    baselineP95Ns + P95_SLACK_NS,
  );
  const failures = [];
  if (candidateMedianNs > medianLimitNs)
    failures.push("median threshold exceeded");
  if (candidateP95Ns > p95LimitNs) failures.push("p95 threshold exceeded");
  return { pass: failures.length === 0, medianLimitNs, p95LimitNs, failures };
}
function scriptDigest() {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, "benchmark-calibration.cjs")))
    .digest("hex");
}
function loadReference() {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "benchmark-calibration-reference.json"),
      "utf8",
    ),
  );
  exactKeys(
    value,
    [
      "schemaVersion",
      "algorithmId",
      "scriptSha256",
      "workloadDigest",
      "workloadResultDigest",
      "observationCount",
      "workloadUnitCount",
      "referenceMedianNs",
      "timeoutMs",
      "madRatioLimit",
      "centralRangeRatioLimit",
      "maxDriftRatio",
    ],
    "calibration reference",
  );
  if (
    value.schemaVersion !== 2 ||
    value.algorithmId !== ALGORITHM_ID ||
    value.scriptSha256 !== scriptDigest() ||
    !SHA256.test(value.scriptSha256) ||
    value.workloadDigest !== workloadDigest() ||
    value.workloadResultDigest !== workloadResultDigest() ||
    value.observationCount !== OBSERVATION_COUNT ||
    value.workloadUnitCount !== WORKLOAD_UNIT_COUNT ||
    value.timeoutMs !== 15_000 ||
    value.madRatioLimit !== 0.1 ||
    value.centralRangeRatioLimit !== 1.2 ||
    value.maxDriftRatio !== 1.1
  )
    throw new Error("calibration reference is invalid");
  if (
    Object.values(value.referenceMedianNs).some(
      (item) => !Number.isFinite(item) || item <= 0,
    )
  )
    throw new Error("calibration reference median is invalid");
  return value;
}
function validateCalibration(value, reference = loadReference()) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "algorithmId",
      "nodeMajor",
      "observations",
      "workloadDigest",
      "process",
    ],
    "calibration",
  );
  exactKeys(value.process, ["execPath", "clean"], "calibration process");
  if (
    value.schemaVersion !== 2 ||
    value.algorithmId !== ALGORITHM_ID ||
    !Number.isInteger(value.nodeMajor) ||
    !Object.hasOwn(reference.referenceMedianNs, String(value.nodeMajor)) ||
    value.workloadDigest !== workloadDigest() ||
    typeof value.process.execPath !== "string" ||
    value.process.clean !== true ||
    !Array.isArray(value.observations) ||
    value.observations.length !== OBSERVATION_COUNT
  )
    throw new Error("calibration authority is invalid");
  value.observations.forEach((observation, index) => {
    exactKeys(
      observation,
      ["ordinal", "elapsedNs", "unitCount", "normalizedNs", "resultDigest"],
      "calibration observation",
    );
    if (
      observation.ordinal !== index + 1 ||
      !Number.isFinite(observation.elapsedNs) ||
      observation.elapsedNs <= 0 ||
      observation.unitCount !== WORKLOAD_UNIT_COUNT ||
      observation.normalizedNs !==
        observation.elapsedNs / WORKLOAD_UNIT_COUNT ||
      observation.resultDigest !== workloadResultDigest()
    )
      throw new Error("calibration observation is invalid");
  });
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function validateCancellationEvidence(cancellation, rawSchedule, fixtureId) {
  exactKeys(cancellation, ["sample", "verdict"], "cancellation evidence");
  exactKeys(
    cancellation.sample,
    [
      "code",
      "destinationAbsent",
      "finalizationTruthful",
      "secondWriter",
      "finalizationStartMs",
      "terminalMs",
      "finalization",
    ],
    "cancellation sample",
  );
  exactKeys(cancellation.verdict, ["pass", "failures"], "cancellation verdict");
  if (
    cancellation.sample.code !== "aborted" ||
    cancellation.sample.destinationAbsent !== true ||
    cancellation.sample.finalizationTruthful !== true ||
    cancellation.sample.secondWriter !== false ||
    cancellation.sample.finalization !== "owned-partial-remains" ||
    !Number.isFinite(cancellation.sample.finalizationStartMs) ||
    cancellation.sample.finalizationStartMs < 0 ||
    cancellation.sample.finalizationStartMs > 250 ||
    !Number.isFinite(cancellation.sample.terminalMs) ||
    cancellation.sample.terminalMs < 0 ||
    cancellation.sample.terminalMs > 2_000 ||
    cancellation.verdict.pass !== true ||
    !Array.isArray(cancellation.verdict.failures) ||
    cancellation.verdict.failures.length !== 0
  )
    throw new Error("cancellation evidence is invalid");
  const retainedCandidate = rawSchedule.find(
    (item) =>
      item.fixtureId === fixtureId &&
      item.round === WARMUPS &&
      item.version === "candidate",
  );
  if (
    !retainedCandidate ||
    !retainedCandidate.sample ||
    !sameJson(cancellation.sample, retainedCandidate.sample.cancellation)
  )
    throw new Error("cancellation sample is not bound to raw evidence");
}
function expectedChildFinalization(record, fixture) {
  if (fixture.kind === "cancellation")
    return record.version === "candidate"
      ? "owned-partial-remains"
      : "not-started";
  if (fixture.expected !== "success") return "not-started";
  return record.version === "candidate"
    ? "private-empty-stage-directory-remains"
    : "none";
}
function validateChildSample(sample, record, fixture, report, seenRunTokens) {
  const cancellation = fixture.kind === "cancellation";
  exactKeys(
    sample,
    [
      "schemaVersion",
      "version",
      "fixtureId",
      "packageSha",
      "runToken",
      "elapsedNs",
      "maxRSSKiB",
      "startedRss",
      "endedRss",
      "outputBytes",
      "outputSha256",
      "status",
      "code",
      "sourceUnchanged",
      "destinationAbsent",
      "finalization",
      "finalizationTruthful",
      "correctnessKey",
      "finalizationKey",
      "allocationPhases",
      "environment",
      ...(cancellation ? ["cancellation"] : []),
    ],
    "benchmark child sample",
  );
  const expectedPackageSha =
    record.version === "baseline"
      ? report.baselineSha256
      : report.candidateSha256;
  const expectedFinalization = expectedChildFinalization(record, fixture);
  if (
    sample.schemaVersion !== 2 ||
    sample.version !== record.version ||
    sample.fixtureId !== fixture.id ||
    sample.packageSha !== expectedPackageSha ||
    !/^[a-f0-9]{32}$/.test(sample.runToken) ||
    seenRunTokens.has(sample.runToken) ||
    !Number.isFinite(sample.elapsedNs) ||
    sample.elapsedNs <= 0 ||
    !Number.isFinite(sample.maxRSSKiB) ||
    sample.maxRSSKiB < 0 ||
    !Number.isFinite(sample.startedRss) ||
    sample.startedRss < 0 ||
    !Number.isFinite(sample.endedRss) ||
    sample.endedRss < 0 ||
    !Number.isSafeInteger(sample.outputBytes) ||
    sample.outputBytes < 0 ||
    sample.status !== fixture.expected ||
    (sample.status === "success"
      ? sample.code !== null
      : typeof sample.code !== "string") ||
    typeof sample.sourceUnchanged !== "boolean" ||
    sample.sourceUnchanged !== true ||
    sample.finalization !== expectedFinalization ||
    sample.finalizationTruthful !== true ||
    !SHA256.test(sample.correctnessKey) ||
    sample.correctnessKey !== deriveCorrectnessKey(sample) ||
    !SHA256.test(sample.finalizationKey) ||
    sample.finalizationKey !==
      deriveFinalizationKey({
        version: sample.version,
        fixtureId: sample.fixtureId,
        finalization: sample.finalization,
        truthful: sample.finalizationTruthful,
      }) ||
    typeof sample.environment !== "object" ||
    sample.environment === null ||
    !sameJson(sample.environment, report.environment)
  )
    throw new Error("benchmark child identity or correctness is invalid");
  seenRunTokens.add(sample.runToken);
  const mustProduceOutput = fixture.expected === "success";
  if (
    (mustProduceOutput &&
      (sample.destinationAbsent !== false ||
        sample.outputBytes <= 0 ||
        !SHA256.test(sample.outputSha256))) ||
    (!mustProduceOutput &&
      (sample.destinationAbsent !== true ||
        sample.outputBytes !== 0 ||
        sample.outputSha256 !== null))
  )
    throw new Error("benchmark child output invariant is invalid");
  if (
    !Array.isArray(sample.allocationPhases) ||
    sample.allocationPhases.length !== 4
  )
    throw new Error("benchmark child allocation evidence is invalid");
  const phases = [
    "package-load",
    "fixture-materialized",
    "sanitize-complete",
    "correctness-complete",
  ];
  sample.allocationPhases.forEach((snapshot, index) => {
    exactKeys(
      snapshot,
      ["phase", "rss", "heapUsed", "external", "arrayBuffers", "maxRSSKiB"],
      "allocation snapshot",
    );
    if (
      snapshot.phase !== phases[index] ||
      [
        snapshot.rss,
        snapshot.heapUsed,
        snapshot.external,
        snapshot.arrayBuffers,
        snapshot.maxRSSKiB,
      ].some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error("benchmark child allocation evidence is invalid");
  });
  if (cancellation) {
    exactKeys(
      sample.cancellation,
      [
        "code",
        "destinationAbsent",
        "finalizationTruthful",
        "secondWriter",
        "finalizationStartMs",
        "terminalMs",
        "finalization",
      ],
      "benchmark child cancellation",
    );
    if (
      sample.cancellation.code !== "aborted" ||
      sample.cancellation.destinationAbsent !== true ||
      sample.cancellation.finalizationTruthful !== true ||
      sample.cancellation.secondWriter !== false ||
      !Number.isFinite(sample.cancellation.finalizationStartMs) ||
      sample.cancellation.finalizationStartMs < 0 ||
      !Number.isFinite(sample.cancellation.terminalMs) ||
      sample.cancellation.terminalMs < 0 ||
      sample.cancellation.finalization !== expectedFinalization
    )
      throw new Error("benchmark child cancellation evidence is invalid");
  }
}
function validateReport(report) {
  const reference = loadReference();
  const expected = expectedBenchmarkEvidence();
  const benchmark = require("./benchmark.cjs");
  exactKeys(
    report,
    [
      "version",
      "elapsedP95Estimator",
      "mode",
      "pass",
      "baselinePackageName",
      "baselineVersion",
      "baselineExpectedIdentity",
      "baselineSha256",
      "candidateSha256",
      "warmups",
      "measurements",
      "thresholds",
      "calibration",
      "rawSchedule",
      "collection",
      "environment",
      "comparisons",
      "cancellation",
      "failures",
    ],
    "benchmark report",
  );
  exactKeys(
    report.elapsedP95Estimator,
    ["method", "quantile", "interpolation", "retainedObservations"],
    "elapsed p95 estimator",
  );
  exactKeys(
    report.environment,
    ["nodeVersion", "platform", "architecture", "runner", "cpu"],
    "benchmark environment",
  );
  if (
    report.version !== 3 ||
    report.elapsedP95Estimator.method !== "Hyndman-Fan Type 7" ||
    report.elapsedP95Estimator.quantile !== 0.95 ||
    report.elapsedP95Estimator.interpolation !== "linear" ||
    report.elapsedP95Estimator.retainedObservations !== MEASUREMENTS ||
    !["report", "admit"].includes(report.mode) ||
    typeof report.pass !== "boolean" ||
    report.baselinePackageName !== "exifcleaner-node" ||
    report.baselineVersion !== "0.1.1" ||
    report.baselineExpectedIdentity !==
      `exifcleaner-node@0.1.1#sha256:${report.baselineSha256}` ||
    !SHA256.test(report.baselineSha256) ||
    !SHA256.test(report.candidateSha256) ||
    report.baselineSha256 === report.candidateSha256 ||
    report.warmups !== WARMUPS ||
    report.measurements !== MEASUREMENTS ||
    !sameJson(report.thresholds, benchmark.BENCHMARK_THRESHOLDS) ||
    typeof report.environment.nodeVersion !== "string" ||
    !/^v\d+\./.test(report.environment.nodeVersion) ||
    ["platform", "architecture", "runner", "cpu"].some(
      (key) =>
        typeof report.environment[key] !== "string" ||
        report.environment[key].length === 0,
    )
  )
    throw new Error("benchmark report envelope is invalid");
  exactKeys(
    report.calibration,
    ["before", "after", "reference", "derived"],
    "report calibration",
  );
  validateCalibration(report.calibration.before, reference);
  validateCalibration(report.calibration.after, reference);
  if (
    report.calibration.before.nodeMajor !==
      report.calibration.after.nodeMajor ||
    report.calibration.before.nodeMajor !==
      Number(report.environment.nodeVersion.match(/^v(\d+)/)[1])
  )
    throw new Error("calibration Node identity mismatch");
  if (!sameJson(report.calibration.reference, reference))
    throw new Error("calibration reference mismatch");
  const derived = deriveRunScale({
    before: report.calibration.before.observations,
    after: report.calibration.after.observations,
    referenceMedianNs:
      reference.referenceMedianNs[String(report.calibration.before.nodeMajor)],
  });
  if (!sameJson(report.calibration.derived, derived))
    throw new Error("calibration derived evidence mismatch");
  exactKeys(report.collection, ["retries", "discarded"], "collection");
  if (
    report.collection.retries !== 0 ||
    report.collection.discarded !== 0 ||
    !Array.isArray(report.rawSchedule) ||
    report.rawSchedule.length !== expected.rawSchedule.length
  )
    throw new Error("retry/discard evidence is invalid");
  const fixtures = new Map(
    expected.fixtures.map((fixture) => [fixture.id, fixture]),
  );
  const retained = new Map();
  const runTokens = new Set();
  for (const [index, expectedRecord] of expected.rawSchedule.entries()) {
    const item = report.rawSchedule[index];
    exactKeys(
      item,
      ["fixtureId", "round", "warmup", "version", "sample"],
      "raw schedule record",
    );
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      item.fixtureId !== expectedRecord.fixtureId ||
      item.round !== expectedRecord.round ||
      item.warmup !== expectedRecord.warmup ||
      item.version !== expectedRecord.version ||
      !item.sample
    )
      throw new Error("raw alternating schedule is invalid");
    validateChildSample(
      item.sample,
      expectedRecord,
      fixtures.get(expectedRecord.fixtureId),
      report,
      runTokens,
    );
    if (!expectedRecord.warmup) {
      const key = `${expectedRecord.fixtureId}:${expectedRecord.version}`;
      retained.set(key, [...(retained.get(key) ?? []), item.sample]);
    }
  }
  if (
    !Array.isArray(report.comparisons) ||
    report.comparisons.length !== expected.comparisonFixtureIds.length ||
    JSON.stringify(report.comparisons.map((item) => item?.fixtureId)) !==
      JSON.stringify(expected.comparisonFixtureIds)
  )
    throw new Error("comparison evidence set is incomplete");
  const aggregate = (samples, runScale) => {
    const correctnessKeys = new Set(
      samples.map((sample) => sample.correctnessKey),
    );
    if (correctnessKeys.size !== 1)
      throw new Error("retained correctness evidence is unstable");
    const finalizationKeys = new Set(
      samples.map((sample) => sample.finalizationKey),
    );
    if (finalizationKeys.size !== 1)
      throw new Error("retained finalization evidence is unstable");
    return {
      correctnessKey: [...correctnessKeys][0],
      finalizationKey: [...finalizationKeys][0],
      medianElapsedNs: percentile(
        samples.map((sample) => sample.elapsedNs * runScale),
        0.5,
      ),
      p95ElapsedNs: performanceP95(
        samples.map((sample) => sample.elapsedNs * runScale),
      ),
      medianMaxRSSKiB: percentile(
        samples.map((sample) => sample.maxRSSKiB),
        0.5,
      ),
    };
  };
  const aggregates = new Map(
    [...retained].map(([key, samples]) => [
      key,
      aggregate(samples, derived.runScale),
    ]),
  );
  const slopes = { baseline: 0, candidate: 0 };
  for (const version of ["baseline", "candidate"])
    slopes[version] = benchmark.rssSlope(
      new Map(
        [...aggregates]
          .filter(
            ([key]) => key.startsWith("still-") && key.endsWith(`:${version}`),
          )
          .map(([key, value]) => [key.slice(0, key.lastIndexOf(":")), value]),
      ),
      "still",
    );
  const failures = [];
  for (const comparison of report.comparisons) {
    exactKeys(
      comparison,
      ["fixtureId", "baseline", "candidate", "timing", "verdict"],
      "benchmark comparison",
    );
    for (const side of ["baseline", "candidate"]) {
      const item = comparison[side];
      const source = retained.get(`${comparison.fixtureId}:${side}`);
      const expectedSamples = source?.map((sample) => ({
        ...sample,
        scaledElapsedNs: sample.elapsedNs * derived.runScale,
      }));
      if (
        !Array.isArray(item?.samples) ||
        !sameJson(item.samples, expectedSamples)
      )
        throw new Error(
          "comparison samples are not bound to retained raw evidence",
        );
      const scaled = item.samples.map((sample) => sample.scaledElapsedNs);
      if (
        item.medianElapsedNs !== percentile(scaled, 0.5) ||
        item.p95ElapsedNs !== performanceP95(scaled)
      )
        throw new Error("derived distribution mismatch");
      exactKeys(
        item,
        [
          "correctnessKey",
          "finalizationKey",
          "medianElapsedNs",
          "p95ElapsedNs",
          "medianMaxRSSKiB",
          "rssSlope",
          "samples",
        ],
        "benchmark comparison side",
      );
      const expectedAggregate = {
        ...aggregates.get(`${comparison.fixtureId}:${side}`),
        rssSlope: slopes[side],
      };
      for (const [key, value] of Object.entries(expectedAggregate))
        if (item[key] !== value)
          throw new Error(
            "comparison aggregate is not bound to retained raw evidence",
          );
    }
    const timing = evaluateTiming({
      baselineMedianNs: comparison.baseline.medianElapsedNs,
      candidateMedianNs: comparison.candidate.medianElapsedNs,
      baselineP95Ns: comparison.baseline.p95ElapsedNs,
      candidateP95Ns: comparison.candidate.p95ElapsedNs,
    });
    if (!sameJson(timing, comparison.timing))
      throw new Error("D-23 verdict mismatch");
    const verdict = benchmark.evaluatePair({
      baseline: comparison.baseline,
      candidate: comparison.candidate,
    });
    if (!sameJson(verdict, comparison.verdict))
      throw new Error(
        "comparison verdict is not bound to retained raw evidence",
      );
    failures.push(
      ...verdict.failures.map(
        (failure) => `${comparison.fixtureId}: ${failure}`,
      ),
    );
  }
  validateCancellationEvidence(
    report.cancellation,
    report.rawSchedule,
    expected.cancellationFixtureId,
  );
  const cancellationVerdict = benchmark.evaluateCancellation(
    report.cancellation.sample,
  );
  if (!sameJson(cancellationVerdict, report.cancellation.verdict))
    throw new Error("cancellation verdict is not bound to raw evidence");
  failures.push(...cancellationVerdict.failures);
  if (
    !Array.isArray(report.failures) ||
    !sameJson(report.failures, failures) ||
    report.pass !== (failures.length === 0)
  )
    throw new Error(
      "benchmark admission conclusion is not bound to raw evidence",
    );
  return report;
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function assertSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new Error(`${label} must be SHA-256`);
}

const WINDOWS_PUBLICATION_DIAGNOSTIC_REASONS = Object.freeze([
  "absent",
  "top-level-shape",
  "top-level-keys",
  "primitive",
  "link-count",
  "destination-parent-recheck",
  "stage-directory-recheck",
  "stage-file-recheck",
  "destination-parent-identity-shape",
  "destination-parent-volume-format",
  "destination-parent-id-format",
  "stage-directory-identity-shape",
  "stage-directory-volume-format",
  "stage-directory-id-format",
  "stage-file-identity-shape",
  "stage-file-volume-format",
  "stage-file-id-format",
  "destination-file-identity-shape",
  "destination-file-volume-format",
  "destination-file-id-format",
  "destination-parent-stage-directory-volume-mismatch",
  "stage-directory-stage-file-volume-mismatch",
  "stage-file-destination-file-volume-mismatch",
  "stage-destination-file-id-mismatch",
]);
const WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES = Object.freeze([
  "win32-x64",
  "win32-arm64",
]);
const WINDOWS_PUBLICATION_DIAGNOSTIC_KEYS = Object.freeze([
  "primitive",
  "linkCalls",
  "destinationParentIdentityRechecked",
  "stageIdentityRechecked",
  "stageFileIdentityRechecked",
  "destinationParent",
  "stageDirectory",
  "stageFile",
  "destinationFile",
]);
const WINDOWS_PUBLICATION_DIAGNOSTIC_IDENTITIES = Object.freeze([
  "destinationParent",
  "stageDirectory",
  "stageFile",
  "destinationFile",
]);
const WINDOWS_PUBLICATION_REFUTATION_RUN = Object.freeze({
  id: 33200060244,
  headSha: "ba1f4c67403daf82c7de996bb210bc0efae8b63e",
  ref: "refs/heads/proof/46-25-windows-diagnostic-ba1f4c6",
  artifacts: Object.freeze({
    "matching-host": Object.freeze({
      "win32-x64":
        "d3a83a61db1443f96ad2518bcb0336e71c5855e4ba93b2f77495aa0baf4a2c14",
      "win32-arm64":
        "e757e4aba6b643a3ca75b8fba77a5778792d83fef39cbae7f18ae4e3eec93726",
    }),
    "installed-node22": Object.freeze({
      "win32-x64":
        "2e13fc5dfbd0baccc69c6305ccc9ef7b5e431d53afb560f081b213a1c999e070",
      "win32-arm64":
        "0111e778fe6b6c89d9afd7b9909ba5059f2d1ac1c87e6ab85f5263421224a88a",
    }),
  }),
});

function diagnosticReason(observation) {
  if (observation.topLevelType === "undefined") return "absent";
  if (observation.topLevelType !== "object") return "top-level-shape";
  if (
    Object.values(observation.topLevelKeys).some((value) => value !== true) ||
    observation.unexpectedTopLevelKeyCount !== 0
  )
    return "top-level-keys";
  if (!observation.primitiveIsCreateHardLinkW) return "primitive";
  if (!observation.linkCallsIsOne) return "link-count";
  if (!observation.destinationParentIdentityRecheckedIsTrue)
    return "destination-parent-recheck";
  if (!observation.stageIdentityRecheckedIsTrue)
    return "stage-directory-recheck";
  if (!observation.stageFileIdentityRecheckedIsTrue)
    return "stage-file-recheck";
  for (const name of WINDOWS_PUBLICATION_DIAGNOSTIC_IDENTITIES) {
    const facts = observation.identities[name];
    const reasonName = name.replace(/([A-Z])/gu, "-$1").toLowerCase();
    if (!facts.keysOk) return `${reasonName}-identity-shape`;
    if (facts.volumeLength !== 16 || !facts.volumeLowerHex)
      return `${reasonName}-volume-format`;
    if (facts.fileIdLength !== 32 || !facts.fileIdLowerHex)
      return `${reasonName}-id-format`;
  }
  if (!observation.equalities.destinationParentVolumeEqualsStageDirectoryVolume)
    return "destination-parent-stage-directory-volume-mismatch";
  if (!observation.equalities.stageDirectoryVolumeEqualsStageFileVolume)
    return "stage-directory-stage-file-volume-mismatch";
  if (!observation.equalities.stageFileVolumeEqualsDestinationFileVolume)
    return "stage-file-destination-file-volume-mismatch";
  if (!observation.equalities.stageFileIdEqualsDestinationFileId)
    return "stage-destination-file-id-mismatch";
  return "accepted";
}

function validateWindowsPublicationObservation(observation) {
  exactKeys(
    observation,
    [
      "status",
      "reason",
      "topLevelType",
      "topLevelKeys",
      "unexpectedTopLevelKeyCount",
      "primitiveIsCreateHardLinkW",
      "linkCallsIsOne",
      "destinationParentIdentityRecheckedIsTrue",
      "stageIdentityRecheckedIsTrue",
      "stageFileIdentityRecheckedIsTrue",
      "identities",
      "equalities",
    ],
    "Windows publication diagnostic observation",
  );
  exactKeys(
    observation.topLevelKeys,
    WINDOWS_PUBLICATION_DIAGNOSTIC_KEYS,
    "Windows publication diagnostic key presence",
  );
  if (
    ![
      "undefined",
      "null",
      "array",
      "object",
      "boolean",
      "number",
      "string",
      "function",
      "symbol",
      "bigint",
    ].includes(observation.topLevelType) ||
    Object.values(observation.topLevelKeys).some(
      (value) => typeof value !== "boolean",
    ) ||
    !Number.isSafeInteger(observation.unexpectedTopLevelKeyCount) ||
    observation.unexpectedTopLevelKeyCount < 0
  )
    throw new Error(
      "Windows publication diagnostic top-level facts are invalid",
    );
  for (const key of [
    "primitiveIsCreateHardLinkW",
    "linkCallsIsOne",
    "destinationParentIdentityRecheckedIsTrue",
    "stageIdentityRecheckedIsTrue",
    "stageFileIdentityRecheckedIsTrue",
  ])
    if (typeof observation[key] !== "boolean")
      throw new Error(
        "Windows publication diagnostic primitive facts are invalid",
      );
  exactKeys(
    observation.identities,
    WINDOWS_PUBLICATION_DIAGNOSTIC_IDENTITIES,
    "Windows publication diagnostic identities",
  );
  for (const identity of Object.values(observation.identities)) {
    exactKeys(
      identity,
      [
        "keysOk",
        "volumeLength",
        "volumeLowerHex",
        "fileIdLength",
        "fileIdLowerHex",
      ],
      "Windows publication diagnostic identity facts",
    );
    if (
      typeof identity.keysOk !== "boolean" ||
      !Number.isSafeInteger(identity.volumeLength) ||
      identity.volumeLength < -1 ||
      typeof identity.volumeLowerHex !== "boolean" ||
      !Number.isSafeInteger(identity.fileIdLength) ||
      identity.fileIdLength < -1 ||
      typeof identity.fileIdLowerHex !== "boolean"
    )
      throw new Error(
        "Windows publication diagnostic identity facts are invalid",
      );
  }
  exactKeys(
    observation.equalities,
    [
      "destinationParentVolumeEqualsStageDirectoryVolume",
      "stageDirectoryVolumeEqualsStageFileVolume",
      "stageFileVolumeEqualsDestinationFileVolume",
      "stageFileIdEqualsDestinationFileId",
    ],
    "Windows publication diagnostic equalities",
  );
  if (
    Object.values(observation.equalities).some(
      (value) => typeof value !== "boolean",
    )
  )
    throw new Error("Windows publication diagnostic equalities are invalid");
  const reason = diagnosticReason(observation);
  if (
    !["accepted", ...WINDOWS_PUBLICATION_DIAGNOSTIC_REASONS].includes(
      observation.reason,
    ) ||
    observation.reason !== reason ||
    observation.status !== (reason === "accepted" ? "accepted" : "rejected")
  )
    throw new Error("Windows publication diagnostic reason is invalid");
  return observation;
}

function validateWindowsPublicationDiagnosticRecord(record, tuple, boundary) {
  exactKeys(
    record,
    ["tuple", "boundary", "nodeMajor", "job", "artifact", "observation"],
    "Windows publication diagnostic record",
  );
  exactKeys(record.job, ["name", "conclusion"], "diagnostic job");
  exactKeys(record.artifact, ["name", "sha256"], "diagnostic artifact");
  const expectedJob =
    boundary === "matching-host"
      ? `build-audit-${tuple}`
      : `installed-${tuple}`;
  const expectedArtifact = `windows-publication-${boundary}-${tuple}`;
  if (
    record.tuple !== tuple ||
    record.boundary !== boundary ||
    record.nodeMajor !== 22 ||
    record.job.name !== expectedJob ||
    !["success", "failure", "cancelled", "timed_out"].includes(
      record.job.conclusion,
    ) ||
    record.artifact.name !== expectedArtifact
  )
    throw new Error(
      "Windows publication diagnostic record identity is invalid",
    );
  assertSha(record.artifact.sha256, "Windows publication diagnostic artifact");
  validateWindowsPublicationObservation(record.observation);
  if (
    record.observation.status === "rejected" &&
    record.job.conclusion !== "failure"
  )
    throw new Error(
      "rejected Windows observation must retain hard job failure",
    );
  return record;
}

function validateWindowsPublicationDiagnosticPair(pair, boundary) {
  exactKeys(pair, WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES, `${boundary} pair`);
  for (const tuple of WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES)
    validateWindowsPublicationDiagnosticRecord(pair[tuple], tuple, boundary);
  return pair;
}

function validateWindowsPublicationDiagnosticLedger(ledger) {
  exactKeys(
    ledger,
    [
      "schemaVersion",
      "diagnosticOnly",
      "run",
      "outcome",
      "selectedBoundary",
      "matchingHost",
      "installedNode22",
      "laterFailures",
    ],
    "Windows publication diagnostic ledger",
  );
  exactKeys(
    ledger.run,
    [
      "repository",
      "workflow",
      "event",
      "attempt",
      "id",
      "url",
      "ref",
      "headSha",
    ],
    "Windows publication diagnostic run",
  );
  if (
    ledger.schemaVersion !==
      "phase-46-windows-publication-diagnostic-ledger/v1" ||
    ledger.diagnosticOnly !== true ||
    ledger.run.repository !== "szTheory/exifcleaner-node" ||
    ledger.run.workflow !== ".github/workflows/ci.yml" ||
    ledger.run.event !== "workflow_dispatch" ||
    ledger.run.attempt !== 1 ||
    !Number.isSafeInteger(ledger.run.id) ||
    ledger.run.id <= 0 ||
    ledger.run.url !==
      `https://github.com/szTheory/exifcleaner-node/actions/runs/${ledger.run.id}` ||
    !/^[a-f0-9]{40}$/u.test(ledger.run.headSha) ||
    ledger.run.ref !==
      `refs/heads/proof/46-25-windows-diagnostic-${ledger.run.headSha.slice(0, 7)}`
  )
    throw new Error("Windows publication diagnostic run identity is invalid");
  const matching = validateWindowsPublicationDiagnosticPair(
    ledger.matchingHost,
    "matching-host",
  );
  const matchingRejected = WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES.some(
    (tuple) => matching[tuple].observation.status === "rejected",
  );
  if (ledger.outcome === "rejection-observed") {
    if (ledger.laterFailures !== null)
      throw new Error("rejection-observed cannot claim a later failure");
    if (matchingRejected) {
      if (
        ledger.selectedBoundary !== "matching-host" ||
        ledger.installedNode22 !== null
      )
        throw new Error("Windows diagnostic boundaries are mixed");
      return ledger;
    }
    if (
      ledger.selectedBoundary !== "installed-node22" ||
      ledger.installedNode22 === null
    )
      throw new Error("Windows diagnostic selected boundary is invalid");
    const installed = validateWindowsPublicationDiagnosticPair(
      ledger.installedNode22,
      "installed-node22",
    );
    if (
      !WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES.some(
        (tuple) => installed[tuple].observation.status === "rejected",
      )
    )
      throw new Error("Windows diagnostic selected boundary has no rejection");
    return ledger;
  }
  if (ledger.outcome !== "hypothesis-refuted")
    throw new Error("Windows publication diagnostic outcome is invalid");
  if (
    ledger.selectedBoundary !== null ||
    matchingRejected ||
    ledger.run.id !== WINDOWS_PUBLICATION_REFUTATION_RUN.id ||
    ledger.run.headSha !== WINDOWS_PUBLICATION_REFUTATION_RUN.headSha ||
    ledger.run.ref !== WINDOWS_PUBLICATION_REFUTATION_RUN.ref
  )
    throw new Error("Windows publication refutation identity is invalid");
  const installed = validateWindowsPublicationDiagnosticPair(
    ledger.installedNode22,
    "installed-node22",
  );
  exactKeys(
    ledger.laterFailures,
    WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES,
    "Windows publication refutation later failures",
  );
  for (const tuple of WINDOWS_PUBLICATION_DIAGNOSTIC_TUPLES) {
    if (
      matching[tuple].observation.status !== "accepted" ||
      matching[tuple].job.conclusion !== "success" ||
      installed[tuple].observation.status !== "accepted" ||
      installed[tuple].job.conclusion !== "failure" ||
      matching[tuple].artifact.sha256 !==
        WINDOWS_PUBLICATION_REFUTATION_RUN.artifacts["matching-host"][tuple] ||
      installed[tuple].artifact.sha256 !==
        WINDOWS_PUBLICATION_REFUTATION_RUN.artifacts["installed-node22"][
          tuple
        ] ||
      ledger.laterFailures[tuple] !== "deterministic-cancellation"
    )
      throw new Error("Windows publication refutation facts are invalid");
  }
  return ledger;
}
function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function git(repoRoot, args, encoding = "utf8") {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding });
}
function gitBlob(repoRoot, revision, file) {
  return Buffer.from(git(repoRoot, ["show", `${revision}:${file}`]));
}
function validateFinalCandidateManifest({
  repoRoot,
  candidateSha,
  repairProofSha,
}) {
  if (
    ![candidateSha, repairProofSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))
  )
    throw new Error("final candidate manifest SHA is invalid");
  const manifestPath = "native/phase-46-final-candidate.json";
  let bytes;
  try {
    bytes = gitBlob(repoRoot, candidateSha, manifestPath);
  } catch {
    throw new Error("final candidate manifest is absent");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("final candidate manifest is invalid JSON");
  }
  if (!bytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`, "utf8")))
    throw new Error("final candidate manifest bytes are not canonical");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "phase",
      "repairParentSha",
      "nativeSource",
      "nativeAuditManifest",
      "nativeAuditAuthority",
      "calibrationReference",
      "calibrationAlgorithm",
      "sourceDistTree",
    ],
    "final candidate manifest",
  );
  if (
    manifest.schemaVersion !== "phase-46-final-candidate/v1" ||
    manifest.phase !== 46 ||
    manifest.repairParentSha !== repairProofSha
  )
    throw new Error("final candidate manifest repair parent is invalid");
  const parent = git(repoRoot, ["rev-parse", `${candidateSha}^`]).trim();
  if (parent !== repairProofSha)
    throw new Error(
      "final candidate manifest does not directly follow repair proof",
    );
  const diff = git(repoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    parent,
    candidateSha,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (diff.length !== 1 || diff[0] !== manifestPath)
    throw new Error("final candidate manifest commit diff is not exact");
  const authorityPaths = [
    ["nativeSource", "native/publication.c"],
    ["nativeAuditManifest", "scripts/audit_native_source.cjs"],
    ["nativeAuditAuthority", "scripts/audit_native_artifact.cjs"],
    [
      "calibrationReference",
      "scripts/qualification/benchmark-calibration-reference.json",
    ],
    ["calibrationAlgorithm", "scripts/qualification/benchmark-calibration.cjs"],
  ];
  for (const [key, expectedPath] of authorityPaths) {
    const value = manifest[key];
    exactKeys(value, ["path", "sha256"], `final authority ${key}`);
    if (
      value.path !== expectedPath ||
      !SHA256.test(value.sha256) ||
      sha256FileFromBytes(gitBlob(repoRoot, candidateSha, value.path)) !==
        value.sha256
    )
      throw new Error(`final authority ${key} is invalid`);
  }
  const tree = manifest.sourceDistTree;
  exactKeys(
    tree,
    ["algorithm", "included", "excluded", "members", "sha256"],
    "final candidate source/dist tree",
  );
  if (
    tree.algorithm !== "phase-46-source-dist-tree/v1" ||
    JSON.stringify(tree.included) !== JSON.stringify(["src", "dist"]) ||
    JSON.stringify(tree.excluded) !== JSON.stringify([]) ||
    !SHA256.test(tree.sha256) ||
    !Array.isArray(tree.members)
  )
    throw new Error("final candidate source/dist tree contract is invalid");
  const listing = git(repoRoot, ["ls-tree", "-r", "-z", candidateSha], "buffer")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const members = listing
    .filter((entry) => /\t(?:src|dist)\//.test(entry))
    .map((entry) => {
      const match = /^(\d+) \w+ [0-9a-f]+\t(.+)$/.exec(entry);
      if (!match || match[1] !== "100644" || !/^(src|dist)\//.test(match[2]))
        throw new Error("final candidate tree member is invalid");
      return {
        path: match[2],
        sha256: sha256FileFromBytes(gitBlob(repoRoot, candidateSha, match[2])),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (
    !members.length ||
    JSON.stringify(tree.members) !== JSON.stringify(members) ||
    tree.sha256 !==
      sha256FileFromBytes(Buffer.from(`${canonicalJson(members)}\n`))
  )
    throw new Error("final candidate source/dist tree digest is invalid");
  return manifest;
}
function sha256FileFromBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function assertEqual(left, right, label) {
  if (left !== right) throw new Error(`${label} mismatch`);
}
function requireWindowsPublicationEvidence(evidence) {
  if (typeof evidence !== "object" || evidence === null)
    throw new Error("Windows native publication evidence is absent");
  exactKeys(
    evidence,
    [
      "primitive",
      "linkCalls",
      "destinationParentIdentityRechecked",
      "stageIdentityRechecked",
      "stageFileIdentityRechecked",
      "destinationParent",
      "stageDirectory",
      "stageFile",
      "destinationFile",
    ],
    "Windows native publication evidence",
  );
  const identities = [
    evidence.destinationParent,
    evidence.stageDirectory,
    evidence.stageFile,
    evidence.destinationFile,
  ];
  identities.forEach((identity) =>
    exactKeys(
      identity,
      ["volumeSerialNumber", "fileId"],
      "Windows native publication identity",
    ),
  );
  if (
    evidence.primitive !== "CreateHardLinkW" ||
    evidence.linkCalls !== 1 ||
    evidence.destinationParentIdentityRechecked !== true ||
    evidence.stageIdentityRechecked !== true ||
    evidence.stageFileIdentityRechecked !== true ||
    identities.some(
      (identity) =>
        typeof identity !== "object" ||
        identity === null ||
        typeof identity.volumeSerialNumber !== "string" ||
        !/^[a-f0-9]{16}$/.test(identity.volumeSerialNumber) ||
        typeof identity.fileId !== "string" ||
        !/^[a-f0-9]{32}$/.test(identity.fileId),
    ) ||
    new Set(identities.map((identity) => identity.volumeSerialNumber)).size !==
      1 ||
    evidence.stageFile.fileId !== evidence.destinationFile.fileId
  )
    throw new Error(
      "Windows native publication evidence is incomplete or inconsistent",
    );
  return {
    primitive: "create-hard-link",
    publication: "pass",
    collision: "pass",
    identity: "pass",
    cleanup: "pass",
  };
}
const TERMINAL_CLEANUP_KEYS = Object.freeze([
  "schemaVersion",
  "abiVersion",
  "platform",
  "ownership",
  "capture",
  "helper",
  "terminal",
  "replacement",
  "nativeLifetime",
]);

function orderedKeys(value, expected, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)
  )
    throw new Error(`${label} fields are not exact and ordered`);
}

function cleanupIdentity(value, nullable, label) {
  if (value === null && nullable) return;
  orderedKeys(value, ["volumeSerialNumber", "fileId"], label);
  if (
    !/^[a-f0-9]{16}$/u.test(value.volumeSerialNumber) ||
    !/^[a-f0-9]{32}$/u.test(value.fileId)
  )
    throw new Error(`${label} is not a Windows FileIdInfo identity`);
}

function sameCleanupIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Recomputes terminal-cleanup evidence from closed raw fields.  No producer
 * conclusion, convenience boolean, pathname operation, or default is trusted. */
function validateTerminalCleanupRecord(record, scenario = "installed") {
  orderedKeys(record, TERMINAL_CLEANUP_KEYS, "terminal cleanup record");
  if (
    record.schemaVersion !== "phase-46-terminal-cleanup/v2" ||
    record.abiVersion !== "native-publication/v2" ||
    !["win32", "linux", "darwin"].includes(record.platform) ||
    !["control", "installed"].includes(scenario)
  )
    throw new Error("terminal cleanup schema is invalid");
  const { ownership, capture, helper, terminal, replacement, nativeLifetime } =
    record;
  orderedKeys(
    ownership,
    [
      "helperToken",
      "captureOwnershipToken",
      "terminalOwnershipToken",
      "captureCapabilityId",
      "terminalCapabilityId",
    ],
    "terminal cleanup ownership",
  );
  orderedKeys(
    capture,
    ["result", "directoryIdentity", "fileIdentity"],
    "terminal cleanup capture",
  );
  orderedKeys(
    helper,
    ["ownershipToken", "quiescenceSequence", "terminalSequence"],
    "terminal cleanup helper",
  );
  orderedKeys(
    terminal,
    [
      "identityBefore",
      "removalIdentity",
      "outcome",
      "consumeCount",
      "replayCount",
      "replayOutcome",
    ],
    "terminal cleanup terminal",
  );
  orderedKeys(
    replacement,
    [
      "observationSequence",
      "injectionSequence",
      "identityBefore",
      "sha256Before",
      "identityAfter",
      "sha256After",
    ],
    "terminal cleanup replacement",
  );
  orderedKeys(
    nativeLifetime,
    ["handlesBefore", "handlesAfter", "finalizersBefore", "finalizersAfter"],
    "terminal cleanup lifetime",
  );
  const hashes = [
    ownership.helperToken,
    ownership.captureOwnershipToken,
    ownership.terminalOwnershipToken,
    ownership.captureCapabilityId,
    ownership.terminalCapabilityId,
  ];
  if (
    hashes.some((value) => !SHA256.test(value)) ||
    ownership.helperToken !== ownership.captureOwnershipToken ||
    ownership.helperToken !== ownership.terminalOwnershipToken ||
    ownership.helperToken !== helper.ownershipToken ||
    ownership.captureCapabilityId !== ownership.terminalCapabilityId ||
    ownership.captureCapabilityId === ownership.helperToken
  )
    throw new Error("terminal cleanup ownership/capability binding is invalid");
  for (const value of [
    helper.quiescenceSequence,
    helper.terminalSequence,
    replacement.observationSequence,
    replacement.injectionSequence,
    terminal.consumeCount,
    terminal.replayCount,
    ...Object.values(nativeLifetime),
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("terminal cleanup sequence or lifetime is invalid");
  if (
    helper.quiescenceSequence <= 0 ||
    !(
      helper.quiescenceSequence <= replacement.observationSequence &&
      replacement.observationSequence < replacement.injectionSequence &&
      replacement.injectionSequence < helper.terminalSequence
    ) ||
    terminal.consumeCount !== 1 ||
    terminal.replayCount !== 1 ||
    terminal.replayOutcome !== "no-action"
  )
    throw new Error(
      "terminal cleanup quiescence or single-use relation is invalid",
    );
  if (record.platform === "win32") {
    if (capture.result !== "captured")
      throw new Error("Windows capture is not authentic");
    cleanupIdentity(
      capture.directoryIdentity,
      false,
      "captured directory identity",
    );
    cleanupIdentity(capture.fileIdentity, false, "captured file identity");
    cleanupIdentity(terminal.identityBefore, true, "terminal identity before");
    cleanupIdentity(
      terminal.removalIdentity,
      true,
      "terminal removal identity",
    );
    const replacementOutcome = [
      "replacement-retained",
      "identity-mismatch",
    ].includes(terminal.outcome);
    if (scenario === "installed" && !replacementOutcome)
      throw new Error(
        "installed Windows record did not preserve the replacement",
      );
    if (replacementOutcome) {
      cleanupIdentity(
        replacement.identityBefore,
        false,
        "replacement identity before",
      );
      cleanupIdentity(
        replacement.identityAfter,
        false,
        "replacement identity after",
      );
      if (
        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||
        !sameCleanupIdentity(
          terminal.removalIdentity,
          replacement.identityBefore,
        ) ||
        sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity) ||
        !sameCleanupIdentity(
          replacement.identityBefore,
          replacement.identityAfter,
        ) ||
        !SHA256.test(replacement.sha256Before) ||
        replacement.sha256Before !== replacement.sha256After
      )
        throw new Error("Windows replacement survivor proof is invalid");
    } else if (terminal.outcome === "removed") {
      if (
        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||
        !sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity)
      )
        throw new Error("Windows removal identity is invalid");
    } else if (terminal.outcome === "absent") {
      if (terminal.identityBefore !== null || terminal.removalIdentity !== null)
        throw new Error("Windows absent identity is invalid");
    } else throw new Error("Windows terminal outcome is invalid");
    if (
      nativeLifetime.handlesAfter !== nativeLifetime.handlesBefore ||
      nativeLifetime.finalizersAfter !== nativeLifetime.finalizersBefore + 1
    )
      throw new Error("Windows native lifetime is imbalanced");
  } else {
    if (
      capture.result !== "unsupported" ||
      capture.directoryIdentity !== null ||
      capture.fileIdentity !== null ||
      terminal.outcome !== "unsupported-retained" ||
      terminal.identityBefore !== null ||
      terminal.removalIdentity !== null ||
      replacement.identityBefore !== null ||
      replacement.identityAfter !== null ||
      !SHA256.test(replacement.sha256Before) ||
      replacement.sha256Before !== replacement.sha256After ||
      nativeLifetime.handlesAfter !== nativeLifetime.handlesBefore ||
      nativeLifetime.finalizersAfter !== nativeLifetime.finalizersBefore
    )
      throw new Error("POSIX retained cleanup record is invalid");
  }
}

function validateInstalledReport(report, tuple, nodeMajor, candidate) {
  const windows = tuple.startsWith("win32");
  const expectedPostCommitResidue = windows
    ? "none"
    : "private-empty-stage-directory-remains";
  const expectedFailureFinalization = windows
    ? "owned-partial-removed"
    : "owned-partial-remains";
  const expectedFailureResidue = !windows;
  if (
    typeof report !== "object" ||
    report === null ||
    report.evidenceScope !== "final-matching-host" ||
    report.hostTuple !== tuple ||
    !new RegExp(`^v${nodeMajor}\\.`).test(report.nodeVersion ?? "") ||
    report.tarball?.sha256 !== candidate.tarballSha256 ||
    report.manifestSha256 !== candidate.corpusManifestSha256 ||
    report.selectedArtifact !== `prebuilds/${tuple}/publication.node`
  )
    throw new Error("installed report binding is invalid");
  exactKeys(
    report,
    [
      "evidenceScope",
      "hostTuple",
      "nodeVersion",
      "tarball",
      "manifestSha256",
      "propertySeed",
      "propertyRuns",
      "propertyOutputDigest",
      "corpusCases",
      "install",
      "selectedArtifact",
      "cases",
      ...(tuple.startsWith("win32") ? ["windowsPublication"] : []),
    ],
    "installed report",
  );
  exactKeys(report.tarball, ["file", "sha256"], "installed tarball");
  exactKeys(report.install, ["command", "arguments"], "installed command");
  if (
    typeof report.tarball.file !== "string" ||
    report.tarball.file.length === 0 ||
    report.tarball.file !== path.basename(report.tarball.file) ||
    !report.tarball.file.endsWith(".tgz") ||
    report.tarball.sha256 !== candidate.tarballSha256 ||
    report.propertySeed !== 460_046 ||
    report.propertyRuns !== 25 ||
    !SHA256.test(report.propertyOutputDigest) ||
    report.install.command !== "npm install --ignore-scripts" ||
    JSON.stringify(report.install.arguments) !==
      JSON.stringify([
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "<admitted-tarball>",
      ])
  )
    throw new Error("installed command or property evidence is invalid");
  if (!Array.isArray(report.corpusCases) || report.corpusCases.length !== 2)
    throw new Error("installed corpus evidence is invalid");
  const expectedCorpusIds = [
    "derived-two-frame-animation",
    "exifcleaner-sample",
  ];
  const expectedCorpus = {
    "exifcleaner-sample": {
      sourceSha256:
        "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
      outputSha256:
        "a412e742b59ef1161af1410dd98b86c91acf85827a5f671d5f91712a4a282e1f",
      removedNamespaces: ["EXIF"],
      payloadDigests: [
        {
          fourCc: "VP8 ",
          occurrence: 0,
          sha256:
            "1300ec4f408f0960b09a5265851b14e81ac0c120fae6c3d555306df849235697",
        },
      ],
    },
    "derived-two-frame-animation": {
      sourceSha256:
        "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
      outputSha256:
        "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
      removedNamespaces: [],
      payloadDigests: [
        {
          fourCc: "ANIM",
          occurrence: 0,
          sha256:
            "ba3e4486d8c5bc4009da061168a88d776a1849bbc2596b474c9b05a9ff44a6c6",
        },
        {
          fourCc: "ANMF",
          occurrence: 0,
          sha256:
            "144759bea1ad5db4c4b1e20e4ffcbadd92ae4737d0559b28e5107871e3d89f96",
        },
        {
          fourCc: "ANMF",
          occurrence: 1,
          sha256:
            "a94c038e055c40ccc62f47ef3c6915fec89258e04d5fb7f5261920601dddef90",
        },
      ],
    },
  };
  const corpusIds = [];
  for (const corpusCase of report.corpusCases) {
    exactKeys(
      corpusCase,
      [
        "id",
        "magicAdmission",
        "sourceSha256",
        "outputSha256",
        "payloadDigests",
        "removedNamespaces",
        "finalization",
      ],
      "installed corpus case",
    );
    if (
      typeof corpusCase.id !== "string" ||
      corpusCase.magicAdmission !== true ||
      !Object.hasOwn(expectedCorpus, corpusCase.id) ||
      corpusCase.sourceSha256 !== expectedCorpus[corpusCase.id].sourceSha256 ||
      corpusCase.outputSha256 !== expectedCorpus[corpusCase.id].outputSha256 ||
      !Array.isArray(corpusCase.payloadDigests) ||
      JSON.stringify(corpusCase.payloadDigests) !==
        JSON.stringify(expectedCorpus[corpusCase.id].payloadDigests) ||
      JSON.stringify(corpusCase.removedNamespaces) !==
        JSON.stringify(expectedCorpus[corpusCase.id].removedNamespaces) ||
      corpusCase.finalization !== expectedPostCommitResidue
    )
      throw new Error("installed corpus case is invalid");
    corpusIds.push(corpusCase.id);
  }
  if (JSON.stringify(corpusIds.sort()) !== JSON.stringify(expectedCorpusIds))
    throw new Error("installed corpus case set is invalid");
  exactKeys(
    report.cases,
    [
      "sourcePreserved",
      "published",
      "collisionPreserved",
      "cancellation",
      "postCommitResidue",
      "collisionFinalization",
    ],
    "installed report cases",
  );
  exactKeys(
    report.cases.cancellation,
    ["code", "nativeWrite", "fallback", "finalization", "residue", "cleanup"],
    "installed cancellation",
  );
  exactKeys(
    report.cases.cancellation.residue,
    ["stageDirectoryExists", "stageFileExists"],
    "installed cancellation residue",
  );
  if (
    report.cases.sourcePreserved !== true ||
    report.cases.published !== true ||
    report.cases.collisionPreserved !== true ||
    report.cases.cancellation.code !== "aborted" ||
    report.cases.cancellation.nativeWrite !== "started" ||
    report.cases.cancellation.fallback !== "do-not-fallback" ||
    report.cases.cancellation.finalization !== expectedFailureFinalization ||
    report.cases.cancellation.residue.stageDirectoryExists !==
      expectedFailureResidue ||
    report.cases.cancellation.residue.stageFileExists !==
      expectedFailureResidue ||
    report.cases.postCommitResidue !== expectedPostCommitResidue ||
    report.cases.collisionFinalization !== expectedFailureFinalization
  )
    throw new Error("installed report contract is invalid");
  validateTerminalCleanupRecord(report.cases.cancellation.cleanup, "installed");
  if (
    report.cases.cancellation.cleanup.platform !==
      (windows ? "win32" : report.cases.cancellation.cleanup.platform) ||
    (!windows &&
      !["linux", "darwin"].includes(report.cases.cancellation.cleanup.platform))
  )
    throw new Error("installed cleanup platform is invalid");
  return tuple.startsWith("win32")
    ? requireWindowsPublicationEvidence(report.windowsPublication)
    : undefined;
}

const D18_TUPLES = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);

function validateIdentityCleanupLedger(ledger) {
  orderedKeys(
    ledger,
    ["schemaVersion", "run", "candidate", "artifacts", "installed"],
    "identity cleanup ledger",
  );
  orderedKeys(
    ledger.run,
    ["id", "url", "ref", "headSha"],
    "identity cleanup ledger run",
  );
  orderedKeys(
    ledger.candidate,
    [
      "implementationSha",
      "tarballSha256",
      "corpusManifestSha256",
      "nativeManifestSha256",
    ],
    "identity cleanup ledger candidate",
  );
  if (
    ledger.schemaVersion !== "phase-46-identity-cleanup-ledger/v1" ||
    !Number.isSafeInteger(ledger.run.id) ||
    ledger.run.id <= 0 ||
    !/^https:\/\//u.test(ledger.run.url) ||
    !/^proof\/46-18-repair-[0-9a-f]+$/u.test(ledger.run.ref) ||
    !/^[a-f0-9]{40}$/u.test(ledger.run.headSha) ||
    ledger.candidate.implementationSha !== ledger.run.headSha ||
    !SHA256.test(ledger.candidate.tarballSha256) ||
    !SHA256.test(ledger.candidate.corpusManifestSha256) ||
    !SHA256.test(ledger.candidate.nativeManifestSha256)
  )
    throw new Error("identity cleanup ledger run/candidate binding is invalid");
  orderedKeys(
    ledger.artifacts,
    D18_TUPLES,
    "identity cleanup ledger artifacts",
  );
  orderedKeys(
    ledger.installed,
    D18_TUPLES,
    "identity cleanup ledger installed",
  );
  const observed = new Set();
  for (const tuple of D18_TUPLES) {
    const artifact = ledger.artifacts[tuple];
    orderedKeys(
      artifact,
      ["binarySha256", "auditReportSha256", "implementationSha"],
      `identity artifact ${tuple}`,
    );
    if (
      !SHA256.test(artifact.binarySha256) ||
      !SHA256.test(artifact.auditReportSha256) ||
      artifact.implementationSha !== ledger.run.headSha
    )
      throw new Error(`identity artifact ${tuple} is stale or incomplete`);
    const installed = ledger.installed[tuple];
    orderedKeys(installed, ["node22", "node24"], `identity installed ${tuple}`);
    for (const [nodeMajor, key] of [
      [22, "node22"],
      [24, "node24"],
    ]) {
      const report = installed[key];
      validateInstalledReport(report, tuple, nodeMajor, ledger.candidate);
      const identity = `${tuple}/node${nodeMajor}`;
      if (observed.has(identity))
        throw new Error(
          "identity cleanup ledger has duplicate installed evidence",
        );
      observed.add(identity);
    }
  }
  if (observed.size !== 12)
    throw new Error("identity cleanup ledger is incomplete");
}
function hostedLedger(filePath, memoryPath, windowsPath) {
  if (!memoryPath || !windowsPath)
    throw new Error("hosted ledger requires memory and Windows ledgers");
  const ledger = readJson(filePath);
  const memory = readJson(memoryPath);
  const windows = readJson(windowsPath);
  const tuples = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
  ];
  const artifacts = [
    "phase-46-admission",
    "qualification-linux-x64-node24",
    "final-native-admission",
    "benchmark-linux-node22",
    "benchmark-linux-node24",
    ...tuples.map((tuple) => `installed-${tuple}`),
  ];
  if (
    ledger.schemaVersion !== 2 ||
    ledger.repository !== "szTheory/exifcleaner-node" ||
    ledger.workflow !== "CI" ||
    ledger.workflowPath !== ".github/workflows/ci.yml" ||
    ledger.event !== "workflow_dispatch" ||
    ledger.conclusion !== "success" ||
    !Number.isSafeInteger(ledger.runId) ||
    !/^https:\/\//.test(ledger.runUrl ?? "") ||
    !/^proof\/46-11-final-[0-9a-f]+$/.test(ledger.ref ?? "") ||
    !/^[a-f0-9]{40}$/.test(ledger.headSha ?? "") ||
    ledger.candidate?.sha !== ledger.headSha
  )
    throw new Error("hosted run identity is invalid");
  if (
    Object.keys(ledger.artifactSha256 ?? {})
      .sort()
      .join(",") !== artifacts.sort().join(",") ||
    artifacts.some((name) => !SHA256.test(ledger.artifactSha256[name]))
  )
    throw new Error("hosted artifact map is incomplete");
  for (const report of [ledger.node22, ledger.node24]) validateReport(report);
  const reports = phaseAdmissionReports([ledger.node22, ledger.node24]);
  for (const report of reports) {
    const nodeMajor = Number(
      report.environment.nodeVersion.match(/^v(\d+)/)[1],
    );
    if (
      report.candidateSha256 !== ledger.candidate.tarballSha256 ||
      report.baselineSha256 !== ledger.baseline?.tarballSha256 ||
      report.mode !== "admit" ||
      report.pass !== true ||
      report.environment.platform !== "linux" ||
      report.environment.architecture !== "x64" ||
      ledger.artifactSha256[`benchmark-linux-node${nodeMajor}`] !==
        ledger.benchmarks?.[`node${nodeMajor}`]?.artifactSha256
    )
      throw new Error("hosted benchmark binding is invalid");
  }
  if (
    ledger.focused?.tuple !== "linux-x64" ||
    ledger.focused?.nodeMajor !== 24 ||
    ledger.focused?.seed !== 460046 ||
    ledger.focused?.propertyRuns !== 200 ||
    !ledger.focused?.oracleAuthority ||
    ledger.focused.manifestSha256 !== ledger.candidate.corpusManifestSha256 ||
    ledger.installedConclusions !== 12
  )
    throw new Error("focused admission authority is invalid");
  if (
    Object.keys(ledger.tuples ?? {})
      .sort()
      .join(",") !== tuples.sort().join(",")
  )
    throw new Error("installed tuple set is incomplete");
  for (const tuple of tuples) {
    const item = ledger.tuples[tuple];
    const expectedWindowsSummary = {};
    if (
      !item?.reports ||
      JSON.stringify(Object.keys(item.reports).sort()) !==
        JSON.stringify(["node22", "node24"])
    )
      throw new Error("installed report map is incomplete");
    for (const [nodeMajor, key] of [
      [22, "node22"],
      [24, "node24"],
    ]) {
      const summary = validateInstalledReport(
        item.reports[key],
        tuple,
        nodeMajor,
        ledger.candidate,
      );
      if (summary !== undefined) Object.assign(expectedWindowsSummary, summary);
    }
    if (
      item?.jobName !== `installed-${tuple}` ||
      item?.conclusion !== "success" ||
      item?.runId !== ledger.runId ||
      item?.headSha !== ledger.headSha ||
      item?.candidateSha !== ledger.headSha ||
      item?.candidateTarballSha256 !== ledger.candidate.tarballSha256 ||
      item?.corpusManifestSha256 !== ledger.candidate.corpusManifestSha256 ||
      item?.nativeManifestSha256 !== ledger.candidate.nativeManifestSha256 ||
      item?.artifact?.name !== `installed-${tuple}` ||
      item.artifact?.runId !== ledger.runId ||
      item.artifact?.sha256 !== ledger.artifactSha256[`installed-${tuple}`] ||
      JSON.stringify(item.nodeMajors) !== JSON.stringify([22, 24])
    )
      throw new Error("installed tuple binding is invalid");
    if (
      tuple.startsWith("win32") &&
      !sameJson(
        {
          primitive: item.primitive,
          publication: item.publication,
          collision: item.collision,
          identity: item.identity,
          cleanup: item.cleanup,
        },
        expectedWindowsSummary,
      )
    )
      throw new Error("Windows publication authority is invalid");
  }
  assertSha(ledger.candidate?.tarballSha256, "candidate tarball");
  assertSha(ledger.candidate?.corpusManifestSha256, "corpus manifest");
  assertSha(ledger.candidate?.nativeManifestSha256, "native manifest");
  if (
    ledger.repairs?.memory?.sha256 !== sha256File(memoryPath) ||
    ledger.repairs?.windows?.sha256 !== sha256File(windowsPath) ||
    ledger.repairs.memory?.runId !== memory.runId ||
    ledger.repairs.windows?.runId !== windows.runId ||
    ledger.repairs.memory?.headSha !== memory.headSha ||
    ledger.repairs.windows?.headSha !== windows.headSha
  )
    throw new Error("prerequisite ledger binding is invalid");
  if (
    JSON.stringify(ledger.finalizationContracts) !==
    JSON.stringify(memory.finalizationContracts)
  )
    throw new Error("version-specific finalization contracts mismatch");
  const animation = ledger.node22?.comparisons?.find(
    (item) => item.fixtureId === "animation-alpha-16m",
  );
  if (
    !animation ||
    animation.baseline.samples.length !== 15 ||
    animation.candidate.samples.length !== 15 ||
    percentile(
      animation.candidate.samples.map((sample) => sample.maxRSSKiB),
      0.5,
    ) > 153500 ||
    percentile(
      animation.candidate.samples.map((sample) => sample.maxRSSKiB),
      0.5,
    ) >
      percentile(
        animation.baseline.samples.map((sample) => sample.maxRSSKiB),
        0.5,
      ) +
        16384
  )
    throw new Error("Node 22 animation RSS authority is invalid");
  return ledger;
}
function phaseAdmissionReports(reports) {
  if (reports.length !== 2)
    throw new Error("both Node benchmark reports are required");
  for (const report of reports) validateReport(report);
  const majors = reports
    .map((report) => Number(report.environment.nodeVersion.match(/^v(\d+)/)[1]))
    .sort()
    .join(",");
  if (
    majors !== "22,24" ||
    reports.some((report) => report.mode !== "admit" || report.pass !== true)
  )
    throw new Error("Node benchmark admission is incomplete");
  if (
    new Set(reports.map((report) => report.candidateSha256)).size !== 1 ||
    new Set(reports.map((report) => report.baselineSha256)).size !== 1
  )
    throw new Error("benchmark tarball identities disagree");
  return reports;
}
function phaseAdmission(paths) {
  if (paths.length !== 2)
    throw new Error("both Node benchmark reports are required");
  const reports = paths.map((file) =>
    validateReport(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
  return phaseAdmissionReports(reports);
}
function main(args) {
  if (args[0] === "--validate-final-candidate-manifest" && args.length === 4)
    return validateFinalCandidateManifest({
      repoRoot: args[1],
      candidateSha: args[2],
      repairProofSha: args[3],
    });
  if (args[0] === "--validate-report" && args.length === 2)
    return validateReport(JSON.parse(fs.readFileSync(args[1], "utf8")));
  if (args[0] === "--phase-admission" && args.length === 3)
    return phaseAdmission(args.slice(1));
  if (args[0] === "--identity-cleanup-ledger" && args.length === 2)
    return validateIdentityCleanupLedger(readJson(args[1]));
  if (
    args[0] === "--windows-publication-diagnostic-ledger" &&
    args.length === 2
  )
    return validateWindowsPublicationDiagnosticLedger(readJson(args[1]));
  if (
    args[0] === "--hosted-ledger" &&
    args[2] === "--memory-ledger" &&
    args[4] === "--windows-ledger" &&
    args.length === 6
  )
    return hostedLedger(args[1], args[3], args[5]);
  throw new Error(
    "usage: --validate-final-candidate-manifest <repo> <candidate-sha> <repair-proof-sha> | --validate-report <file> | --phase-admission <node22> <node24> | --identity-cleanup-ledger <file> | --windows-publication-diagnostic-ledger <file> | --hosted-ledger <file> --memory-ledger <file> --windows-ledger <file>",
  );
}
module.exports = {
  MEDIAN_RATIO,
  MEDIAN_SLACK_NS,
  P95_RATIO,
  P95_SLACK_NS,
  deriveBlockEstimate,
  deriveRunScale,
  evaluateTiming,
  loadReference,
  performanceP95,
  validateCalibration,
  validateReport,
  hostedLedger,
  validateFinalCandidateManifest,
  validateInstalledReport,
  validateTerminalCleanupRecord,
  validateIdentityCleanupLedger,
  validateWindowsPublicationDiagnosticLedger,
  phaseAdmission,
  deriveCorrectnessKey,
  deriveFinalizationKey,
};
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
