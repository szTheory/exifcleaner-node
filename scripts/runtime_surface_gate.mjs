#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenDependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];
const forbiddenRuntimeModules = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dns",
  "dgram",
  "child_process",
  "worker_threads",
  "cluster",
]);

function diagnostic(path, reason) {
  return `${path}: ${reason}`;
}

function importSpecifiers(source) {
  const specifiers = [];
  const staticImport =
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isForbiddenRuntimeModule(specifier) {
  const bareSpecifier = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  return [...forbiddenRuntimeModules].some(
    (forbidden) =>
      bareSpecifier === forbidden || bareSpecifier.startsWith(`${forbidden}/`),
  );
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

function packedFiles(root) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const packed = JSON.parse(output);
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    !Array.isArray(packed[0]?.files)
  ) {
    throw new Error("npm pack --dry-run did not return one file manifest");
  }
  return packed[0].files.map((file) => file.path).sort();
}

function isApprovedPackedFile(path) {
  return (
    path === "package.json" ||
    path === "LICENSE" ||
    path === "README.md" ||
    /^prebuilds\/(?:linux|darwin|win32)-(?:x64|arm64)\/publication\.node$/u.test(
      path,
    ) ||
    /^dist\/.+\.(?:js|d\.ts|js\.map|d\.ts\.map)$/u.test(path)
  );
}

export async function checkRuntimeSurface(packageRoot) {
  const root = resolve(packageRoot);
  const diagnostics = [];
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    );
  } catch (error) {
    return [
      diagnostic("package.json", `cannot parse manifest: ${String(error)}`),
    ];
  }

  for (const section of forbiddenDependencySections) {
    if (Object.hasOwn(manifest, section)) {
      diagnostics.push(
        diagnostic(
          "package.json",
          `runtime dependency section ${section} is forbidden`,
        ),
      );
    }
  }
  for (const lifecycle of forbiddenLifecycleScripts) {
    if (Object.hasOwn(manifest.scripts ?? {}, lifecycle)) {
      diagnostics.push(
        diagnostic(
          "package.json",
          `lifecycle script ${lifecycle} is forbidden`,
        ),
      );
    }
  }
  const exports = manifest.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    diagnostics.push(
      diagnostic("package.json", "exports must expose only the root subpath"),
    );
  } else {
    for (const subpath of Object.keys(exports).sort()) {
      if (subpath !== ".") {
        diagnostics.push(
          diagnostic("package.json", `export subpath ${subpath} is forbidden`),
        );
      }
    }
  }

  if (diagnostics.length > 0) return diagnostics.sort();

  try {
    for (const file of await javascriptFiles(root)) {
      const displayPath = relative(root, file).replaceAll("\\", "/");
      for (const specifier of importSpecifiers(await readFile(file, "utf8"))) {
        if (isForbiddenRuntimeModule(specifier)) {
          diagnostics.push(
            diagnostic(
              displayPath,
              `forbidden runtime import ${JSON.stringify(specifier)}`,
            ),
          );
        }
      }
    }
  } catch (error) {
    diagnostics.push(
      diagnostic("dist", `cannot inspect built runtime: ${String(error)}`),
    );
  }

  if (diagnostics.length === 0) {
    try {
      for (const file of packedFiles(root)) {
        if (!isApprovedPackedFile(file)) {
          diagnostics.push(diagnostic(file, "packed file is not approved"));
        }
      }
    } catch (error) {
      diagnostics.push(diagnostic("npm pack --dry-run", String(error)));
    }
  }
  return diagnostics.sort();
}

async function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot) {
    console.error("Usage: runtime_surface_gate.mjs <package-root>");
    process.exitCode = 2;
    return;
  }
  const diagnostics = await checkRuntimeSurface(packageRoot);
  if (diagnostics.length > 0) {
    console.error(
      `Runtime surface gate failed:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("Runtime surface gate passed");
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  await main();
}
