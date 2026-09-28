export declare const ICC_SEGMENT_IDENTIFIER = "ICC_PROFILE";
/**
 * Reassembles a multi-segment JPEG APP2 ICC_PROFILE profile from its raw APPn
 * payloads (identifier prefix included, as buffered by `parseJpeg`). Segments may
 * arrive in any order; they are concatenated in sequence order, not payload-array
 * order (D-01 edge: out-of-order segments still reassemble correctly).
 */
export declare function reassembleIccSegments(payloads: readonly Buffer[]): Buffer;
//# sourceMappingURL=icc.d.ts.map