import { createIsobmffHandler } from "./isobmff-handler.js";
import type { FormatCapabilities } from "../types.js";

// Unregistered AVIF handler module (Phase 62, D-02 shape (c)). Never imported by
// `src/admission/registry.ts` in this plan -- registration (adding it to `HANDLERS`, wiring the
// real `AvifCapabilities` literal, and the `QUALIFICATION_FORMATS` entry it requires under D-03)
// happens only in 62.1-07's atomic commit. Until then this module is reachable only through the
// test seam (`setRegisteredHandlersForTests`), never through the public `dist/index.js` import
// closure (`tests/isobmff_surface.test.ts`).

/**
 * D-10: the AVIF handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"avif"` and a D-10 staging name below. The
 * capability is supplied by the caller -- 62.1-07 passes the real `AvifCapabilities` literal; this
 * plan's tests pass a borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export function createAvifHandler(
  capability: FormatCapabilities,
): ReturnType<typeof createIsobmffHandler> {
  return createIsobmffHandler({
    brand: "avif",
    stagingFileName: "output.avif",
    capability,
  });
}
