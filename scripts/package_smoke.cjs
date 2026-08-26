#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const {
  accessSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const DEVELOPMENT_SCOPE = "development-current-host";
const FINAL_SCOPE = "final-matching-host";
const FORBIDDEN_SCOPE = "final-release";

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
) {
  const expected = resolve(
    sandbox,
    "node_modules",
    "exifcleaner-node",
    "prebuilds",
    `${platform}-${arch}`,
    "publication.node",
  );
  return (
    platform === "win32" &&
    error?.code === "EPERM" &&
    typeof error.path === "string" &&
    resolve(error.path) === expected
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
  return { tarball: resolve(values["--tarball"]), evidenceScope };
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

function sourceWebp() {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;
  const vp8 = Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]);
  const exif = Buffer.from("II*\0\b\0\0\0\0\0\0\0", "binary");
  const body = Buffer.concat([
    chunk("VP8X", vp8x),
    chunk("VP8 ", vp8),
    chunk("EXIF", exif),
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

async function runTransactions(packageRoot, sandbox) {
  const api = await import(
    pathToFileURL(join(packageRoot, "dist", "index.js")).href
  );
  const sourcePath = join(sandbox, "source.webp");
  const destinationPath = join(sandbox, "sanitized.webp");
  const source = sourceWebp();
  writeFileSync(sourcePath, source);
  const options = {
    sourcePath,
    destinationPath,
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
  };
  const published = await api.sanitizeFile(options);
  if (!published.ok)
    throw new Error(
      `Installed transaction did not publish: ${JSON.stringify(published.error)}`,
    );
  if (!readFileSync(sourcePath).equals(source))
    throw new Error("Installed transaction changed source bytes");
  if (!readFileSync(destinationPath).length)
    throw new Error("Installed transaction did not write destination");

  const competitorPath = join(sandbox, "competitor.webp");
  const competitor = Buffer.from("competitor survives", "utf8");
  writeFileSync(competitorPath, competitor);
  const collision = await api.sanitizeFile({
    ...options,
    destinationPath: competitorPath,
  });
  if (collision.ok || collision.error.code !== "destination-exists")
    throw new Error(
      "Installed transaction did not refuse competing destination",
    );
  if (!readFileSync(competitorPath).equals(competitor))
    throw new Error("Installed transaction replaced competing destination");
  const finalization = collision.error.finalization;
  if (finalization?.state !== "owned-partial-remains")
    throw new Error(
      "Installed collision did not preserve bounded D-52 residue truth",
    );
  return {
    sourcePreserved: true,
    published: true,
    collisionPreserved: true,
    postCommitResidue: published.value.postCommitResidue.state,
    collisionFinalization: finalization.state,
  };
}

async function runSmoke({ tarball, evidenceScope }) {
  assertArchiveShape(tarball);
  const sandbox = mkdtempSync(join(tmpdir(), "exifcleaner-package-smoke-"));
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
    const cases = await runTransactions(installedRoot, sandbox);
    return {
      evidenceScope,
      hostTuple: hostTuple(),
      nodeVersion: process.version,
      tarball: { path: tarball, sha256: sha256(tarball) },
      install: {
        command: "npm install --ignore-scripts",
        arguments: installArgs.slice(npm.prefix.length),
      },
      selectedArtifact: literalArtifact
        .slice(installedRoot.length + 1)
        .replaceAll("\\", "/"),
      cases,
    };
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch (error) {
      if (!isLoadedNativeCleanupLock(error, sandbox)) throw error;
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
  assertLiteralHostArtifact,
  createDevelopmentTarballForTests,
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
