#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "../..");
const manifestEvidence = "tests/corpus/manifest.json";
const faultEvidence = "tests/qualification/fault-plan.ts";
const logicalFaults = new Set([
  "stage-directory-create",
  "stage-directory-verify",
  "stage-open",
  "stage-write",
  "stage-sync",
  "stage-close",
  "stage-reopen",
  "output-verification",
  "source-recheck",
  "timestamps",
  "destination-directory-open",
  "publication",
  "stage-disposition",
]);
const barriers = new Set([
  "after-stage-creation",
  "during-bounded-copy",
  "after-write-sync",
  "after-reopen-verification",
  "before-publication",
  "during-finalization",
]);
const oracleTests = new Map([
  [
    "libwebp-1.5.0-example",
    "proves the official fixture through identical decode, structure, and metadata evidence",
  ],
  [
    "generated-two-frame-animation",
    "proves animation canvas, timing, and frame hashes in both directions",
  ],
  [
    "shallow-admission-decode-rejection",
    "keeps shallow parser admission distinct from independent decode rejection",
  ],
  [
    "nested-order-violation",
    "rejects malformed ordering and padding through the structural oracle",
  ],
]);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function normalizedArguments(args) {
  return args.flatMap((argument) => {
    const match = argument.match(/^(--[^=]+)=(.*)$/u);
    return match === null ? [argument] : [match[1], match[2]];
  });
}

function parseArguments(args) {
  const normalized = normalizedArguments(args);
  const values = {};
  let json = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const flag = normalized[index];
    if (flag === "--json") {
      if (json) throw new Error("Duplicate option --json");
      json = true;
      continue;
    }
    if (
      !new Set(["--case", "--oracle", "--seed", "--path", "--fault"]).has(flag)
    )
      throw new Error(`Unknown qualification option ${flag}`);
    const value = normalized[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    if (Object.hasOwn(values, flag))
      throw new Error(`Duplicate option ${flag}`);
    values[flag] = value;
    index += 1;
  }
  const selectors = ["--case", "--oracle", "--seed", "--fault"].filter(
    (flag) => values[flag] !== undefined,
  );
  if (selectors.length > 1)
    throw new Error("Choose only one focused qualification selector");
  if (values["--path"] !== undefined && values["--seed"] === undefined)
    throw new Error("--path requires --seed");
  if (json && values["--case"] === undefined)
    throw new Error("--json is available only with --case");

  if (selectors.length === 0) {
    if (normalized.length !== 0)
      throw new Error("A focused qualification selector is required");
    return {
      mode: "default",
      replay: "npm run qualify",
      evidence: manifestEvidence,
    };
  }
  if (values["--case"] !== undefined) {
    const id = values["--case"];
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(id))
      throw new Error("--case must be a bounded manifest ID");
    return {
      mode: "case",
      id,
      json,
      replay: `npm run qualify -- --case ${id}${json ? " --json" : ""}`,
      evidence: `${manifestEvidence}#${id}`,
    };
  }
  if (values["--oracle"] !== undefined) {
    const id = values["--oracle"];
    if (!oracleTests.has(id)) throw new Error("Unknown --oracle ledger ID");
    return {
      mode: "oracle",
      id,
      testName: oracleTests.get(id),
      replay: `npm run qualify -- --oracle ${id}`,
      evidence: `${manifestEvidence}#${id}`,
    };
  }
  if (values["--seed"] !== undefined) {
    const seedText = values["--seed"];
    if (!/^-?\d+$/u.test(seedText))
      throw new Error("--seed must be an integer");
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed) || Math.abs(seed) > 2_147_483_647)
      throw new Error("--seed is outside fast-check bounds");
    const replayPath = values["--path"];
    if (
      replayPath !== undefined &&
      !/^(?:[0-9]+)(?::[0-9]+)*$/u.test(replayPath)
    )
      throw new Error("--path must be a bounded fast-check replay path");
    return {
      mode: "property",
      seed,
      path: replayPath,
      replay: `npm run qualify -- --seed ${seed}${replayPath === undefined ? "" : ` --path ${replayPath}`}`,
      evidence: "tests/qualification/generators.ts#qualificationArbitrary",
    };
  }

  const fault = values["--fault"];
  if (barriers.has(fault))
    return {
      mode: "fault",
      fault,
      testName: `controls ${fault} without sleeps or scheduler luck`,
      replay: `npm run qualify -- --fault ${fault}`,
      evidence: `${faultEvidence}#${fault}`,
    };
  const match = fault.match(/^([a-z][a-z-]+):(\d+):(EIO|ENOSPC|EPERM)$/u);
  if (
    match === null ||
    !logicalFaults.has(match[1]) ||
    match[2] !== "1" ||
    match[3] !== "EIO"
  )
    throw new Error(
      "--fault must be a named barrier or <operation>:1:EIO from the fault ledger",
    );
  const operation = match[1];
  return {
    mode: "fault",
    fault,
    testName:
      operation === "stage-disposition"
        ? "records a single capability-disposition fault"
        : `injects ${operation} once with terminal safety`,
    replay: `npm run qualify -- --fault ${fault}`,
    evidence: `${faultEvidence}#${operation}`,
  };
}

