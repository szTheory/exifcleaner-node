/*
 * Private native publication boundary.  The OS operation below is the only
 * publication authority: no pathname observation or fallback is a success
 * condition.  The standalone entrypoint is compiled only by the test harness.
 */
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#ifndef PUBLICATION_STANDALONE_TEST
#include <node_api.h>
#endif

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <uv.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdlib.h>
#elif defined(__APPLE__)
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/attr.h>
#include <unistd.h>
#ifndef AT_FDCWD
#define AT_FDCWD -2
#endif
#else
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Keep the raw renameat2 boundary buildable with conservative libc headers. */
#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#endif

typedef enum publication_result {
  PUBLICATION_PUBLISHED = 0,
  PUBLICATION_COLLISION = 1,
  PUBLICATION_UNSUPPORTED = 2,
  PUBLICATION_FAILED = 3,
} publication_result;

#if defined(_WIN32)
typedef struct private_stage_directory {
  HANDLE handle;
  FILE_ID_INFO identity;
  HANDLE parent_handle;
  FILE_ID_INFO parent_identity;
  /* Set only by the pre-hook capture operation. Never reopen the stage path
   * after this handle has proved its identity and DELETE authority. */
  HANDLE cleanup_handle;
  FILE_ID_INFO cleanup_identity;
} private_stage_directory;

/* Bounded, per-addon evidence for the most recent successful Windows link.
 * It is diagnostic-only and is consumed by the installed-package smoke test;
 * production publication authority remains the native return code. */
typedef struct windows_publication_evidence {
  BOOL available;
  FILE_ID_INFO destination_parent;
  FILE_ID_INFO stage_directory;
  FILE_ID_INFO stage_file;
  FILE_ID_INFO destination_file;
} windows_publication_evidence;

static windows_publication_evidence last_windows_publication_evidence;

static publication_result publish_no_replace(HANDLE stage, const WCHAR *destination,
                                             const WCHAR *stage_path,
                                             private_stage_directory *capability,
                                             DWORD *diagnostic);
static private_stage_directory *create_private_stage_directory(const WCHAR *path,
                                                               BOOL *residue_remains);
static publication_result remove_private_stage_file(
    private_stage_directory *capability, const WCHAR *stage_path);
static private_stage_directory *capture_private_stage_cleanup(
    private_stage_directory *capability, const WCHAR *stage_path,
    const FILE_ID_INFO *expected);
static publication_result consume_private_stage_cleanup(
    private_stage_directory *capability);
static publication_result dispose_private_stage_directory(
    private_stage_directory *capability);
#else
static publication_result publish_no_replace(int stage_directory, const char *stage_entry,
                                             int destination_directory,
                                             const char *destination_entry);
#endif

#ifndef PUBLICATION_STANDALONE_TEST
static const char *publication_result_name(publication_result result) {
  switch (result) {
    case PUBLICATION_PUBLISHED: return "published";
    case PUBLICATION_COLLISION: return "collision";
    case PUBLICATION_UNSUPPORTED: return "unsupported";
    default: return "failed";
  }
}

#if defined(_WIN32)
static napi_value file_id_info_value(napi_env env, const FILE_ID_INFO *identity);
static napi_value native_diagnostic_result(napi_env env, DWORD diagnostic) {
  const char *operation = "link:";
  char value[64];
  size_t length = 7;
  size_t index = 0;
  char digits[16];
  size_t digit_count = 0;
  DWORD error = diagnostic;
  const char prefix[] = "failed:";
  for (index = 0; index < sizeof(prefix) - 1; index += 1) value[index] = prefix[index];
  for (index = 0; operation[index] != '\0'; index += 1) value[length + index] = operation[index];
  length += index;
  do {
    digits[digit_count] = (char)('0' + (error % 10));
    digit_count += 1;
    error /= 10;
  } while (error != 0 && digit_count < sizeof(digits));
  while (digit_count > 0) {
    digit_count -= 1;
    value[length] = digits[digit_count];
    length += 1;
  }
  value[length] = '\0';
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}
#endif

static napi_value publication_result_value(napi_env env, publication_result result
#if defined(_WIN32)
                                          , DWORD diagnostic
#endif
                                          ) {
  napi_value value;
#if defined(_WIN32)
  if (result == PUBLICATION_FAILED && diagnostic != ERROR_SUCCESS)
    return native_diagnostic_result(env, diagnostic);
#endif
  napi_create_string_utf8(env, publication_result_name(result), NAPI_AUTO_LENGTH, &value);
  return value;
}

#if defined(_WIN32)
static void *publication_allocate(size_t size) {
  return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
}

static void publication_free(void *value) {
  if (value != NULL) HeapFree(GetProcessHeap(), 0, value);
}

