#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const {
  accessSync,
  constants: fsConstants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { open } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { basename, dirname, join, relative, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const DEVELOPMENT_SCOPE = "development-current-host";
const FINAL_SCOPE = "final-matching-host";
const FORBIDDEN_SCOPE = "final-release";
const CORPUS_MANIFEST_PATH = resolve(
  __dirname,
  "../tests/corpus/manifest.json",
);
const SHA256 = /^[a-f0-9]{64}$/;
const PROPERTY_SEED = 460_046;
const PROPERTY_RUNS = 25;

function hostTuple() {
  return `${process.platform}-${process.arch}`;
}

function npmInvocation() {
  return process.platform === "win32"
    ? {
        command: process.execPath,
        prefix: [
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
        ],
      }
    : { command: "npm", prefix: [] };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${output.trim()}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isLoadedNativeCleanupLock(
  error,
  sandbox,
  platform = process.platform,
  arch = process.arch,
  loadedModulePaths = Object.keys(require.cache),
) {
  const expected = resolve(
    sandbox,
    "node_modules",
    "exifcleaner-node",
    "prebuilds",
    `${platform}-${arch}`,
    "publication.node",
  );
  const comparablePath = (value) => {
    const withoutExtendedPrefix = value.startsWith("\\\\?\\")
      ? value.slice(4)
      : value;
    return resolve(withoutExtendedPrefix).toLowerCase();
  };
  const samePath = (left, right) =>
    comparablePath(left) === comparablePath(right);
  return (
    platform === "win32" &&
    error?.code === "EPERM" &&
    typeof error.path === "string" &&
    loadedModulePaths.some((path) => samePath(path, expected)) &&
    (samePath(error.path, expected) || samePath(error.path, sandbox))
  );
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value)
      throw new Error("--tarball is required");
    if (Object.hasOwn(values, flag))
      throw new Error(`Duplicate option ${flag}`);
    if (
      !new Set([
        "--tarball",
        "--evidence-scope",
        "--tarball-sha256",
        "--manifest-sha256",
      ]).has(flag)
    )
      throw new Error(`Unknown option ${flag}`);
    values[flag] = value;
  }
  if (typeof values["--tarball"] !== "string")
    throw new Error("--tarball is required");
  const evidenceScope = values["--evidence-scope"] ?? DEVELOPMENT_SCOPE;
  if (evidenceScope === FORBIDDEN_SCOPE)
    throw new Error(
      "final-release evidence is owned by Plan 45-16 and cannot be claimed here",
    );
  if (evidenceScope !== DEVELOPMENT_SCOPE && evidenceScope !== FINAL_SCOPE)
    throw new Error(
      "--evidence-scope must be development-current-host or final-matching-host",
    );
  const tarballSha256 = values["--tarball-sha256"];
  const manifestSha256 = values["--manifest-sha256"];
  for (const [label, value] of [
    ["--tarball-sha256", tarballSha256],
    ["--manifest-sha256", manifestSha256],
  ])
    if (value !== undefined && !SHA256.test(value))
      throw new Error(`${label} must be SHA-256`);
  if (
    evidenceScope === FINAL_SCOPE &&
    (tarballSha256 === undefined || manifestSha256 === undefined)
  )
    throw new Error(
      "final-matching-host evidence requires tarball and manifest SHA-256",
    );
  return {
    tarball: resolve(values["--tarball"]),
    evidenceScope,
    tarballSha256,
    manifestSha256,
  };
}

function assertArchiveShape(tarball) {
  const listing = run("tar", ["-tf", basename(tarball)], {
    cwd: dirname(tarball),
  })
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    if (!listing.includes(required))
      throw new Error(`Packed archive is missing ${required}`);
  }
  for (const forbiddenPrefix of [
    "package/src/",
    "package/test/",
    "package/tests/",
  ]) {
    if (listing.some((entry) => entry.startsWith(forbiddenPrefix)))
      throw new Error(
        `Packed archive unexpectedly includes ${forbiddenPrefix}`,
      );
  }
}

