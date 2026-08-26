import type { FileHandle } from "node:fs/promises";
import type { Result, SanitizeOptions, SanitizeResult } from "../types.js";
import type { RegisteredHandler } from "../admission/registry.js";
import type { WebpAdmission, WebpOutputChunk } from "../admission/webp-handler.js";
import { type FileOps } from "./file-ops.js";
import { type SourceSnapshot } from "./identity.js";
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
    readonly beforePublish?: () => void | Promise<void>;
}
export declare function runSafeTransaction(input: SafeTransactionInput): Promise<Result<SanitizeResult>>;
//# sourceMappingURL=safe-transaction.d.ts.map