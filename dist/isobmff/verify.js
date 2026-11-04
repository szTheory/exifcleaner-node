import { COPY_BLOCK_BYTES } from "../io/copy-range.js";
import { executionError } from "../errors.js";
import { createMinimalExif } from "../metadata/exif.js";
import { err, ok } from "../result.js";
import { classifyIsobmffModel } from "./admission.js";
import { IsobmffStructureError } from "./errors.js";
import { computeIsobmffMinimalExifTags } from "./plan.js";
import { parseIsobmff } from "./parse.js";
// ISOBMFF output verifier (Phase 62, D-18 complete, 62-09): re-parses the destination through the
// real engine, confirms it still admits, and recomputes every expectation from the SOURCE
// admission and the request flags only -- never from the plan's own output (T-62-25). Covers:
// the top-level type list minus free/skip/C2PA uuid with ftyp bytes identical; the surviving item
// set, pitm, and each surviving item's infe fields; iref minus removed entries (k's to-list
// reduction); each surviving item's associations by resolved property bytes plus essential bit,
// in order; each surviving item's payload byte-identical through each file's own iloc/idat,
// streamed in COPY_BLOCK_BYTES windows; 0 or 1 Exif items (D-13's minimal Exif content); 0 mime
// items; the D-16 ICC colr rule both ways; D-11's iloc version/widths; mdat payload-length
// coverage (the union of surviving cm=0 extents); and idat byte-identity.
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function verificationError(detail, path) {
    return executionError({ code: "verification-failed", detail, path }, "started");
}
function verificationAborted(path) {
    return executionError({
        code: "aborted",
        // Stryker disable next-line StringLiteral: unobservable-message — the aborted result's detail is free-text diagnostic wording; the typed aborted code, the path and the started phase are unchanged.
        detail: "Operation was aborted.",
        path,
    }, "started");
}
/** Resolve an item's extent to an absolute file offset, construction_method 0 (file-relative:
 * `item.baseOffset` is already an absolute file position, written that way by the source encoder
 * and never adjusted outside `mdat`'s own rewrite) or 1 (idat-relative: `item.baseOffset` is an
 * offset into `idat`'s own payload, so the absolute file position is `idat`'s own absolute start
 * -- `layout.metaOffset + layout.metaHeaderSize + idatRange.offset`, since `idatRange.offset` is
 * itself relative to `metaPayload`, a freshly-read standalone buffer, not the file -- plus that). */
function resolveAbsoluteOffset(model, item, extent) {
    if (item.constructionMethod === 1) {
        if (model.idatRange === undefined) {
            throw new Error("verifyIsobmffOutput: construction_method 1 item but no idat range");
        }
        return (model.layout.metaOffset +
            model.layout.metaHeaderSize +
            model.idatRange.offset +
            item.baseOffset +
            extent.offset);
    }
    return item.baseOffset + extent.offset;
}
async function rangesEqual(sourceHandle, sourceOffset, destinationHandle, destinationOffset, length, signal) {
    const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(length, 1));
    const sourceBuffer = Buffer.allocUnsafe(bufferSize);
    const destinationBuffer = Buffer.allocUnsafe(bufferSize);
    for (let offset = 0; offset < length;) {
        if (isAborted(signal))
            // Stryker disable next-line LogicalOperator, StringLiteral: unobservable-message — this thrown value never leaves verifyIsobmffOutput: its catch block returns the typed aborted result whenever the signal is aborted, so neither the reason-or-DOMException choice nor the DOMException name or message reaches a caller.
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const take = Math.min(COPY_BLOCK_BYTES, length - offset);
        const left = await sourceHandle.read(sourceBuffer, 0, take, sourceOffset + offset);
        const right = await destinationHandle.read(destinationBuffer, 0, take, destinationOffset + offset);
        if (left.bytesRead !== take || right.bytesRead !== take) {
            throw new Error("Source or output changed or became truncated during verification.");
        }
        if (!sourceBuffer
            .subarray(0, take)
            .equals(destinationBuffer.subarray(0, take)))
            return false;
        offset += take;
    }
    return true;
}
/** D-16: read a whole file into one buffer, for the removed-ICC-bytes absence scan only -- every
 * other check in this module reads bounded ranges through the file handles directly. */