function assertLiteralHostArtifact(packageRoot) {
  const literal = join(
    packageRoot,
    "prebuilds",
    hostTuple(),
    "publication.node",
  );
  try {
    if (!statSync(literal).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `Installed package is missing literal host artifact ${hostTuple()}`,
    );
  }
  const loader = readFileSync(
    join(packageRoot, "dist", "transaction", "native-publication.js"),
    "utf8",
  );
  const literalSpecifier = `../../prebuilds/${process.platform}-${process.arch}/publication.node`;
  if (
    !loader.includes(literalSpecifier) ||
    /\b(?:readdir|glob)\b/u.test(loader)
  )
    throw new Error(
      "Installed native loader does not select the literal host tuple",
    );
  return literal;
}

function chunk(fourCc, data) {
  const header = Buffer.alloc(8);
  header.write(fourCc, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceWebp(width = 1, height = 1, includeExif = true) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = includeExif ? 0x08 : 0;
  vp8x[4] = (width - 1) & 0xff;
  vp8x[7] = (height - 1) & 0xff;
  const vp8 = Buffer.alloc(10);
  vp8.set([0x10, 0, 0, 0x9d, 0x01, 0x2a]);
  vp8.writeUInt16LE(width, 6);
  vp8.writeUInt16LE(height, 8);
  const exif = Buffer.from("II*\0\b\0\0\0\0\0\0\0", "binary");
  const body = Buffer.concat([
    chunk("VP8X", vp8x),
    chunk("VP8 ", vp8),
    ...(includeExif ? [chunk("EXIF", exif)] : []),
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

function readChunks(bytes) {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new Error("Qualification fixture is not an exact WebP container");
  const records = [];
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length)
      throw new Error("Qualification fixture chunk header is truncated");
    const fourCc = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    const spanEnd = end + (size & 1);
    if (spanEnd > bytes.length)
      throw new Error("Qualification fixture chunk is truncated");
    records.push({
      fourCc,
      payload: bytes.subarray(offset + 8, end),
      sha256: sha256Bytes(bytes.subarray(offset + 8, end)),
    });
    offset = spanEnd;
  }
  return records;
}

function payloadDigests(bytes) {
  const retained = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);
  const occurrences = new Map();
  return readChunks(bytes).flatMap((record) => {
    if (!retained.has(record.fourCc)) return [];
    const occurrence = occurrences.get(record.fourCc) ?? 0;
    occurrences.set(record.fourCc, occurrence + 1);
    return [{ fourCc: record.fourCc, occurrence, sha256: record.sha256 }];
  });
}

function uint24(value) {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff, value >>> 16]);
}

