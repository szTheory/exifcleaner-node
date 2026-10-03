const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const authorityManifestPath = path.join(
  projectRoot,
  "tests/corpus/tools/manifest.json",
);
const corpusManifestPath = path.join(projectRoot, "tests/corpus/manifest.json");
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(detail) {
  throw new Error(`Oracle authority rejected: ${detail}`);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} fields are not exact`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a non-empty string`);
  return value;
}

function repositoryPath(relativePath, label) {
  const value = requiredString(relativePath, label);
  const resolved = path.resolve(projectRoot, value);
  const fromRoot = path.relative(projectRoot, resolved);
  if (
    path.isAbsolute(value) ||
    fromRoot.startsWith("..") ||
    path.resolve(projectRoot, fromRoot) !== resolved
  )
    fail(`${label} leaves the repository`);
  return resolved;
}

function tarMemberName(value, root, label) {
  const member = requiredString(value, label);
  if (
    member.startsWith("/") ||
    member.includes("..") ||
    !member.startsWith(`${root}/`)
  )
    fail(`${label} is outside ${root}`);
  return member;
}

/**
 * Resolves `candidatePath` against `dir` and refuses it (WR-02) unless the
 * result stays inside `dir` -- whether `candidatePath` is itself absolute
 * (escapes `dir` outright) or a relative `../` climb. Mirrors the
 * containment checks `repositoryPath`/`tarMemberName` already apply to other
 * trusted-looking-but-untrusted paths in this file.
 */
function assertPathWithinDir(dir, candidatePath, label) {
  const value = requiredString(candidatePath, label);
  const resolved = path.resolve(dir, value);
  const fromDir = path.relative(dir, resolved);
  if (fromDir.startsWith("..") || path.isAbsolute(fromDir))
    fail(`${label} resolves outside ${dir}`);
  return resolved;
}

function sha(value, label) {
  if (!SHA256.test(requiredString(value, label)))
    fail(`${label} is not SHA-256`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail(`${label} must be a positive integer`);
}

const AUTHORITY_REQUIRED_KEYS = [
  "id",
  "kind",
  "version",
  "revision",
  "origin",
  "archive",
  "license",
  "platforms",
  "architectures",
  "versionProbe",
  "entrypoints",
];
// `licenseExtra` is optional (closed-key, not a required field): it is
// populated only by authorities that carry a second legal document distinct
// from their primary SPDX-classified license (D-20) -- today only
// libaom-3.15.1's PATENTS file, which is not itself an SPDX license
// identifier and so is not validated against the admitted SPDX Set below.
function exactKeysWithOptional(value, required, optional, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = new Set(Object.keys(value));
  for (const key of required)
    if (!actual.has(key)) fail(`${label} fields are not exact`);
  const allowed = new Set([...required, ...optional]);
  for (const key of actual)
    if (!allowed.has(key)) fail(`${label} fields are not exact`);
}

function validateAuthorityShape(authority) {
  exactKeysWithOptional(
    authority,
    AUTHORITY_REQUIRED_KEYS,
    ["licenseExtra"],
    "authority",
  );
  const id = requiredString(authority.id, "authority.id");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) fail("authority.id is unstable");
  if (!new Set(["compiled-source", "script"]).has(authority.kind))
    fail(`${id}.kind is unsupported`);
  requiredString(authority.version, `${id}.version`);
  if (!REVISION.test(requiredString(authority.revision, `${id}.revision`)))
    fail(`${id}.revision is not immutable`);
  if (!requiredString(authority.origin, `${id}.origin`).startsWith("https://"))
    fail(`${id}.origin must use https`);

  exactKeys(authority.archive, ["path", "sha256", "root"], `${id}.archive`);
  repositoryPath(authority.archive.path, `${id}.archive.path`);
  sha(authority.archive.sha256, `${id}.archive.sha256`);
  const root = requiredString(authority.archive.root, `${id}.archive.root`);
  if (root.includes("/") || root.includes("..")) fail(`${id}.archive.root`);

  exactKeys(
    authority.license,
    ["spdx", "path", "member", "sha256"],
    `${id}.license`,
  );
  if (
    !new Set([
      "BSD-3-Clause",
      "Artistic-1.0-Perl OR GPL-1.0-or-later",
      "libpng-2.0",
      "HPND",
      "IJG AND BSD-3-Clause AND Zlib",
      "LGPL-3.0-or-later",
      "BSD-2-Clause",
    ]).has(authority.license.spdx)
  )
    fail(`${id}.license.spdx is not admitted`);
  repositoryPath(authority.license.path, `${id}.license.path`);
  tarMemberName(authority.license.member, root, `${id}.license.member`);
  sha(authority.license.sha256, `${id}.license.sha256`);

  if (authority.licenseExtra !== undefined) {
    exactKeys(
      authority.licenseExtra,
      ["path", "member", "sha256"],
      `${id}.licenseExtra`,
    );
    repositoryPath(authority.licenseExtra.path, `${id}.licenseExtra.path`);
    tarMemberName(
      authority.licenseExtra.member,
      root,
      `${id}.licenseExtra.member`,
    );
    sha(authority.licenseExtra.sha256, `${id}.licenseExtra.sha256`);
  }

  if (
    JSON.stringify(authority.platforms) !== JSON.stringify(["linux"]) ||
    JSON.stringify(authority.architectures) !== JSON.stringify(["x64"])
  )
    fail(`${id} platform/architecture authority is not exact`);

  exactKeys(
    authority.versionProbe,
    ["member", "sha256", "contains"],
    `${id}.versionProbe`,
  );
  tarMemberName(
    authority.versionProbe.member,
    root,
    `${id}.versionProbe.member`,
  );
  sha(authority.versionProbe.sha256, `${id}.versionProbe.sha256`);
  requiredString(
    authority.versionProbe.contains,
    `${id}.versionProbe.contains`,
  );

  if (
    !Array.isArray(authority.entrypoints) ||
    authority.entrypoints.length === 0
  )
    fail(`${id}.entrypoints must be non-empty`);
  const entrypointIds = new Set();
  for (const entrypoint of authority.entrypoints) {
    exactKeys(
      entrypoint,
      ["id", "kind", "member", "bytes", "sha256"],
      `${id}.entrypoint`,
    );
    const entrypointId = requiredString(entrypoint.id, `${id}.entrypoint.id`);
    if (entrypointIds.has(entrypointId))
      fail(`${id} has duplicate entrypoints`);
    entrypointIds.add(entrypointId);
    if (!new Set(["c-source", "perl-script"]).has(entrypoint.kind))
      fail(`${id}.${entrypointId}.kind`);
    tarMemberName(entrypoint.member, root, `${id}.${entrypointId}.member`);
    positiveInteger(entrypoint.bytes, `${id}.${entrypointId}.bytes`);
    sha(entrypoint.sha256, `${id}.${entrypointId}.sha256`);
  }
}