static WCHAR *read_path(napi_env env, napi_value value) {
  size_t length;
  size_t index;
  WCHAR *path;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length > (MAXDWORD / sizeof(WCHAR)) - 1) {
    return NULL;
  }
  path = (WCHAR *)publication_allocate((length + 1) * sizeof(WCHAR));
  if (path == NULL ||
      napi_get_value_string_utf16(env, value, (char16_t *)path, length + 1,
                                  &length) != napi_ok) {
    publication_free(path);
    return NULL;
  }
  for (index = 0; index < length; index += 1) {
    if (path[index] == L'\0') {
      publication_free(path);
      return NULL;
    }
  }
  return path;
}

static void finalize_stage_directory(napi_env env, void *data, void *hint) {
  private_stage_directory *capability = (private_stage_directory *)data;
  (void)env;
  (void)hint;
  if (capability != NULL) {
    if (capability->handle != INVALID_HANDLE_VALUE) CloseHandle(capability->handle);
    if (capability->parent_handle != INVALID_HANDLE_VALUE)
      CloseHandle(capability->parent_handle);
    if (capability->cleanup_handle != INVALID_HANDLE_VALUE)
      CloseHandle(capability->cleanup_handle);
    publication_free(capability);
  }
}
#endif

static napi_value publish_no_replace_binding(napi_env env, napi_callback_info info) {
  size_t argc =
#if defined(_WIN32)
      4;
#else
      4;
#endif
  napi_value args[4];
#if defined(_WIN32)
  int32_t stage_descriptor;
  HANDLE stage_handle;
  WCHAR *destination;
  WCHAR *stage_path;
  void *capability_data = NULL;
#else
  size_t stage_entry_length;
  size_t destination_entry_length;
  int32_t stage_directory;
  int32_t destination_directory;
  char *stage_entry;
  char *destination_entry;
#endif
  publication_result result = PUBLICATION_FAILED;
#if defined(_WIN32)
  DWORD diagnostic = ERROR_SUCCESS;
#endif
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc !=
#if defined(_WIN32)
      4
#else
      4
#endif
      ) {
    napi_throw_type_error(env, NULL, "publishNoReplace requires native capabilities");
    return NULL;
  }
#if defined(_WIN32)
  if (napi_get_value_int32(env, args[0], &stage_descriptor) != napi_ok) {
    napi_throw_type_error(env, NULL, "publishNoReplace requires an open stage descriptor");
    return NULL;
  }
  destination = read_path(env, args[1]);
  stage_path = read_path(env, args[2]);
  if (destination == NULL || stage_path == NULL ||
      napi_get_value_external(env, args[3], &capability_data) != napi_ok ||
      capability_data == NULL) {
    publication_free(destination);
    publication_free(stage_path);
    napi_throw_error(env, NULL, "could not read destination path");
    return NULL;
  }
  stage_handle = uv_get_osfhandle(stage_descriptor);
  if (stage_handle == INVALID_HANDLE_VALUE) {
    publication_free(destination);
    publication_free(stage_path);
    return publication_result_value(env, PUBLICATION_FAILED
#if defined(_WIN32)
                                    , ERROR_SUCCESS
#endif
                                    );
  }
  result = publish_no_replace(stage_handle, destination, stage_path,
                              (private_stage_directory *)capability_data, &diagnostic);
  publication_free(destination);
  publication_free(stage_path);
#else
  if (
      napi_get_value_int32(env, args[0], &stage_directory) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &stage_entry_length) != napi_ok ||
      napi_get_value_int32(env, args[2], &destination_directory) != napi_ok ||
      napi_get_value_string_utf8(env, args[3], NULL, 0, &destination_entry_length) != napi_ok) {
    napi_throw_type_error(env, NULL, "publishNoReplace requires directory descriptors and entry names");
    return NULL;
  }
  stage_entry = malloc(stage_entry_length + 1);
  destination_entry = malloc(destination_entry_length + 1);
  if (stage_entry == NULL || destination_entry == NULL ||
      napi_get_value_string_utf8(env, args[1], stage_entry, stage_entry_length + 1, NULL) != napi_ok ||
      napi_get_value_string_utf8(env, args[3], destination_entry, destination_entry_length + 1, NULL) != napi_ok) {
    free(stage_entry);
    free(destination_entry);
    napi_throw_error(env, NULL, "could not read publication entry names");
    return NULL;
  }
  result = publish_no_replace(stage_directory, stage_entry, destination_directory,
                              destination_entry);
  free(stage_entry);
  free(destination_entry);
#endif
  return publication_result_value(env, result
#if defined(_WIN32)
                                  , diagnostic
#endif
                                  );
}

