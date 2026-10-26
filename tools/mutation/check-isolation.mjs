#!/usr/bin/env node
// Isolation guard for the StrykerJS tooling package (MUT-01, D-01..D-03).
//
// Why it exists: Stryker lives in tools/mutation/ with its own lockfile so the
// library's manifests stay byte-clean and mutation runs measure the SAME vitest
// the normal suite uses. A leak (a second vitest, a root devDependency, a
// root-manifest change riding along with a tooling change) would make every
// mutation score untrustworthy. Node builtins only; every check fails closed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STRYKER_PACKAGES = [
  "@stryker-mutator/core",
  "@stryker-mutator/api",
  "@stryker-mutator/vitest-runner",
  "@stryker-mutator/typescript-checker",
];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function readJson(path, problems) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`cannot read ${path}: ${error.message}`);
    return null;
  }
}

/** Static rules over the manifests; needs no install. Returns problem strings. */
export function checkStaticIsolation(root) {
  const problems = [];
  const tooling = join(root, "tools", "mutation");
  const pkg = readJson(join(tooling, "package.json"), problems);
  if (pkg !== null) {
    const dev = pkg.devDependencies ?? {};
    const pins = STRYKER_PACKAGES.map((name) => [name, dev[name]]);
    for (const [name, version] of pins) {
      if (version === undefined)
        problems.push(`${name} missing from tools/mutation devDependencies`);
      else if (!EXACT_VERSION.test(version))
        problems.push(`${name} pin "${version}" is not an exact x.y.z version`);
    }
    const present = pins.map(([, v]) => v).filter((v) => v !== undefined);
    if (new Set(present).size > 1)
      problems.push(
        `@stryker-mutator pins are not identical: ${present.join(", ")}`,
      );
    const lock = readJson(join(tooling, "package-lock.json"), problems);
    if (lock !== null) {
      for (const [name, version] of pins) {
        const entry = lock.packages?.[`node_modules/${name}`];
        if (entry === undefined)
          problems.push(
            `${name} missing from tools/mutation/package-lock.json`,
          );
        else if (version !== undefined && entry.version !== version)
          problems.push(
            `${name} lockfile version ${entry.version} differs from pin ${version}`,
          );
      }
    }
  }
  let npmrc = "";
  try {
    npmrc = readFileSync(join(tooling, ".npmrc"), "utf8");
  } catch {
    problems.push("tools/mutation/.npmrc is missing");
  }
  if (!npmrc.split(/\r?\n/).includes("legacy-peer-deps=true"))
    problems.push("tools/mutation/.npmrc lacks the line legacy-peer-deps=true");

  const rootPkgText = readText(join(root, "package.json"), problems);
  const rootLockText = readText(join(root, "package-lock.json"), problems);
  if (rootPkgText.includes("@stryker-mutator"))
    problems.push("root package.json mentions @stryker-mutator");
  if (rootLockText.includes("@stryker-mutator"))
    problems.push("root package-lock.json mentions @stryker-mutator");
  try {
    const rootPkg = JSON.parse(rootPkgText);
    for (const [name, command] of Object.entries(rootPkg.scripts ?? {}))
      if (/stryker|tools\/mutation/.test(String(command)))
        problems.push(
          `root script "${name}" references stryker or tools/mutation`,
        );
    if (Object.keys(rootPkg.dependencies ?? {}).length > 0)
      problems.push("root package.json has a non-empty dependencies key");
  } catch (error) {
    problems.push(`root package.json is not valid JSON: ${error.message}`);
  }
  return problems;
}

function readText(path, problems) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    problems.push(`cannot read ${path}: ${error.message}`);
    return "";
  }
}

/** Rules over the installed tree: one vitest only, the root copy. */
export function checkInstalledIsolation(root) {
  const problems = [];
  const tooling = join(root, "tools", "mutation");
  if (existsSync(join(tooling, "node_modules", "vitest")))
    problems.push("nested vitest found in tools/mutation/node_modules");
  try {
    const resolved = createRequire(join(tooling, "package.json")).resolve(
      "vitest/package.json",
    );
    const rootCopy = join(root, "node_modules", "vitest", "package.json");
    if (realpathSync(resolved) !== realpathSync(rootCopy))
      problems.push(
        `tools/mutation resolves vitest to ${resolved}, not the root copy`,
      );
  } catch (error) {
    problems.push(
      `cannot resolve vitest from tools/mutation: ${error.message}`,
    );
  }
  return problems;
}

/** Base revision rule shared with floors.mjs (67-05). */
export function resolveBaseRev(env) {
  if (env.MUTATION_BASE_REV) return env.MUTATION_BASE_REV;
  return `origin/${env.GITHUB_BASE_REF || "main"}`;
}

/** A change under tools/mutation/ must not ride with a root manifest change. */
export function checkManifestCoupling(baseRev, cwd) {
  let names;
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baseRev}...HEAD`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    names = out.split("\0").filter(Boolean);
  } catch (error) {
    return [
      `cannot diff against ${baseRev} (fail closed): ${error.message.split("\n")[0]}`,
    ];
  }
  if (!names.some((n) => n.startsWith("tools/mutation/"))) return [];
  return ["package.json", "package-lock.json"]
    .filter((m) => names.includes(m))
    .map((m) => `${m} changed in the same range as tools/mutation/ (D-01)`);
}

export function main(env = process.env) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const problems = [
    ...checkStaticIsolation(root),
    ...(existsSync(join(root, "tools", "mutation", "node_modules"))
      ? checkInstalledIsolation(root)
      : []),
    ...checkManifestCoupling(resolveBaseRev(env), root),
  ];
  for (const problem of problems) console.error(`isolation: ${problem}`);
  if (problems.length === 0) console.log("isolation: ok");
  return problems.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
