#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { copyFile, mkdir, readFile, rm } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const packageRoot = resolve(__dirname, "..");
const supportedTuples = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);
const tuple = `${process.platform}-${process.arch}`;

function expectedMachine() {
  if (process.arch === "x64") return process.platform === "win32" ? 0x8664 : process.platform === "linux" ? 62 : 0x01000007;
  if (process.arch === "arm64") return process.platform === "win32" ? 0xaa64 : process.platform === "linux" ? 183 : 0x0100000c;
  throw new Error(`Unsupported native architecture: ${process.arch}`);
}

function validateBinary(binary) {
  const machine = expectedMachine();
  if (process.platform === "darwin") {
    if (binary.readUInt32BE(0) !== 0xcffaedfe || binary.readUInt32LE(4) !== machine) {
      throw new Error("Built addon is not the expected Mach-O architecture.");
    }
    return;
  }
  if (process.platform === "linux") {
    if (binary.subarray(0, 4).toString("ascii") !== "\u007fELF" || binary.readUInt16LE(18) !== machine) {
      throw new Error("Built addon is not the expected ELF architecture.");
    }
    return;
  }
  const peOffset = binary.readUInt32LE(60);
  if (binary.subarray(0, 2).toString("ascii") !== "MZ" || binary.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\0\0" || binary.readUInt16LE(peOffset + 4) !== machine) {
    throw new Error("Built addon is not the expected PE architecture.");
  }
}

async function main() {
  if (!supportedTuples.has(tuple)) throw new Error(`Unsupported native tuple: ${tuple}`);
  const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
  const buildDirectory = join(packageRoot, "build");
  const output = join(buildDirectory, "Release", "publication.node");
  const destination = join(packageRoot, "prebuilds", tuple, "publication.node");
  await rm(buildDirectory, { force: true, recursive: true });
  try {
    execFileSync(process.execPath, [nodeGyp, "rebuild"], { cwd: packageRoot, stdio: "inherit" });
    validateBinary(await readFile(output));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(output, destination);
    console.log(`Built native publication addon: ${tuple}`);
  } finally {
    await rm(buildDirectory, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
