import type { IsobmffAdmission } from "./admission.js";
export type IsobmffOutputPlanPart = {
    readonly kind: "copy";
    readonly sourceOffset: number;
    readonly length: number;
} | {
    readonly kind: "bytes";
    readonly data: Buffer;
};
export interface IsobmffOutputPlan {
    readonly parts: readonly IsobmffOutputPlanPart[];
    readonly removedItemIds: readonly number[];
    readonly declineReason?: string;
}
export declare function buildIsobmffOutputPlan(admission: IsobmffAdmission, _preserveOrientation: boolean, _preserveColorProfile: boolean, _preserveResolution: boolean, _orientation: number | undefined): IsobmffOutputPlan;
export declare function checkIsobmffOutputPlan(plan: IsobmffOutputPlan): string | undefined;
//# sourceMappingURL=plan.d.ts.map