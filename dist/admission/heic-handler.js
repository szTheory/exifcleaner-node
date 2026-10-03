import { createIsobmffHandler } from "./isobmff-handler.js";
import { ICC_PRESERVATION_POLICY_ID, MAX_PROFILE_BYTES, } from "../metadata/icc_admission.js";
import { ISOBMFF_MAX_BOX_COUNT, ISOBMFF_MAX_BOX_DEPTH, ISOBMFF_MAX_BUFFERED_BYTES_TOTAL, ISOBMFF_MAX_META_BYTES, } from "../isobmff/caps.js";
// Registered HEIC handler module (62.1-07, D-03/D-05). `heicHandler` below is added to
// `src/admission/registry.ts`'s `HANDLERS` in the same atomic commit as its `QUALIFICATION_FORMATS`
// entry, the widened `NativeFormat`/`FormatCapabilities` unions and the public contract re-pin.
/**
 * D-10: the HEIC handler is a thin factory over the shared ISOBMFF engine
 * (`createIsobmffHandler`), frozen with brand `"heic"` and a D-10 staging name below. The
 * registered `heicHandler` passes the real `HEIC_CAPABILITY` literal; tests may still pass a
 * borrowed capability (`createIsobmffWriterHandlerForTests` precedent).
 */
export function createHeicHandler(capability) {
    return createIsobmffHandler({
        brand: "heic",
        stagingFileName: "output.heic",
        capability,
    });
}
/**
 * D-05: the published HEIC capability. `brands` equals the classifier's `HEIC_BRANDS`, `refuses`
 * equals `HEIF_REFUSALS` in order (src/isobmff/refusals.ts), and `limits` are the caps.ts
 * constants; all three are pinned by value in tests/isobmff_registration.test.ts.
 */
export const HEIC_CAPABILITY = Object.freeze({
    format: "heic",
    mimeTypes: Object.freeze(["image/heic", "image/heif"]),
    extensions: Object.freeze([".heic", ".heif"]),
    brands: Object.freeze(["heic", "heix", "heim", "heis"]),
    inspect: true,
    sanitize: true,
    preserves: Object.freeze({
        orientation: true,
        colorProfile: true,
        timestamps: true,
        resolution: true,
        imagePayload: true,
        animationPayload: false,
    }),
    validation: Object.freeze({
        container: "full",
        codecBitstream: "not-decoded",
    }),
    colorProfile: Object.freeze({
        policy: ICC_PRESERVATION_POLICY_ID,
        preservation: "preserve-if-present",
        versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"]),
        classes: Object.freeze(["scnr", "mntr"]),
        spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "]),
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
    ]),
    removes: Object.freeze(["EXIF", "XMP", "ICC", "C2PA"]),
    detection: "magic",
});
export const heicHandler = createHeicHandler(HEIC_CAPABILITY);
//# sourceMappingURL=heic-handler.js.map