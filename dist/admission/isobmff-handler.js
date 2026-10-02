import { admitIsobmff } from "../isobmff/admission.js";
import { classifyIsobmffBrand } from "../isobmff/brand.js";
import { classifyIsobmffAdmissionFailure } from "../isobmff/errors.js";
import { buildIsobmffOutputPlan, checkIsobmffOutputPlan, } from "../isobmff/plan.js";
import { verifyIsobmffOutput } from "../isobmff/verify.js";
import { writeIsobmffOutput } from "../isobmff/writer.js";
export function createIsobmffHandler(options) {
    const { brand, stagingFileName, capability } = options;
    return Object.freeze({
        capability,
        stagingFileName,
        matches(magic) {
            return classifyIsobmffBrand(magic) === brand;
        },
        async admit(handle, size, signal) {
            return admitIsobmff(handle, size, signal);
        },
        inspect(admission) {
            return {
                format: capability.format,
                entries: admission.entries,
                warnings: admission.warnings,
            };
        },
        buildOutputPlan: buildIsobmffOutputPlan,
        checkOutputPlan(plan) {
            return checkIsobmffOutputPlan(plan);
        },
        classifyAdmissionFailure(cause) {
            return classifyIsobmffAdmissionFailure(cause);
        },
        async writeOutput(source, destination, plan, signal) {
            return writeIsobmffOutput(source, destination, plan, signal);
        },
        async verifyOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, preserveResolution, expectedOrientation, signal) {
            return verifyIsobmffOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, preserveResolution, expectedOrientation, signal);
        },
    });
}
//# sourceMappingURL=isobmff-handler.js.map