static napi_value create_stage_directory_binding(napi_env env, napi_callback_info info) {
  napi_value value;
#if defined(_WIN32)
  size_t argc = 1;
  napi_value args[1];
  WCHAR *path;
  private_stage_directory *capability;
  BOOL residue_remains = FALSE;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      (path = read_path(env, args[0])) == NULL) {
    napi_throw_type_error(env, NULL, "createPrivateStageDirectory requires one path string");
    return NULL;
  }
  capability = create_private_stage_directory(path, &residue_remains);
  publication_free(path);
  if (capability == NULL) {
    if (residue_remains) {
      /* Boolean needs no allocation, so even low-memory setup failures leave
       * TypeScript with a conservative, truthful finalization state. */
      napi_get_boolean(env, TRUE, &value);
      return value;
    }
    napi_get_undefined(env, &value);
    return value;
  }
  if (napi_create_external(env, capability, finalize_stage_directory, NULL, &value) !=
      napi_ok) {
    residue_remains = dispose_private_stage_directory(capability) != PUBLICATION_PUBLISHED;
    finalize_stage_directory(env, capability, NULL);
    if (residue_remains) {
      napi_get_boolean(env, TRUE, &value);
      return value;
    }
    napi_get_undefined(env, &value);
    return value;
  }
  return value;
#else
  (void)info;
  napi_get_undefined(env, &value);
  return value;
#endif
}

static napi_value dispose_stage_directory_binding(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  size_t argc = 1;
  napi_value args[1];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, args[0], &data) != napi_ok || data == NULL) {
    return publication_result_value(env, PUBLICATION_FAILED, ERROR_SUCCESS);
  }
  return publication_result_value(
      env, dispose_private_stage_directory((private_stage_directory *)data),
      ERROR_SUCCESS);
#else
  (void)info;
  return publication_result_value(env, PUBLICATION_UNSUPPORTED);
#endif
}

static napi_value remove_stage_file_binding(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  size_t argc = 2;
  napi_value args[2];
  void *data = NULL;
  WCHAR *stage_path;
  publication_result result;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_external(env, args[0], &data) != napi_ok || data == NULL ||
      (stage_path = read_path(env, args[1])) == NULL) {
    return publication_result_value(env, PUBLICATION_FAILED, ERROR_SUCCESS);
  }
  result = remove_private_stage_file((private_stage_directory *)data, stage_path);
  publication_free(stage_path);
  return publication_result_value(env, result, ERROR_SUCCESS);
#else
  (void)info;
  return publication_result_value(env, PUBLICATION_UNSUPPORTED);
#endif
}

#if defined(_WIN32)
static int hex_value(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

static BOOL read_file_id_info(napi_env env, napi_value value, FILE_ID_INFO *identity) {
  napi_value volume;
  napi_value file_id;
  uint32_t serial;
  size_t length = 0;
  char text[sizeof(identity->FileId.Identifier) * 2 + 1];
  size_t index;
  if (identity == NULL || napi_get_named_property(env, value, "volumeSerialNumber", &volume) != napi_ok ||
      napi_get_named_property(env, value, "fileId", &file_id) != napi_ok ||
      napi_get_value_uint32(env, volume, &serial) != napi_ok ||
      napi_get_value_string_utf8(env, file_id, text, sizeof(text), &length) != napi_ok ||
      length != sizeof(identity->FileId.Identifier) * 2) return FALSE;
  identity->VolumeSerialNumber = serial;
  for (index = 0; index < sizeof(identity->FileId.Identifier); index += 1) {
    int high = hex_value(text[index * 2]);
    int low = hex_value(text[index * 2 + 1]);
    if (high < 0 || low < 0) return FALSE;
    identity->FileId.Identifier[index] = (BYTE)((high << 4) | low);
  }
  return TRUE;
}
#endif

static napi_value stage_file_identity_binding(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  size_t argc = 1;
  napi_value args[1];
  int32_t descriptor;
  HANDLE handle;
  FILE_ID_INFO identity;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, args[0], &descriptor) != napi_ok ||
      (handle = uv_get_osfhandle(descriptor)) == INVALID_HANDLE_VALUE ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))) {
    napi_value value; napi_get_undefined(env, &value); return value;
  }
  return file_id_info_value(env, &identity);
#else
  napi_value value; (void)info; napi_get_undefined(env, &value); return value;
#endif
}

static napi_value capture_stage_cleanup_binding(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  size_t argc = 3;
  napi_value args[3];
  void *data = NULL;
  WCHAR *stage_path;
  FILE_ID_INFO expected;
  private_stage_directory *capability;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_external(env, args[0], &data) != napi_ok || data == NULL ||
      (stage_path = read_path(env, args[1])) == NULL || !read_file_id_info(env, args[2], &expected)) {
    napi_value value; napi_get_undefined(env, &value); return value;
  }
  capability = capture_private_stage_cleanup((private_stage_directory *)data, stage_path, &expected);
  publication_free(stage_path);
  if (capability == NULL) { napi_value value; napi_get_undefined(env, &value); return value; }
  return args[0];
