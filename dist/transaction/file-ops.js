import { constants as fsConstants } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
export const NODE_FILE_OPS = Object.freeze({
    createDirectory: (path, mode) => mkdir(path, { mode }),
    open,
    statPath: stat,
    statHandle: (handle) => handle.stat(),
    sync: (handle) => handle.sync(),
    close: (handle) => handle.close(),
    utimes: (handle, atime, mtime) => handle.utimes(atime, mtime),
});
export const DIRECT_FINAL_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL;
export const REOPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
// The Windows staging directory is an opaque native capability with an
// owner-only ACL. Node's POSIX O_NOFOLLOW flag is not a supported Windows
// reopen contract and produces an unusable fd on Windows ARM64.
export const WINDOWS_REOPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_NONBLOCK;
export const STAGE_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
export const DESTINATION_DIRECTORY_FLAGS = STAGE_DIRECTORY_FLAGS;
//# sourceMappingURL=file-ops.js.map