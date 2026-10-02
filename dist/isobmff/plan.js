import { fullBoxHeader, plainBoxHeader, rebuildIinf, rebuildIloc, rebuildIpma, rebuildIprp, rebuildIref, } from "./rebuild.js";
function declined(removedItemIds, reason) {
    return { parts: [], removedItemIds, declineReason: reason };
}
/**
 * D-15: the union of surviving construction_method-0 extents, merged in ascending source offset.
 * Items with no construction_method-0 extents (e.g. a cm=1 grid descriptor, which lives in
 * `idat` and is copied verbatim as part of `meta`) contribute nothing here.
 */
function collectSourceExtents(survivingItems) {
    const entries = [];
    for (const item of survivingItems) {
        if (item.constructionMethod !== 0)
            continue;
        item.extents.forEach((extent, extentIndex) => {
            entries.push({
                itemId: item.id,
                extentIndex,
                absStart: item.baseOffset + extent.offset,
                length: extent.length,
            });
        });
    }
    return [...entries].sort((a, b) => a.absStart - b.absStart);
}
/** Each surviving extent's new offset relative to the new mdat payload's own start (0-based). */
function newRelativeOffsets(sourceExtents) {
    const map = new Map();
    let running = 0;
    for (const entry of sourceExtents) {
        map.set(`${entry.itemId}:${entry.extentIndex}`, running);
        running += entry.length;
    }
    return map;
}
/**
 * D-11: surviving construction_method-0 items' `iloc` rewrites, given where the new mdat payload
 * will start in the output file. `baseOffsetSize > 0`: base = the first extent's new absolute
 * position, other extent offsets are relative to it. `baseOffsetSize == 0`: every extent offset is
 * its own new absolute position (no base).
 */
