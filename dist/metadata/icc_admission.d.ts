import type { ColorProfileAdmissionReason } from "../types.js";
export declare const ICC_PRESERVATION_POLICY_ID = "icc-structural-v0.2";
export interface IccTagRange {
    readonly signature: number;
    readonly offset: number;
    readonly size: number;
}
export type IccAdmissionResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: ColorProfileAdmissionReason;
    readonly detail: string;
};
/**
 * Bounded structural admission only. It does not evaluate ICC semantics, CMM safety,
 * or color correctness, and never transforms or returns payload bytes.
 */
export declare function validateIccForPreservation(payload: Buffer): IccAdmissionResult;
//# sourceMappingURL=icc_admission.d.ts.map