"use strict";

const crypto = require("node:crypto");

const SHA256 = /^[a-f0-9]{64}$/;
const FINALIZATION = new Set([
  "none",
  "not-started",
  "private-empty-stage-directory-remains",
  "owned-partial-remains",
]);

function exactPayload(input, keys, label) {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    JSON.stringify(Object.keys(input)) !== JSON.stringify(keys)
  )
    throw new Error(`${label} payload is not exact`);
  return input;
}

function correctnessPayload(input) {
  exactPayload(
    input,
    [
      "status",
      "code",
      "outputBytes",
      "outputSha256",
      "sourceUnchanged",
      "destinationAbsent",
    ],
    "correctness",
  );
  if (
    typeof input.status !== "string" ||
    input.status.length === 0 ||
    !(
      input.code === null ||
      (typeof input.code === "string" && input.code.length > 0)
    ) ||
    !Number.isSafeInteger(input.outputBytes) ||
    input.outputBytes < 0 ||
    !(
      input.outputSha256 === null ||
      (typeof input.outputSha256 === "string" &&
        SHA256.test(input.outputSha256))
    ) ||
    (input.outputSha256 === null) !== (input.outputBytes === 0) ||
    typeof input.sourceUnchanged !== "boolean" ||
    typeof input.destinationAbsent !== "boolean"
  )
    throw new Error("correctness payload is invalid");
  return { ...input };
}

function finalizationPayload(input) {
  exactPayload(
    input,
    ["version", "fixtureId", "finalization", "truthful"],
    "finalization",
  );
  if (
    !["baseline", "candidate"].includes(input.version) ||
    typeof input.fixtureId !== "string" ||
    input.fixtureId.length === 0 ||
    typeof input.finalization !== "string" ||
    !FINALIZATION.has(input.finalization) ||
    input.truthful !== true
  )
    throw new Error("finalization payload is invalid");
  return { ...input };
}

function hash(domain, payload) {
  return crypto
    .createHash("sha256")
    .update(`${domain}\n${JSON.stringify(payload)}`)
    .digest("hex");
}

function deriveCorrectnessKey(input) {
  return hash(
    "exifcleaner.benchmark.correctness.v2",
    correctnessPayload({
      status: input?.status,
      code: input?.code,
      outputBytes: input?.outputBytes,
      outputSha256: input?.outputSha256,
      sourceUnchanged: input?.sourceUnchanged,
      destinationAbsent: input?.destinationAbsent,
    }),
  );
}

function deriveFinalizationKey(input) {
  return hash(
    "exifcleaner.benchmark.finalization.v2",
    finalizationPayload({
      version: input?.version,
      fixtureId: input?.fixtureId,
      finalization: input?.finalization,
      truthful: input?.truthful ?? input?.finalizationTruthful,
    }),
  );
}

module.exports = {
  correctnessPayload,
  finalizationPayload,
  deriveCorrectnessKey,
  deriveFinalizationKey,
};
