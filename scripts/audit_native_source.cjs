#!/usr/bin/env node
/* Development-only admission gate for the private C bridge. */
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const sourcePath = resolve(
  process.argv[2] || resolve(__dirname, "..", "native", "publication.c"),
);
const allowedHeaders = new Set([
  "node_api.h",
  "uv.h",
  "windows.h",
  "aclapi.h",
  "sddl.h",
  "stdio.h",
  "string.h",
  "errno.h",
  "fcntl.h",
  "sys/attr.h",
  "unistd.h",
  "wchar.h",
  "stdlib.h",
  "sys/syscall.h",
]);
const allowedCalls = new Set([
  "CloseHandle",
  "AccessCheck",
  "AddAccessAllowedAceEx",
  "CreateDirectoryW",
  "CreateFileW",
  "CreateHardLinkW",
  "CreateWellKnownSid",
  "DuplicateToken",
  "EqualSid",
  "FIELD_OFFSET",
  "GetAce",
  "GetAclInformation",
  "GetCurrentProcess",
  "GetFileInformationByHandleEx",
  "GetLastError",
  "GetProcessHeap",
  "GetSecurityDescriptorControl",
  "GetSecurityInfo",
  "GetTokenInformation",
  "HeapAlloc",
  "HeapFree",
  "InitializeAcl",
  "InitializeSecurityDescriptor",
  "LocalFree",
  "MapGenericMask",
  "OpenProcessToken",
  "SetSecurityDescriptorControl",
  "SetSecurityDescriptorDacl",
  "SetSecurityDescriptorOwner",
  "SetFileInformationByHandle",
  "memcpy",
  "puts",
  "renameat2",
  "renameatx_np",
  "syscall",
  "wcschr",
  "wcslen",
  "malloc",
  "free",
  "napi_create_string_utf8",
  "napi_create_object",
  "napi_create_uint32",
  "napi_create_external",
  "napi_define_properties",
  "napi_get_cb_info",
  "napi_get_boolean",
  "napi_get_undefined",
  "napi_get_value_external",
  "napi_get_value_int32",
  "napi_get_value_string_utf16",
  "napi_get_value_string_utf8",
  "napi_set_named_property",
  "napi_throw_error",
  "napi_throw_type_error",
  "publication_result_name",
  "create_private_stage_directory",
  "publication_allocate",
  "read_path",
  "parent_path",
  "uv_get_osfhandle",
]);
const languageCalls = new Set([
  "defined",
  "else",
  "for",
  "if",
  "sizeof",
  "while",
  "switch",
  "NAPI_MODULE_INIT",
]);
const forbiddenFamilies = [
  [
    "network",
    /\b(socket|connect|bind|listen|accept|getaddrinfo|WinHttp\w*|Internet\w*)\b/i,
  ],
  ["process", /\b(fork|exec\w*|popen|posix_spawn|CreateProcess\w*)\b/i],
  ["shell", /\b(system|ShellExecute\w*)\b/i],
  ["downloader", /\b(URLDownloadToFile\w*|BITS\w*)\b/i],
  ["runtime-build", /\b(cl\.exe|gcc|clang|node-gyp|make)\b/i],
  ["dynamic-loader", /\b(dlopen|dlsym|LoadLibrary\w*|GetProcAddress)\b/i],
  ["replacing-publication", /\b(rename|MoveFile\w*|CopyFile\w*)\b/i],
  [
    "pathname-cleanup",
    /\b(unlink|unlinkat|remove|rm|rmdir|RemoveFile|DeleteFileW|RemoveDirectoryW)\b/i,
  ],
];

function stripCommentsAndStrings(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/L"(?:\\.|[^"\\])*"/g, 'L""');
}

function fail(message) {
  console.error(`Native source audit failed: ${message}`);
  process.exitCode = 1;
}

let source;
try {
  source = readFileSync(sourcePath, "utf8");
} catch (error) {
  fail(`cannot read ${sourcePath}: ${error.message}`);
  process.exit();
}

const headers = [
  ...source.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm),
].map((match) => match[1]);
for (const header of headers) {
  if (!allowedHeaders.has(header)) fail(`header ${header} is not allowlisted`);
}

const tokens = stripCommentsAndStrings(source);
for (const [category, pattern] of forbiddenFamilies) {
  if (pattern.test(tokens)) fail(`${category} capability is forbidden`);
}

for (const match of tokens.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
  const identifier = match[1];
  if (allowedCalls.has(identifier) || languageCalls.has(identifier)) continue;
  const declaration = new RegExp(
    `(?:static\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\\s+)+${identifier}\\s*\\(`,
  );
  if (!declaration.test(tokens))
    fail(`function ${identifier} is not allowlisted`);
}

if (process.exitCode !== 1) console.log("Native source audit passed");