#else
  napi_value value; (void)info; napi_get_undefined(env, &value); return value;
#endif
}

static napi_value consume_stage_cleanup_binding(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  size_t argc = 1; napi_value args[1]; void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, args[0], &data) != napi_ok || data == NULL)
    return publication_result_value(env, PUBLICATION_FAILED, ERROR_SUCCESS);
  return publication_result_value(env, consume_private_stage_cleanup((private_stage_directory *)data), ERROR_SUCCESS);
#else
  (void)info; return publication_result_value(env, PUBLICATION_UNSUPPORTED);
#endif
}

#if defined(_WIN32)
static napi_value file_id_info_value(napi_env env, const FILE_ID_INFO *identity) {
  static const char hex[] = "0123456789abcdef";
  char identifier[sizeof(identity->FileId.Identifier) * 2 + 1];
  size_t index;
  napi_value value;
  napi_value volume;
  napi_value file_id;
  if (identity == NULL || napi_create_object(env, &value) != napi_ok ||
      napi_create_uint32(env, identity->VolumeSerialNumber, &volume) != napi_ok) {
    return NULL;
  }
  for (index = 0; index < sizeof(identity->FileId.Identifier); index += 1) {
    identifier[index * 2] = hex[(identity->FileId.Identifier[index] >> 4) & 0x0f];
    identifier[index * 2 + 1] = hex[identity->FileId.Identifier[index] & 0x0f];
  }
  identifier[sizeof(identity->FileId.Identifier) * 2] = '\0';
  if (napi_create_string_utf8(env, identifier, NAPI_AUTO_LENGTH, &file_id) != napi_ok ||
      napi_set_named_property(env, value, "volumeSerialNumber", volume) != napi_ok ||
      napi_set_named_property(env, value, "fileId", file_id) != napi_ok) {
    return NULL;
  }
  return value;
}

static napi_value take_last_windows_publication_evidence_binding(
    napi_env env, napi_callback_info info) {
  napi_value value;
  napi_value property;
  napi_value destination_parent;
  napi_value stage_directory;
  napi_value stage_file;
  napi_value destination_file;
  (void)info;
  if (!last_windows_publication_evidence.available) {
    napi_get_undefined(env, &value);
    return value;
  }
  last_windows_publication_evidence.available = FALSE;
  destination_parent = file_id_info_value(
      env, &last_windows_publication_evidence.destination_parent);
  stage_directory = file_id_info_value(
      env, &last_windows_publication_evidence.stage_directory);
  stage_file = file_id_info_value(env, &last_windows_publication_evidence.stage_file);
  destination_file = file_id_info_value(
      env, &last_windows_publication_evidence.destination_file);
  if (destination_parent == NULL || stage_directory == NULL || stage_file == NULL ||
      destination_file == NULL || napi_create_object(env, &value) != napi_ok ||
      napi_create_string_utf8(env, "CreateHardLinkW", NAPI_AUTO_LENGTH, &property) != napi_ok ||
      napi_set_named_property(env, value, "primitive", property) != napi_ok ||
      napi_create_uint32(env, 1, &property) != napi_ok ||
      napi_set_named_property(env, value, "linkCalls", property) != napi_ok ||
      napi_get_boolean(env, TRUE, &property) != napi_ok ||
      napi_set_named_property(env, value, "destinationParentIdentityRechecked", property) != napi_ok ||
      napi_set_named_property(env, value, "stageIdentityRechecked", property) != napi_ok ||
      napi_set_named_property(env, value, "stageFileIdentityRechecked", property) != napi_ok ||
      napi_set_named_property(env, value, "destinationParent", destination_parent) != napi_ok ||
      napi_set_named_property(env, value, "stageDirectory", stage_directory) != napi_ok ||
      napi_set_named_property(env, value, "stageFile", stage_file) != napi_ok ||
      napi_set_named_property(env, value, "destinationFile", destination_file) != napi_ok) {
    napi_get_undefined(env, &value);
  }
  return value;
}
#else
static napi_value take_last_windows_publication_evidence_binding(
    napi_env env, napi_callback_info info) {
  napi_value value;
  (void)info;
  napi_get_undefined(env, &value);
  return value;
}
#endif

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "publishNoReplace", NULL, publish_no_replace_binding, NULL, NULL, NULL, napi_default, NULL },
    { "createPrivateStageDirectory", NULL, create_stage_directory_binding, NULL, NULL, NULL, napi_default, NULL },
    { "disposePrivateStageDirectory", NULL, dispose_stage_directory_binding, NULL, NULL, NULL, napi_default, NULL },
    { "removePrivateStageFile", NULL, remove_stage_file_binding, NULL, NULL, NULL, napi_default, NULL },
    { "capturePrivateStageCleanup", NULL, capture_stage_cleanup_binding, NULL, NULL, NULL, napi_default, NULL },
    { "consumePrivateStageCleanup", NULL, consume_stage_cleanup_binding, NULL, NULL, NULL, napi_default, NULL },
    { "stageFileIdentity", NULL, stage_file_identity_binding, NULL, NULL, NULL, napi_default, NULL },
    { "takeLastWindowsPublicationEvidence", NULL, take_last_windows_publication_evidence_binding, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
#endif

#if defined(_WIN32)
static publication_result map_windows_error(DWORD error) {
  if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
    return PUBLICATION_COLLISION;
  }
  if (error == ERROR_INVALID_FUNCTION || error == ERROR_INVALID_PARAMETER ||
      error == ERROR_NOT_SUPPORTED || error == ERROR_CALL_NOT_IMPLEMENTED ||
      error == ERROR_NOT_SAME_DEVICE) {
    return PUBLICATION_UNSUPPORTED;
  }
  return PUBLICATION_FAILED;
}