async function readWholeFile(handle, size) {
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    if (bytesRead !== size) {
        throw new Error("readWholeFile: short read.");
    }
    return buffer;
}
/** D-16: "colr" is a plain box (not a FullBox): size(4) type(4) colour_type(4) [ICC bytes]. The
 * ICC payload starts right after the 8-byte plain box header plus the 4-byte colour_type field. */
function colrIccPayloadBytes(model, property) {
    return model.layout.metaPayload.subarray(property.start + 12, property.end);
}
/** D-16 (recomputed here independently of `plan.ts`, T-62-25): the 1-based `ipco` property
 * indices this request removes -- every `colr` property whose `colourType` is "prof" or "rICC",
 * when `preserveColorProfile` is false; none when it is true. */
function removedColrPropertyIndices(model, preserveColorProfile) {
    if (preserveColorProfile)
        return new Set();
    return new Set(model.properties
        .filter((property) => property.type === "colr" &&
        (property.colourType === "prof" || property.colourType === "rICC"))
        .map((property) => property.index));
}
/** D-18: one surviving item's associations, resolved to (property bytes, essential), in the
 * item's own declaration order, with any removed ICC property's association already excluded. */
function resolvePropertyAssociationBytes(model, item, removedIndices) {
    return item.properties
        .filter((association) => !removedIndices.has(association.index))
        .map((association) => {
        const property = model.properties.find((candidate) => candidate.index === association.index);
        if (property === undefined) {
            throw new Error(
            // Stryker disable next-line StringLiteral: unobservable-message — this undeclared-property label only reaches the verification-failed detail text; the typed verification-failed code is unchanged.
            `resolvePropertyAssociationBytes: item ${item.id} references undeclared property ` +
                // Stryker disable next-line StringLiteral: unobservable-message — the property index label only reaches the verification-failed detail text; the typed verification-failed code is unchanged.
                `index ${association.index}.`);
        }
        return {
            bytes: model.layout.metaPayload.subarray(property.start, property.end),
            essential: association.essential,
        };
    });
}
export async function verifyIsobmffOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, preserveResolution, expectedOrientation, signal) {
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
        // Stryker disable next-line StringLiteral: unobservable-message — the Could not reopen and verify the destination. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
        const reopenDetail = "Could not reopen and verify the destination.";
        return err(verificationError(cause instanceof IsobmffStructureError ? cause.message : reopenDetail, destinationPath));
    }
    try {
        // D-18: pitm never changes -- the primary item is never removed (D3's removable-item-
        // referenced rule already refuses a removable item named by pitm at admission).
        if (admission.model.primaryItemId !== destinationModel.primaryItemId) {
            return err(
            // Stryker disable next-line StringLiteral: unobservable-message — the pitm (primary item id) changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            verificationError("pitm (primary item id) changed.", destinationPath));
        }
        // D-11: the source's iloc version and all four declared field widths are written unchanged.
        const sourceIloc = admission.model.iloc;
        const destinationIloc = destinationModel.iloc;
        if (sourceIloc === undefined || destinationIloc === undefined) {
            // Stryker disable next-line StringLiteral: unobservable-message — the Missing iloc table. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            return err(verificationError("Missing iloc table.", destinationPath));
        }
        if (sourceIloc.version !== destinationIloc.version ||
            sourceIloc.offsetSize !== destinationIloc.offsetSize ||
            sourceIloc.lengthSize !== destinationIloc.lengthSize ||
            sourceIloc.baseOffsetSize !== destinationIloc.baseOffsetSize ||
            sourceIloc.indexSize !== destinationIloc.indexSize) {
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the iloc version or a declared field width wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "iloc version or a declared field width changed.", destinationPath));
        }
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
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the Destination top-level box list did not match wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "Destination top-level box list did not match the source minus free/skip/C2PA uuid.", destinationPath));
        }
        const sourceFtyp = admission.model.layout.topLevelBoxes.find((box) => box.type === "ftyp");
        const destinationFtyp = destinationModel.layout.topLevelBoxes.find(
        // Stryker disable next-line ConditionalExpression: defensive-unreachable-by-construction — the destination was re-parsed above through readTopLevelBoxes, which throws box-framing unless the first top-level box is ftyp, so the ftyp found by type and the first box are the same box and the always-true predicate returns it; the always-false sibling on this line (killed by every successful verification) is suppressed only as collateral of this next-line directive.
        (box) => box.type === "ftyp");
        if (sourceFtyp === undefined || destinationFtyp === undefined) {
            return err(
            // Stryker disable next-line StringLiteral: unobservable-message — the Missing top-level ftyp box. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            verificationError("Missing top-level ftyp box.", destinationPath));
        }
        // Stryker disable next-line ArithmeticOperator: equivalent-arithmetic — ftyp is the first top-level box (readTopLevelBoxes enforces it) and the first box starts at file offset 0, so sourceFtyp.start is always 0 and end - start equals end + start for every admitted source.
        const ftypLength = sourceFtyp.end - sourceFtyp.start;
        const ftypEqual = await rangesEqual(sourceHandle, sourceFtyp.start, destinationHandle, destinationFtyp.start, ftypLength, signal);
        if (!ftypEqual) {
            // Stryker disable next-line StringLiteral: unobservable-message — the ftyp bytes changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
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
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the Destination item set did not match the wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "Destination item set did not match the sanitized plan.", destinationPath));
        }
        // D-13/D-18: 0 or 1 Exif items. If 1, it must be k, reused at its own id -- never a new one,
        // never more than one. No `mime` (XMP) item ever survives.
        let exifItemCount = 0;
        for (const item of destinationModel.items) {
            if (item.type === "mime") {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the mime item remained after sanitization. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                "mime item remained after sanitization.", destinationPath));
            }
            if (item.type === "Exif") {
                // Stryker disable next-line AssignmentOperator: defensive-unreachable-by-construction — exifItemCount only feeds `exifItemCount === 0`, which is false for 1 and for -1 alike; a second Exif item carrying the kept id would need a duplicate item_ID, and parseIsobmff declines that before this loop, so the count never exceeds 1.
                exifItemCount += 1;
                if (item.id !== keepExifItemId) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Unexpected Exif item N remained after sanitization. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Unexpected Exif item ${item.id} remained after sanitization.`, destinationPath));
                }
            }
        }
        if (keepExifItemId !== undefined && exifItemCount === 0) {
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the Expected minimal Exif item N is missing wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            `Expected minimal Exif item ${keepExifItemId} is missing from the destination.`, destinationPath));
        }
        // D-16: recomputed independently of plan.ts, from the SOURCE admission's own properties.
        const removedPropertyIndices = removedColrPropertyIndices(admission.model, preserveColorProfile);
        const sourceItemsById = admission.model.itemsById;
        for (const destinationItem of destinationModel.items) {
            if (destinationItem.id === keepExifItemId) {
                // D-13: k's payload is new, synthesized bytes -- compare against the recomputed
                // expected payload, never against the source's own (removed) Exif bytes. The destination
                // admission above already refuses a removable (Exif) item whose construction_method is not
                // 0, so the kept item's extent is always a file offset here.
                if (destinationItem.extents.length !== 1) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Minimal Exif item N does not have wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Minimal Exif item ${destinationItem.id} does not have exactly one extent.`, destinationPath));
                }
                const extent = destinationItem.extents[0];
                // A kept payload of any other length fails the byte comparison below (the read comes up
                // short or `equals` is false); the destination admission keeps every extent inside the
                // single mdat payload, so the read buffer is never larger than the destination file.
                if (expectedMinimalExifPayload === undefined) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Minimal Exif item N payload length did wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Minimal Exif item ${destinationItem.id} payload length did not match the ` +
                        // Stryker disable next-line StringLiteral: unobservable-message — the expected minimal Exif payload. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "expected minimal Exif payload.", destinationPath));
                }
                const absoluteOffset = resolveAbsoluteOffset(destinationModel, destinationItem, extent);
                const actualPayload = Buffer.allocUnsafe(extent.length);
                const read = await destinationHandle.read(actualPayload, 0, extent.length, absoluteOffset);
                if (read.bytesRead !== extent.length ||
                    !actualPayload.equals(expectedMinimalExifPayload)) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Minimal Exif item N payload bytes did wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Minimal Exif item ${destinationItem.id} payload bytes did not match the ` +
                        // Stryker disable next-line StringLiteral: unobservable-message — the expected minimal Exif payload. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "expected minimal Exif payload.", destinationPath));
                }
                // CR-01 (code review 2026-10-02): assert the CARDINALITY of k's qualifying cdsc record
                // -- exactly one cdsc record from k reduces to [pitm] -- not just that `.find()` happens
                // to turn up a match. k may legitimately carry OTHER iref records of any type, including
                // other cdsc records to other items (D-13: only the qualifying record is rewritten; every
                // other record from k survives verbatim), so this does not assert k carries only one cdsc
                // record total, only that exactly one reduces to [pitm].
                const qualifyingCdscRecordsFromK = destinationModel.references.filter((reference) => reference.type === "cdsc" &&
                    reference.fromItemId === destinationItem.id &&
                    reference.toItemIds.length === 1 &&
                    reference.toItemIds[0] === destinationModel.primaryItemId);
                if (qualifyingCdscRecordsFromK.length !== 1) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Minimal Exif item N has wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Minimal Exif item ${destinationItem.id} has ` +
                        // Stryker disable next-line StringLiteral: unobservable-message — the N cdsc records reduced to [pitm]; expected wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        `${qualifyingCdscRecordsFromK.length} cdsc records reduced to [pitm]; expected ` +
                        // Stryker disable next-line StringLiteral: unobservable-message — the exactly 1. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "exactly 1.", destinationPath));
                }
                if (destinationItem.properties.length !== 0) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Minimal Exif item N unexpectedly carries an wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Minimal Exif item ${destinationItem.id} unexpectedly carries an ipma entry.`, destinationPath));
                }
                continue;
            }
            const sourceItem = sourceItemsById.get(destinationItem.id);
            if (sourceItem === undefined) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the Destination item N has no source counterpart. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `Destination item ${destinationItem.id} has no source counterpart.`, destinationPath));
            }
            // D-18: every surviving item's infe fields (type, name, hidden, contentType,
            // contentEncoding) are equal -- the writer copies every non-k infe box byte-verbatim
            // (D-14), so this must hold exactly.
            if (sourceItem.type !== destinationItem.type ||
                sourceItem.name !== destinationItem.name ||
                sourceItem.hidden !== destinationItem.hidden ||
                sourceItem.contentType !== destinationItem.contentType ||
                sourceItem.contentEncoding !== destinationItem.contentEncoding) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the Item N infe fields changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `Item ${destinationItem.id} infe fields changed.`, destinationPath));
            }
            // D-18: associations compared by resolved property bytes plus essential bit, in order --
            // never by index, never as an unordered set. A removed ICC property's association is
            // excluded from the SOURCE side's expectation (D-16), independently of the plan's own
            // remap, before the ordered comparison runs.
            const expectedAssociations = resolvePropertyAssociationBytes(admission.model, sourceItem, removedPropertyIndices);
            const actualAssociations = resolvePropertyAssociationBytes(destinationModel, destinationItem, new Set());
            if (expectedAssociations.length !== actualAssociations.length) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the Item N property association count changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `Item ${destinationItem.id} property association count changed.`, destinationPath));
            }
            for (let index = 0; index < expectedAssociations.length; index += 1) {
                const expected = expectedAssociations[index];
                const actual = actualAssociations[index];
                if (expected.essential !== actual.essential ||
                    !expected.bytes.equals(actual.bytes)) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Item N property association N changed (bytes wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Item ${destinationItem.id} property association ${index} changed (bytes or ` +
                        // Stryker disable next-line StringLiteral: unobservable-message — the essential bit, or associations were reordered). wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "essential bit, or associations were reordered).", destinationPath));
                }
            }
            if (sourceItem.extents.length !== destinationItem.extents.length) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the Item N extent count changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `Item ${destinationItem.id} extent count changed.`, destinationPath));
            }
            for (let index = 0; index < sourceItem.extents.length; index += 1) {
                const sourceExtent = sourceItem.extents[index];
                const destinationExtent = destinationItem.extents[index];
                if (sourceExtent.length !== destinationExtent.length) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Item N extent N length changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Item ${destinationItem.id} extent ${index} length changed.`, destinationPath));
                }
                const sourceAbsolute = resolveAbsoluteOffset(admission.model, sourceItem, sourceExtent);
                const destinationAbsolute = resolveAbsoluteOffset(destinationModel, destinationItem, destinationExtent);
                const equal = await rangesEqual(sourceHandle, sourceAbsolute, destinationHandle, destinationAbsolute, sourceExtent.length, signal);
                if (!equal) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the Item N payload bytes changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    `Item ${destinationItem.id} payload bytes changed.`, destinationPath));
                }
            }
        }
        // D-18: iref equals the source's minus removed entries, with k's own QUALIFYING cdsc record
        // (the first, in iref order, of type "cdsc" from k whose to-list contains the primary) -- and
        // ONLY that record -- reduced to [pitm] (D-13). Recomputed independently of plan.ts, from the
        // source admission only, and independently of plan.ts's own index computation (code review
        // 2026-10-02 CR-01: a blanket `fromItemId === keepExifItemId` rewrite previously squashed
        // every record from k, not only the qualifying one).
        // With no kept item (`keepExifItemId` undefined) no reference's numeric `fromItemId` matches,
        // so the search yields -1 and no record is rewritten.
        const qualifyingKReferenceIndex = admission.model.references.findIndex((reference) => reference.fromItemId === keepExifItemId &&
            reference.type === "cdsc" &&
            reference.toItemIds.includes(admission.model.primaryItemId));
        const expectedReferences = admission.model.references
            .map((reference, index) => ({ reference, index }))
            .filter(({ reference }) => !removedIds.has(reference.fromItemId) ||
            reference.fromItemId === keepExifItemId)
            .map(({ reference, index }) => index === qualifyingKReferenceIndex
            ? { ...reference, toItemIds: [admission.model.primaryItemId] }
            : reference);
        const actualReferences = destinationModel.references;
        if (expectedReferences.length !== actualReferences.length) {
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the iref record count did not match the wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "iref record count did not match the source minus removed entries.", destinationPath));
        }
        for (let index = 0; index < expectedReferences.length; index += 1) {
            const expected = expectedReferences[index];
            const actual = actualReferences[index];
            if (expected.type !== actual.type ||
                expected.fromItemId !== actual.fromItemId ||
                expected.toItemIds.length !== actual.toItemIds.length ||
                expected.toItemIds.some((id, toIndex) => id !== actual.toItemIds[toIndex])) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the iref record N did not match the wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `iref record ${index} did not match the source minus removed entries.`, destinationPath));
            }
        }
        // D-16/D-18: the ICC `colr` rule, both ways. `nclx` is always preserved, byte-identical,
        // regardless of the flag -- checked first since it applies unconditionally.
        const sourceColrProperties = admission.model.properties.filter((property) => property.type === "colr");
        // parseIpco sets `colourType` only on colr properties, and the destination list is consumed
        // only through `colourType` (nclx, prof, rICC), so it needs no separate colr type filter.
        const destinationProperties = destinationModel.properties;
        const sourceNclxBytes = sourceColrProperties
            .filter((property) => property.colourType === "nclx")
            .map((property) => admission.model.layout.metaPayload.subarray(property.start, property.end));
        const destinationNclxBytes = destinationProperties
            .filter((property) => property.colourType === "nclx")
            .map((property) => destinationModel.layout.metaPayload.subarray(property.start, property.end));
        if (sourceNclxBytes.length !== destinationNclxBytes.length ||
            sourceNclxBytes.some((bytes, index) => !bytes.equals(destinationNclxBytes[index]))) {
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the A kept nclx colr property changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "A kept nclx colr property changed.", destinationPath));
        }
        if (preserveColorProfile) {
            // D-16: nothing is removed -- the whole ipco box must be byte-identical to the source's.
            const sourceIpco = admission.model.layout.item.iprpChildren.find((child) => child.type === "ipco");
            const destinationIpco = destinationModel.layout.item.iprpChildren.find((child) => child.type === "ipco");
            if ((sourceIpco === undefined) !== (destinationIpco === undefined)) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the ipco presence changed although preserveColorProfile is true. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                "ipco presence changed although preserveColorProfile is true.", destinationPath));
            }
            if (sourceIpco !== undefined && destinationIpco !== undefined) {
                const sourceIpcoBytes = admission.model.layout.metaPayload.subarray(sourceIpco.start, sourceIpco.end);
                const destinationIpcoBytes = destinationModel.layout.metaPayload.subarray(destinationIpco.start, destinationIpco.end);
                if (!sourceIpcoBytes.equals(destinationIpcoBytes)) {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the ipco bytes changed although preserveColorProfile is true. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    "ipco bytes changed although preserveColorProfile is true.", destinationPath));
                }
            }
        }
        else {
            // D-16: no prof/rICC colr property may remain anywhere in the destination's ipco, and none
            // of the removed ICC payload bytes may occur anywhere in the destination file.
            for (const property of destinationProperties) {
                if (property.colourType === "prof" || property.colourType === "rICC") {
                    return err(verificationError(
                    // Stryker disable next-line StringLiteral: unobservable-message — the An ICC colr property (prof/rICC) remained after wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    "An ICC colr property (prof/rICC) remained after sanitization with " +
                        // Stryker disable next-line StringLiteral: unobservable-message — the preserveColorProfile false. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "preserveColorProfile false.", destinationPath));
                }
            }
            const removedIccProperties = sourceColrProperties.filter((property) => property.colourType === "prof" || property.colourType === "rICC");
            // WR-01 (code review 2026-10-02): recompute the WHOLE expected surviving ipco payload
            // independently -- source properties, in source order, minus the independently
            // recomputed removed indices -- and compare it byte for byte against the destination's
            // actual ipco children bytes. The per-item association check elsewhere in this function
            // only reads back properties an `ipma` entry actually associates with a surviving item; a
            // property no `ipma` entry references at all (an orphan, D-34, e.g. a `udes` box) was never
            // read back by anything before this check existed, so a corrupting or dropping defect in
            // `rebuildIpco`/the removal filter would go uncaught.
            const removedPropertyIndices = new Set(sourceColrProperties
                .filter((property) => property.colourType === "prof" || property.colourType === "rICC")
                .map((property) => property.index));
            const expectedIpcoChildrenBytes = Buffer.concat(admission.model.properties
                .filter((property) => !removedPropertyIndices.has(property.index))
                .map((property) => admission.model.layout.metaPayload.subarray(property.start, property.end)));
            const destinationIpcoForOrphanCheck = destinationModel.layout.item.iprpChildren.find((child) => child.type === "ipco");
            const actualIpcoChildrenBytes = destinationIpcoForOrphanCheck === undefined
                ? Buffer.alloc(0)
                : destinationModel.layout.metaPayload.subarray(destinationIpcoForOrphanCheck.payloadStart, destinationIpcoForOrphanCheck.end);
            if (!expectedIpcoChildrenBytes.equals(actualIpcoChildrenBytes)) {
                return err(verificationError(
                // Stryker disable next-line StringLiteral: unobservable-message — the The surviving ipco payload (source properties minus wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                "The surviving ipco payload (source properties minus the removed ICC " +
                    // Stryker disable next-line StringLiteral: unobservable-message — the properties) did not match the destination byte wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                    "properties) did not match the destination byte for byte.", destinationPath));
            }
            if (removedIccProperties.length > 0) {
                const destinationWhole = await readWholeFile(destinationHandle, destinationSize);
                for (const property of removedIccProperties) {
                    const iccBytes = colrIccPayloadBytes(admission.model, property);
                    if (iccBytes.length > 0 && destinationWhole.includes(iccBytes)) {
                        return err(verificationError(
                        // Stryker disable next-line StringLiteral: unobservable-message — the Removed ICC payload bytes were found in wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                        "Removed ICC payload bytes were found in the destination.", destinationPath));
                    }
                }
            }
        }
        // D-18 coverage: the output mdat payload length equals the size of the union of output
        // construction_method-0 extents (recomputed from the destination's own item graph, never
        // trusted from the plan) -- proves no gap and no overflow in the rebuilt mdat payload.
        const destinationMdat = destinationModel.mdatRanges[0];
        if (destinationMdat === undefined) {
            return err(
            // Stryker disable next-line StringLiteral: unobservable-message — the Missing top-level mdat box. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            verificationError("Missing top-level mdat box.", destinationPath));
        }
        const cm0Ranges = [];
        for (const item of destinationModel.items) {
            if (item.constructionMethod !== 0)
                continue;
            for (const extent of item.extents) {
                if (extent.length === 0)
                    continue;
                const start = item.baseOffset + extent.offset;
                cm0Ranges.push({ start, end: start + extent.length });
            }
        }
        cm0Ranges.sort((a, b) => a.start - b.start);
        let coveredLength = 0;
        let previousEnd;
        for (const range of cm0Ranges) {
            const effectiveStart = previousEnd !== undefined
                ? Math.max(range.start, previousEnd)
                : range.start;
            if (range.end > effectiveStart) {
                coveredLength += range.end - effectiveStart;
            }
            previousEnd =
                previousEnd !== undefined
                    ? Math.max(previousEnd, range.end)
                    : range.end;
        }
        if (coveredLength !== destinationMdat.length) {
            return err(verificationError(
            // Stryker disable next-line StringLiteral: unobservable-message — the Output mdat payload length did not equal wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            "Output mdat payload length did not equal the union of surviving extents " +
                // Stryker disable next-line StringLiteral: unobservable-message — the (covered N, mdat payload length N). wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                `(covered ${coveredLength}, mdat payload length ${destinationMdat.length}).`, destinationPath));
        }
        // D-18: idat is byte-identical. Presence must agree (idat is copied verbatim, D-14 -- it is
        // dropped only when the source never had one); its payload length and bytes must match
        // exactly, resolved to each file's own absolute position (idatRange.offset is relative to
        // `metaPayload`, never the file -- see resolveAbsoluteOffset's banner).
        const sourceIdat = admission.model.idatRange;
        const destinationIdat = destinationModel.idatRange;
        if ((sourceIdat === undefined) !== (destinationIdat === undefined)) {
            // Stryker disable next-line StringLiteral: unobservable-message — the idat presence changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
            return err(verificationError("idat presence changed.", destinationPath));
        }
        if (sourceIdat !== undefined && destinationIdat !== undefined) {
            if (sourceIdat.length !== destinationIdat.length) {
                // Stryker disable next-line StringLiteral: unobservable-message — the idat length changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                return err(verificationError("idat length changed.", destinationPath));
            }
            const sourceAbsolute = admission.model.layout.metaOffset +
                admission.model.layout.metaHeaderSize +
                sourceIdat.offset;
            const destinationAbsolute = destinationModel.layout.metaOffset +
                destinationModel.layout.metaHeaderSize +
                destinationIdat.offset;
            const idatEqual = await rangesEqual(sourceHandle, sourceAbsolute, destinationHandle, destinationAbsolute, sourceIdat.length, signal);
            if (!idatEqual) {
                // Stryker disable next-line StringLiteral: unobservable-message — the idat bytes changed. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
                return err(verificationError("idat bytes changed.", destinationPath));
            }
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        // Stryker disable next-line StringLiteral: unobservable-message — the Could not verify the destination. wording only reaches the verification-failed detail text; the typed verification-failed code, the path and the started phase are unchanged.
        const verifyDetail = "Could not verify the destination.";
        return err(verificationError(cause instanceof Error ? cause.message : verifyDetail, destinationPath));
    }
}
//# sourceMappingURL=verify.js.map