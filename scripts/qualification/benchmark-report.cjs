#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ALGORITHM_ID,
  OBSERVATION_COUNT,
  WORKLOAD_UNIT_COUNT,
  workloadDigest,
  workloadResultDigest,
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
    if (!sameJson(timing, comparison.timing))
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
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function assertSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new Error(`${label} must be SHA-256`);
}
function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}
function assertEqual(left, right, label) {
  if (left !== right) throw new Error(`${label} mismatch`);
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
      (item.primitive !== "create-hard-link" ||
        [item.publication, item.collision, item.identity, item.cleanup].some(
          (value) => value !== "pass",
        ))
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
  if (args[0] === "--validate-report" && args.length === 2)
    return validateReport(JSON.parse(fs.readFileSync(args[1], "utf8")));
  if (args[0] === "--phase-admission" && args.length === 3)
    return phaseAdmission(args.slice(1));
  if (
    args[0] === "--hosted-ledger" &&
    args[2] === "--memory-ledger" &&
    args[4] === "--windows-ledger" &&
    args.length === 6
  )
    return hostedLedger(args[1], args[3], args[5]);
  throw new Error(
    "usage: --validate-report <file> | --phase-admission <node22> <node24> | --hosted-ledger <file> --memory-ledger <file> --windows-ledger <file>",
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