function validateFixtureShape(fixture) {
  exactKeys(
    fixture,
    ["id", "authority", "member", "path", "bytes", "sha256", "licenseMember"],
    "fixture",
  );
  requiredString(fixture.id, "fixture.id");
  requiredString(fixture.authority, "fixture.authority");
  requiredString(fixture.member, "fixture.member");
  repositoryPath(fixture.path, "fixture.path");
  positiveInteger(fixture.bytes, "fixture.bytes");
  sha(fixture.sha256, "fixture.sha256");
  requiredString(fixture.licenseMember, "fixture.licenseMember");
}

function validateManifestShape(manifest) {
  exactKeys(manifest, ["schemaVersion", "authorities", "fixtures"], "manifest");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Array.isArray(manifest.authorities) || manifest.authorities.length !== 8)
    fail("exactly eight tool authorities are required");
  manifest.authorities.forEach(validateAuthorityShape);
  const ids = manifest.authorities.map((item) => item.id);
  if (
    JSON.stringify(ids) !==
    JSON.stringify([
      "libwebp-1.5.0",
      "exiftool-13.59",
      "libpng-1.6.58",
      "pngcheck-4.0.1",
      "libjpeg-turbo-3.2.0",
      "libheif-1.23.5",
      "libde265-1.1.3",
      "libaom-3.15.1",
    ])
  )
    fail("authority order and IDs are not exact");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0)
    fail("at least one upstream fixture authority is required");
  manifest.fixtures.forEach(validateFixtureShape);
  const fixtureIds = manifest.fixtures.map((item) => item.id);
  if (new Set(fixtureIds).size !== fixtureIds.length)
    fail("fixture ids must be unique");
  return manifest;
}

function readTarMembers(archivePath, requiredMembers) {
  const wanted = new Set(requiredMembers);
  const found = new Map();
  for (const member of wanted) {
    const extraction = spawnSync("tar", ["-xOf", archivePath, member], {
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    if (extraction.error !== undefined)
      fail(`cannot extract tar member ${member}: ${extraction.error.message}`);
    if (extraction.status !== 0)
      fail(
        `cannot extract tar member ${member}: ${String(extraction.stderr).trim()}`,
      );
    found.set(member, Buffer.from(extraction.stdout));
  }
  return found;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runTool(command, args, options, label) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error !== undefined) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replaceAll(projectRoot, "<repo>")
      .replace(/\/(?:home|tmp|Users)\/[^\s:]+/g, "<path>")
      .trim();
    fail(`${label}${detail.length > 0 ? `: ${detail.slice(-2_000)}` : ""}`);
  }
  return result;
}

function validateAuthorityBytes(authority) {
  const archivePath = repositoryPath(
    authority.archive.path,
    `${authority.id}.archive.path`,
  );
  const archive = fs.readFileSync(archivePath);
  if (digest(archive) !== authority.archive.sha256)
    fail(`${authority.id} archive digest drift`);
  const memberNames = [
    authority.license.member,
    ...(authority.licenseExtra !== undefined
      ? [authority.licenseExtra.member]
      : []),
    authority.versionProbe.member,
    ...authority.entrypoints.map((entrypoint) => entrypoint.member),
  ];
  const members = readTarMembers(archivePath, memberNames);
  const license = fs.readFileSync(
    repositoryPath(authority.license.path, `${authority.id}.license.path`),
  );
  const archivedLicense = members.get(authority.license.member);
  if (
    digest(license) !== authority.license.sha256 ||
    !license.equals(archivedLicense)
  )
    fail(`${authority.id} license evidence drift`);
  if (authority.licenseExtra !== undefined) {
    const licenseExtra = fs.readFileSync(
      repositoryPath(
        authority.licenseExtra.path,
        `${authority.id}.licenseExtra.path`,
      ),
    );
    const archivedLicenseExtra = members.get(authority.licenseExtra.member);
    if (
      digest(licenseExtra) !== authority.licenseExtra.sha256 ||
      !licenseExtra.equals(archivedLicenseExtra)
    )
      fail(`${authority.id} licenseExtra evidence drift`);
  }
  const versionProbe = members.get(authority.versionProbe.member);
  if (
    digest(versionProbe) !== authority.versionProbe.sha256 ||
    !versionProbe.toString("utf8").includes(authority.versionProbe.contains)
  )
    fail(`${authority.id} version authority drift`);
  for (const entrypoint of authority.entrypoints) {
    const bytes = members.get(entrypoint.member);
    if (
      bytes.length !== entrypoint.bytes ||
      digest(bytes) !== entrypoint.sha256
    )
      fail(`${authority.id}.${entrypoint.id} entrypoint drift`);
  }
  return { archivePath, members };
}

/**
 * WebP-specific exact oracle assertions (T-56-33): the immutable
 * libwebp-1.5.0-example fixture's byte structure and dwebp/webpinfo/ExifTool
 * transcript are pinned exactly, unchanged since before the Phase 56
 * generalization. Kept in its own function so `validateFixture` stays
 * format-neutral and this fixture's evidence never widens.
 */
