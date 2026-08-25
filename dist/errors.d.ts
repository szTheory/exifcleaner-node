import type { JsonSafeCause, MetadataError, MetadataErrorDetails, NativeWriteState, FallbackProof } from "./types.js";
export declare function jsonSafeCause(cause: unknown): JsonSafeCause;
export declare function isNodeErrorCode(cause: unknown, code: string): boolean;
export declare function aborted(path?: string): MetadataError;
export declare function requestError<T extends MetadataErrorDetails>(error: T): T & FallbackProof;
export declare function sourceOpenError<T extends MetadataErrorDetails>(error: T): T & FallbackProof;
export declare function admissionDecline<T extends MetadataErrorDetails>(error: T): T & FallbackProof;
export declare function executionError<T extends MetadataErrorDetails>(error: T, nativeWrite: NativeWriteState): T & FallbackProof;
//# sourceMappingURL=errors.d.ts.map