import { type IsobmffAdmission } from "../isobmff/admission.js";
import { type IsobmffOutputPlan } from "../isobmff/plan.js";
import type { FormatHandler } from "./handler.js";
import type { FormatCapabilities } from "../types.js";
export interface CreateIsobmffHandlerOptions {
    readonly brand: "heic" | "avif";
    readonly stagingFileName: string;
    readonly capability: FormatCapabilities;
}
export declare function createIsobmffHandler(options: CreateIsobmffHandlerOptions): FormatHandler<IsobmffAdmission, IsobmffOutputPlan>;
//# sourceMappingURL=isobmff-handler.d.ts.map