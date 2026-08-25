import type { Stats } from "node:fs";
export interface SourceSnapshot {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly atime: Date;
    readonly mtime: Date;
}
export interface FileIdentity {
    readonly dev: number;
    readonly ino: number;
}
export declare function snapshotSource(stats: Stats): SourceSnapshot;
export declare function identityOf(stats: Stats): FileIdentity;
export declare function identityMatches(expected: FileIdentity, actual: Stats): boolean;
export declare function sourceSnapshotMatches(expected: SourceSnapshot, actual: Stats): boolean;
//# sourceMappingURL=identity.d.ts.map