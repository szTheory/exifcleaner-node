import type { FileHandle } from "node:fs/promises";
import type { IsobmffOutputPlan } from "./plan.js";
export declare function writeIsobmffOutput(source: FileHandle, destination: FileHandle, plan: IsobmffOutputPlan, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=writer.d.ts.map