import type { FileHandle } from "node:fs/promises";
import type { Result, SanitizeOptions, SanitizeResult } from "../types.js";
import type { RegisteredHandler } from "../admission/registry.js";
import type { WebpAdmission, WebpOutputChunk } from "../admission/webp-handler.js";
import { type FileOps } from "./file-ops.js";
import { type SourceSnapshot } from "./identity.js";
import { type NativeStageFileIdentity, type TerminalCleanupRecord } from "./native-publication.js";
export interface SafeTransactionInput {
    readonly sourceHandle: FileHandle;
    readonly sourceSnapshot: SourceSnapshot;
    readonly sourceMode: number;
    readonly handler: RegisteredHandler;
    readonly admission: WebpAdmission;
    readonly plan: readonly WebpOutputChunk[];
    readonly orientation: number | undefined;
    readonly options: SanitizeOptions;
    readonly fileOps: FileOps;
    /** Private test-only scheduling seam immediately before the one native call. */
    readonly beforePublish?: (paths: {
        readonly stageDirectoryPath: string;
        readonly stagePath: string;
    }) => void | Promise<void>;
    /** Private test-only seam before bounded terminal-stage finalization. */
    readonly beforeStageFinalization?: (paths: {
        readonly stageDirectoryPath: string;
        readonly stagePath: string;
    }) => void | Readonly<{
        observationSequence: number;
        injectionSequence: number;
        identityBefore: NativeStageFileIdentity | null;
        sha256Before: string | null;
        identityAfter: NativeStageFileIdentity | null;
        sha256After: string | null;
    }> | Promise<void | Readonly<{
        observationSequence: number;
        injectionSequence: number;
        identityBefore: NativeStageFileIdentity | null;
        sha256Before: string | null;
        identityAfter: NativeStageFileIdentity | null;
        sha256After: string | null;
    }>>;
    /** Private installed-evidence sink; never threaded through sanitizeFile. */
    readonly onTerminalCleanupRecord?: (record: TerminalCleanupRecord) => void;
    /** Private platform seam for deterministic capability-finalization coverage. */
    readonly platform?: NodeJS.Platform;
}
export declare function runSafeTransaction(input: SafeTransactionInput): Promise<Result<SanitizeResult>>;
//# sourceMappingURL=safe-transaction.d.ts.map