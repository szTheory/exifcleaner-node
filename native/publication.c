/*
 * Private native publication boundary.  The OS operation below is the only
 * publication authority: no pathname observation or fallback is a success
 * condition.  The standalone entrypoint is compiled only by the test harness.
 */
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#elif defined(__APPLE__)
#include <errno.h>
#include <stdio.h>
#include <sys/attr.h>
#include <unistd.h>
#else
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
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
} private_stage_directory;

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

static publication_result publish_no_replace(const wchar_t *stage,
                                             const wchar_t *destination) {
  HANDLE stage_handle;
  FILE_RENAME_INFO *rename_info;
  size_t destination_bytes;
  DWORD allocation_size;
  publication_result result;

  if (stage == NULL || destination == NULL || wcschr(destination, L'\0') == NULL) {
    return PUBLICATION_FAILED;
  }
  destination_bytes = wcslen(destination) * sizeof(wchar_t);
  if (destination_bytes > MAXDWORD - FIELD_OFFSET(FILE_RENAME_INFO, FileName)) {
    return PUBLICATION_FAILED;
  }
  stage_handle = CreateFileW(stage, DELETE | SYNCHRONIZE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (stage_handle == INVALID_HANDLE_VALUE) {
    return map_windows_error(GetLastError());
  }
  allocation_size = (DWORD)(FIELD_OFFSET(FILE_RENAME_INFO, FileName) + destination_bytes);
  rename_info = (FILE_RENAME_INFO *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                               allocation_size);
  if (rename_info == NULL) {
    CloseHandle(stage_handle);
    return PUBLICATION_FAILED;
  }
  rename_info->Flags = 0;
  rename_info->RootDirectory = NULL;
  rename_info->FileNameLength = (DWORD)destination_bytes;
  memcpy(rename_info->FileName, destination, destination_bytes);
  result = SetFileInformationByHandle(stage_handle, FileRenameInfoEx, rename_info,
                                      allocation_size)
               ? PUBLICATION_PUBLISHED
               : map_windows_error(GetLastError());
  HeapFree(GetProcessHeap(), 0, rename_info);
  CloseHandle(stage_handle);
  return result;
}

/* The directory capability is intentionally opaque to callers. */
static BOOL verify_private_stage_directory(HANDLE handle, PSID token_user) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION |
      DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &descriptor);
  BOOL valid = status == ERROR_SUCCESS && owner != NULL && token_user != NULL &&
      EqualSid(owner, token_user) && dacl != NULL &&
      GetSecurityDescriptorControl(descriptor, &control, &revision) &&
      (control & SE_DACL_PROTECTED) != 0;
  if (descriptor != NULL) LocalFree(descriptor);
  return valid;
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
    return PUBLICATION_PUBLISHED;
  }
  legacy.DeleteFile = TRUE;
  if (SetFileInformationByHandle(capability->handle, FileDispositionInfo,
                                 &legacy, sizeof(legacy))) {
    return PUBLICATION_PUBLISHED;
  }
  return map_windows_error(GetLastError());
}
#elif defined(__APPLE__)
static publication_result publish_no_replace(const char *stage, const char *destination) {
  if (renamex_np(stage, destination, RENAME_EXCL) == 0) return PUBLICATION_PUBLISHED;
  if (errno == EEXIST) return PUBLICATION_COLLISION;
  if (errno == ENOTSUP || errno == EINVAL || errno == EXDEV) return PUBLICATION_UNSUPPORTED;
  return PUBLICATION_FAILED;
}
#else
static publication_result publish_no_replace(const char *stage, const char *destination) {
  long operation = syscall(SYS_renameat2, AT_FDCWD, stage, AT_FDCWD, destination,
                           RENAME_NOREPLACE);
  if (operation == 0) return PUBLICATION_PUBLISHED;
  if (errno == EEXIST) return PUBLICATION_COLLISION;
  if (errno == ENOSYS || errno == EINVAL || errno == ENOTSUP || errno == EOPNOTSUPP ||
      errno == EXDEV) return PUBLICATION_UNSUPPORTED;
  return PUBLICATION_FAILED;
}
#endif

#ifdef PUBLICATION_STANDALONE_TEST
int main(int argc, char **argv) {
  publication_result result;
  if (argc != 3) return 64;
#if defined(_WIN32)
  return 65;
#else
  result = publish_no_replace(argv[1], argv[2]);
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