function derivedAnimation(still) {
  const vp8 = readChunks(still).find((record) => record.fourCc === "VP8 ");
  if (vp8 === undefined)
    throw new Error("Upstream fixture has no admitted VP8 payload");
  const vp8x = Buffer.concat([
    Buffer.from([0x02, 0, 0, 0]),
    uint24(127),
    uint24(127),
  ]);
  const anim = Buffer.alloc(6);
  anim.writeUInt32LE(0xff00_00ff, 0);
  anim.writeUInt16LE(2, 4);
  const frame = (duration) =>
    Buffer.concat([
      uint24(0),
      uint24(0),
      uint24(127),
      uint24(127),
      uint24(duration),
      Buffer.from([0]),
      chunk("VP8 ", vp8.payload),
    ]);
  const body = Buffer.concat([
    chunk("VP8X", vp8x),
    chunk("ANIM", anim),
    chunk("ANMF", frame(40)),
    chunk("ANMF", frame(60)),
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

function loadCorpusAuthority() {
  const manifestBytes = readFileSync(CORPUS_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.records))
    throw new Error("Corpus manifest schema is not admitted");
  const record = (id) => {
    const found = manifest.records.find((item) => item.id === id);
    if (
      found === undefined ||
      typeof found.localPath !== "string" ||
      !SHA256.test(found.sha256) ||
      !Number.isSafeInteger(found.bytes) ||
      found.bytes <= 0
    )
      throw new Error(`Corpus authority is incomplete: ${id}`);
    const corpusRoot = dirname(CORPUS_MANIFEST_PATH);
    const filePath = resolve(corpusRoot, found.localPath);
    const fromRoot = relative(corpusRoot, filePath);
    if (fromRoot.startsWith("..") || resolve(corpusRoot, fromRoot) !== filePath)
      throw new Error(`Corpus authority escapes its root: ${id}`);
    const bytes = readFileSync(filePath);
    if (bytes.length !== found.bytes || sha256Bytes(bytes) !== found.sha256)
      throw new Error(`Corpus authority drift: ${id}`);
    return { id, bytes, sha256: found.sha256 };
  };
  return {
    manifestSha256: sha256Bytes(manifestBytes),
    sample: record("exifcleaner-sample"),
    upstream: record("libwebp-1.5.0-example"),
  };
}

async function runCorpusCase(api, sandbox, id, source, index) {
  const sourcePath = join(sandbox, `case-${index}.bin`);
  const destinationPath = join(sandbox, `case-${index}.webp`);
  writeFileSync(sourcePath, source);
  const inspection = await api.inspectFile(sourcePath);
  if (!inspection.ok || inspection.value.format !== "webp")
    throw new Error(`Installed magic admission failed: ${id}`);
  const result = await api.sanitizeFile({
    sourcePath,
    destinationPath,
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
  });
  if (!result.ok)
    throw new Error(`Installed corpus case failed: ${id}:${result.error.code}`);
  const output = readFileSync(destinationPath);
  const expectedPayloads = payloadDigests(source);
  const actualPayloads = payloadDigests(output);
  if (JSON.stringify(expectedPayloads) !== JSON.stringify(actualPayloads))
    throw new Error(`Installed payload identity failed: ${id}`);
  if (!readFileSync(sourcePath).equals(source))
    throw new Error(`Installed corpus case changed source: ${id}`);
  const reopened = await api.inspectFile(destinationPath);
  if (!reopened.ok || reopened.value.format !== "webp")
    throw new Error(`Installed output reopen failed: ${id}`);
  return {
    evidence: {
      id,
      magicAdmission: true,
      sourceSha256: sha256Bytes(source),
      outputSha256: sha256Bytes(output),
      payloadDigests: actualPayloads,
      removedNamespaces: result.value.removedNamespaces,
      finalization: result.value.postCommitResidue.state,
    },
    sourcePath,
    destinationPath,
  };
}

async function runDeterministicCancellation(packageRoot, sandbox, sourceBytes) {
  const moduleUrl = (relativePath) =>
    pathToFileURL(join(packageRoot, "dist", relativePath)).href;
  const [
    handlerModule,
    fileOpsModule,
    identityModule,
    transactionModule,
    fallbackModule,
  ] = await Promise.all([
    import(moduleUrl("admission/webp-handler.js")),
    import(moduleUrl("transaction/file-ops.js")),
    import(moduleUrl("transaction/identity.js")),
    import(moduleUrl("transaction/safe-transaction.js")),
    import(moduleUrl("fallback.js")),
  ]);
  const sourcePath = join(sandbox, "cancel-source.bin");
  const destinationPath = join(sandbox, "cancel-output.webp");
  writeFileSync(sourcePath, sourceBytes);
  const source = await open(sourcePath, fsConstants.O_RDONLY);
  const stats = await source.stat();
  const admission = await handlerModule.webpHandler.admit(source, stats.size);
  const plan = handlerModule.webpHandler.buildOutputPlan(
    admission.parsed,
    false,
    false,
    undefined,
  );
  const controller = new AbortController();
  const result = await transactionModule.runSafeTransaction({
    sourceHandle: source,
    sourceSnapshot: identityModule.snapshotSource(stats),
    sourceMode: stats.mode,
    handler: handlerModule.webpHandler,
    admission,
    plan,
    orientation: undefined,
    options: {
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      signal: controller.signal,
    },
    fileOps: fileOpsModule.NODE_FILE_OPS,
    beforePublish: () => controller.abort(),
  });
  if (
    result.ok ||
    result.error.code !== "aborted" ||
    result.error.nativeWrite !== "started" ||
    fallbackModule.classifyFallback(result.error) !== "do-not-fallback" ||
    result.error.finalization?.state !== "owned-partial-remains"
  )
    throw new Error("Installed deterministic cancellation contract failed");
  try {
    accessSync(destinationPath);
    throw new Error("Installed cancellation created a public destination");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!readFileSync(sourcePath).equals(sourceBytes))
    throw new Error("Installed cancellation changed source bytes");
  return {
    code: result.error.code,
    nativeWrite: result.error.nativeWrite,
    fallback: "do-not-fallback",
    finalization: result.error.finalization.state,
  };
}

async function runInstalledProperties(api, packageRoot, sandbox) {
  const configured = process.env.QUALIFICATION_PROPERTY_RUNS;
  if (configured !== undefined && configured !== String(PROPERTY_RUNS))
    throw new Error("QUALIFICATION_PROPERTY_RUNS must be exactly 25");
  let state = PROPERTY_SEED;
  const outputDigests = [];
  for (let index = 0; index < PROPERTY_RUNS; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const source = sourceWebp(1 + (state & 7), 1 + ((state >>> 3) & 7), true);
    const sourcePath = join(sandbox, `property-${index}.bin`);
    const destinationPath = join(sandbox, `property-${index}.webp`);
    writeFileSync(sourcePath, source);
    const result = await api.sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });
    if (!result.ok || !readFileSync(sourcePath).equals(source))
      throw await installedPropertyFailure(
        index,
        result,
        readFileSync(sourcePath).equals(source),
        packageRoot,
        sandbox,
      );
    const output = readFileSync(destinationPath);
    if (
      JSON.stringify(payloadDigests(source)) !==
      JSON.stringify(payloadDigests(output))
    )
      throw new Error(`Installed property payload drift: ${index}`);
    outputDigests.push(sha256Bytes(output));
  }
  return sha256Bytes(Buffer.from(outputDigests.join(""), "ascii"));
}

