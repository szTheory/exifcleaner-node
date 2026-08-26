#!/usr/bin/env node

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const forbiddenDependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];
const forbiddenLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"];
const forbiddenRuntimeModules = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "child_process", "worker_threads", "cluster"]);
function artifactContract() {
  return require("./native_artifacts.cjs");
}

const diagnostic = (path, reason) => `${path}: ${reason}`;

function importSpecifiers(source) {
  const specifiers = [];
  const staticImport = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isForbiddenRuntimeModule(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return [...forbiddenRuntimeModules].some((forbidden) => bare === forbidden || bare.startsWith(`${forbidden}/`));
}

async function javascriptFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  await visit(resolve(root, "dist"));
  return files.sort();
}

function isApprovedPackedFile(path) {
  return path === "package.json" || path === "LICENSE" || path === "README.md" || /^prebuilds\/(?:linux|darwin|win32)-(?:x64|arm64)\/publication\.node$/u.test(path) || /^dist\/.+\.(?:js|d\.ts|js\.map|d\.ts\.map)$/u.test(path);
}

export async function checkRuntimeSurface(packageRoot) {
  const root = resolve(packageRoot);
  const diagnostics = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  } catch (error) {
    return [diagnostic("package.json", `cannot parse manifest: ${String(error)}`)];
  }
  for (const section of forbiddenDependencySections) {
    if (Object.hasOwn(manifest, section)) diagnostics.push(diagnostic("package.json", `runtime dependency section ${section} is forbidden`));
  }
  for (const lifecycle of forbiddenLifecycleScripts) {
    if (Object.hasOwn(manifest.scripts ?? {}, lifecycle)) diagnostics.push(diagnostic("package.json", `lifecycle script ${lifecycle} is forbidden`));
  }
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    diagnostics.push(diagnostic("package.json", "exports must expose only the root subpath"));
  } else for (const subpath of Object.keys(manifest.exports).sort()) {
    if (subpath !== ".") diagnostics.push(diagnostic("package.json", `export subpath ${subpath} is forbidden`));
  }
  try {
    for (const file of await javascriptFiles(root)) {
      const display = relative(root, file).replaceAll("\\", "/");
      for (const specifier of importSpecifiers(await readFile(file, "utf8"))) {
        if (isForbiddenRuntimeModule(specifier)) diagnostics.push(diagnostic(display, `forbidden runtime import ${JSON.stringify(specifier)}`));
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic("dist", `cannot inspect built runtime: ${String(error)}`));
  }
  return diagnostics.sort();
}

export async function checkPackedListing(files) {
  const diagnostics = [];
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) return [diagnostic("packed listing", "must be an array of paths")];
  const { EXACT_ARTIFACTS } = artifactContract();
  const exactNativePaths = EXACT_ARTIFACTS.map((artifact) => artifact.path).sort();
  const nativePaths = files.filter((file) => file.endsWith(".node")).sort();
  if (nativePaths.join("\n") !== exactNativePaths.join("\n")) diagnostics.push(diagnostic("packed listing", "packed native path set must contain exactly six literal D-50 paths"));
  for (const file of files) if (!isApprovedPackedFile(file)) diagnostics.push(diagnostic(file, "packed file is not approved"));
  return diagnostics.sort();
}

async function reportsFrom(directory) {
  const reports = {};
  const { EXACT_ARTIFACTS } = artifactContract();
  for (const artifact of EXACT_ARTIFACTS) reports[artifact.tuple] = await readFile(resolve(directory, `${artifact.tuple}.json`), "utf8");
  return reports;
}

export async function checkAssembly({ root, manifestPath, reportsDirectory, evidenceScope }) {
  if (evidenceScope !== "test-fixture" && evidenceScope !== "final-release") return [diagnostic("evidence scope", "must be test-fixture or final-release")];
  try {
    const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
    const reports = await reportsFrom(reportsDirectory);
    if (evidenceScope === "final-release" && Object.values(reports).some((report) => JSON.parse(report).evidenceScope === "test-fixture")) return [diagnostic("assembly", "fixture evidence is rejected for final release admission")];
    const { EXACT_ARTIFACTS, validateManifest } = artifactContract();
    await validateManifest(resolve(root), manifest, reports);
    const extraNodes = await nativeFilesOutsideExactPaths(resolve(root), EXACT_ARTIFACTS.map((artifact) => artifact.path));
    if (extraNodes.length > 0) return [diagnostic(extraNodes[0], "extra native binary is forbidden")];
    return [];
  } catch (error) {
    return [diagnostic("assembly", String(error))];
  }
}

async function nativeFilesOutsideExactPaths(root, exactNativePaths) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        const display = relative(root, path).replaceAll("\\", "/");
        if (!exactNativePaths.includes(display)) found.push(display);
      }
    }
  }
  await visit(root);
  return found.sort();
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || !args[index + 1]) throw new Error("Usage: runtime_surface_gate.mjs <package-root> | --source <root> | --assembly-root <root> --manifest <file> --reports-dir <dir> --evidence-scope <test-fixture|final-release> | --packed-listing <json>");
    values[args[index].slice(2)] = args[index + 1];
  }
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && !args[0].startsWith("--")) {
    const diagnostics = await checkRuntimeSurface(args[0]);
    if (diagnostics.length === 0) return console.log("Runtime surface gate passed");
    throw new Error(diagnostics.join("\n"));
  }
  const values = parseArgs(args);
  let diagnostics = [];
  let label = "runtime surface";
  if (values.source) diagnostics = await checkRuntimeSurface(values.source);
  else if (values["packed-listing"]) diagnostics = await checkPackedListing(JSON.parse(await readFile(resolve(values["packed-listing"]), "utf8")));
  else if (values["assembly-root"] && values.manifest && values["reports-dir"] && values["evidence-scope"]) {
    label = "assembly";
    diagnostics = await checkAssembly({ root: values["assembly-root"], manifestPath: values.manifest, reportsDirectory: values["reports-dir"], evidenceScope: values["evidence-scope"] });
  } else throw new Error("incomplete gate inputs");
  if (diagnostics.length === 0) console.log(`${label} gate passed`);
  else throw new Error(diagnostics.join("\n"));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(`Runtime surface gate failed:\n- ${String(error.message ?? error).replaceAll("\n", "\n- ")}`); process.exitCode = 1; }
}