static BOOL file_identity_matches(const FILE_ID_INFO *left, const FILE_ID_INFO *right) {
  size_t index;
  if (left->VolumeSerialNumber != right->VolumeSerialNumber) return FALSE;
  for (index = 0; index < sizeof(left->FileId.Identifier); index += 1) {
    if (left->FileId.Identifier[index] != right->FileId.Identifier[index]) return FALSE;
  }
  return TRUE;
}

static WCHAR *parent_path(const WCHAR *path) {
  size_t length = 0;
  size_t split = 0;
  size_t parent_length;
  WCHAR *parent;
  BOOL found_separator = FALSE;
  if (path == NULL || path[0] == L'\0') return NULL;
  while (path[length] != L'\0') {
    if (path[length] == L'\\' || path[length] == L'/') {
      split = length;
      found_separator = TRUE;
    }
    length += 1;
  }
  if (!found_separator) {
    /* A filename in the current directory has an explicit, safe parent. */
    parent = (WCHAR *)publication_allocate(2 * sizeof(WCHAR));
    if (parent == NULL) return NULL;
    parent[0] = L'.';
    parent[1] = L'\0';
    return parent;
  }
  if (split + 1 >= length) return NULL;
  parent_length = split;
  if (split == 0) parent_length = 1;
  /* C:\\file has the drive root as its parent; C: would be drive-relative. */
  if (split == 2 && path[1] == L':') parent_length = split + 1;
  parent = (WCHAR *)publication_allocate((parent_length + 1) * sizeof(WCHAR));
  if (parent == NULL) return NULL;
  for (length = 0; length < parent_length; length += 1) parent[length] = path[length];
  parent[parent_length] = L'\0';
  return parent;
}

static HANDLE open_directory_no_reparse(const WCHAR *path) {
  return CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
}