function validateWebpFixtureBytes(fixture, member, record) {
  const payloadSize = member.readUInt32LE(16);
  const payload = member.subarray(20, 20 + payloadSize);
  if (
    member.toString("ascii", 0, 4) !== "RIFF" ||
    member.toString("ascii", 8, 12) !== "WEBP" ||
    member.toString("ascii", 12, 16) !== "VP8 " ||
    payloadSize !== 4860 ||
    digest(payload) !==
      "89c641e38f1b10766880e7c81e3ca69246836fdb81100c39cd39881513b9dd36" ||
    record.oracle?.dwebp?.pamSha256 !==
      "ff7c5b6f529f2800154e87e3a56f708f9de842cda7ffff2b7284821cc1a9848a" ||
    record.oracle?.webpinfo?.chunks?.[0]?.spanBytes !== 4868 ||
    JSON.stringify(record.oracle?.exiftool?.warnings) !== "[]"
  )
    fail(`${fixture.id} exact oracle assertion drift`);
}

/**
 * Generalized (56-09 KIT-01): every fixture entry ties its committed bytes to
 * an exact member of a pinned authority archive (T-56-30) and to a
 * corresponding corpus record whose own provenance/digest fields agree. A
 * format-specific exact-byte assertion (`validateWebpFixtureBytes`) applies
 * only to the fixture whose authority is `libwebp-1.5.0`, so the WebP
 * evidence this kit already pinned never widens; other authorities (for
 * example `libpng-1.6.58`) validate only the format-neutral shape above.
 */
function validateFixture(fixture, manifest, validatedAuthorities) {
  const authority = manifest.authorities.find(
    (item) => item.id === fixture.authority,
  );
  if (authority === undefined) fail(`${fixture.id} authority is missing`);
  const archiveState = validatedAuthorities.get(authority.id);
  const member = readTarMembers(archiveState.archivePath, [fixture.member]).get(
    fixture.member,
  );
  const repositoryBytes = fs.readFileSync(
    repositoryPath(fixture.path, `${fixture.id}.path`),
  );
  if (
    fixture.licenseMember !== authority.license.member ||
    member.length !== fixture.bytes ||
    digest(member) !== fixture.sha256 ||
    !repositoryBytes.equals(member)
  )
    fail(`${fixture.id} committed fixture drift`);

  const corpus = readJson(corpusManifestPath, "corpus manifest");
  const record = corpus.records?.find((item) => item.id === fixture.id);
  if (
    !isObject(record) ||
    !Array.isArray(record.roles) ||
    record.roles.length === 0 ||
    record.localPath !==
      path.relative(
        path.dirname(corpusManifestPath),
        repositoryPath(fixture.path, `${fixture.id}.path`),
      ) ||
    record.provenance?.revision !== authority.revision ||
    record.provenance?.license !== authority.license.spdx ||
    record.provenance?.licenseStatus !== "approved" ||
    record.bytes !== fixture.bytes ||
    record.sha256 !== fixture.sha256
  )
    fail(`${fixture.id} corpus authority drift`);

  if (fixture.authority === "libwebp-1.5.0")
    validateWebpFixtureBytes(fixture, member, record);
}

function runShapeMutationChecks(manifest) {
  const mutations = [
    (copy) => delete copy.authorities[0].origin,
    (copy) => (copy.authorities[0].platforms = []),
    (copy) => (copy.authorities[0].license.spdx = "unknown"),
    (copy) => (copy.authorities[0].entrypoints[0].member = "../dwebp"),
    (copy) => delete copy.fixtures[0].sha256,
    (copy) => copy.authorities.splice(2, 1), // drop libpng-1.6.58
    (copy) => copy.authorities.splice(3, 1), // drop pngcheck-4.0.1
    (copy) => copy.authorities.splice(4, 1), // drop libjpeg-turbo-3.2.0
    (copy) => copy.authorities.splice(5, 1), // drop libheif-1.23.5
    (copy) => copy.authorities.splice(6, 1), // drop libde265-1.1.3
    (copy) => copy.authorities.splice(7, 1), // drop libaom-3.15.1
    (copy) => (copy.authorities[5].license.spdx = "unknown"), // libheif bad SPDX
    (copy) => delete copy.authorities[7].licenseExtra.sha256, // aom licenseExtra shape (WR-02-style negative control)
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(manifest);
    mutate(copy);
    let rejected = false;
    try {
      validateManifestShape(copy);
    } catch {
      rejected = true;
    }
    if (!rejected) fail("authority schema mutation was not rejected");
  }
}

function validateAllAuthority() {
  const manifest = validateManifestShape(
    readJson(authorityManifestPath, "authority manifest"),
  );
  runShapeMutationChecks(manifest);
  const validated = new Map();
  for (const authority of manifest.authorities)
    validated.set(authority.id, validateAuthorityBytes(authority));
  for (const fixture of manifest.fixtures)
    validateFixture(fixture, manifest, validated);
  return { manifest, validated };
}

function authoritySummary(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    authorities: manifest.authorities.map((authority) => ({
      id: authority.id,
      version: authority.version,
      revision: authority.revision,
      archiveSha256: authority.archive.sha256,
      entrypoints: authority.entrypoints.map((entrypoint) => ({
        id: entrypoint.id,
        member: entrypoint.member,
        sha256: entrypoint.sha256,
      })),
    })),
    fixtures: manifest.fixtures.map((fixture) => ({
      id: fixture.id,
      sha256: fixture.sha256,
      bytes: fixture.bytes,
    })),
  };
}

function loadAndValidateAuthority() {
  return authoritySummary(validateAllAuthority().manifest);
}

/**
 * The exact SIMD-disabled report line printed by libjpeg-turbo 3.2.0's
 * CMakeLists.txt (`message(STATUS ...)`, not `report_option` -- SIMD has its
 * own bespoke report path) when `WITH_SIMD=0`. Measured directly against the
 * pinned 3.2.0 source (2026-09-27): `cmake -S <root> -B <build>
 * -DWITH_SIMD=0 ...` prints this line verbatim.
 */