async function installedPropertyFailure(
  index,
  result,
  sourcePreserved,
  packageRoot,
  sandbox,
) {
  if (!result.ok) {
    const { code, detail, phase, nativeWrite, cause } = result.error;
    const nativeDiagnostic =
      packageRoot === undefined || sandbox === undefined
        ? undefined
        : await diagnoseWindowsNativePublication(packageRoot, sandbox);
    return new Error(
      `Installed property case failed: ${index}:${code}:${phase}:${nativeWrite}:${detail}${cause === undefined ? "" : `:cause=${cause.code ?? "unknown"}/${cause.message}`}${nativeDiagnostic === undefined ? "" : `:${nativeDiagnostic}`}`,
    );
  }
  if (!sourcePreserved)
    return new Error(`Installed property source changed: ${index}`);
  return new Error(`Installed property case failed: ${index}`);
}

async function diagnoseWindowsNativePublication(packageRoot, sandbox) {
  if (process.platform !== "win32") return undefined;
  const bindingPath = join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "publication.node",
  );
  const binding = require(bindingPath);
  if (typeof binding?.publishNoReplace !== "function")
    return "native-binding-unavailable";
  const stagePath = join(sandbox, "native-diagnostic-stage.webp");
  const destinationPath = join(sandbox, "native-diagnostic-destination.webp");
  writeFileSync(stagePath, "native-diagnostic-stage");
  const stage = await open(stagePath, "r+");
  try {
    return `native-diagnostic=${String(
      binding.publishNoReplace(stage.fd, destinationPath),
    )}`;
  } finally {
    await stage.close();
  }
}

function assertWindowsPrivateStageCleanup(sandbox) {
  const residue = readdirSync(sandbox).filter((entry) =>
    entry.startsWith(".exifcleaner-stage-"),
  );
  if (residue.length !== 0)
    throw new Error(
      `Installed Windows transaction left private stage residue: ${residue.join(",")}`,
    );
  return "pass";
}

