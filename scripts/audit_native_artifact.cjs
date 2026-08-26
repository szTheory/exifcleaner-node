#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const LINUX_LIBRARIES = new Set(["libc.so.6"]);
const LINUX_IMPORTS = new Set([
  "renameat2",
  "__errno_location",
  "malloc",
  "free",
  "memcpy",
  "memset",
  "strlen",
  "__stack_chk_fail",
]);
const DARWIN_LIBRARIES = new Set(["/usr/lib/libSystem.B.dylib"]);
const DARWIN_IMPORTS = new Set([
  "_renamex_np",
  "___error",
  "_malloc",
  "_free",
  "_memcpy",
  "_memset",
  "_strlen",
  "___stack_chk_fail",
]);
const WINDOWS_LIBRARIES = new Set(["node.exe", "KERNEL32.dll", "ADVAPI32.dll"]);
const WINDOWS_IMPORTS = new Set([
  "CreateFileW",
  "SetFileInformationByHandle",
  "GetFileInformationByHandleEx",
  "CloseHandle",
  "GetLastError",
  "GetCurrentProcess",
  "GetProcessHeap",
  "HeapAlloc",
  "HeapFree",
  "LocalFree",
  "CreateDirectoryW",
  "OpenProcessToken",
  "GetTokenInformation",
  "DuplicateToken",
  "CreateWellKnownSid",
  "EqualSid",
  "InitializeSecurityDescriptor",
  "SetSecurityDescriptorOwner",
  "SetSecurityDescriptorDacl",
  "SetSecurityDescriptorControl",
  "InitializeAcl",
  "AddAccessAllowedAceEx",
  "GetAclInformation",
  "GetAce",
  "GetSecurityInfo",
  "GetSecurityDescriptorOwner",
  "GetSecurityDescriptorDacl",
  "GetSecurityDescriptorControl",
  "MapGenericMask",
  "AccessCheck",
]);

function stableReport(auditTool, libraries, imports) {
  return JSON.stringify({
    auditTool,
    libraries: [...libraries].sort(),
    imports: [...imports].sort(),
  });
}

function assertAllowlisted(values, allowlist, predicate, kind) {
  for (const value of values) {
    if (!allowlist.has(value) && !predicate(value)) {
      throw new Error(`${kind} ${value} is not allowlisted`);
    }
  }
}

function auditLinux(dynamicOutput, symbolsOutput) {
  const libraries = [
    ...dynamicOutput.matchAll(/Shared library: \[([^\]]+)\]/g),
  ].map((match) => match[1]);
  const imports = [
    ...symbolsOutput.matchAll(/\bUND\s+([^\s@]+)(?:@[^\s]+)?/g),
  ].map((match) => match[1]);
  assertAllowlisted(
    libraries,
    LINUX_LIBRARIES,
    () => false,
    "Linux dependency",
  );
  assertAllowlisted(
    imports,
    LINUX_IMPORTS,
    (name) => /^napi_[A-Za-z0-9_]*$/.test(name),
    "Linux import",
  );
  return stableReport("readelf", libraries, imports);
}

function auditDarwin(librariesOutput, symbolsOutput) {
  const libraries = librariesOutput
    .split(/\r?\n/)
    .map((line) => line.trim().split(" (")[0])
    .filter((line) => line.startsWith("/") && !line.endsWith(":"));
  const imports = symbolsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => (line.startsWith("U ") ? line.slice(2).trim() : line))
    .filter((line) => line.startsWith("_"));
  assertAllowlisted(
    libraries,
    DARWIN_LIBRARIES,
    () => false,
    "macOS dependency",
  );
  assertAllowlisted(
    imports,
    DARWIN_IMPORTS,
    (name) => /^_napi_[A-Za-z0-9_]*$/.test(name),
    "macOS import",
  );
  return stableReport("otool-nm", libraries, imports);
}

function auditWindows(dependentsOutput, importsOutput) {
  const libraries = [
    ...dependentsOutput.matchAll(/^\s*([A-Za-z0-9_.-]+\.dll|node\.exe)\s*$/gim),
  ].map((match) => match[1]);
  const imports = [
    ...importsOutput.matchAll(/^\s{4,}([A-Za-z_][A-Za-z0-9_@]*)\s*$/gm),
  ]
    .map((match) => match[1])
    .filter((name) => !/\.dll$/i.test(name));
  assertAllowlisted(
    libraries,
    WINDOWS_LIBRARIES,
    () => false,
    "Windows dependency",
  );
  assertAllowlisted(
    imports,
    WINDOWS_IMPORTS,
    (name) => /^napi_[A-Za-z0-9_]*$/.test(name),
    "Windows import",
  );
  return stableReport("dumpbin", libraries, imports);
}

function auditHostArtifact(path) {
  if (process.platform === "linux") {
    return auditLinux(
      execFileSync("readelf", ["-dW", path], { encoding: "utf8" }),
      execFileSync("readelf", ["-Ws", path], { encoding: "utf8" }),
    );
  }
  if (process.platform === "darwin") {
    return auditDarwin(
      execFileSync("otool", ["-L", path], { encoding: "utf8" }),
      execFileSync("nm", ["-u", path], { encoding: "utf8" }),
    );
  }
  if (process.platform === "win32") {
    return auditWindows(
      execFileSync("dumpbin", ["/dependents", path], { encoding: "utf8" }),
      execFileSync("dumpbin", ["/imports", path], { encoding: "utf8" }),
    );
  }
  throw new Error(`Unsupported audit platform: ${process.platform}`);
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "Usage: audit_native_artifact.cjs <matching-host-publication.node>",
    );
  process.stdout.write(`${auditHostArtifact(path)}\n`);
}

module.exports = { auditLinux, auditDarwin, auditWindows, auditHostArtifact };