const LIBJPEG_TURBO_SIMD_DISABLED_REPORT_LINE =
  "SIMD extensions: None (WITH_SIMD = 0)";

/**
 * D-08's feature-set assertion (57-08 A4 correction): libjpeg-turbo 3.x has
 * no 12-bit-precision CMake toggle (12-bit decode is always built in), so
 * this never widens the admitted JPEG variant list -- it only proves the
 * oracle was actually built with the flags `prepareOracleTools` requested, throwing
 * `libjpeg-turbo feature drift: <feature>` (not wrapped by `fail()`, so the
 * message names exactly which of the five independent checks failed) the
 * moment any one of them drifts.
 */
function assertLibjpegTurboFeatures({
  configureLog,
  djpegVersionText,
  arithmeticDecodeExitCode,
}) {
  const checks = [
    [
      "arithmetic decoding enabled",
      configureLog.includes(
        "Arithmetic decoding support enabled (WITH_ARITH_DEC = 1)",
      ),
    ],
    [
      "arithmetic encoding disabled",
      configureLog.includes(
        "Arithmetic encoding support disabled (WITH_ARITH_ENC = 0)",
      ),
    ],
    [
      "shared libraries disabled",
      configureLog.includes("Shared libraries disabled (ENABLE_SHARED = 0)"),
    ],
    [
      "SIMD disabled",
      configureLog.includes(LIBJPEG_TURBO_SIMD_DISABLED_REPORT_LINE),
    ],
    ["djpeg version", djpegVersionText.includes("libjpeg-turbo version 3.2.0")],
    ["arithmetic decode of testimgari.jpg", arithmeticDecodeExitCode === 0],
  ];
  for (const [feature, ok] of checks)
    if (!ok) throw new Error(`libjpeg-turbo feature drift: ${feature}`);
}

/**
 * D-21's feature-set assertion for the HEIF decode stack (libheif +
 * libde265 + aom, built decoder-only): proves the oracle was actually built
 * with the flags `buildOracleTools` requested, throwing `libheif feature
 * drift: <feature>` (not wrapped by `fail()`, so the message names exactly
 * which of the three independent checks failed) the moment any one of them
 * drifts. `aomConfigureLog` and `heifConfigureLog` are the raw stdout+stderr
 * text captured from each library's own `cmake -S ... -B ...` configure step.
 */
function assertHeifFeatures({ aomConfigureLog, heifConfigureLog }) {
  const checks = [
    [
      "aom target CPU is generic",
      aomConfigureLog.includes("Detected CPU: generic"),
    ],
    [
      "libde265 HEVC decoder built in",
      /libde265 HEVC decoder\s*:\s*\+ built-in/.test(heifConfigureLog),
    ],
    [
      "AOM AV1 decoder built in",
      /AOM AV1 decoder\s*:\s*\+ built-in/.test(heifConfigureLog),
    ],
  ];
  for (const [feature, ok] of checks)
    if (!ok) throw new Error(`libheif feature drift: ${feature}`);
}

/**
 * Builds every oracle into an already-existing `workspace` directory and
 * returns the tools record (authority summary plus each built executable's
 * `{ path, sha256 }`), WITHOUT a `dispose()` -- disposal is the caller's
 * concern (KIT-09 D-02/D-04). Refuses a non-linux/x64 host; a caller using an
 * injected `build` function (for example a test's `fakeBuild`) never reaches
 * this check because it supplies its own function in place of this one.
 */