static publication_result publish_no_replace(HANDLE stage_handle,
                                             const WCHAR *destination,
                                             const WCHAR *stage_path,
                                             private_stage_directory *capability,
                                             DWORD *diagnostic) {
  HANDLE parent_handle = INVALID_HANDLE_VALUE;
  HANDLE stage_directory = INVALID_HANDLE_VALUE;
  HANDLE destination_handle = INVALID_HANDLE_VALUE;
  FILE_ID_INFO parent_identity;
  FILE_ID_INFO stage_identity;
  FILE_ID_INFO stage_file_identity;
  WCHAR *destination_parent = NULL;
  WCHAR *stage_parent = NULL;
  publication_result result = PUBLICATION_FAILED;
  DWORD error;

  if (diagnostic != NULL) *diagnostic = ERROR_SUCCESS;
  last_windows_publication_evidence.available = FALSE;
  if (stage_handle == INVALID_HANDLE_VALUE || stage_handle == NULL || destination == NULL ||
      stage_path == NULL || capability == NULL ||
      capability->handle == INVALID_HANDLE_VALUE ||
      capability->parent_handle == INVALID_HANDLE_VALUE) goto done;
  destination_parent = parent_path(destination);
  stage_parent = parent_path(stage_path);
  if (destination_parent == NULL || stage_parent == NULL) goto done;
  parent_handle = open_directory_no_reparse(destination_parent);
  stage_directory = open_directory_no_reparse(stage_parent);
  if (parent_handle == INVALID_HANDLE_VALUE || stage_directory == INVALID_HANDLE_VALUE ||
      !GetFileInformationByHandleEx(parent_handle, FileIdInfo, &parent_identity,
                                    sizeof(parent_identity)) ||
      !GetFileInformationByHandleEx(stage_directory, FileIdInfo, &stage_identity,
                                    sizeof(stage_identity)) ||
      !GetFileInformationByHandleEx(stage_handle, FileIdInfo, &stage_file_identity,
                                    sizeof(stage_file_identity)) ||
      !file_identity_matches(&parent_identity, &capability->parent_identity) ||
      !file_identity_matches(&stage_identity, &capability->identity) ||
      parent_identity.VolumeSerialNumber != stage_identity.VolumeSerialNumber ||
      stage_identity.VolumeSerialNumber != stage_file_identity.VolumeSerialNumber) {
    result = PUBLICATION_UNSUPPORTED;
    goto done;
  }
  if (CreateHardLinkW(destination, stage_path, NULL)) {
    /* This is evidence only. A failure to observe it cannot revoke an already
     * successful no-replace publication, but it must not be reported as proof. */
    destination_handle = CreateFileW(
        destination, READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (destination_handle != INVALID_HANDLE_VALUE) {
      FILE_ID_INFO destination_file_identity;
      if (GetFileInformationByHandleEx(destination_handle, FileIdInfo,
                                       &destination_file_identity,
                                       sizeof(destination_file_identity)) &&
          file_identity_matches(&stage_file_identity, &destination_file_identity)) {
        last_windows_publication_evidence.destination_parent = parent_identity;
        last_windows_publication_evidence.stage_directory = stage_identity;
        last_windows_publication_evidence.stage_file = stage_file_identity;
        last_windows_publication_evidence.destination_file = destination_file_identity;
        last_windows_publication_evidence.available = TRUE;
      }
    }
    result = PUBLICATION_PUBLISHED;
  } else {
    error = GetLastError();
    if (diagnostic != NULL) *diagnostic = error;
    result = map_windows_error(error);
  }
done:
  if (destination_handle != INVALID_HANDLE_VALUE) CloseHandle(destination_handle);
  if (stage_directory != INVALID_HANDLE_VALUE) CloseHandle(stage_directory);
  if (parent_handle != INVALID_HANDLE_VALUE) CloseHandle(parent_handle);
  publication_free(destination_parent);
  publication_free(stage_parent);
  return result;
}

/* The directory capability is intentionally opaque to callers. */
static BOOL verify_private_stage_directory(HANDLE handle, HANDLE token,
                                           PSID token_user) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PSID group = NULL;
  PACL dacl = NULL;
  ACL_SIZE_INFORMATION acl_information;
  ACCESS_ALLOWED_ACE *ace;
  BYTE system_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_sid_size = sizeof(system_sid);
  DWORD index;
  BOOL saw_user = FALSE;
  BOOL saw_system = FALSE;
  HANDLE impersonation = NULL;
  GENERIC_MAPPING mapping = {
      FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  DWORD desired_access = FILE_ALL_ACCESS;
  DWORD granted_access = 0;
  PRIVILEGE_SET privileges;
  DWORD privilege_size = sizeof(privileges);
  BOOL access_status = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION |
      GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, &group, &dacl,
      NULL, &descriptor);
  BOOL valid = status == ERROR_SUCCESS && owner != NULL && group != NULL &&
      token_user != NULL && EqualSid(owner, token_user) && dacl != NULL &&
      GetSecurityDescriptorControl(descriptor, &control, &revision) &&
      (control & SE_DACL_PROTECTED) != 0 &&
      CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_sid_size) &&
      GetAclInformation(dacl, &acl_information, sizeof(acl_information),
                        AclSizeInformation) &&
      acl_information.AceCount == 2;
  if (valid) {
    for (index = 0; index < acl_information.AceCount; index += 1) {
      if (!GetAce(dacl, index, (void **)&ace) ||
          ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
          (ace->Header.AceFlags & INHERITED_ACE) != 0 ||
          ace->Mask != FILE_ALL_ACCESS) {
        valid = FALSE;
        break;
      }
      if (EqualSid(&ace->SidStart, token_user)) saw_user = TRUE;
      else if (EqualSid(&ace->SidStart, system_sid)) saw_system = TRUE;
      else {
        valid = FALSE;
        break;
      }
    }
    valid = valid && saw_user && saw_system;
  }
  if (valid) {
    MapGenericMask(&desired_access, &mapping);
    valid = DuplicateToken(token, SecurityImpersonation, &impersonation) &&
            AccessCheck(descriptor, impersonation, desired_access, &mapping,
                        &privileges, &privilege_size, &granted_access,
                        &access_status) &&
            access_status && (granted_access & desired_access) == desired_access;
  }
  if (impersonation != NULL) CloseHandle(impersonation);
  if (descriptor != NULL) LocalFree(descriptor);
  return valid;
}

static BOOL dispose_verified_stage_directory(HANDLE directory) {
  FILE_DISPOSITION_INFO_EX disposition = {0};
  FILE_DISPOSITION_INFO legacy = {0};
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (!SetFileInformationByHandle(directory, FileDispositionInfoEx, &disposition,
                                  sizeof(disposition))) {
    legacy.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(directory, FileDispositionInfo, &legacy,
                                    sizeof(legacy))) {
      return FALSE;
    }
  }
  return CloseHandle(directory);
}

