import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

export interface FileOps {
  readonly createDirectory: (path: string, mode: number) => Promise<void>;
  readonly open: (
    path: string,
    flags: number,
    mode?: number,
  ) => Promise<FileHandle>;
  readonly statPath: (path: string) => Promise<Stats>;
  readonly lstatPath: (path: string) => Promise<Stats>;
  readonly statHandle: (handle: FileHandle) => Promise<Stats>;
  readonly sync: (handle: FileHandle) => Promise<void>;
  readonly close: (handle: FileHandle) => Promise<void>;
  readonly utimes: (
    handle: FileHandle,
    atime: Date,
    mtime: Date,
  ) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export const NODE_FILE_OPS: FileOps = Object.freeze({
  createDirectory: (path: string, mode: number) => mkdir(path, { mode }),
  open,
  statPath: stat,
  lstatPath: lstat,
  statHandle: (handle: FileHandle) => handle.stat(),
  sync: (handle: FileHandle) => handle.sync(),
  close: (handle: FileHandle) => handle.close(),
  utimes: (handle: FileHandle, atime: Date, mtime: Date) =>
    handle.utimes(atime, mtime),
  remove: (path: string) => rm(path, { force: true }),
});

export const DIRECT_FINAL_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL;
export const REOPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
export const WINDOWS_REOPEN_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
export const STAGE_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
export const DESTINATION_DIRECTORY_FLAGS = STAGE_DIRECTORY_FLAGS;
