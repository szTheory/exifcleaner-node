import { createIsobmffHandler } from "./isobmff-handler.js";
import type { FormatCapabilities, AvifCapabilities } from "../types.js";
/**
 * D-10: the AVIF handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"avif"` and a D-10 staging name below. The
 * registered `avifHandler` passes the real `AVIF_CAPABILITY` literal; tests may still pass a
 * borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export declare function createAvifHandler(capability: FormatCapabilities): ReturnType<typeof createIsobmffHandler>;
/**
 * D-05: the published AVIF capability. `brands` equals the classifier's `[AVIF_BRAND]`, `refuses`
 * equals `HEIF_REFUSALS` in order (src/isobmff/refusals.ts), and `limits` are the caps.ts
 * constants; all three are pinned by value in tests/isobmff_registration.test.ts.
 */
export declare const AVIF_CAPABILITY: AvifCapabilities;
export declare const avifHandler: import("./handler.js").FormatHandler<import("../isobmff/admission.js").IsobmffAdmission, import("../isobmff/plan.js").IsobmffOutputPlan>;
//# sourceMappingURL=avif-handler.d.ts.map