static private_stage_directory *create_private_stage_directory(const WCHAR *path,
                                                               BOOL *residue_remains) {
  HANDLE token = NULL;
  DWORD token_size = 0;
  TOKEN_USER *token_user = NULL;
  BYTE system_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_sid_size = sizeof(system_sid);
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE parent = INVALID_HANDLE_VALUE;
  WCHAR *parent_name = NULL;
  private_stage_directory *capability = NULL;
  BOOL directory_created = FALSE;
  BOOL directory_verified = FALSE;
  DWORD acl_size = sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) +
                   2 * SECURITY_MAX_SID_SIZE;

  if (path == NULL || (parent_name = parent_path(path)) == NULL ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &token))
    goto done;
  parent = open_directory_no_reparse(parent_name);
  if (parent == INVALID_HANDLE_VALUE) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &token_size);
  if (token_size == 0 ||
      (token_user = (TOKEN_USER *)publication_allocate(token_size)) == NULL ||
      !GetTokenInformation(token, TokenUser, token_user, token_size, &token_size) ||
      !CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_sid_size) ||
      (dacl = (PACL)publication_allocate(acl_size)) == NULL ||
      !InitializeAcl(dacl, acl_size, ACL_REVISION) ||
      !AddAccessAllowedAceEx(dacl, ACL_REVISION, 0, FILE_ALL_ACCESS,
                            token_user->User.Sid) ||
      !AddAccessAllowedAceEx(dacl, ACL_REVISION, 0, FILE_ALL_ACCESS, system_sid) ||
      !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, token_user->User.Sid, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, dacl, FALSE) ||
      !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED,
                                    SE_DACL_PROTECTED)) {
    goto done;
  }
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = &descriptor;
  attributes.bInheritHandle = FALSE;
  if (!CreateDirectoryW(path, &attributes)) goto done;
  directory_created = TRUE;
  directory = CreateFileW(
      path, READ_CONTROL | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (directory == INVALID_HANDLE_VALUE ||
      !verify_private_stage_directory(directory, token, token_user->User.Sid)) {
    goto done;
  }
  directory_verified = TRUE;
  capability = (private_stage_directory *)publication_allocate(sizeof(*capability));
  if (capability == NULL ||
      !GetFileInformationByHandleEx(directory, FileIdInfo, &capability->identity,
                                    sizeof(capability->identity)) ||
      !GetFileInformationByHandleEx(parent, FileIdInfo, &capability->parent_identity,
                                    sizeof(capability->parent_identity))) {
    publication_free(capability);
    capability = NULL;
    goto done;
  }
  capability->handle = directory;
  capability->parent_handle = parent;
  capability->cleanup_handle = INVALID_HANDLE_VALUE;
  directory = INVALID_HANDLE_VALUE;
  parent = INVALID_HANDLE_VALUE;

done:
  if (capability == NULL && directory_created) {
    if (directory_verified && directory != INVALID_HANDLE_VALUE &&
        dispose_verified_stage_directory(directory)) {
      directory = INVALID_HANDLE_VALUE;
    } else if (residue_remains != NULL) {
      /* Never delete by pathname after setup failed: a handle verified as the
       * just-created private directory is the ownership proof for removal. */
      *residue_remains = TRUE;
    }
  }
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  if (parent != INVALID_HANDLE_VALUE) CloseHandle(parent);
  if (token != NULL) CloseHandle(token);
  publication_free(dacl);
  publication_free(token_user);
  publication_free(parent_name);
  return capability;
}

static publication_result remove_private_stage_file(
    private_stage_directory *capability, const WCHAR *stage_path) {
  (void)capability;
  (void)stage_path;
  /* Legacy private entrypoint is deliberately non-authoritative. Deletion
   * requires the pre-hook retained-handle capability below. */
  return PUBLICATION_UNSUPPORTED;
}