function computeIlocRewrites(survivingItems, relativeOffsets, baseOffsetSize, newMdatPayloadStart) {
    const rewrites = new Map();
    for (const item of survivingItems) {
        if (item.constructionMethod !== 0)
            continue;
        const relatives = item.extents.map((_extent, index) => relativeOffsets.get(`${item.id}:${index}`));
        if (baseOffsetSize > 0) {
            const base = relatives[0];
            rewrites.set(item.id, {
                newBaseOffset: newMdatPayloadStart + base,
                extentOffsets: relatives.map((relative) => relative - base),
            });
        }
        else {
            rewrites.set(item.id, {
                newBaseOffset: 0,
                extentOffsets: relatives.map((relative) => newMdatPayloadStart + relative),
            });
        }
    }
    return rewrites;
}
function buildMetaBytes(layoutItem, metaPayload, survivingItems, iinfBytes, irefBytes, iprpBytes, ilocRewrites) {
    const ilocBytes = rebuildIloc(layoutItem.ilocVersion, layoutItem.ilocOffsetSize, layoutItem.ilocLengthSize, layoutItem.ilocBaseOffsetSize, layoutItem.ilocIndexSize, survivingItems, ilocRewrites);
    const parts = [];
    for (const child of layoutItem.metaChildren) {
        if (child.type === "iinf") {
            parts.push(iinfBytes);
            continue;
        }
        if (child.type === "iloc") {
            parts.push(ilocBytes);
            continue;
        }
        if (child.type === "iref") {
            if (irefBytes !== undefined)
                parts.push(irefBytes);
            continue;
        }
        if (child.type === "iprp") {
            if (iprpBytes !== undefined)
                parts.push(iprpBytes);
            continue;
        }
        // hdlr, dinf, pitm, idat, grpl: copied verbatim (D-14).
        parts.push(metaPayload.subarray(child.start, child.end));
    }
    const childrenBytes = Buffer.concat(parts);
    return Buffer.concat([
        fullBoxHeader("meta", 0, 0, childrenBytes.length),
        childrenBytes,
    ]);
}
export function buildIsobmffOutputPlan(admission, _preserveOrientation, _preserveColorProfile, _preserveResolution, _orientation) {
    const { model, classification } = admission;
    const { layout } = model;
    const removedIds = new Set(classification.removableItemIds);
    const survivingItems = model.items.filter((item) => !removedIds.has(item.id));
    const survivingItemIds = survivingItems.map((item) => item.id);
    const ftypBox = layout.topLevelBoxes.find((box) => box.type === "ftyp");
    const mdatBox = layout.topLevelBoxes.find((box) => box.type === "mdat");
    if (ftypBox === undefined || mdatBox === undefined) {
        return declined(classification.removableItemIds, "Source is missing a top-level ftyp or mdat box.");
    }
    if (mdatBox.headerSize !== 8) {
        return declined(classification.removableItemIds, "Unsupported mdat box header form (largesize) for this build.");
    }
    const sourceExtents = collectSourceExtents(survivingItems);
    const relativeOffsets = newRelativeOffsets(sourceExtents);
    const newMdatPayloadLength = sourceExtents.reduce((total, entry) => total + entry.length, 0);
    // iinf: always rebuilt (entry_count shrinks, surviving infe boxes copied verbatim).
    const iinfBytes = rebuildIinf(layout.metaPayload, layout.item.iinfVersion, survivingItemIds, layout.item.infeRanges);
    // iref: rebuilt from records whose from-item survives; dropped entirely if that leaves none.
    let irefBytes;
    if (layout.item.irefVersion !== undefined) {
        const survivingReferences = model.references.filter((reference) => !removedIds.has(reference.fromItemId));
        if (survivingReferences.length > 0) {
            irefBytes = rebuildIref(layout.item.irefVersion, survivingReferences);
        }
    }
    // iprp: ipco copied verbatim, ipma rebuilt (surviving entries only).
    let iprpBytes;
    const iprpChildren = layout.item.iprpChildren;
    if (iprpChildren.length > 0) {
        const ipcoHeader = iprpChildren.find((child) => child.type === "ipco");
        const ipmaHeader = iprpChildren.find((child) => child.type === "ipma");
        const ipcoBytes = ipcoHeader !== undefined
            ? layout.metaPayload.subarray(ipcoHeader.start, ipcoHeader.end)
            : Buffer.alloc(0);
        let ipmaBytes;
        if (ipmaHeader !== undefined && layout.item.ipmaVersion !== undefined) {
            const survivingAssociations = (model.ipma ?? []).filter((entry) => !removedIds.has(entry.itemId));
            ipmaBytes = rebuildIpma(layout.item.ipmaVersion, layout.item.ipmaFlags ?? 0, survivingAssociations.map((entry) => ({
                itemId: entry.itemId,
                associations: entry.associations.map((association) => ({
                    propertyIndex: association.propertyIndex,
                    essential: association.essential,
                })),
            })));
        }
        const order = iprpChildren
            .map((child) => child.type)
            .filter((type) => type === "ipco" || type === "ipma");
        iprpBytes = rebuildIprp(order, ipcoBytes, ipmaBytes);
    }
    // D-11: widths never change, so the rebuilt meta's length is independent of the actual offset
    // *values* -- probe with offset 0 to learn the new mdat payload's start, then rebuild once more
    // with the real values.
    const probeRewrites = computeIlocRewrites(survivingItems, relativeOffsets, layout.item.ilocBaseOffsetSize, 0);
    const probeMetaBytes = buildMetaBytes(layout.item, layout.metaPayload, survivingItems, iinfBytes, irefBytes, iprpBytes, probeRewrites);
    const ftypTotalSize = ftypBox.end - ftypBox.start;
    const newMetaTotalSize = probeMetaBytes.length;
    const newMdatPayloadStart = ftypTotalSize + newMetaTotalSize + mdatBox.headerSize;
    const finalRewrites = computeIlocRewrites(survivingItems, relativeOffsets, layout.item.ilocBaseOffsetSize, newMdatPayloadStart);
    const metaBytes = buildMetaBytes(layout.item, layout.metaPayload, survivingItems, iinfBytes, irefBytes, iprpBytes, finalRewrites);
    if (metaBytes.length !== probeMetaBytes.length) {
        return declined(classification.removableItemIds, "Rebuilt meta length changed between the probe and final passes.");
    }
    const mdatHeaderBytes = plainBoxHeader("mdat", newMdatPayloadLength);
    const parts = [
        { kind: "copy", sourceOffset: ftypBox.start, length: ftypTotalSize },
        { kind: "bytes", data: metaBytes },
        { kind: "bytes", data: mdatHeaderBytes },
        ...sourceExtents.map((entry) => ({
            kind: "copy",
            sourceOffset: entry.absStart,
            length: entry.length,
        })),
    ];
    return { parts, removedItemIds: classification.removableItemIds };
}
export function checkIsobmffOutputPlan(plan) {
    return plan.declineReason;
}
//# sourceMappingURL=plan.js.map