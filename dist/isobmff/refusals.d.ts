export type HeifRefusal = "malformed-container" | "resource-limits" | "image-sequence" | "unknown-boxes" | "unknown-item-types" | "unsupported-features" | "unsafe-item-layout";
export declare const HEIF_REFUSALS: readonly HeifRefusal[];
/**
 * D-06 mapping table: every internal `IsobmffDeclineClass` to the one coarse public `HeifRefusal`
 * it is reported under. `brand-mismatch` (D-09) maps to `unsupported-features`; `offset-rewrite-
 * overflow` (D-12) maps to `unsafe-item-layout` -- both added here as part of the 62-12 class
 * additions, per the D-06 table.
 */
export declare const HEIF_REFUSAL_BY_DECLINE_CLASS: {
    "box-framing": "malformed-container";
    "meta-not-fullbox": "malformed-container";
    "duplicate-meta": "malformed-container";
    "extent-outside-mdat": "malformed-container";
    "item-graph-invalid": "malformed-container";
    "cap-meta-bytes": "resource-limits";
    "cap-box-count": "resource-limits";
    "cap-box-depth": "resource-limits";
    "cap-buffered-bytes": "resource-limits";
    "sequence-box": "image-sequence";
    "sequence-brand": "image-sequence";
    "top-level-box-not-allowed": "unknown-boxes";
    "unknown-meta-child": "unknown-boxes";
    "unknown-item-type": "unknown-item-types";
    "removable-item-in-idat": "unsupported-features";
    "construction-method-2": "unsupported-features";
    "external-data-reference": "unsupported-features";
    "multiple-mdat": "unsupported-features";
    "meta-handler-not-pict": "unsupported-features";
    "unsupported-box-version": "unsupported-features";
    "brand-mismatch": "unsupported-features";
    "removable-extent-overlap": "unsafe-item-layout";
    "removable-item-referenced": "unsafe-item-layout";
    "surviving-zero-length-extent": "unsafe-item-layout";
    "surviving-offset-width-zero": "unsafe-item-layout";
    "offset-rewrite-overflow": "unsafe-item-layout";
};
//# sourceMappingURL=refusals.d.ts.map