import type { Capabilities, Inspection, InspectOptions, Result, SanitizeOptions, SanitizeResult } from "./types.js";
export declare function getCapabilities(): Capabilities;
export declare function inspectFile(filePath: string, options?: InspectOptions): Promise<Result<Inspection>>;
export declare function sanitizeFile(options: SanitizeOptions): Promise<Result<SanitizeResult>>;
//# sourceMappingURL=engine.d.ts.map