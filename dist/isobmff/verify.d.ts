import type { FileHandle } from "node:fs/promises";
import type { Result } from "../types.js";
import { type IsobmffAdmission } from "./admission.js";
export declare function verifyIsobmffOutput(sourceHandle: FileHandle, admission: IsobmffAdmission, destinationHandle: FileHandle, destinationSize: number, destinationPath: string, _preserveOrientation: boolean, _preserveColorProfile: boolean, _preserveResolution: boolean, _expectedOrientation: number | undefined, signal?: AbortSignal): Promise<Result<void>>;
//# sourceMappingURL=verify.d.ts.map