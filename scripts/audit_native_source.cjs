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
  "napi_get_named_property",
  "napi_get_undefined",
  "napi_get_value_external",
  "napi_get_value_int32",
  "napi_get_value_string_utf16",
  "napi_get_value_string_utf8",
  "napi_get_value_uint32",
  "napi_set_named_property",
  "napi_throw_error",
  "napi_throw_type_error",
  "publication_result_name",
  "create_private_stage_directory",
  "capture_private_stage_cleanup",
  "publication_allocate",
  "read_path",
  "parent_path",
  "uv_get_osfhandle",
  "GetModuleHandleW",
  "GetProcAddress",
  "publication_bind_host",
]);

// The exact symbol surface publication_bind_host may resolve against the host
// process. Anything outside this set is a capability the bridge does not have.
const HOST_BOUND_SYMBOLS = new Set([
  "napi_create_external",
  "napi_create_object",
  "napi_create_string_utf8",
  "napi_create_uint32",
  "napi_define_properties",
  "napi_get_boolean",
  "napi_get_cb_info",
  "napi_get_null",
  "napi_get_undefined",
  "napi_get_value_external",
  "napi_get_value_int32",
  "napi_get_value_string_utf16",
  "napi_get_value_string_utf8",
  "napi_set_named_property",
  "napi_throw_error",
  "napi_throw_type_error",
  "uv_get_osfhandle",
  "libnode.dll",
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
  // Loading code remains forbidden outright. Resolving an entry point against a
  // module the loader has ALREADY mapped is a strictly weaker capability, and on
  // Windows it is the only way to reach the running host's N-API surface without
  // naming a provider module at link time. GetProcAddress is therefore permitted
  // only under the confinement asserted by requireHostBindingConfinement below;
  // GetModuleHandleA/GetModuleHandleEx and every library loader stay forbidden.
  [
    "dynamic-loader",
    /\b(dlopen|dlsym|LoadLibrary\w*|LoadPackagedLibrary|GetModuleHandleA|GetModuleHandleEx\w*)\b/i,
  ],
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

function functionBody(input, name) {
  const signature = new RegExp(
    `static\\s+(?:napi_value|private_stage_directory\\s*\\*|publication_result|BOOL)\\s*${name}\\s*\\(`,
    "g",
  );
  let start;
  let open;
  for (const match of input.matchAll(signature)) {
    const candidate = match.index;
    const candidateOpen = input.indexOf("{", candidate);
    const candidateEnd = input.indexOf(";", candidate);
    if (
      candidateOpen !== -1 &&
      (candidateEnd === -1 || candidateOpen < candidateEnd)
    ) {
      start = candidate;
      open = candidateOpen;
      break;
    }
  }
  if (start === undefined || open === undefined) return undefined;
  let depth = 0;
  for (let index = open; index < input.length; index += 1) {
    if (input[index] === "{") depth += 1;
    if (input[index] === "}" && --depth === 0)
      return input.slice(start, index + 1);
  }
  return undefined;
}

function requirePattern(input, pattern, description) {
  if (!pattern.test(input)) fail(`missing ${description}`);
}

/*
 * GetProcAddress is permitted only as the host N-API binding, and only inside
 * publication_bind_host. This confinement is what keeps the relaxation of the
 * dynamic-loader family from widening the bridge's actual capability:
 *   - the module handle may come only from an already-mapped module, never a load
 *   - the only name the bridge may look for is "libnode.dll"
 *   - the only entry points it may resolve are the fixed N-API surface
 *   - no other function in the file may resolve anything
 */
function requireHostBindingConfinement(rawSource, strippedTokens) {
  const rawBody = functionBody(rawSource, "publication_bind_host");
  const strippedBody = functionBody(strippedTokens, "publication_bind_host");
  if (rawBody === undefined || strippedBody === undefined) {
    fail(
      "publication_bind_host is missing; the host N-API binding is required",
    );
    return;
  }

  const resolutions = [...strippedTokens.matchAll(/\bGetProcAddress\s*\(/g)];
  const confined = [...strippedBody.matchAll(/\bGetProcAddress\s*\(/g)];
  if (resolutions.length !== confined.length)
    fail("GetProcAddress is only permitted inside publication_bind_host");

  const handles = [...strippedTokens.matchAll(/\bGetModuleHandleW\s*\(/g)];
  const confinedHandles = [
    ...strippedBody.matchAll(/\bGetModuleHandleW\s*\(/g),
  ];
  if (handles.length !== confinedHandles.length)
    fail("GetModuleHandleW is only permitted inside publication_bind_host");

  for (const [, literal] of rawBody.matchAll(/L?"((?:\\.|[^"\\])*)"/g)) {
    if (!HOST_BOUND_SYMBOLS.has(literal))
      fail(`publication_bind_host may not resolve "${literal}"`);
  }

  requirePattern(
    rawBody,
    /GetModuleHandleW\(L"libnode\.dll"\)/,
    "already-mapped libnode.dll probe",
  );
  requirePattern(
    rawBody,
    /GetModuleHandleW\(NULL\)/,
    "running-host module handle",
  );
  if (
    /\bGetModuleHandleW\s*\(\s*(?!NULL\s*\)|L"libnode\.dll"\s*\))/.test(rawBody)
  )
    fail('publication_bind_host may only ask for NULL or L"libnode.dll"');
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

requireHostBindingConfinement(source, tokens);

for (const match of tokens.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
  const identifier = match[1];
  if (allowedCalls.has(identifier) || languageCalls.has(identifier)) continue;
  // A function-pointer declarator -- `napi_status(NAPI_CDECL *field)(...)` or
  // `uv_os_fd_t(*field)(...)` -- names a return type, not a call. The forbidden
  // families above are matched against the whole file regardless.
  if (
    /^\s*(?:NAPI_CDECL\s*)?\*/.test(tokens.slice(match.index + match[0].length))
  )
    continue;
  const declaration = new RegExp(
    `(?:static\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\\s+)+${identifier}\\s*\\(`,
  );
  if (!declaration.test(tokens))
    fail(`function ${identifier} is not allowlisted`);
}

const captureBinding = functionBody(tokens, "capture_stage_cleanup_binding");
const captureAuthority = functionBody(tokens, "capture_private_stage_cleanup");
const consumeAuthority = functionBody(tokens, "consume_private_stage_cleanup");
const identityComparison = functionBody(tokens, "file_identity_matches");

if (
  captureBinding === undefined ||
  captureAuthority === undefined ||
  consumeAuthority === undefined ||
  identityComparison === undefined
) {
  fail("private descriptor cleanup authority is incomplete");
} else {
  requirePattern(
    captureBinding,
    /argc\s*=\s*3[\s\S]*napi_get_value_int32[\s\S]*uv_get_osfhandle\(stage_descriptor\)[\s\S]*GetFileInformationByHandleEx\(stage_handle,\s*FileIdInfo,\s*&expected/,
    "borrowed descriptor FileIdInfo capture",
  );
  requirePattern(
    captureBinding,
    /capture_private_stage_cleanup\(\(private_stage_directory \*\)data,\s*stage_path,\s*&expected\)/,
    "native capture invocation",
  );
  requirePattern(
    captureAuthority,
    /CreateFileW\(stage_path,[\s\S]*DELETE\s*\|\s*FILE_READ_ATTRIBUTES\s*\|\s*SYNCHRONIZE,[\s\S]*FILE_SHARE_READ\s*\|\s*FILE_SHARE_WRITE\s*\|\s*FILE_SHARE_DELETE,[\s\S]*FILE_FLAG_OPEN_REPARSE_POINT/,
    "identity-bound cleanup open rights",
  );
  requirePattern(
    captureAuthority,
    /GetFileInformationByHandleEx\(stage_file,\s*FileIdInfo,\s*&observed[\s\S]*file_identity_matches\(&observed,\s*expected\)[\s\S]*capability->cleanup_handle\s*=\s*stage_file/,
    "observed identity comparison and retained handle",
  );
  requirePattern(
    identityComparison,
    /left->VolumeSerialNumber\s*!=\s*right->VolumeSerialNumber[\s\S]*left->FileId\.Identifier\[index\]\s*!=\s*right->FileId\.Identifier\[index\]/,
    "complete FileIdInfo comparison",
  );
  requirePattern(
    consumeAuthority,
    /SetFileInformationByHandle\(capability->cleanup_handle[\s\S]*CloseHandle\(capability->cleanup_handle\)[\s\S]*capability->cleanup_handle\s*=\s*INVALID_HANDLE_VALUE/,
    "retained cleanup-handle consume",
  );
  if (
    /\buint32_t\b|napi_get_value_uint32|napi_get_named_property|\bnapi_value\s+identity\b/.test(
      captureBinding,
    )
  )
    fail(
      "capture authority must not parse a JavaScript identity object or uint32 volume serial",
    );
  if (/\bReOpenFile\b/.test(tokens))
    fail("post-capture stage-path reopen capability is forbidden");
}

if (process.exitCode !== 1) console.log("Native source audit passed");
