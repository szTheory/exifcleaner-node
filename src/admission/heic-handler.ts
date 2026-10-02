import { createIsobmffHandler } from "./isobmff-handler.js";
import type { FormatCapabilities } from "../types.js";

// Unregistered HEIC handler module (Phase 62, D-02 shape (c)). Never imported by
// `src/admission/registry.ts` in this plan -- registration (adding it to `HANDLERS`, wiring the
// real `HeicCapabilities` literal, and the `QUALIFICATION_FORMATS` entry it requires under D-03)
// happens only in 62.1-07's atomic commit. Until then this module is reachable only through the
// test seam (`setRegisteredHandlersForTests`), never through the public `dist/index.js` import
// closure (`tests/isobmff_surface.test.ts`).

/**
 * D-10: the HEIC handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"heic"` and a D-10 staging name below. The
 * capability is supplied by the caller -- 62.1-07 passes the real `HeicCapabilities` literal; this
 * plan's tests pass a borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export function createHeicHandler(
  capability: FormatCapabilities,
): ReturnType<typeof createIsobmffHandler> {
  return createIsobmffHandler({
    brand: "heic",
    stagingFileName: "output.heic",
    capability,
  });
}