function buildOracleTools(workspace) {
  const { manifest, validated } = validateAllAuthority();
  if (process.platform !== "linux" || process.arch !== "x64")
    fail("oracle execution requires the admitted linux/x64 host");

  for (const authority of manifest.authorities) {
    runTool(
      "tar",
      ["-xzf", validated.get(authority.id).archivePath, "-C", workspace],
      {},
      `${authority.id} extraction failed`,
    );
  }

  const libwebp = manifest.authorities[0];
  const libwebpRoot = path.join(workspace, libwebp.archive.root);
  runTool(
    path.join(libwebpRoot, "configure"),
    ["--disable-shared", "--enable-static", "--disable-dependency-tracking"],
    { cwd: libwebpRoot },
    "libwebp configure failed",
  );
  runTool("make", ["-j2"], { cwd: libwebpRoot }, "libwebp build failed");

  const dwebpPath = path.join(libwebpRoot, "examples/dwebp");
  const webpinfoPath = path.join(libwebpRoot, "examples/webpinfo");
  const exiftoolAuthority = manifest.authorities[1];
  const exiftoolPath = path.join(
    workspace,
    exiftoolAuthority.archive.root,
    "exiftool",
  );
  fs.chmodSync(exiftoolPath, 0o755);

  const animationSourcePath = path.join(
    projectRoot,
    "scripts/qualification/anim_oracle.c",
  );
  if (!fs.existsSync(animationSourcePath))
    fail("animation oracle source is missing");
  const animationPath = path.join(workspace, "anim-oracle");
  runTool(
    "cc",
    [
      "-std=c11",
      "-O2",
      animationSourcePath,
      "-I",
      path.join(libwebpRoot, "src"),
      "-L",
      path.join(libwebpRoot, "src/demux/.libs"),
      "-L",
      path.join(libwebpRoot, "src/.libs"),
      "-lwebpdemux",
      "-lwebp",
      "-lm",
      "-o",
      animationPath,
    ],
    {},
    "animation oracle build failed",
  );

  const libpng = manifest.authorities[2];
  const libpngRoot = path.join(workspace, libpng.archive.root);
  runTool(
    path.join(libpngRoot, "configure"),
    ["--disable-shared", "--enable-static", "--disable-dependency-tracking"],
    { cwd: libpngRoot },
    "libpng configure failed",
  );
  runTool("make", ["-j2"], { cwd: libpngRoot }, "libpng build failed");

  const pngDecodeSourcePath = path.join(
    projectRoot,
    "scripts/qualification/png_decode_oracle.c",
  );
  if (!fs.existsSync(pngDecodeSourcePath))
    fail("png decode oracle source is missing");
  const pngDecodePath = path.join(workspace, "png-decode-oracle");
  runTool(
    "cc",
    [
      "-std=c11",
      "-O2",
      pngDecodeSourcePath,
      "-I",
      libpngRoot,
      "-L",
      path.join(libpngRoot, ".libs"),
      "-lpng16",
      "-lz",
      "-lm",
      "-o",
      pngDecodePath,
    ],
    {},
    "png decode oracle build failed",
  );

  const pngcheck = manifest.authorities[3];
  const pngcheckRoot = path.join(workspace, pngcheck.archive.root);
  const pngcheckPath = path.join(workspace, "pngcheck");
  runTool(
    "cc",
    [
      "-std=c11",
      "-O2",
      path.join(pngcheckRoot, "pngcheck.c"),
      "-lz",
      "-o",
      pngcheckPath,
    ],
    {},
    "pngcheck build failed",
  );

  const libjpegTurbo = manifest.authorities[4];
  const libjpegTurboRoot = path.join(workspace, libjpegTurbo.archive.root);
  const libjpegTurboBuild = path.join(workspace, "libjpeg-turbo-build");
  const configure = runTool(
    "cmake",
    [
      "-S",
      libjpegTurboRoot,
      "-B",
      libjpegTurboBuild,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DENABLE_SHARED=0",
      "-DENABLE_STATIC=1",
      "-DWITH_SIMD=0",
      "-DWITH_ARITH_DEC=1",
      "-DWITH_ARITH_ENC=0",
      "-DWITH_TURBOJPEG=0",
      "-DWITH_TESTS=0",
    ],
    {},
    "libjpeg-turbo configure failed",
  );
  const configureLog = `${configure.stdout ?? ""}\n${configure.stderr ?? ""}`;
  runTool(
    "cmake",
    [
      "--build",
      libjpegTurboBuild,
      "--target",
      "djpeg-static",
      "jpegtran-static",
      "rdjpgcom",
      "jpeg-static",
      "--parallel",
      "2",
    ],
    {},
    "libjpeg-turbo build failed",
  );

  const djpegPath = path.join(libjpegTurboBuild, "djpeg-static");
  const jpegtranPath = path.join(libjpegTurboBuild, "jpegtran-static");
  const rdjpgcomPath = path.join(libjpegTurboBuild, "rdjpgcom");
  const libjpegStaticPath = path.join(libjpegTurboBuild, "libjpeg.a");
  const libjpegTurboIncludeDir = libjpegTurboBuild; // jconfig.h/jconfigint.h land here

  const djpegVersion = spawnSync(djpegPath, ["-version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (djpegVersion.error !== undefined)
    fail(`djpeg version check failed: ${djpegVersion.error.message}`);
  const djpegVersionText = djpegVersion.stderr ?? "";

  const arithmeticSourcePath = path.join(
    libjpegTurboRoot,
    "testimages/testimgari.jpg",
  );
  const arithmeticDecode = spawnSync(
    djpegPath,
    ["-outfile", path.join(workspace, "testimgari.ppm"), arithmeticSourcePath],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (arithmeticDecode.error !== undefined)
    fail(
      `libjpeg-turbo arithmetic decode smoke failed: ${arithmeticDecode.error.message}`,
    );
  const arithmeticDecodeExitCode = arithmeticDecode.status ?? 1;

  assertLibjpegTurboFeatures({
    configureLog,
    djpegVersionText,
    arithmeticDecodeExitCode,
  });

  const jpegDecodeSourcePath = path.join(
    projectRoot,
    "scripts/qualification/jpeg_decode_oracle.c",
  );
  if (!fs.existsSync(jpegDecodeSourcePath))
    fail("jpeg decode oracle source is missing");
  const jpegDecodePath = path.join(workspace, "jpeg-decode-oracle");
  runTool(
    "cc",
    [
      "-std=c11",
      "-O2",
      jpegDecodeSourcePath,
      "-I",
      libjpegTurboIncludeDir,
      "-I",
      path.join(libjpegTurboRoot, "src"),
      "-L",
      libjpegTurboBuild,
      "-ljpeg",
      "-o",
      jpegDecodePath,
    ],
    {},
    "jpeg decode oracle build failed",
  );

  // --- HEIF decode stack (D-21, QUA-04 prerequisite): aom (decoder-only),
  // then libde265, then libheif, installed into one shared job-local prefix
  // so libheif's own -DCMAKE_PREFIX_PATH finds both decoder backends. Build
  // order matters: libheif's configure step probes for the other two.
  const heifPrefix = path.join(workspace, "heif-prefix");
  fs.mkdirSync(heifPrefix, { recursive: true });
  const parallelJobs = String(os.cpus().length || 1);

  const aomAuthority = manifest.authorities[7];
  const aomRoot = path.join(workspace, aomAuthority.archive.root);
  const aomBuild = path.join(workspace, "aom-build");
  const aomConfigure = runTool(
    "cmake",
    [
      "-S",
      aomRoot,
      "-B",
      aomBuild,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DAOM_TARGET_CPU=generic",
      "-DCONFIG_AV1_ENCODER=0",
      "-DENABLE_DOCS=0",
      "-DENABLE_EXAMPLES=0",
      "-DENABLE_TESTS=0",
      "-DENABLE_TOOLS=0",
      "-DENABLE_TESTDATA=0",
      "-DBUILD_SHARED_LIBS=0",
      `-DCMAKE_INSTALL_PREFIX=${heifPrefix}`,
    ],
    {},
    "aom configure failed",
  );
  const aomConfigureLog = `${aomConfigure.stdout ?? ""}\n${aomConfigure.stderr ?? ""}`;
  runTool(
    "cmake",
    ["--build", aomBuild, "--parallel", parallelJobs],
    {},
    "aom build failed",
  );
  runTool("cmake", ["--install", aomBuild], {}, "aom install failed");

  const libde265Authority = manifest.authorities[6];
  const libde265Root = path.join(workspace, libde265Authority.archive.root);
  const libde265Build = path.join(workspace, "libde265-build");
  runTool(
    "cmake",
    [
      "-S",
      libde265Root,
      "-B",
      libde265Build,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DENABLE_SIMD=OFF",
      "-DENABLE_AVX2=OFF",
      "-DENABLE_AVX512=OFF",
      "-DENABLE_DECODER=OFF",
      "-DENABLE_SDL=OFF",
      "-DBUILD_SHARED_LIBS=OFF",
      `-DCMAKE_INSTALL_PREFIX=${heifPrefix}`,
    ],
    {},
    "libde265 configure failed",
  );
  runTool(
    "cmake",
    ["--build", libde265Build, "--parallel", parallelJobs],
    {},
    "libde265 build failed",
  );
  runTool("cmake", ["--install", libde265Build], {}, "libde265 install failed");

  const libheifAuthority = manifest.authorities[5];
  const libheifRoot = path.join(workspace, libheifAuthority.archive.root);
  const libheifBuild = path.join(workspace, "libheif-build");
  const heifConfigure = runTool(
    "cmake",
    [
      "-S",
      libheifRoot,
      "-B",
      libheifBuild,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_PREFIX_PATH=${heifPrefix}`,
      `-DCMAKE_INSTALL_PREFIX=${heifPrefix}`,
      "-DBUILD_SHARED_LIBS=OFF",
      "-DENABLE_PLUGIN_LOADING=OFF",
      "-DWITH_LIBDE265=ON",
      "-DWITH_AOM_DECODER=ON",
      "-DWITH_AOM_ENCODER=OFF",
      "-DWITH_X265=OFF",
      "-DWITH_X264=OFF",
      "-DWITH_OpenH264_DECODER=OFF",
      "-DWITH_EXAMPLES=OFF",
      "-DWITH_GDK_PIXBUF=OFF",
      "-DBUILD_TESTING=OFF",
      "-DBUILD_DOCUMENTATION=OFF",
      "-DWITH_UNCOMPRESSED_CODEC=OFF",
    ],
    {},
    "libheif configure failed",
  );
  const heifConfigureLog = `${heifConfigure.stdout ?? ""}\n${heifConfigure.stderr ?? ""}`;
  assertHeifFeatures({ aomConfigureLog, heifConfigureLog });
  runTool(
    "cmake",
    ["--build", libheifBuild, "--parallel", parallelJobs],
    {},
    "libheif build failed",
  );
  runTool("cmake", ["--install", libheifBuild], {}, "libheif install failed");

  const heifIncludeDir = path.join(heifPrefix, "include");
  const heifLibDir = path.join(heifPrefix, "lib");
  const aomStaticPath = path.join(heifLibDir, "libaom.a");
  const de265StaticPath = path.join(heifLibDir, "libde265.a");
  const heifStaticPath = path.join(heifLibDir, "libheif.a");

  // --- HEIF whole-graph decode oracle (62.1-03, D-23, QUA-04): built once per job against the
  // D-21 static stack above, exactly like the JPEG/PNG decode oracles.
  const heifDecodeSourcePath = path.join(
    projectRoot,
    "scripts/qualification/heif_decode_oracle.c",
  );
  if (!fs.existsSync(heifDecodeSourcePath))
    fail("heif decode oracle source is missing");
  const heifDecodePath = path.join(workspace, "heif-decode-oracle");
  runTool(
    "cc",
    [
      "-std=c11",
      "-O2",
      heifDecodeSourcePath,
      "-I",
      heifIncludeDir,
      "-L",
      heifLibDir,
      "-o",
      heifDecodePath,
      "-lheif",
      "-lde265",
      "-laom",
      "-lstdc++",
      "-lpthread",
      "-lm",
    ],
    {},
    "heif decode oracle build failed",
  );

  const executable = (filePath) => ({
    path: filePath,
    sha256: digest(fs.readFileSync(filePath)),
  });
  const tools = {
    authority: authoritySummary(manifest),
    dwebp: executable(dwebpPath),
    webpinfo: executable(webpinfoPath),
    animation: executable(animationPath),
    exiftool: executable(exiftoolPath),
    pngDecode: executable(pngDecodePath),
    pngcheck: executable(pngcheckPath),
    djpeg: executable(djpegPath),
    jpegtran: executable(jpegtranPath),
    rdjpgcom: executable(rdjpgcomPath),
    jpegStatic: executable(libjpegStaticPath),
    jpegDecode: executable(jpegDecodePath),
    // HEIF decode stack (62.1-03 links these against the whole-graph oracle below).
    heifIncludeDir,
    heifLibDir,
    aomStatic: executable(aomStaticPath),
    de265Static: executable(de265StaticPath),
    heifStatic: executable(heifStaticPath),
    heifDecode: executable(heifDecodePath),
  };
  probeOracleVersions(tools, manifest);
  return tools;
}

/**
 * The cheap, post-build version probes that do NOT need the configure log or
 * the extracted source tree (KIT-09 D-02/D-05) -- re-runnable against a
 * cache-loaded tools record, where neither is available. `assertLibjpegTurboFeatures`
 * (configure-log-dependent) is deliberately NOT included here; it stays inline
 * in `buildOracleTools`, where the configure log and the extracted
 * `testimages/testimgari.jpg` fixture both still exist.
 */
function probeOracleVersions(tools, manifest) {
  const libwebp = manifest.authorities[0];
  const exiftoolAuthority = manifest.authorities[1];
  const libpng = manifest.authorities[2];
  const pngcheck = manifest.authorities[3];
  const libjpegTurbo = manifest.authorities[4];
  const libheif = manifest.authorities[5];

  const dwebpVersion = runTool(
    tools.dwebp.path,
    ["-version"],
    {},
    "dwebp version check failed",
  ).stdout.trim();
  const webpinfoVersion = runTool(
    tools.webpinfo.path,
    ["-version"],
    {},
    "webpinfo version check failed",
  ).stdout.trim();
  const exiftoolVersion = runTool(
    tools.exiftool.path,
    ["-ver"],
    {},
    "ExifTool version check failed",
  ).stdout.trim();
  if (
    dwebpVersion !== libwebp.version ||
    webpinfoVersion !== `WebP Decoder version: ${libwebp.version}` ||
    exiftoolVersion !== exiftoolAuthority.version
  )
    fail("built oracle version drift");

  // The decode oracle has no `-version` flag (it takes exactly one input
  // path per its I/O contract); it prints the libpng it was linked
  // against to stderr unconditionally, even on a bare usage error, so
  // this can confirm the built binary is actually wired to the pinned
  // libpng without a separate flag.
  const pngDecodeUsage = spawnSync(tools.pngDecode.path, [], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (pngDecodeUsage.error !== undefined)
    fail(
      `png decode oracle version check failed: ${pngDecodeUsage.error.message}`,
    );
  if (!(pngDecodeUsage.stderr ?? "").includes(`libpng ${libpng.version}`))
    fail("built oracle version drift");

  const pngcheckVersion = runTool(
    tools.pngcheck.path,
    ["-h"],
    {},
    "pngcheck version check failed",
  ).stdout.trim();
  if (!pngcheckVersion.includes(pngcheck.version))
    fail("built oracle version drift");

  const jpegDecodeUsage = spawnSync(tools.jpegDecode.path, [], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (jpegDecodeUsage.error !== undefined)
    fail(
      `jpeg decode oracle version check failed: ${jpegDecodeUsage.error.message}`,
    );
  if (
    !(jpegDecodeUsage.stderr ?? "").includes(
      `libjpeg-turbo ${libjpegTurbo.version}`,
    )
  )
    fail("built oracle version drift");

  // Same no-`-version`-flag pattern as the other decode oracles: the whole-graph HEIF decode
  // oracle takes exactly one usage error path (missing argv), printing the libheif version to
  // stderr unconditionally even then.
  const heifDecodeUsage = spawnSync(tools.heifDecode.path, [], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (heifDecodeUsage.error !== undefined)
    fail(
      `heif decode oracle version check failed: ${heifDecodeUsage.error.message}`,
    );
  if (!(heifDecodeUsage.stderr ?? "").includes(`libheif ${libheif.version}`))
    fail("built oracle version drift");
}

/**
 * Builds once per process, in an ephemeral `mkdtemp` workspace it owns and
 * disposes (KIT-09 D-02). `build` is injectable so a test can swap in a
 * `fakeBuild` that writes small placeholder executables instead of running a
 * real linux/x64 build. When `EXIFCLEANER_ORACLE_DIR` is set, appends one
 * line to `<that dir>/builds.log` so a stray per-process build is visible to
 * `assertBuiltOnce` (D-06) even though this function never writes
 * `complete.json` itself.
 */
function prepareOracleTools({ build = buildOracleTools } = {}) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "exifcleaner-oracles-linux-x64-"),
  );
  let complete = false;
  try {
    const tools = build(workspace);
    complete = true;
    const dir = process.env.EXIFCLEANER_ORACLE_DIR;
    if (typeof dir === "string" && dir.length > 0)
      fs.appendFileSync(
        path.join(dir, "builds.log"),
        `${new Date().toISOString()} pid ${process.pid}\n`,
      );
    return {
      ...tools,
      dispose() {
        fs.rmSync(workspace, { recursive: true, force: true });
      },
    };
  } finally {
    if (!complete) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * `--prepare <dir>` (KIT-09 D-02): claims `dir` exclusively (`build.claim`,
 * `wx` -- a second claim on the same directory throws), appends to
 * `builds.log`, builds into `<dir>/workspace`, and writes `complete.json`
 * last via a temp file + `renameSync` so a reader never observes a partial
 * completion record. Returns the built tools record (without `dispose` --
 * `prepareOracleDir` itself owns no ephemeral resource; the job directory is
 * the caller's to keep or discard).
 */
function prepareOracleDir(dir, { build = buildOracleTools } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const claimPath = path.join(dir, "build.claim");
  try {
    fs.writeFileSync(
      claimPath,
      `${new Date().toISOString()} pid ${process.pid}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (error && error.code === "EEXIST")
      fail(`oracle directory already claimed: ${dir}`);
    throw error;
  }
  const buildsLogPath = path.join(dir, "builds.log");
  fs.appendFileSync(
    buildsLogPath,
    `${new Date().toISOString()} pid ${process.pid}\n`,
  );

  const workspace = path.join(dir, "workspace");
  let tools;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    tools = build(workspace);
  } catch (error) {
    // A thrown build (e.g. a flaky toolchain crash) must not leave `dir`
    // permanently claimed: roll back the exclusive claim and the
    // pre-build `builds.log` line so a retry into this same directory
    // (a self-hosted-runner retry-in-place, or a manual re-run) gets a
    // fresh build attempt instead of a misleading "already claimed"
    // error that masks the real failure (WR-01). This only widens the
    // retry window after a *failed* build; a successful claim still
    // blocks a concurrent second build into the same never-before-used
    // directory (KIT-09 D-06).
    fs.rmSync(claimPath, { force: true });
    fs.rmSync(buildsLogPath, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }

  const executables = {};
  // Plain-string directory fields (for example `heifIncludeDir`/`heifLibDir`,
  // D-21): not a hashable file, but still needed by a cache-mode reload (CI
  // sets EXIFCLEANER_ORACLE_DIR, never rebuilding), so they ride alongside
  // `executables` in their own bag rather than being silently dropped.
  const directories = {};
  for (const [name, value] of Object.entries(tools)) {
    if (name === "authority") continue;
    if (
      isObject(value) &&
      typeof value.path === "string" &&
      typeof value.sha256 === "string"
    ) {
      executables[name] = { path: value.path, sha256: value.sha256 };
    } else if (typeof value === "string") {
      directories[name] = value;
    }
  }
  const complete = {
    version: 1,
    authority: tools.authority,
    executables,
    directories,
    toolchain: { node: process.version },
  };
  const tmpPath = path.join(dir, "complete.json.tmp");
  const completePath = path.join(dir, "complete.json");
  fs.writeFileSync(tmpPath, JSON.stringify(complete, null, 2));
  fs.renameSync(tmpPath, completePath);
  return tools;
}

/**
 * Reads a directory `prepareOracleDir` already built, never writing to it
 * (KIT-09 D-05): verifies `complete.json` exists and its `authority` still
 * matches the committed authority manifest's own summary, re-hashes every
 * recorded executable (refusing on any mismatch -- a tampered binary never
 * loads), re-runs the cheap version probes, and returns the tools with
 * `source: "cache"` and a no-op `dispose()`.
 */
function loadPreparedOracleTools(dir, { probe = probeOracleVersions } = {}) {
  const completePath = path.join(dir, "complete.json");
  if (!fs.existsSync(completePath))
    fail(`oracle directory is not complete: ${dir}`);
  const complete = readJson(completePath, "complete.json");
  const manifest = validateManifestShape(
    readJson(authorityManifestPath, "authority manifest"),
  );
  const expectedAuthority = authoritySummary(manifest);
  if (JSON.stringify(complete.authority) !== JSON.stringify(expectedAuthority))
    fail(`cached oracle authority drift: ${dir}`);

  const tools = { authority: complete.authority };
  for (const [name, record] of Object.entries(complete.executables ?? {})) {
    const recordPath = assertPathWithinDir(
      dir,
      record.path,
      `cached oracle path for ${name}`,
    );
    const bytes = fs.readFileSync(recordPath);
    if (digest(bytes) !== record.sha256)
      fail(`cached oracle sha256 mismatch: ${name}`);
    tools[name] = { path: recordPath, sha256: record.sha256 };
  }
  for (const [name, dirPath] of Object.entries(complete.directories ?? {})) {
    const resolvedPath = assertPathWithinDir(
      dir,
      dirPath,
      `cached oracle directory for ${name}`,
    );
    if (!fs.existsSync(resolvedPath))
      fail(`cached oracle directory missing: ${name}`);
    tools[name] = resolvedPath;
  }
  probe(tools, manifest);
  process.stderr.write(`oracle cache hit ${dir}\n`);
  return {
    ...tools,
    source: "cache",
    dispose() {},
  };
}

/**
 * `--assert-built-once <dir>` (KIT-09 D-06): exits 0 only when `builds.log`
 * holds exactly one non-empty line and `complete.json` is present -- a
 * missing/empty log, a two-line log, or a missing `complete.json` all fail.
 */
function assertBuiltOnce(dir) {
  const logPath = path.join(dir, "builds.log");
  if (!fs.existsSync(logPath))
    fail(`oracle directory has no build log: ${dir}`);
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length !== 1)
    fail(
      `oracle directory was built ${lines.length} times, expected exactly once: ${dir}`,
    );
  if (!fs.existsSync(path.join(dir, "complete.json")))
    fail(`oracle directory is not complete: ${dir}`);
}

/**
 * The single read-only loader every `oracles.ts` consumer delegates to
 * (KIT-09 D-04): with `EXIFCLEANER_ORACLE_DIR` set, loads (never builds) from
 * that directory; unset and `env.CI === "true"` throws on the first `tools()`
 * call (never at construction, so a loader can be created speculatively);
 * otherwise builds once per process via `prepareOracleTools`. Its own memo
 * means each `createOracleToolsLoader()` instance builds/loads at most once.
 */
function createOracleToolsLoader({
  env = process.env,
  build = buildOracleTools,
  probe = probeOracleVersions,
} = {}) {
  let memo;
  return {
    tools() {
      if (memo !== undefined) return memo;
      const dir = env.EXIFCLEANER_ORACLE_DIR;
      if (typeof dir === "string" && dir.length > 0) {
        memo = loadPreparedOracleTools(dir, { probe });
        return memo;
      }
      if (env.CI === "true") fail("EXIFCLEANER_ORACLE_DIR is required in CI");
      const tools = prepareOracleTools({ build });
      memo = { ...tools, source: "build" };
      return memo;
    },
  };
}

const defaultLoader = createOracleToolsLoader();
const loadOrPrepareOracleTools = () => defaultLoader.tools();

module.exports = {
  loadAndValidateAuthority,
  prepareOracleTools,
  buildOracleTools,
  probeOracleVersions,
  prepareOracleDir,
  loadPreparedOracleTools,
  assertBuiltOnce,
  createOracleToolsLoader,
  loadOrPrepareOracleTools,
  readTarMembers,
  assertLibjpegTurboFeatures,
  assertHeifFeatures,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const usage =
    "Usage: node scripts/qualification/build-oracles.cjs --verify-authority | --prepare <dir> | --assert-built-once <dir>\n";
  const runCli = (action) => {
    try {
      action();
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  };
  if (args.length === 1 && args[0] === "--verify-authority") {
    runCli(() => {
      process.stdout.write(`${JSON.stringify(loadAndValidateAuthority())}\n`);
    });
  } else if (args.length === 2 && args[0] === "--prepare") {
    runCli(() => {
      prepareOracleDir(args[1]);
      process.stdout.write(`oracle authorities prepared: ${args[1]}\n`);
    });
  } else if (args.length === 2 && args[0] === "--assert-built-once") {
    runCli(() => {
      assertBuiltOnce(args[1]);
      process.stdout.write(`oracle directory built exactly once: ${args[1]}\n`);
    });
  } else {
    process.stderr.write(usage);
    process.exitCode = 2;
  }
}
