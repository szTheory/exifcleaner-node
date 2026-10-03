import { createIsobmffHandler } from "./isobmff-handler.js";
import {
  ICC_PRESERVATION_POLICY_ID,
  MAX_PROFILE_BYTES,
} from "../metadata/icc_admission.js";
import {
  ISOBMFF_MAX_BOX_COUNT,
  ISOBMFF_MAX_BOX_DEPTH,
  ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
  ISOBMFF_MAX_META_BYTES,
} from "../isobmff/caps.js";
import type { FormatCapabilities, AvifCapabilities } from "../types.js";

// Registered AVIF handler module (62.1-07, D-03/D-05). `avifHandler` below is added to
// `src/admission/registry.ts`'s `HANDLERS` in the same atomic commit as its `QUALIFICATION_FORMATS`
// entry, the widened `NativeFormat`/`FormatCapabilities` unions and the public contract re-pin.

/**
 * D-10: the AVIF handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"avif"` and a D-10 staging name below. The
 * registered `avifHandler` passes the real `AVIF_CAPABILITY` literal; tests may still pass a
 * borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
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

/**
 * D-05: the published AVIF capability. `brands` equals the classifier's `[AVIF_BRAND]`, `refuses`
 * equals `HEIF_REFUSALS` in order (src/isobmff/refusals.ts), and `limits` are the caps.ts
 * constants; all three are pinned by value in tests/isobmff_registration.test.ts.
 */
export const AVIF_CAPABILITY: AvifCapabilities = Object.freeze({
  format: "avif" as const,
  mimeTypes: Object.freeze(["image/avif"] as const),
  extensions: Object.freeze([".avif"] as const),
  brands: Object.freeze(["avif"] as const),
  inspect: true as const,
  sanitize: true as const,
  preserves: Object.freeze({
    orientation: true as const,
    colorProfile: true as const,
    timestamps: true as const,
    resolution: true as const,
    imagePayload: true as const,
    animationPayload: false as const,
  }),
  validation: Object.freeze({
    container: "full" as const,
    codecBitstream: "not-decoded" as const,
  }),
  colorProfile: Object.freeze({
    policy: ICC_PRESERVATION_POLICY_ID,
    preservation: "preserve-if-present" as const,
    versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"] as const),
    classes: Object.freeze(["scnr", "mntr"] as const),
    spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "] as const),
    maxProfileBytes: MAX_PROFILE_BYTES,
    maxTagCount: 4_096,
  }),
  limits: Object.freeze({
    maxMetaBytes: ISOBMFF_MAX_META_BYTES,
    maxBoxCount: ISOBMFF_MAX_BOX_COUNT,
    maxBoxDepth: ISOBMFF_MAX_BOX_DEPTH,
    maxBufferedBytesTotal: ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
  }),
  refuses: Object.freeze([
    "malformed-container",
    "resource-limits",
    "image-sequence",
    "unknown-boxes",
    "unknown-item-types",
    "unsupported-features",
    "unsafe-item-layout",
  ] as const),
  removes: Object.freeze(["EXIF", "XMP", "ICC", "C2PA"] as const),
  detection: "magic" as const,
});

export const avifHandler = createAvifHandler(AVIF_CAPABILITY);
