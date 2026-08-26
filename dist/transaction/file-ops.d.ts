import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
export interface FileOps {
    readonly createDirectory: (path: string, mode: number) => Promise<void>;
    readonly open: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
    readonly statPath: (path: string) => Promise<Stats>;
    readonly lstatPath: (path: string) => Promise<Stats>;
    readonly statHandle: (handle: FileHandle) => Promise<Stats>;
    readonly sync: (handle: FileHandle) => Promise<void>;
    readonly close: (handle: FileHandle) => Promise<void>;
    readonly utimes: (handle: FileHandle, atime: Date, mtime: Date) => Promise<void>;
    readonly remove: (path: string) => Promise<void>;
}
export declare const NODE_FILE_OPS: FileOps;
export declare const DIRECT_FINAL_FLAGS: number;
export declare const REOPEN_FLAGS: number;
export declare const STAGE_DIRECTORY_FLAGS: number;
//# sourceMappingURL=file-ops.d.ts.map