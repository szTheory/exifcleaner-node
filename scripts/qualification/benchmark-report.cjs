#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ALGORITHM_ID,
  TRIAL_COUNT,
  workloadDigest,
} = require("./benchmark-calibration.cjs");

const SHA256 = /^[a-f0-9]{64}$/;
const MEDIAN_RATIO = 1.2;
const MEDIAN_SLACK_NS = 15_000_000;
const P95_RATIO = 1.35;
const P95_SLACK_NS = 30_000_000;

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
function percentile(values, quantile) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  )
    throw new Error("timing values are invalid");
  return [...values].sort((a, b) => a - b)[
    Math.ceil(values.length * quantile) - 1
  ];
}
function validateCalibration(value, reference) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "algorithmId",
      "nodeMajor",
      "trials",
      "workloadDigest",
      "process",
    ],
    "calibration",
  );
  exactKeys(value.process, ["execPath", "clean"], "calibration process");
  if (
    value.schemaVersion !== 1 ||
    value.algorithmId !== ALGORITHM_ID ||
    !Number.isInteger(value.nodeMajor) ||
    !Array.isArray(value.trials) ||
    value.trials.length !== TRIAL_COUNT ||
    value.trials.some((trial) => !Number.isFinite(trial) || trial <= 0) ||
    value.workloadDigest !== workloadDigest() ||
    typeof value.process.execPath !== "string" ||
    value.process.clean !== true
  )
    throw new Error("calibration authority is invalid");
  if (
    reference !== undefined &&
    (!Object.hasOwn(reference.referenceMedianNs, String(value.nodeMajor)) ||
      reference.algorithmId !== value.algorithmId ||
      reference.workloadDigest !== value.workloadDigest)
  )
    throw new Error("calibration reference does not bind authority");
}
function deriveRunScale({ before, after, referenceMedianNs }) {
  const beforeMedianNs = percentile(before, 0.5);
  const afterMedianNs = percentile(after, 0.5);
  if (
    !Number.isFinite(referenceMedianNs) ||
    referenceMedianNs <= 0 ||
    Math.max(beforeMedianNs, afterMedianNs) /
      Math.min(beforeMedianNs, afterMedianNs) >
      1.1
  )
    throw new Error("calibration drift or reference is invalid");
  const observedCalibrationNs = Math.sqrt(beforeMedianNs * afterMedianNs);
  const runScale = referenceMedianNs / observedCalibrationNs;
  if (!Number.isFinite(runScale) || runScale <= 0)
    throw new Error("run scale is invalid");
  return { beforeMedianNs, afterMedianNs, observedCalibrationNs, runScale };
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
      "trialCount",
      "referenceMedianNs",
      "timeoutMs",
      "maxDriftRatio",
    ],
    "calibration reference",
  );
  if (
    value.schemaVersion !== 1 ||
    value.algorithmId !== ALGORITHM_ID ||
    value.scriptSha256 !== scriptDigest() ||
    !SHA256.test(value.scriptSha256) ||
    value.workloadDigest !== workloadDigest() ||
    value.trialCount !== TRIAL_COUNT ||
    value.timeoutMs !== 10_000 ||
    value.maxDriftRatio !== 1.1
  )
    throw new Error("calibration reference is invalid");
  return value;
}
function validateReport(report) {
  const reference = loadReference();
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
      Number(report.environment.nodeVersion.match(/^v(\\d+)/)[1])
  )
    throw new Error("calibration Node identity mismatch");
  const derived = deriveRunScale({
    before: report.calibration.before.trials,
    after: report.calibration.after.trials,
    referenceMedianNs:
      reference.referenceMedianNs[String(report.calibration.before.nodeMajor)],
  });
  for (const [key, value] of Object.entries(derived))
    if (report.calibration.derived[key] !== value)
      throw new Error(`calibration derived ${key} mismatch`);
  for (const comparison of report.comparisons) {
    for (const side of ["baseline", "candidate"]) {
      const item = comparison[side];
      if (
        !Array.isArray(item.samples) ||
        item.samples.length !== 15 ||
        item.samples.some(
          (sample) =>
            !Number.isFinite(sample.elapsedNs) ||
            sample.elapsedNs <= 0 ||
            !Number.isFinite(sample.scaledElapsedNs) ||
            sample.scaledElapsedNs !== sample.elapsedNs * derived.runScale,
        )
      )
        throw new Error("retained sample evidence is invalid");
      const scaled = item.samples.map((sample) => sample.scaledElapsedNs);
      if (
        item.medianElapsedNs !== percentile(scaled, 0.5) ||
        item.p95ElapsedNs !== percentile(scaled, 0.95)
      )
        throw new Error("derived distribution mismatch");
    }
    const timing = evaluateTiming({
      baselineMedianNs: comparison.baseline.medianElapsedNs,
      candidateMedianNs: comparison.candidate.medianElapsedNs,
      baselineP95Ns: comparison.baseline.p95ElapsedNs,
      candidateP95Ns: comparison.candidate.p95ElapsedNs,
    });
    if (JSON.stringify(timing) !== JSON.stringify(comparison.timing))
      throw new Error("D-23 verdict mismatch");
  }
  exactKeys(report.collection, ["retries", "discarded"], "collection");
  if (
    report.collection.retries !== 0 ||
    report.collection.discarded !== 0 ||
    !Array.isArray(report.rawSchedule)
  )
    throw new Error("retry/discard evidence is invalid");
  const fixtureIds = new Set(report.rawSchedule.map((item) => item.fixtureId));
  for (const fixtureId of fixtureIds) {
    const records = report.rawSchedule.filter(
      (item) => item.fixtureId === fixtureId,
    );
    if (
      records.length !== 34 ||
      records.filter((item) => item.warmup).length !== 4 ||
      records.filter((item) => !item.warmup).length !== 30 ||
      records.some((item, index) => {
        const round = Math.floor(index / 2);
        const expectedVersion = (
          round % 2 === 0
            ? ["baseline", "candidate"]
            : ["candidate", "baseline"]
        )[index % 2];
        return (
          item.round !== round ||
          item.warmup !== round < 2 ||
          item.version !== expectedVersion ||
          !item.sample ||
          Object.hasOwn(item.sample, "calibration")
        );
      })
    )
      throw new Error("raw alternating schedule is invalid");
  }
  return report;
}
function hostedLedger(filePath) {
  const ledger = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const report of [ledger.node22, ledger.node24]) validateReport(report);
  return ledger;
}
function phaseAdmission(paths) {
  if (paths.length !== 2)
    throw new Error("both Node benchmark reports are required");
  const reports = paths.map((file) =>
    validateReport(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
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
function main(args) {
  if (args[0] === "--validate-report" && args.length === 2)
    return validateReport(JSON.parse(fs.readFileSync(args[1], "utf8")));
  if (args[0] === "--phase-admission" && args.length === 3)
    return phaseAdmission(args.slice(1));
  if (args[0] === "--hosted-ledger" && args.length >= 2)
    return hostedLedger(args[1]);
  throw new Error(
    "usage: --validate-report <file> | --phase-admission <node22> <node24> | --hosted-ledger <file>",
  );
}
module.exports = {
  MEDIAN_RATIO,
  MEDIAN_SLACK_NS,
  P95_RATIO,
  P95_SLACK_NS,
  deriveRunScale,
  evaluateTiming,
  loadReference,
  validateCalibration,
  validateReport,
  hostedLedger,
  phaseAdmission,
};
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
