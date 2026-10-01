import type { AdmissionDeclineDetail } from "../admission/handler.js";
export type IsobmffDeclineClass = "removable-item-in-idat" | "construction-method-2" | "external-data-reference" | "multiple-mdat" | "unknown-item-type" | "sequence-box" | "sequence-brand" | "unknown-meta-child" | "top-level-box-not-allowed" | "meta-handler-not-pict" | "unsupported-box-version" | "removable-extent-overlap" | "removable-item-referenced" | "surviving-zero-length-extent" | "surviving-offset-width-zero" | "cap-meta-bytes" | "cap-box-count" | "cap-box-depth" | "cap-buffered-bytes" | "extent-outside-mdat" | "meta-not-fullbox" | "duplicate-meta" | "box-framing" | "item-graph-invalid";
export declare const ISOBMFF_DECLINE_CLASSES: readonly IsobmffDeclineClass[];
/** The three public codes this engine can report (a subset of `MetadataErrorDetails["code"]`). */
export type IsobmffPublicKind = "unsupported-format" | "unsafe-structure" | "malformed-file";
/**
 * Class -> public-code mapping (D-12). Every `unsupported-format` entry is a D3 "not admitted"
 * shape; every `unsafe-structure` entry is a D5 safety violation or a cap breach (PNG D-25
 * precedent: a cap breach is always `unsafe-structure`, never remapped to ICC policy); every
 * `malformed-file` entry is a structural/framing defect that makes the file unreadable as
 * ISOBMFF at all.
 */
export declare const DECLINE_CLASS_TO_KIND: {
    "removable-item-in-idat": "unsupported-format";
    "construction-method-2": "unsupported-format";
    "external-data-reference": "unsupported-format";
    "multiple-mdat": "unsupported-format";
    "unknown-item-type": "unsupported-format";
    "sequence-box": "unsupported-format";
    "sequence-brand": "unsupported-format";
    "unknown-meta-child": "unsupported-format";
    "top-level-box-not-allowed": "unsupported-format";
    "meta-handler-not-pict": "unsupported-format";
    "unsupported-box-version": "unsupported-format";
    "removable-extent-overlap": "unsafe-structure";
    "removable-item-referenced": "unsafe-structure";
    "surviving-zero-length-extent": "unsafe-structure";
    "surviving-offset-width-zero": "unsafe-structure";
    "cap-meta-bytes": "unsafe-structure";
    "cap-box-count": "unsafe-structure";
    "cap-box-depth": "unsafe-structure";
    "cap-buffered-bytes": "unsafe-structure";
    "extent-outside-mdat": "malformed-file";
    "meta-not-fullbox": "malformed-file";
    "duplicate-meta": "malformed-file";
    "box-framing": "malformed-file";
    "item-graph-invalid": "malformed-file";
};
export interface IsobmffLimitContext {
    readonly cap: string;
    readonly size: number;
    readonly limit: number;
}
export declare class IsobmffStructureError extends Error {
    readonly kind: "unsupported-format" | "unsafe-structure" | "malformed-file";
    readonly declineClass: IsobmffDeclineClass;
    readonly limit?: IsobmffLimitContext;
    constructor(declineClass: IsobmffDeclineClass, message: string, limit?: IsobmffLimitContext);
}
/**
 * D-12's explicit carve-out: the ICC-preservation failure is never an `IsobmffStructureError`
 * (the engine already declines it as `unsupported-feature`/`color-profile-preservation` once
 * `admission.colorProfile` is set, src/engine.ts:186-198), so this classifier never needs (and
 * must never grow) ICC-specific branching the way PNG's `classifyAdmissionFailure` does (PNG
 * D-25: a cap breach must never be misreported as an ICC policy decline). It is a direct
 * `cause.kind`/`cause.message` passthrough for every `IsobmffStructureError`, and `undefined`
 * for anything else.
 */
export declare function classifyIsobmffAdmissionFailure(cause: unknown): AdmissionDeclineDetail | undefined;
//# sourceMappingURL=errors.d.ts.map