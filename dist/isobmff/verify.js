import { COPY_BLOCK_BYTES } from "../io/copy-range.js";
import { executionError } from "../errors.js";
import { err, ok } from "../result.js";
import { classifyIsobmffModel } from "./admission.js";
import { IsobmffStructureError } from "./errors.js";
import { parseIsobmff } from "./parse.js";
// ISOBMFF output verifier (Phase 62, D-18 subset): re-parses the destination through the real
// engine, confirms it still admits, confirms the surviving item set matches the plan, confirms no
// Exif/mime item remains, and proves every surviving item's payload is byte-identical between
// source and destination through each file's own iloc/idat, in COPY_BLOCK_BYTES-sized streamed
// windows -- never a whole-item in-memory read. 62-09 completes the remaining D-18 checks
// (association-by-resolved-bytes, idat coverage, inserted-ICC/-Exif content) this subset defers.
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function verificationError(detail, path) {
    return executionError({ code: "verification-failed", detail, path }, "started");
}
function verificationAborted(path) {
    return executionError({ code: "aborted", detail: "Operation was aborted.", path }, "started");
}
/** Resolve an item's extent to an absolute file offset, construction_method 0 (file-relative) or
 * 1 (idat-relative). */
function resolveAbsoluteOffset(model, item, extent) {
    if (item.constructionMethod === 1) {
        if (model.idatRange === undefined) {
            throw new Error("verifyIsobmffOutput: construction_method 1 item but no idat range");
        }
        return model.idatRange.offset + item.baseOffset + extent.offset;
    }
    return item.baseOffset + extent.offset;
}
async function rangesEqual(sourceHandle, sourceOffset, destinationHandle, destinationOffset, length, signal) {
    const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(length, 1));
    const sourceBuffer = Buffer.allocUnsafe(bufferSize);
    const destinationBuffer = Buffer.allocUnsafe(bufferSize);
    for (let offset = 0; offset < length;) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const take = Math.min(COPY_BLOCK_BYTES, length - offset);
        const left = await sourceHandle.read(sourceBuffer, 0, take, sourceOffset + offset);
        const right = await destinationHandle.read(destinationBuffer, 0, take, destinationOffset + offset);
        if (left.bytesRead !== take || right.bytesRead !== take) {
            throw new Error("Source or output changed or became truncated during verification.");
        }
        if (!sourceBuffer.subarray(0, take).equals(destinationBuffer.subarray(0, take)))
            return false;
        offset += take;
    }
    return true;
}
export async function verifyIsobmffOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, _preserveOrientation, _preserveColorProfile, _preserveResolution, _expectedOrientation, signal) {
    let destinationModel;
    try {
        destinationModel = await parseIsobmff(destinationHandle, destinationSize, undefined, signal);
        // Must admit: a decline here throws IsobmffStructureError, caught below.
        classifyIsobmffModel(destinationModel, destinationSize);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        return err(verificationError(cause instanceof IsobmffStructureError
            ? cause.message
            : "Could not reopen and verify the destination.", destinationPath));
    }
    try {
        const removedIds = new Set(admission.classification.removableItemIds);
        const expectedSurvivingIds = admission.model.items
            .filter((item) => !removedIds.has(item.id))
            .map((item) => item.id);
        const actualSurvivingIds = destinationModel.items.map((item) => item.id);
        if (expectedSurvivingIds.length !== actualSurvivingIds.length ||
            expectedSurvivingIds.some((id, index) => id !== actualSurvivingIds[index])) {
            return err(verificationError("Destination item set did not match the sanitized plan.", destinationPath));
        }
        for (const item of destinationModel.items) {
            if (item.type === "Exif" || item.type === "mime") {
                return err(verificationError(`${item.type} item remained after sanitization.`, destinationPath));
            }
        }
        const sourceItemsById = admission.model.itemsById;
        for (const destinationItem of destinationModel.items) {
            const sourceItem = sourceItemsById.get(destinationItem.id);
            if (sourceItem === undefined) {
                return err(verificationError(`Destination item ${destinationItem.id} has no source counterpart.`, destinationPath));
            }
            if (sourceItem.extents.length !== destinationItem.extents.length) {
                return err(verificationError(`Item ${destinationItem.id} extent count changed.`, destinationPath));
            }
            for (let index = 0; index < sourceItem.extents.length; index += 1) {
                const sourceExtent = sourceItem.extents[index];
                const destinationExtent = destinationItem.extents[index];
                if (sourceExtent.length !== destinationExtent.length) {
                    return err(verificationError(`Item ${destinationItem.id} extent ${index} length changed.`, destinationPath));
                }
                const sourceAbsolute = resolveAbsoluteOffset(admission.model, sourceItem, sourceExtent);
                const destinationAbsolute = resolveAbsoluteOffset(destinationModel, destinationItem, destinationExtent);
                const equal = await rangesEqual(sourceHandle, sourceAbsolute, destinationHandle, destinationAbsolute, sourceExtent.length, signal);
                if (!equal) {
                    return err(verificationError(`Item ${destinationItem.id} payload bytes changed.`, destinationPath));
                }
            }
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        return err(verificationError(cause instanceof Error
            ? cause.message
            : "Could not verify the destination.", destinationPath));
    }
}
//# sourceMappingURL=verify.js.map