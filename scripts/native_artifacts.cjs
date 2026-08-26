#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { readdir, readFile } = require("node:fs/promises");
const { join, relative, sep } = require("node:path");

const EXACT_ARTIFACTS = Object.freeze([
  {
    tuple: "linux-x64",
    path: "prebuilds/linux-x64/publication.node",
    binaryFormat: "elf",
    machine: "x64",
    auditTool: "readelf",
  },
  {
    tuple: "linux-arm64",
    path: "prebuilds/linux-arm64/publication.node",
    binaryFormat: "elf",
    machine: "arm64",
    auditTool: "readelf",
  },
  {
    tuple: "darwin-x64",
    path: "prebuilds/darwin-x64/publication.node",
    binaryFormat: "macho",
    machine: "x64",
    auditTool: "otool-nm",
  },
  {
    tuple: "darwin-arm64",
    path: "prebuilds/darwin-arm64/publication.node",
    binaryFormat: "macho",
    machine: "arm64",
    auditTool: "otool-nm",
  },
  {
    tuple: "win32-x64",
    path: "prebuilds/win32-x64/publication.node",
    binaryFormat: "pe",
    machine: "x64",
    auditTool: "dumpbin",
  },
  {
    tuple: "win32-arm64",
    path: "prebuilds/win32-arm64/publication.node",
    binaryFormat: "pe",
    machine: "arm64",
    auditTool: "dumpbin",
  },
]);
const auditReportByHash = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function binaryIdentity(binary) {
  if (binary.subarray(0, 4).toString("ascii") === "\u007fELF") {
    if (binary.length < 20) throw new Error("ELF artifact is truncated");
    const machine = binary.readUInt16LE(18);
    return {
      binaryFormat: "elf",
      machine:
        machine === 62
          ? "x64"
          : machine === 183
            ? "arm64"
            : `unknown-${machine}`,
    };
  }
  if (binary.length >= 8 && binary.readUInt32BE(0) === 0xcffaedfe) {
    const machine = binary.readUInt32LE(4);
    return {
      binaryFormat: "macho",
      machine:
        machine === 0x01000007
          ? "x64"
          : machine === 0x0100000c
            ? "arm64"
            : `unknown-${machine}`,
    };
  }
  if (binary.length >= 70 && binary.subarray(0, 2).toString("ascii") === "MZ") {
    const offset = binary.readUInt32LE(60);
    if (
      offset + 6 > binary.length ||
      binary.subarray(offset, offset + 4).toString("ascii") !== "PE\0\0"
    )
      throw new Error("PE artifact is malformed");
    const machine = binary.readUInt16LE(offset + 4);
    return {
      binaryFormat: "pe",
      machine:
        machine === 0x8664
          ? "x64"
          : machine === 0xaa64
            ? "arm64"
            : `unknown-${machine}`,
    };
  }
  throw new Error("Artifact has an unrecognized binary format");
}

async function artifactPaths(root) {
  const directory = join(root, "prebuilds");
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name === "publication.node")
        found.push(relative(root, child).split(sep).join("/"));
    }
  }
  await visit(directory);
  return found.sort();
}

function reportFor(record, reports) {
  const report =
    reports?.[record.tuple] ?? auditReportByHash.get(record.auditReportSha256);
  if (typeof report !== "string")
    throw new Error(`Artifact ${record.tuple} has no audit report`);
  if (sha256(report) !== record.auditReportSha256)
    throw new Error(`Artifact ${record.tuple} audit report hash is stale`);
  const parsed = JSON.parse(report);
  if (parsed.auditTool !== record.auditTool)
    throw new Error(`Artifact ${record.tuple} audit report tool is mislabeled`);
}

async function validateManifest(root, manifest, reports) {
  if (!Array.isArray(manifest) || manifest.length !== EXACT_ARTIFACTS.length)
    throw new Error("Manifest must contain exactly six artifacts");
  const expectedByTuple = new Map(
    EXACT_ARTIFACTS.map((record) => [record.tuple, record]),
  );
  const seen = new Set();
  for (const record of manifest) {
    const expected = expectedByTuple.get(record.tuple);
    if (!expected)
      throw new Error(`Manifest tuple ${record.tuple} is unexpected`);
    if (seen.has(record.tuple))
      throw new Error(`Manifest tuple ${record.tuple} is duplicate`);
    seen.add(record.tuple);
    for (const field of ["path", "binaryFormat", "machine", "auditTool"]) {
      if (record[field] !== expected[field])
        throw new Error(`Artifact ${record.tuple} ${field} is mislabeled`);
    }
    const binary = await readFile(join(root, record.path));
    const identity = binaryIdentity(binary);
    if (identity.binaryFormat !== record.binaryFormat)
      throw new Error(`Artifact ${record.tuple} binary format is wrong`);
    if (identity.machine !== record.machine)
      throw new Error(`Artifact ${record.tuple} machine is wrong`);
    if (sha256(binary) !== record.sha256)
      throw new Error(`Artifact ${record.tuple} hash is stale`);
    reportFor(record, reports);
  }
  const actual = await artifactPaths(root);
  const expectedPaths = EXACT_ARTIFACTS.map((record) => record.path).sort();
  if (actual.join("\n") !== expectedPaths.join("\n"))
    throw new Error("Artifact path set has missing or unexpected entries");
  return true;
}

async function createManifest(root, reports) {
  const manifest = [];
  for (const expected of EXACT_ARTIFACTS) {
    const binary = await readFile(join(root, expected.path));
    const report = reports?.[expected.tuple];
    if (typeof report !== "string")
      throw new Error(`Missing audit report for ${expected.tuple}`);
    const record = {
      ...expected,
      sha256: sha256(binary),
      auditReportSha256: sha256(report),
    };
    auditReportByHash.set(record.auditReportSha256, report);
    manifest.push(record);
  }
  await validateManifest(root, manifest, reports);
  return manifest;
}

module.exports = {
  EXACT_ARTIFACTS,
  binaryIdentity,
  createManifest,
  validateManifest,
};
