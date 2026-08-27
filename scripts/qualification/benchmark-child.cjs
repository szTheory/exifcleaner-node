#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { materializeFixture } = require("./benchmark.cjs");

const SHA256 = /^[a-f0-9]{64}$/;

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function digestFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function memorySnapshot(phase) {
  const memory = process.memoryUsage();
  return {
    phase,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    maxRSSKiB:
      process.platform === "darwin"
        ? process.resourceUsage().maxRSS / 1024
        : process.resourceUsage().maxRSS,
  };
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error("benchmark child arguments must be flag/value pairs");
    if (
      !new Set([
        "--package-root",
        "--package-sha",
        "--version",
        "--fixture",
        "--run-token",
      ]).has(flag)
    )
      throw new Error(`unknown benchmark child option ${flag}`);
    values[flag] = value;
  }
  const packageRoot = values["--package-root"];
  const packageSha = values["--package-sha"];
  const version = values["--version"];
  const fixture = values["--fixture"];
  const runToken = values["--run-token"];
  if (
    typeof packageRoot !== "string" ||
    typeof packageSha !== "string" ||
    !SHA256.test(packageSha) ||
    (version !== "baseline" && version !== "candidate") ||
    typeof fixture !== "string" ||
    typeof runToken !== "string" ||
    !/^[a-f0-9]{32}$/.test(runToken)
  )
    throw new Error("benchmark child identity is incomplete");
  return {
    packageRoot: path.resolve(packageRoot),
    packageSha,
    version,
    fixture: JSON.parse(Buffer.from(fixture, "base64").toString("utf8")),
    runToken,
  };
}

