#!/usr/bin/env node
"use strict";

// This authority deliberately has no package arguments or package imports. It runs
// outside both package children, before and after their fixed benchmark schedule.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALGORITHM_ID = "exifcleaner-run-calibration-v2";
const OBSERVATION_COUNT = 15;
const WORKLOAD_UNIT_COUNT = 16;
const referencePath = path.join(
  __dirname,
  "benchmark-calibration-reference.json",
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function workloadDigest() {
  const hash = crypto.createHash("sha256");
  let state = 0x460014;
  for (let index = 0; index < 4096; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    hash.update(
      Buffer.from(`${state.toString(16).padStart(8, "0")}:${index}\n`),
    );
  }
  return hash.digest("hex");
}

function runWorkloadUnit() {
  let bytes = Buffer.from(workloadDigest(), "hex");
  for (let index = 0; index < 2048; index += 1)
    bytes = crypto.createHash("sha256").update(bytes).digest();
  return sha256(bytes);
}

function workloadResultDigest() {
  return runWorkloadUnit();
}

function runObservation(ordinal) {
  const started = process.hrtime.bigint();
  let resultDigest;
  for (let unit = 0; unit < WORKLOAD_UNIT_COUNT; unit += 1)
    resultDigest = runWorkloadUnit();
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return {
    ordinal,
    elapsedNs,
    unitCount: WORKLOAD_UNIT_COUNT,
    normalizedNs: elapsedNs / WORKLOAD_UNIT_COUNT,
    resultDigest,
  };
}

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function main() {
  if (process.argv.length !== 2)
    throw new Error("calibration accepts no arguments");
  const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const scriptSha256 = sha256(fs.readFileSync(__filename));
  if (
    !exactKeys(reference, [
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
    ]) ||
    reference.schemaVersion !== 2 ||
    reference.algorithmId !== ALGORITHM_ID ||
    reference.scriptSha256 !== scriptSha256 ||
    reference.workloadDigest !== workloadDigest() ||
    reference.workloadResultDigest !== workloadResultDigest() ||
    reference.observationCount !== OBSERVATION_COUNT ||
    reference.workloadUnitCount !== WORKLOAD_UNIT_COUNT ||
    !Object.hasOwn(reference.referenceMedianNs, String(nodeMajor)) ||
    !Number.isFinite(reference.referenceMedianNs[String(nodeMajor)]) ||
    reference.timeoutMs !== 15_000 ||
    reference.madRatioLimit !== 0.1 ||
    reference.centralRangeRatioLimit !== 1.2 ||
    reference.maxDriftRatio !== 1.1
  )
    throw new Error("calibration reference identity is invalid");
  const observations = Array.from({ length: OBSERVATION_COUNT }, (_, index) =>
    runObservation(index + 1),
  );
  if (
    observations.some(
      (observation, index) =>
        !Number.isFinite(observation.elapsedNs) ||
        observation.elapsedNs <= 0 ||
        observation.ordinal !== index + 1 ||
        observation.normalizedNs !==
          observation.elapsedNs / WORKLOAD_UNIT_COUNT ||
        observation.resultDigest !== reference.workloadResultDigest,
    )
  )
    throw new Error("calibration workload is invalid");
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 2,
      algorithmId: ALGORITHM_ID,
      nodeMajor,
      observations,
      workloadDigest: workloadDigest(),
      process: { execPath: process.execPath, clean: true },
    })}\n`,
  );
}

module.exports = {
  ALGORITHM_ID,
  OBSERVATION_COUNT,
  WORKLOAD_UNIT_COUNT,
  workloadDigest,
  workloadResultDigest,
  runObservation,
};
if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
