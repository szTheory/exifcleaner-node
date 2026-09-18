#!/usr/bin/env node
"use strict";

/*
 * Host-independence gate for the Windows prebuilds.
 *
 * A Windows import names the module that provides it AT LINK TIME. Inside a
 * packaged Electron app the module providing N-API is the app executable, whose
 * name varies per application -- it is not "node.exe". An addon that declares a
 * dependency on the literal name "node.exe" therefore makes the loader find and
 * map a SECOND, complete Node runtime into the process. Handles minted by the
 * real host are then decompressed against the wrong V8 pointer-compression cage
 * and the first N-API call faults. Published 0.2.1 shipped exactly that on both
 * win32-x64 and win32-arm64.
 *
 * scripts/audit_native_artifact.cjs also covers this, but only on a Windows host
 * with dumpbin, and dumpbin's /dependents and /imports do not distinguish a
 * static import from a delay-load descriptor. This gate reads the PE data
 * directories directly, so it runs from any host, covers every prebuild rather
 * than only the matching one, and tells the two import kinds apart.
 */

const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const WINDOWS_TUPLES = ["win32-x64", "win32-arm64"];
const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_DESCRIPTOR_SIZE = 32;

function readPortableExecutable(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d)
    throw new Error("not a PE image: missing MZ signature");
  const signature = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(signature) !== 0x00004550)
    throw new Error("not a PE image: missing PE signature");

  const coff = signature + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const plus = buffer.readUInt16LE(optional) === 0x20b;
  const directories = optional + (plus ? 112 : 96);
  const directoryCount = buffer.readUInt32LE(directories - 4);

  const directory = (index) =>
    index < directoryCount
      ? {
          rva: buffer.readUInt32LE(directories + index * 8),
          size: buffer.readUInt32LE(directories + index * 8 + 4),
        }
      : { rva: 0, size: 0 };

  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = optional + optionalSize + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(header + 8),
      virtualAddress: buffer.readUInt32LE(header + 12),
      rawSize: buffer.readUInt32LE(header + 16),
      rawPointer: buffer.readUInt32LE(header + 20),
    });
  }

  const offsetOf = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span)
        return section.rawPointer + (rva - section.virtualAddress);
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };

  const nameAt = (rva) => {
    const start = offsetOf(rva);
    let end = start;
    while (end < buffer.length && buffer[end] !== 0) end += 1;
    return buffer.toString("ascii", start, end);
  };

  const walk = (index, stride, nameField) => {
    const { rva } = directory(index);
    if (rva === 0) return [];
    const names = [];
    for (let cursor = offsetOf(rva); ; cursor += stride) {
      const nameRva = buffer.readUInt32LE(cursor + nameField);
      if (nameRva === 0) break;
      names.push(nameAt(nameRva));
    }
    return names;
  };

  return {
    staticImports: walk(IMPORT_DIRECTORY, IMPORT_DESCRIPTOR_SIZE, 12),
    delayImports: walk(DELAY_IMPORT_DIRECTORY, DELAY_DESCRIPTOR_SIZE, 4),
  };
}

function inspect(path) {
  const { staticImports, delayImports } = readPortableExecutable(
    readFileSync(path),
  );
  const hosted = [...staticImports, ...delayImports].filter((name) =>
    /^node\.exe$|^libnode\.dll$|\.exe$/i.test(name),
  );
  return { staticImports, delayImports, hosted };
}

function checkPrebuilds(packageRoot) {
  const failures = [];
  const reports = {};
  for (const tuple of WINDOWS_TUPLES) {
    const path = join(packageRoot, "prebuilds", tuple, "publication.node");
    let report;
    try {
      report = inspect(path);
    } catch (error) {
      failures.push(`${tuple}: ${error.message}`);
      continue;
    }
    reports[tuple] = report;
    if (report.hosted.length > 0) {
      const kinds = report.hosted
        .map(
          (name) =>
            `${name} (${report.staticImports.includes(name) ? "static" : "delay-load"})`,
        )
        .join(", ");
      failures.push(
        `${tuple}: declares a dependency on the host executable: ${kinds}. ` +
          `The N-API surface must be bound at runtime against the module already ` +
          `hosting the addon, not imported from a module named at link time.`,
      );
    }
  }
  return { failures, reports };
}

if (require.main === module) {
  const packageRoot = resolve(process.argv[2] || join(__dirname, ".."));
  const { failures, reports } = checkPrebuilds(packageRoot);
  for (const [tuple, report] of Object.entries(reports)) {
    process.stdout.write(
      `${tuple}: static [${report.staticImports.join(", ")}] delay [${report.delayImports.join(", ") || "none"}]\n`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures)
      process.stderr.write(
        `Windows host-independence gate failed: ${failure}\n`,
      );
    process.exitCode = 1;
  } else {
    process.stdout.write("Windows host-independence gate passed\n");
  }
}

module.exports = { readPortableExecutable, inspect, checkPrebuilds };
