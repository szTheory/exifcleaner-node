import type { IsobmffAdmission } from "./admission.js";
import { type MinimalExifTags } from "../metadata/exif.js";
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
/**
 * D-13: the minimal IFD0 tag set the writer may synthesize into item k -- orientation only when
 * `preserveOrientation` requested a valid one, resolution only from k's own IFD0 (`admission.
 * sourceResolution`, already scoped to k by `findExifSourceItemId`, admission.ts) when
 * `preserveResolution` requested it. `undefined` when neither tag applies (nothing to write).
 * Mirrors `src/admission/jpeg-handler.ts`'s `computeMinimalExifTags` exactly.
 */
export declare function computeIsobmffMinimalExifTags(admission: IsobmffAdmission, preserveOrientation: boolean, preserveResolution: boolean, orientation: number | undefined): MinimalExifTags | undefined;
export declare function buildIsobmffOutputPlan(admission: IsobmffAdmission, preserveOrientation: boolean, _preserveColorProfile: boolean, preserveResolution: boolean, orientation: number | undefined): IsobmffOutputPlan;
export declare function checkIsobmffOutputPlan(plan: IsobmffOutputPlan): string | undefined;
//# sourceMappingURL=plan.d.ts.map