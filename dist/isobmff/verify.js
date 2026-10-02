import { COPY_BLOCK_BYTES } from "../io/copy-range.js";
import { executionError } from "../errors.js";
import { createMinimalExif } from "../metadata/exif.js";
import { err, ok } from "../result.js";
import { classifyIsobmffModel } from "./admission.js";
import { IsobmffStructureError } from "./errors.js";
import { computeIsobmffMinimalExifTags } from "./plan.js";
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
export async function verifyIsobmffOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, _preserveColorProfile, preserveResolution, expectedOrientation, signal) {
    // D-13/D-18: recompute the minimal Exif item's expected shape from the source admission and
    // the request flags -- never from the plan -- so a planner bug cannot also fool the verifier.
    const tags = computeIsobmffMinimalExifTags(admission, preserveOrientation, preserveResolution, expectedOrientation);
    const keepExifItemId = tags !== undefined ? admission.exifSourceItemId : undefined;
    const expectedMinimalExifPayload = keepExifItemId !== undefined
        ? Buffer.concat([Buffer.alloc(4), createMinimalExif(tags)])
        : undefined;
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
        // D-14/D-18: the output top-level type list equals the source's minus free/skip/C2PA uuid,
        // in the same source order, and ftyp's bytes are identical. Every admitted top-level `uuid`
        // is the C2PA box (D-09/D5: any other usertype already fails parse-time admission), so
        // filtering by type alone (never by usertype) is exact here.
        const sourceTopLevelTypes = admission.model.layout.topLevelBoxes
            .map((box) => box.type)
            .filter((type) => type !== "free" && type !== "skip" && type !== "uuid");
        const destinationTopLevelTypes = destinationModel.layout.topLevelBoxes.map((box) => box.type);
        if (sourceTopLevelTypes.length !== destinationTopLevelTypes.length ||
            sourceTopLevelTypes.some((type, index) => type !== destinationTopLevelTypes[index])) {
            return err(verificationError("Destination top-level box list did not match the source minus free/skip/C2PA uuid.", destinationPath));
        }
        const sourceFtyp = admission.model.layout.topLevelBoxes.find((box) => box.type === "ftyp");
        const destinationFtyp = destinationModel.layout.topLevelBoxes.find((box) => box.type === "ftyp");
        if (sourceFtyp === undefined || destinationFtyp === undefined) {
            return err(verificationError("Missing top-level ftyp box.", destinationPath));
        }
        const ftypEqual = await rangesEqual(sourceHandle, sourceFtyp.start, destinationHandle, destinationFtyp.start, sourceFtyp.end - sourceFtyp.start, signal);
        if (!ftypEqual) {
            return err(verificationError("ftyp bytes changed.", destinationPath));
        }
        // D-13: k's own id stays in the expected surviving set (in its original source-order slot)
        // exactly when a minimal Exif item is required -- its old payload is gone, but its id is
        // reused in place, never a new allocation.
        const removedIds = new Set(admission.classification.removableItemIds);
        const expectedSurvivingIds = admission.model.items
            .filter((item) => !removedIds.has(item.id) || item.id === keepExifItemId)
            .map((item) => item.id);
        const actualSurvivingIds = destinationModel.items.map((item) => item.id);
        if (expectedSurvivingIds.length !== actualSurvivingIds.length ||
            expectedSurvivingIds.some((id, index) => id !== actualSurvivingIds[index])) {
            return err(verificationError("Destination item set did not match the sanitized plan.", destinationPath));
        }
        // D-13/D-18: 0 or 1 Exif items. If 1, it must be k, reused at its own id -- never a new one,
        // never more than one. No `mime` (XMP) item ever survives.
        let exifItemCount = 0;
        for (const item of destinationModel.items) {
            if (item.type === "mime") {
                return err(verificationError("mime item remained after sanitization.", destinationPath));
            }
            if (item.type === "Exif") {
                exifItemCount += 1;
                if (item.id !== keepExifItemId) {
                    return err(verificationError(`Unexpected Exif item ${item.id} remained after sanitization.`, destinationPath));
                }
            }
        }
        if (exifItemCount > 1) {
            return err(verificationError("More than one Exif item remained after sanitization.", destinationPath));
        }
        if (keepExifItemId !== undefined && exifItemCount === 0) {
            return err(verificationError(`Expected minimal Exif item ${keepExifItemId} is missing from the destination.`, destinationPath));
        }
        const sourceItemsById = admission.model.itemsById;
        for (const destinationItem of destinationModel.items) {
            if (destinationItem.id === keepExifItemId) {
                // D-13: k's payload is new, synthesized bytes -- compare against the recomputed
                // expected payload, never against the source's own (removed) Exif bytes.
                if (destinationItem.constructionMethod !== 0) {
                    return err(verificationError(`Minimal Exif item ${destinationItem.id} is not construction_method 0.`, destinationPath));
                }
                if (destinationItem.extents.length !== 1) {
                    return err(verificationError(`Minimal Exif item ${destinationItem.id} does not have exactly one extent.`, destinationPath));
                }
                const extent = destinationItem.extents[0];
                if (expectedMinimalExifPayload === undefined ||
                    extent.length !== expectedMinimalExifPayload.length) {
                    return err(verificationError(`Minimal Exif item ${destinationItem.id} payload length did not match the ` +
                        "expected minimal Exif payload.", destinationPath));
                }
                const absoluteOffset = resolveAbsoluteOffset(destinationModel, destinationItem, extent);
                const actualPayload = Buffer.allocUnsafe(extent.length);
                const read = await destinationHandle.read(actualPayload, 0, extent.length, absoluteOffset);
                if (read.bytesRead !== extent.length ||
                    !actualPayload.equals(expectedMinimalExifPayload)) {
                    return err(verificationError(`Minimal Exif item ${destinationItem.id} payload bytes did not match the ` +
                        "expected minimal Exif payload.", destinationPath));
                }
                const cdscRecord = destinationModel.references.find((reference) => reference.type === "cdsc" && reference.fromItemId === destinationItem.id);
                if (cdscRecord === undefined ||
                    cdscRecord.toItemIds.length !== 1 ||
                    cdscRecord.toItemIds[0] !== destinationModel.primaryItemId) {
                    return err(verificationError(`Minimal Exif item ${destinationItem.id} cdsc reference did not reduce to ` +
                        "[pitm].", destinationPath));
                }
                continue;
            }
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