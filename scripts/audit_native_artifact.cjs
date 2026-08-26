#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const LINUX_LIBRARIES = new Set([
  "libc.so.6",
  "ld-linux-aarch64.so.1",
  "ld-linux-x86-64.so.2",
]);
const LINUX_IMPORTS = new Set([
  "renameat2",
  "__errno_location",
  "malloc",
  "free",
  "memcpy",
  "memset",
  "strlen",
  "syscall",
  "__stack_chk_fail",
]);
const DARWIN_LIBRARIES = new Set(["/usr/lib/libSystem.B.dylib"]);
const DARWIN_IMPORTS = new Set([
  "_renameatx_np",
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
  const rejected = [...new Set(values)].filter(
    (value) => !allowlist.has(value) && !predicate(value),
  );
  if (rejected.length > 0) {
    throw new Error(`${kind}s are not allowlisted: ${rejected.join(", ")}`);
  }
}

function auditLinux(dynamicOutput, symbolsOutput) {
  const libraries = [
    ...dynamicOutput.matchAll(/Shared library: \[([^\]]+)\]/g),
  ].map((match) => match[1]);
  const imports = [
    ...symbolsOutput.matchAll(/\bUND[ \t]+([^\s@]+)(?:@[^\s]+)?/g),
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
  const importsSection = importsOutput.split(/^\s*Summary\s*$/im)[0];
  const imports = [
    ...importsSection.matchAll(
      /^\s+[0-9A-Fa-f]+\s+([A-Za-z_][A-Za-z0-9_@]*)[ \t]*$/gm,
    ),
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

function nonemptyLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function chooseDumpbinPath(paths, arch) {
  const hostTarget = `host${arch}\\${arch}\\dumpbin.exe`;
  const preferredFallbacks = [
    "hostx64\\x64\\dumpbin.exe",
    "hostarm64\\arm64\\dumpbin.exe",
  ];
  return [...paths].sort((left, right) => {
    const score = (candidate) => {
      const normalized = candidate.toLowerCase().replaceAll("/", "\\");
      if (normalized.endsWith(hostTarget)) return 0;
      const fallback = preferredFallbacks.findIndex((suffix) =>
        normalized.endsWith(suffix),
      );
      return fallback === -1 ? preferredFallbacks.length + 1 : fallback + 1;
    };
    return score(left) - score(right) || left.localeCompare(right);
  })[0];
}

function resolveDumpbin({
  arch = process.arch,
  env = process.env,
  execFile = execFileSync,
} = {}) {
  try {
    const path = nonemptyLines(
      execFile("where.exe", ["dumpbin.exe"], { encoding: "utf8" }),
    )[0];
    if (path) return path;
  } catch {
    // GitHub-hosted runners install dumpbin without adding it to PATH.
  }

  const vswhere =
    env.VSWHERE_PATH ||
    join(
      env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    );
  let candidates;
  try {
    candidates = nonemptyLines(
      execFile(
        vswhere,
        [
          "-latest",
          "-products",
          "*",
          "-find",
          "VC\\Tools\\MSVC\\**\\bin\\Host*\\*\\dumpbin.exe",
        ],
        { encoding: "utf8" },
      ),
    );
  } catch (error) {
    throw new Error(
      `Could not locate dumpbin via PATH or Visual Studio (${vswhere})`,
      { cause: error },
    );
  }
  const path = chooseDumpbinPath(candidates, arch);
  if (!path) {
    throw new Error(
      `Visual Studio did not report a dumpbin executable via ${vswhere}`,
    );
  }
  return path;
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
    const dumpbin = resolveDumpbin();
    return auditWindows(
      execFileSync(dumpbin, ["/dependents", path], { encoding: "utf8" }),
      execFileSync(dumpbin, ["/imports", path], { encoding: "utf8" }),
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

module.exports = {
  auditLinux,
  auditDarwin,
  auditWindows,
  auditHostArtifact,
  chooseDumpbinPath,
  resolveDumpbin,
};
