import { createIsobmffHandler } from "./isobmff-handler.js";
import type { FormatCapabilities } from "../types.js";
/**
 * D-10: the AVIF handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"avif"` and a D-10 staging name below. The
 * capability is supplied by the caller -- 62.1-07 passes the real `AvifCapabilities` literal; this
 * plan's tests pass a borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export declare function createAvifHandler(capability: FormatCapabilities): ReturnType<typeof createIsobmffHandler>;
//# sourceMappingURL=avif-handler.d.ts.map