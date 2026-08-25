import { constants as fsConstants } from "node:fs";
import { lstat, open, rm, stat } from "node:fs/promises";
export const NODE_FILE_OPS = Object.freeze({
    open,
    statPath: stat,
    lstatPath: lstat,
    statHandle: (handle) => handle.stat(),
    sync: (handle) => handle.sync(),
    close: (handle) => handle.close(),
    utimes: (handle, atime, mtime) => handle.utimes(atime, mtime),
    remove: (path) => rm(path, { force: true }),
});
export const DIRECT_FINAL_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL;
export const REOPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
//# sourceMappingURL=file-ops.js.map