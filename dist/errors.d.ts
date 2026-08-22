import type { JsonSafeCause, MetadataError } from "./types.js";
export declare function jsonSafeCause(cause: unknown): JsonSafeCause;
export declare function isNodeErrorCode(cause: unknown, code: string): boolean;
export declare function aborted(path?: string): MetadataError;
//# sourceMappingURL=errors.d.ts.map