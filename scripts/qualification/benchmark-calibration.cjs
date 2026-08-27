#!/usr/bin/env node
"use strict";

// This authority deliberately has no package arguments or package imports.  It is
// run by the benchmark parent before and after *both* installed package children.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALGORITHM_ID = "exifcleaner-run-calibration-v1";
const TRIAL_COUNT = 3;
const referencePath = path.join(__dirname, "benchmark-calibration-reference.json");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function workloadDigest() {
  const hash = crypto.createHash("sha256");
  let state = 0x460014;
  for (let index = 0; index < 4096; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    hash.update(Buffer.from(`${state.toString(16).padStart(8, "0")}:${index}\n`));
  }
  return hash.digest("hex");
}

function runTrial() {
  const started = process.hrtime.bigint();
  let bytes = Buffer.from(workloadDigest(), "hex");
  for (let index = 0; index < 2048; index += 1)
    bytes = crypto.createHash("sha256").update(bytes).digest();
  const digest = sha256(bytes);
  return { elapsedNs: Number(process.hrtime.bigint() - started), digest };
}

function main() {
  if (process.argv.length !== 2) throw new Error("calibration accepts no arguments");
  const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const scriptSha256 = sha256(fs.readFileSync(__filename));
  if (
    reference.schemaVersion !== 1 ||
    reference.algorithmId !== ALGORITHM_ID ||
    reference.scriptSha256 !== scriptSha256 ||
    reference.workloadDigest !== workloadDigest() ||
    reference.trialCount !== TRIAL_COUNT ||
    !Object.hasOwn(reference.referenceMedianNs, String(nodeMajor)) ||
    !Number.isFinite(reference.referenceMedianNs[String(nodeMajor)]) ||
    reference.timeoutMs !== 10_000 ||
    reference.maxDriftRatio !== 1.1
  ) throw new Error("calibration reference identity is invalid");
  const trials = Array.from({ length: TRIAL_COUNT }, runTrial);
  if (trials.some((trial) => !Number.isFinite(trial.elapsedNs) || trial.elapsedNs <= 0 || trial.digest !== trials[0].digest))
    throw new Error("calibration workload is invalid");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    algorithmId: ALGORITHM_ID,
    nodeMajor,
    trials: trials.map((trial) => trial.elapsedNs),
    workloadDigest: workloadDigest(),
    process: { execPath: process.execPath, clean: true },
  })}\n`);
}

module.exports = { ALGORITHM_ID, TRIAL_COUNT, workloadDigest, runTrial };
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
