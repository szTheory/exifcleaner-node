import type { Result } from "./types.js";
export declare function ok<T>(value: T): Result<T, never>;
export declare function err<E>(error: E): Result<never, E>;
//# sourceMappingURL=result.d.ts.map