import { createIsobmffHandler } from "./isobmff-handler.js";
import type { FormatCapabilities, HeicCapabilities } from "../types.js";
/**
 * D-10: the HEIC handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"heic"` and a D-10 staging name below. The
 * registered `heicHandler` passes the real `HEIC_CAPABILITY` literal; tests may still pass a
 * borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export declare function createHeicHandler(capability: FormatCapabilities): ReturnType<typeof createIsobmffHandler>;
/**
 * D-05: the published HEIC capability. `brands` equals the classifier's `HEIC_BRANDS`, `refuses`
 * equals `HEIF_REFUSALS` in order (src/isobmff/refusals.ts), and `limits` are the caps.ts
 * constants; all three are pinned by value in tests/isobmff_registration.test.ts.
 */
export declare const HEIC_CAPABILITY: HeicCapabilities;
export declare const heicHandler: import("./handler.js").FormatHandler<import("../isobmff/admission.js").IsobmffAdmission, import("../isobmff/plan.js").IsobmffOutputPlan>;
//# sourceMappingURL=heic-handler.d.ts.map