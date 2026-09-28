import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
export interface FileOps {
    readonly createDirectory: (path: string, mode: number) => Promise<void>;
    readonly open: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
    readonly statPath: (path: string) => Promise<Stats>;
    readonly statHandle: (handle: FileHandle) => Promise<Stats>;
    readonly sync: (handle: FileHandle) => Promise<void>;
    readonly close: (handle: FileHandle) => Promise<void>;
    readonly utimes: (handle: FileHandle, atime: Date, mtime: Date) => Promise<void>;
    /**
     * Removes a single, already-empty directory by pathname (non-recursive
     * `rmdir`, no `recursive` option, never `rm`). The OS refuses this for a
     * non-empty directory -- that refusal is load-bearing, not incidental.
     */
    readonly removeDirectory: (path: string) => Promise<void>;
}
export declare const NODE_FILE_OPS: FileOps;
export declare const DIRECT_FINAL_FLAGS: number;
export declare const REOPEN_FLAGS: number;
export declare const WINDOWS_REOPEN_FLAGS: number;
export declare const STAGE_DIRECTORY_FLAGS: number;
export declare const DESTINATION_DIRECTORY_FLAGS: number;
//# sourceMappingURL=file-ops.d.ts.map