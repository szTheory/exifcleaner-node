import { admitIsobmff } from "../isobmff/admission.js";
import { classifyIsobmffBrand } from "../isobmff/brand.js";
import { classifyIsobmffAdmissionFailure, IsobmffStructureError, } from "../isobmff/errors.js";
import { buildIsobmffOutputPlan, checkIsobmffOutputPlan, } from "../isobmff/plan.js";
import { verifyIsobmffOutput } from "../isobmff/verify.js";
import { writeIsobmffOutput } from "../isobmff/writer.js";
/**
 * D-09(b): re-classifies the parsed `ftyp` brand set the SAME way `matches` does at selection
 * (`classifyIsobmffBrand`), but over `admitIsobmff`'s own already-parsed `model.majorBrand` /
 * `model.compatibleBrands` rather than a fresh magic-byte read -- catching a file swapped between
 * selection and admission (a TOCTOU race: `matches` saw one brand, the bytes `admitIsobmff`
 * actually parsed are a different file's). A synthetic minimal `ftyp` buffer is built from the
 * already-parsed strings (never re-reading the file) and handed to the SAME classifier `matches`
 * uses, so both checks share one brand-classification rule, never two divergent copies of it.
 */
function reclassifyParsedBrands(majorBrand, compatibleBrands) {
    const size = 16 + compatibleBrands.length * 4;
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(size, 0);
    bytes.write("ftyp", 4, 4, "ascii");
    bytes.write(majorBrand, 8, 4, "ascii");
    compatibleBrands.forEach((compatibleBrand, index) => {
        bytes.write(compatibleBrand, 16 + index * 4, 4, "ascii");
    });
    return classifyIsobmffBrand(bytes);
}
export function createIsobmffHandler(options) {
    const { brand, stagingFileName, capability } = options;
    return Object.freeze({
        capability,
        stagingFileName,
        matches(magic) {
            return classifyIsobmffBrand(magic) === brand;
        },
        async admit(handle, size, signal) {
            const admission = await admitIsobmff(handle, size, signal);
            const reclassified = reclassifyParsedBrands(admission.model.majorBrand, admission.model.compatibleBrands);
            if (reclassified !== brand) {
                throw new IsobmffStructureError("brand-mismatch", `Parsed brand classification "${reclassified}" does not match this handler's own brand "${brand}" (D-09b).`);
            }
            return admission;
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