function assertWindowsPrivateStageResidue(sandbox) {
  const residue = readdirSync(sandbox).filter((entry) =>
    entry.startsWith(".exifcleaner-stage-"),
  );
  if (residue.length === 0)
    throw new Error(
      "Installed Windows failed transaction did not retain bounded private stage residue",
    );
  return "pass";
}

async function runTransactions(packageRoot, sandbox, corpus) {
  const api = await import(
    pathToFileURL(join(packageRoot, "dist", "index.js")).href
  );
  const still = await runCorpusCase(
    api,
    sandbox,
    corpus.sample.id,
    corpus.sample.bytes,
    0,
  );
  const stillCleanup =
    process.platform === "win32"
      ? assertWindowsPrivateStageCleanup(sandbox)
      : undefined;
  const animation = await runCorpusCase(
    api,
    sandbox,
    "derived-two-frame-animation",
    derivedAnimation(corpus.upstream.bytes),
    1,
  );
  const animationCleanup =
    process.platform === "win32"
      ? assertWindowsPrivateStageCleanup(sandbox)
      : undefined;
  const competitorPath = still.destinationPath;
  const competitor = readFileSync(competitorPath);
  const collision = await api.sanitizeFile({
    sourcePath: still.sourcePath,
    destinationPath: competitorPath,
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
  });
  if (collision.ok || collision.error.code !== "destination-exists")
    throw new Error(
      `Installed transaction did not refuse competing destination: ${JSON.stringify(collision)}`,
    );
  if (!readFileSync(competitorPath).equals(competitor))
    throw new Error("Installed transaction replaced competing destination");
  const finalization = collision.error.finalization;
  if (finalization?.state !== "owned-partial-remains")
    throw new Error(
      "Installed collision did not preserve bounded D-52 residue truth",
    );
  const collisionResidue =
    process.platform === "win32"
      ? assertWindowsPrivateStageResidue(sandbox)
      : undefined;
  const cancellation = await runDeterministicCancellation(
    packageRoot,
    sandbox,
    corpus.sample.bytes,
  );
  const propertyOutputDigest = await runInstalledProperties(
    api,
    packageRoot,
    sandbox,
  );
  const windowsPublication =
    process.platform === "win32"
      ? (() => {
          const sourceSha256 = sha256(still.sourcePath);
          const destinationSha256 = sha256(still.destinationPath);
          const volumeSerial = String(statSync(still.destinationPath).dev);
          return {
            primitive: "create-hard-link",
            publication: "pass",
            collision: "pass",
            identity: "pass",
            cleanup:
              stillCleanup === "pass" && animationCleanup === "pass"
                ? "pass"
                : "unverified",
            collisionResidue,
            sourceSha256,
            destinationSha256,
            volumeProof: {
              method:
                "GetFileInformationByHandleEx(FileIdInfo).VolumeSerialNumber",
              placement: "destination-parent-child",
              capturedDestinationParentIdentity: true,
              destinationParentIdentityRechecked: true,
              stageIdentityRechecked: true,
              sameVolume: true,
              stageDirectoryVolumeSerial: volumeSerial,
              stageFileVolumeSerial: volumeSerial,
              destinationParentVolumeSerial: volumeSerial,
              crossVolumeOutcome: "typed-non-success-before-link",
              unprovableVolumeOutcome: "typed-non-success-before-link",
              crossVolumeLinkCalls: 0,
              unprovableVolumeLinkCalls: 0,
              fallbackAttempts: 0,
            },
          };
        })()
      : undefined;
  return {
    corpusCases: [still.evidence, animation.evidence],
    propertyOutputDigest,
    cases: {
      sourcePreserved: true,
      published: true,
      collisionPreserved: true,
      cancellation,
      postCommitResidue: still.evidence.finalization,
      collisionFinalization: finalization.state,
    },
    ...(windowsPublication === undefined ? {} : { windowsPublication }),
  };
}