function moduleUrl(packageRoot, relativePath) {
  return pathToFileURL(path.join(packageRoot, relativePath)).href;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ordinaryOperation(
  publicApi,
  fixture,
  sourcePath,
  destinationPath,
) {
  const controller = new AbortController();
  if (fixture.kind === "cancellation") controller.abort();
  return publicApi.sanitizeFile({
    sourcePath,
    destinationPath,
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
    signal: controller.signal,
  });
}

function ordinaryFinalization(result, sandbox, destinationPath) {
  const privateStages = fs
    .readdirSync(sandbox, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(".exifcleaner-stage-"),
    );
  const residue = result.ok ? result.value.postCommitResidue : undefined;
  if (residue?.state === "private-empty-stage-directory-remains")
    return {
      finalization: residue.state,
      finalizationTruthful:
        privateStages.length === 1 &&
        fs.readdirSync(path.join(sandbox, privateStages[0].name)).length === 0,
    };
  return {
    finalization: residue?.state ?? (result.ok ? "none" : "not-started"),
    finalizationTruthful:
      privateStages.length === 0 &&
      (result.ok ? exists(destinationPath) : !exists(destinationPath)),
  };
}

async function candidateCancellation(packageRoot, sourcePath, destinationPath) {
  const [
    { selectHandler },
    { NODE_FILE_OPS },
    { snapshotSource },
    transaction,
  ] = await Promise.all([
    import(moduleUrl(packageRoot, "dist/admission/registry.js")),
    import(moduleUrl(packageRoot, "dist/transaction/file-ops.js")),
    import(moduleUrl(packageRoot, "dist/transaction/identity.js")),
    import(moduleUrl(packageRoot, "dist/transaction/safe-transaction.js")),
  ]);
  const controller = new AbortController();
  const sourceHandle = await fsPromises.open(sourcePath, fs.constants.O_RDONLY);
  const sourceStats = await sourceHandle.stat();
  const handler = await selectHandler(sourceHandle);
  if (handler === undefined)
    throw new Error("cancellation fixture was not admitted");
  const admission = await handler.admit(
    sourceHandle,
    sourceStats.size,
    controller.signal,
  );
  const orientation =
    admission.orientation.status === "valid"
      ? admission.orientation.value
      : undefined;
  const plan = handler.buildOutputPlan(
    admission.parsed,
    false,
    false,
    orientation,
  );
  let abortAt;
  let finalizationAt;
  let stageDirectoryPath;
  let stagePath;
  const result = await transaction.runSafeTransaction({
    sourceHandle,
    sourceSnapshot: snapshotSource(sourceStats),
    sourceMode: sourceStats.mode,
    handler,
    admission,
    plan,
    orientation,
    options: {
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      signal: controller.signal,
    },
    fileOps: NODE_FILE_OPS,
    beforePublish(paths) {
      stageDirectoryPath = paths.stageDirectoryPath;
      stagePath = paths.stagePath;
      abortAt = process.hrtime.bigint();
      controller.abort();
    },
    beforeStageFinalization() {
      finalizationAt = process.hrtime.bigint();
    },
  });
  const terminalAt = process.hrtime.bigint();
  if (abortAt === undefined || finalizationAt === undefined)
    throw new Error(
      "cancellation did not reach the deterministic copy barrier",
    );
  const finalization = result.ok ? undefined : result.error.finalization;
  const stageExists =
    stageDirectoryPath !== undefined && exists(stageDirectoryPath);
  const stagedFileExists = stagePath !== undefined && exists(stagePath);
  const claimedResidue = finalization?.state === "owned-partial-remains";
  const claimedAbsent =
    finalization?.state === "owned-partial-removed" ||
    finalization?.state === "already-missing";
  const finalizationTruthful =
    (claimedResidue && stageExists && stagedFileExists) ||
    (claimedAbsent && !stageExists && !stagedFileExists);
  return {
    result,
    cancellation: {
      code: result.ok ? "unexpected-success" : result.error.code,
      destinationAbsent: !exists(destinationPath),
      finalizationTruthful,
      secondWriter: false,
      finalizationStartMs: Number(finalizationAt - abortAt) / 1_000_000,
      terminalMs: Number(terminalAt - abortAt) / 1_000_000,
      finalization: finalization?.state ?? "missing",
    },
  };
}

function assertExpected(fixture, result) {
  const status = result.ok
    ? "success"
    : result.error.code === "aborted"
      ? "aborted"
      : "refused";
  if (status !== fixture.expected)
    throw new Error(
      `fixture ${fixture.id} returned ${status}, expected ${fixture.expected}`,
    );
  return status;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(options.packageRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.name !== "exifcleaner-node" ||
    packageJson.version !== "0.1.1"
  )
    throw new Error("installed benchmark package identity is invalid");
  const publicApi = await import(
    moduleUrl(options.packageRoot, "dist/index.js")
  );
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "exifcleaner-sample-"));
  const sourcePath = path.join(sandbox, "source.webp");
  const destinationPath = path.join(sandbox, "output.webp");
  const allocationPhases = [memorySnapshot("package-load")];
  const source = materializeFixture(options.fixture, sourcePath);
  allocationPhases.push(memorySnapshot("fixture-materialized"));
  const sourceDigest = source.sha256;
  const startedRss = process.memoryUsage().rss;
  const startedAt = process.hrtime.bigint();
  try {
    const measured =
      options.version === "candidate" && options.fixture.kind === "cancellation"
        ? await candidateCancellation(
            options.packageRoot,
            sourcePath,
            destinationPath,
          )
        : {
            result: await ordinaryOperation(
              publicApi,
              options.fixture,
              sourcePath,
              destinationPath,
            ),
            cancellation:
              options.fixture.kind === "cancellation"
                ? {
                    code: "aborted",
                    destinationAbsent: true,
                    finalizationTruthful: true,
                    secondWriter: false,
                    finalizationStartMs: 0,
                    terminalMs: 0,
                    finalization: "not-started",
                  }
                : undefined,
          };
    const endedAt = process.hrtime.bigint();
    allocationPhases.push(memorySnapshot("sanitize-complete"));
    const status = assertExpected(options.fixture, measured.result);
    const destinationAbsent = !exists(destinationPath);
    const outputBytes = destinationAbsent
      ? 0
      : fs.statSync(destinationPath).size;
    const outputSha256 = destinationAbsent
      ? null
      : await digestFile(destinationPath);
    const sourceUnchanged = (await digestFile(sourcePath)) === sourceDigest;
    const finalization =
      measured.cancellation === undefined
        ? ordinaryFinalization(measured.result, sandbox, destinationPath)
        : {
            finalization: measured.cancellation.finalization,
            finalizationTruthful: measured.cancellation.finalizationTruthful,
          };
    const correctnessKey = digest(
      Buffer.from(
        JSON.stringify({
          status,
          code: measured.result.ok ? null : measured.result.error.code,
          outputBytes,
          outputSha256,
          sourceUnchanged,
          destinationAbsent,
          finalizationTruthful: finalization.finalizationTruthful,
        }),
      ),
    );
    allocationPhases.push(memorySnapshot("correctness-complete"));
    const record = {
      schemaVersion: 1,
      version: options.version,
      fixtureId: options.fixture.id,
      packageSha: options.packageSha,
      runToken: options.runToken,
      elapsedNs: Number(endedAt - startedAt),
      maxRSSKiB:
        process.platform === "darwin"
          ? process.resourceUsage().maxRSS / 1024
          : process.resourceUsage().maxRSS,
      startedRss,
      endedRss: process.memoryUsage().rss,
      outputBytes,
      outputSha256,
      sourceUnchanged,
      destinationAbsent,
      finalization: finalization.finalization,
      finalizationTruthful: finalization.finalizationTruthful,
      correctnessKey,
      cancellation: measured.cancellation,
      allocationPhases,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        runner: process.env.ImageOS ?? "local",
        cpu: os.cpus()[0]?.model ?? "unknown",
      },
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
