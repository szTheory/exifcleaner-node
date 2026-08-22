#!/usr/bin/env node

const {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, isAbsolute, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const suppliedPath = args.find((arg) => arg !== "--keep");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const npmInvocation =
  process.platform === "win32"
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
let createdTarball = false;
let tarball;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} exited with status ${result.status}`,
    );
  }
  return result.stdout;
}

function resolveTarball(input) {
  const candidate = resolve(input);
  if (candidate.endsWith(".tgz")) return candidate;
  const archives = readdirSync(candidate)
    .filter((entry) => entry.endsWith(".tgz"))
    .sort();
  if (archives.length !== 1) {
    throw new Error(
      `Expected exactly one .tgz in ${candidate}; found ${archives.length}`,
    );
  }
  return join(candidate, archives[0]);
}

if (suppliedPath) {
  tarball = resolveTarball(suppliedPath);
} else {
  const packOutput = run(
    npmInvocation.command,
    [...npmInvocation.prefix, "pack", "--json"],
    { capture: true },
  );
  const packResult = JSON.parse(packOutput);
  if (
    !Array.isArray(packResult) ||
    packResult.length !== 1 ||
    !packResult[0].filename
  ) {
    throw new Error("npm pack did not return exactly one package archive");
  }
  tarball = resolve(packResult[0].filename);
  createdTarball = true;
}

const archiveListing = run("tar", ["-tf", tarball], { capture: true })
  .split(/\r?\n/u)
  .filter(Boolean);
for (const required of [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
]) {
  if (!archiveListing.includes(required)) {
    throw new Error(`Packed archive is missing ${required}`);
  }
}
for (const forbiddenPrefix of [
  "package/src/",
  "package/test/",
  "package/tests/",
]) {
  if (archiveListing.some((entry) => entry.startsWith(forbiddenPrefix))) {
    throw new Error(`Packed archive unexpectedly includes ${forbiddenPrefix}`);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "exifcleaner package smoke ü-"));
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
  run(
    npmInvocation.command,
    [
      ...npmInvocation.prefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      copiedTarball,
    ],
    {
      cwd: sandbox,
    },
  );
  writeFileSync(
    join(sandbox, "smoke.mjs"),
    "const loaded = await import('exifcleaner-node');\nif (!loaded || typeof loaded !== 'object') throw new Error('Package import failed');\n",
  );
  run(process.execPath, ["smoke.mjs"], { cwd: sandbox });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  if (createdTarball && !keep) rmSync(tarball, { force: true });
}

if (keep && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tarball=${isAbsolute(tarball) ? tarball : resolve(tarball)}\n`,
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `name=${packageJson.name}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${packageJson.version}\n`);
}

console.log(
  `Package smoke passed for ${packageJson.name}@${packageJson.version}`,
);
