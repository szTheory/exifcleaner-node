"use strict";

const crypto = require("node:crypto");

/**
 * The ordered payload is an evidence contract: keep it in lockstep with the
 * child sample schema and never derive it from aggregate benchmark fields.
 */
function deriveCorrectnessKey(sample) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        status: sample.status,
        code: sample.code,
        outputBytes: sample.outputBytes,
        outputSha256: sample.outputSha256,
        sourceUnchanged: sample.sourceUnchanged,
        destinationAbsent: sample.destinationAbsent,
        finalizationTruthful: sample.finalizationTruthful,
      }),
    )
    .digest("hex");
}

module.exports = { deriveCorrectnessKey };