static private_stage_directory *capture_private_stage_cleanup(
    private_stage_directory *capability, const WCHAR *stage_path,
    const FILE_ID_INFO *expected) {
  HANDLE stage_file = INVALID_HANDLE_VALUE;
  FILE_ID_INFO observed;
  if (capability == NULL || capability->handle == INVALID_HANDLE_VALUE ||
      capability->cleanup_handle != INVALID_HANDLE_VALUE || stage_path == NULL ||
      expected == NULL) return NULL;
  /* This is the single pathname-to-authority transition: required rights,
   * all sharing, reparse refusal, and identity proof occur before the hook. */
  stage_file = CreateFileW(stage_path,
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (stage_file == INVALID_HANDLE_VALUE ||
      !GetFileInformationByHandleEx(stage_file, FileIdInfo, &observed, sizeof(observed)) ||
      !file_identity_matches(&observed, expected)) {
    if (stage_file != INVALID_HANDLE_VALUE) CloseHandle(stage_file);
    return NULL;
  }
  capability->cleanup_identity = observed;
  capability->cleanup_handle = stage_file;
  return capability;
}

static publication_result consume_private_stage_cleanup(
    private_stage_directory *capability) {
  FILE_DISPOSITION_INFO_EX disposition = {0};
  FILE_DISPOSITION_INFO legacy = {0};
  publication_result result = PUBLICATION_FAILED;
  if (capability == NULL || capability->cleanup_handle == INVALID_HANDLE_VALUE)
    return PUBLICATION_UNSUPPORTED;
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (SetFileInformationByHandle(capability->cleanup_handle, FileDispositionInfoEx, &disposition,
                                 sizeof(disposition))) {
    result = PUBLICATION_PUBLISHED;
  } else {
    legacy.DeleteFile = TRUE;
    if (SetFileInformationByHandle(capability->cleanup_handle, FileDispositionInfo, &legacy,
                                   sizeof(legacy))) {
      result = PUBLICATION_PUBLISHED;
    } else {
      result = map_windows_error(GetLastError());
    }
  }
  CloseHandle(capability->cleanup_handle);
  capability->cleanup_handle = INVALID_HANDLE_VALUE;
  return result;
}

static publication_result dispose_private_stage_directory(private_stage_directory *capability) {
  FILE_DISPOSITION_INFO_EX disposition = {0};
  FILE_DISPOSITION_INFO legacy = {0};
  if (capability == NULL || capability->handle == INVALID_HANDLE_VALUE) {
    return PUBLICATION_FAILED;
  }
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (SetFileInformationByHandle(capability->handle, FileDispositionInfoEx,
                                 &disposition, sizeof(disposition))) {
    CloseHandle(capability->handle);
    capability->handle = INVALID_HANDLE_VALUE;
    if (capability->parent_handle != INVALID_HANDLE_VALUE) {
      CloseHandle(capability->parent_handle);
      capability->parent_handle = INVALID_HANDLE_VALUE;
    }
    return PUBLICATION_PUBLISHED;
  }
  legacy.DeleteFile = TRUE;
  if (SetFileInformationByHandle(capability->handle, FileDispositionInfo,
                                 &legacy, sizeof(legacy))) {
    CloseHandle(capability->handle);
    capability->handle = INVALID_HANDLE_VALUE;
    if (capability->parent_handle != INVALID_HANDLE_VALUE) {
      CloseHandle(capability->parent_handle);
      capability->parent_handle = INVALID_HANDLE_VALUE;
    }
    return PUBLICATION_PUBLISHED;
  }
  return map_windows_error(GetLastError());
}
#elif defined(__APPLE__)
static publication_result publish_no_replace(int stage_directory, const char *stage_entry,
                                             int destination_directory,
                                             const char *destination_entry) {
  if (renameatx_np(stage_directory, stage_entry, destination_directory,
                   destination_entry, RENAME_EXCL) == 0) return PUBLICATION_PUBLISHED;
  if (errno == EEXIST) return PUBLICATION_COLLISION;
  if (errno == ENOTSUP || errno == EINVAL || errno == EXDEV) return PUBLICATION_UNSUPPORTED;
  return PUBLICATION_FAILED;
}
#else
static publication_result publish_no_replace(int stage_directory, const char *stage_entry,
                                             int destination_directory,
                                             const char *destination_entry) {
#ifdef SYS_renameat2
  long operation = syscall(SYS_renameat2, stage_directory, stage_entry,
                           destination_directory, destination_entry, RENAME_NOREPLACE);
  if (operation == 0) return PUBLICATION_PUBLISHED;
  if (errno == EEXIST) return PUBLICATION_COLLISION;
  if (errno == ENOSYS || errno == EINVAL || errno == ENOTSUP || errno == EOPNOTSUPP ||
      errno == EXDEV) return PUBLICATION_UNSUPPORTED;
  return PUBLICATION_FAILED;
#else
  (void)stage_directory;
  (void)stage_entry;
  (void)destination_directory;
  (void)destination_entry;
  return PUBLICATION_UNSUPPORTED;
#endif
}
#endif

#ifdef PUBLICATION_STANDALONE_TEST
int main(int argc, char **argv) {
  publication_result result;
  if (argc != 3) return 64;
#if defined(_WIN32)
  return 65;
#else
  result = publish_no_replace(AT_FDCWD, argv[1], AT_FDCWD, argv[2]);
  if (result == PUBLICATION_PUBLISHED) {
    puts("published");
    return 0;
  }
  if (result == PUBLICATION_COLLISION) {
    puts("collision");
    return 10;
  }
  puts(result == PUBLICATION_UNSUPPORTED ? "unsupported" : "failed");
  return 11;
#endif
}
#endif