function run(command, args, environment = {}) {
  const completed = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  if (completed.error !== undefined) throw completed.error;
  return completed.status ?? 1;
}

function npm(args, environment) {
  return run(npmCommand(), args, environment);
}

function runOracleAuthority() {
  if (process.platform !== "linux" || process.arch !== "x64") return 0;
  return run(process.execPath, [
    "scripts/qualification/build-oracles.cjs",
    "--verify-authority",
  ]);
}

function execute(options) {
  if (npm(["run", "build"]) !== 0) return 1;
  if (options.mode === "case") {
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "tests/qualification/corpus.ts"),
    ).href;
    const program = `import { runQualificationCase } from ${JSON.stringify(moduleUrl)}; const result = await runQualificationCase(${JSON.stringify(options.id)}); process.stdout.write(JSON.stringify(result${options.json ? ", null, 2" : ""}) + "\\n");`;
    return run(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      program,
    ]);
  }
  if (options.mode === "property")
    return npm(["test", "--", "tests/qualification/property.test.ts"], {
      FC_SEED: String(options.seed),
      ...(options.path === undefined
        ? { FC_RUNS: "200" }
        : { FC_PATH: options.path, FC_RUNS: "1" }),
    });
  if (options.mode === "fault")
    return npm([
      "test",
      "--",
      "tests/qualification/transaction.test.ts",
      "-t",
      options.testName,
    ]);
  if (options.mode === "oracle") {
    if (process.platform !== "linux" || process.arch !== "x64") {
      process.stderr.write(
        "Focused external oracle replay requires the admitted linux-x64 host.\n",
      );
      return 1;
    }
    if (runOracleAuthority() !== 0) return 1;
    return npm([
      "test",
      "--",
      "tests/qualification/oracles.test.ts",
      "-t",
      options.testName,
    ]);
  }
  if (runOracleAuthority() !== 0) return 1;
  return npm([
    "test",
    "--",
    "tests/qualification/tracer.test.ts",
    "tests/qualification/parser.test.ts",
    "tests/qualification/property.test.ts",
    "tests/qualification/transaction.test.ts",
    "tests/qualification/oracles.test.ts",
  ]);
}

function main(args) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "Usage: npm run qualify [-- --case <id> [--json] | --oracle <id> | --seed <n> [--path <path>] | --fault <plan>]\n",
    );
    return 2;
  }
  const status = execute(options);
  if (status !== 0)
    process.stderr.write(
      `Reproduce: ${options.replay}\nEvidence: ${options.evidence}\n`,
    );
  return status;
}

module.exports = { execute, main, parseArguments };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