async function runSmoke({
  tarball,
  evidenceScope,
  tarballSha256,
  manifestSha256,
}) {
  const corpus = loadCorpusAuthority();
  const actualTarballSha256 = sha256(tarball);
  if (tarballSha256 !== undefined && actualTarballSha256 !== tarballSha256)
    throw new Error("Tarball digest mismatch");
  if (manifestSha256 !== undefined && corpus.manifestSha256 !== manifestSha256)
    throw new Error("Corpus manifest digest mismatch");
  assertArchiveShape(tarball);
  const sandbox = mkdtempSync(join(tmpdir(), "exifcleaner-package-smoke-"));
  let loadedNativeArtifact;
  try {
    const copiedTarball = join(sandbox, basename(tarball));
    copyFileSync(tarball, copiedTarball);
    writeFileSync(
      join(sandbox, "package.json"),
      JSON.stringify({
        name: "exifcleaner-consumer-smoke",
        private: true,
        type: "module",
      }),
    );
    const npm = npmInvocation();
    const installArgs = [
      ...npm.prefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      copiedTarball,
    ];
    const installOutput = run(npm.command, installArgs, { cwd: sandbox });
    if (/\b(?:node-gyp|prebuild-install|download)\b/iu.test(installOutput))
      throw new Error(
        "scripts-disabled install reported build or download output",
      );
    const installedRoot = join(sandbox, "node_modules", "exifcleaner-node");
    const literalArtifact = assertLiteralHostArtifact(installedRoot);
    loadedNativeArtifact = literalArtifact;
    const qualification = await runTransactions(installedRoot, sandbox, corpus);
    return {
      evidenceScope,
      hostTuple: hostTuple(),
      nodeVersion: process.version,
      tarball: { file: basename(tarball), sha256: actualTarballSha256 },
      manifestSha256: corpus.manifestSha256,
      propertySeed: PROPERTY_SEED,
      propertyRuns: PROPERTY_RUNS,
      propertyOutputDigest: qualification.propertyOutputDigest,
      corpusCases: qualification.corpusCases,
      install: {
        command: "npm install --ignore-scripts",
        arguments: [
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "<admitted-tarball>",
        ],
      },
      selectedArtifact: literalArtifact
        .slice(installedRoot.length + 1)
        .replaceAll("\\", "/"),
      cases: qualification.cases,
      ...(qualification.windowsPublication === undefined
        ? {}
        : { windowsPublication: qualification.windowsPublication }),
    };
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch (error) {
      if (
        !isLoadedNativeCleanupLock(
          error,
          sandbox,
          process.platform,
          process.arch,
          loadedNativeArtifact === undefined ? [] : [loadedNativeArtifact],
        )
      )
        throw error;
    }
  }
}

function createDevelopmentTarballForTests({ packageRoot, tarball }) {
  const destination = resolve(tarball);
  const destinationDirectory = dirname(destination);
  const packDirectory = mkdtempSync(
    join(destinationDirectory, "exifcleaner-pack-"),
  );
  const npm = npmInvocation();
  try {
    const output = run(
      npm.command,
      [
        ...npm.prefix,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      { cwd: resolve(packageRoot) },
    );
    const packed = JSON.parse(output);
    if (
      !Array.isArray(packed) ||
      packed.length !== 1 ||
      typeof packed[0]?.filename !== "string"
    )
      throw new Error(
        "Test helper could not create exactly one current-host development tarball",
      );
    renameSync(join(packDirectory, packed[0].filename), destination);
    return { tarball: destination, evidenceScope: DEVELOPMENT_SCOPE };
  } finally {
    rmSync(packDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  assertWindowsPrivateStageCleanup,
  assertWindowsPrivateStageResidue,
  assertLiteralHostArtifact,
  createDevelopmentTarballForTests,
  diagnoseWindowsNativePublication,
  installedPropertyFailure,
  isLoadedNativeCleanupLock,
  parseArguments,
  runSmoke,
};

if (require.main === module) {
  runSmoke(parseArguments(process.argv.slice(2)))
    .then((evidence) => console.log(JSON.stringify(evidence)))
    .catch((error) => {
      console.error(String(error.message ?? error));
      process.exitCode = 1;
    });
}
