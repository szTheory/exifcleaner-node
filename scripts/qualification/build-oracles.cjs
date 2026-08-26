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

function sha(value, label) {
  if (!SHA256.test(requiredString(value, label)))
    fail(`${label} is not SHA-256`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail(`${label} must be a positive integer`);
}

function validateAuthorityShape(authority) {
  exactKeys(
    authority,
    [
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
    ],
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
    !new Set(["BSD-3-Clause", "Artistic-1.0-Perl OR GPL-1.0-or-later"]).has(
      authority.license.spdx,
    )
  )
    fail(`${id}.license.spdx is not admitted`);
  repositoryPath(authority.license.path, `${id}.license.path`);
  tarMemberName(authority.license.member, root, `${id}.license.member`);
  sha(authority.license.sha256, `${id}.license.sha256`);

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
  if (!Array.isArray(manifest.authorities) || manifest.authorities.length !== 2)
    fail("exactly two tool authorities are required");
  manifest.authorities.forEach(validateAuthorityShape);
  const ids = manifest.authorities.map((item) => item.id);
  if (
    JSON.stringify(ids) !== JSON.stringify(["libwebp-1.5.0", "exiftool-13.59"])
  )
    fail("authority order and IDs are not exact");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 1)
    fail("exactly one upstream fixture authority is required");
  manifest.fixtures.forEach(validateFixtureShape);
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
    JSON.stringify(record.roles) !==
      JSON.stringify(["decode", "differential", "structural"]) ||
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

function runShapeMutationChecks(manifest) {
  const mutations = [
    (copy) => delete copy.authorities[0].origin,
    (copy) => (copy.authorities[0].platforms = []),
    (copy) => (copy.authorities[0].license.spdx = "unknown"),
    (copy) => (copy.authorities[0].entrypoints[0].member = "../dwebp"),
    (copy) => delete copy.fixtures[0].sha256,
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

function prepareOracleTools() {
  const { manifest, validated } = validateAllAuthority();
  if (process.platform !== "linux" || process.arch !== "x64")
    fail("oracle execution requires the admitted linux/x64 host");

  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "exifcleaner-oracles-linux-x64-"),
  );
  let complete = false;
  try {
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
    const dwebpVersion = runTool(
      dwebpPath,
      ["-version"],
      {},
      "dwebp version check failed",
    ).stdout.trim();
    const webpinfoVersion = runTool(
      webpinfoPath,
      ["-version"],
      {},
      "webpinfo version check failed",
    ).stdout.trim();
    const exiftoolVersion = runTool(
      exiftoolPath,
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

    const executable = (filePath) => ({
      path: filePath,
      sha256: digest(fs.readFileSync(filePath)),
    });
    complete = true;
    return {
      authority: authoritySummary(manifest),
      dwebp: executable(dwebpPath),
      webpinfo: executable(webpinfoPath),
      animation: executable(animationPath),
      exiftool: executable(exiftoolPath),
      dispose() {
        fs.rmSync(workspace, { recursive: true, force: true });
      },
    };
  } finally {
    if (!complete) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

module.exports = {
  loadAndValidateAuthority,
  prepareOracleTools,
  readTarMembers,
};

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== "--verify-authority") {
    process.stderr.write(
      "Usage: node scripts/qualification/build-oracles.cjs --verify-authority\n",
    );
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(loadAndValidateAuthority())}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
