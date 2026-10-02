// Rebuild helpers (Phase 62, D-11/D-13/D-14/D-16 subset): re-emit the source `meta` child box
// encodings with removed-item entries dropped, changing values only where D-11/D-13/D-16 require
// (iloc base/offset rewrite for shifted mdat, minimal Exif synthesis, ICC property removal).
// Every function here is a pure byte-producing transform over already-buffered `metaPayload`
// bytes and plain data the caller (`plan.ts`) has already computed -- none of these touch a file
// handle.
/** A plain (non-FullBox) box header: size(32) type(32) payload. */
export function plainBoxHeader(type, payloadLength) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payloadLength, 0);
    header.write(type, 4, "ascii");
    return header;
}
/** A FullBox header: size(32) type(32) version(8) flags(24). */
export function fullBoxHeader(type, version, flags, payloadLength) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(12 + payloadLength, 0);
    header.write(type, 4, "ascii");
    header.writeUInt8(version, 8);
    header.writeUIntBE(flags & 0x00ffffff, 9, 3);
    return header;
}
function writeSizedUint(value, width) {
    if (width === 0)
        return Buffer.alloc(0);
    if (width === 4) {
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32BE(value, 0);
        return buffer;
    }
    if (width === 8) {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64BE(BigInt(value), 0);
        return buffer;
    }
    throw new Error(`rebuild: unsupported field width ${width}`);
}
/**
 * Rebuild `iinf`: entry_count recomputed to the surviving count, surviving `infe` boxes copied
 * verbatim from `metaPayload` in their original (iinf) order (D-14). `infeOverrides` (D-13):
 * when present for an item id, its already-built `infe` bytes replace the verbatim copy -- used
 * only for the minimal Exif item k, whose rewritten `infe` (empty name, item_protection_index 0)
 * must never be the source's own bytes.
 */
export function rebuildIinf(metaPayload, version, survivingItemIds, infeRanges, infeOverrides) {
    const entryCountBytes = version === 0 ? 2 : 4;
    const infeBuffers = survivingItemIds.map((id) => {
        const override = infeOverrides?.get(id);
        if (override !== undefined)
            return override;
        const range = infeRanges.get(id);
        if (range === undefined) {
            throw new Error(`rebuildIinf: no infe range for surviving item ${id}`);
        }
        return metaPayload.subarray(range.start, range.end);
    });
    const entryCount = Buffer.alloc(entryCountBytes);
    if (entryCountBytes === 2)
        entryCount.writeUInt16BE(survivingItemIds.length, 0);
    else
        entryCount.writeUInt32BE(survivingItemIds.length, 0);
    const payload = Buffer.concat([entryCount, ...infeBuffers]);
    return Buffer.concat([
        fullBoxHeader("iinf", version, 0, payload.length),
        payload,
    ]);
}
/**
 * Rebuild `iloc`: source version and the four field widths are written unchanged (D-11). Surviving
 * items are re-emitted in their original order; a `rewrites` entry replaces that item's base_offset
 * and per-extent offset values, everything else (construction_method, data_reference_index,
 * extent_index, extent_length) is copied from the item unchanged. An item with no `rewrites` entry
 * (construction_method 1, e.g. the grid descriptor) is copied byte-verbatim (D-11).
 */
export function rebuildIloc(version, offsetSize, lengthSize, baseOffsetSize, indexSize, items, rewrites) {
    const itemCountBytes = version === 2 ? 4 : 2;
    const parts = [
        Buffer.from([((offsetSize & 0xf) << 4) | (lengthSize & 0xf)]),
        Buffer.from([((baseOffsetSize & 0xf) << 4) | (indexSize & 0xf)]),
    ];
    const itemCount = Buffer.alloc(itemCountBytes);
    if (itemCountBytes === 4)
        itemCount.writeUInt32BE(items.length, 0);
    else
        itemCount.writeUInt16BE(items.length, 0);
    parts.push(itemCount);
    const hasConstructionMethod = version === 1 || version === 2;
    const hasIndexField = (version === 1 || version === 2) && indexSize > 0;
    for (const item of items) {
        const idBuffer = Buffer.alloc(version === 2 ? 4 : 2);
        if (version === 2)
            idBuffer.writeUInt32BE(item.id, 0);
        else
            idBuffer.writeUInt16BE(item.id, 0);
        parts.push(idBuffer);
        if (hasConstructionMethod) {
            const cm = Buffer.alloc(2);
            cm.writeUInt16BE(item.constructionMethod & 0xf, 0);
            parts.push(cm);
        }
        const dataRef = Buffer.alloc(2);
        dataRef.writeUInt16BE(item.dataReferenceIndex, 0);
        parts.push(dataRef);
        const rewrite = rewrites.get(item.id);
        const baseOffset = rewrite !== undefined ? rewrite.newBaseOffset : item.baseOffset;
        parts.push(writeSizedUint(baseOffset, baseOffsetSize));
        const extentCount = Buffer.alloc(2);
        extentCount.writeUInt16BE(item.extents.length, 0);
        parts.push(extentCount);
        item.extents.forEach((extent, index) => {
            if (hasIndexField)
                parts.push(writeSizedUint(extent.index, indexSize));
            const offset = rewrite !== undefined ? rewrite.extentOffsets[index] : extent.offset;
            parts.push(writeSizedUint(offset, offsetSize));
            parts.push(writeSizedUint(extent.length, lengthSize));
        });
    }
    const payload = Buffer.concat(parts);
    return Buffer.concat([
        fullBoxHeader("iloc", version, 0, payload.length),
        payload,
    ]);
}
/** Rebuild `iref`: source version, every record whose from-item survives is re-emitted verbatim. */
export function rebuildIref(version, references) {
    const idBytes = version === 0 ? 2 : 4;
    const parts = [];
    for (const reference of references) {
        const typeBuffer = Buffer.alloc(4);
        typeBuffer.write(reference.type, 0, "ascii");
        const fromBuffer = Buffer.alloc(idBytes);
        if (idBytes === 2)
            fromBuffer.writeUInt16BE(reference.fromItemId, 0);
        else
            fromBuffer.writeUInt32BE(reference.fromItemId, 0);
        const countBuffer = Buffer.alloc(2);
        countBuffer.writeUInt16BE(reference.toItemIds.length, 0);
        const toBuffers = reference.toItemIds.map((id) => {
            const buffer = Buffer.alloc(idBytes);
            if (idBytes === 2)
                buffer.writeUInt16BE(id, 0);
            else
                buffer.writeUInt32BE(id, 0);
            return buffer;
        });
        const recordPayload = Buffer.concat([
            fromBuffer,
            countBuffer,
            ...toBuffers,
        ]);
        const recordSize = Buffer.alloc(4);
        recordSize.writeUInt32BE(8 + recordPayload.length, 0);
        parts.push(recordSize, typeBuffer, recordPayload);
    }
    const payload = Buffer.concat(parts);
    return Buffer.concat([
        fullBoxHeader("iref", version, 0, payload.length),
        payload,
    ]);
}
/** Rebuild `ipma`: source version/flags, surviving entries only, associations copied unchanged. */
export function rebuildIpma(version, flags, entries) {
    const itemIdBytes = version === 0 ? 2 : 4;
    const wide = (flags & 1) === 1;
    const parts = [];
    const entryCount = Buffer.alloc(4);
    entryCount.writeUInt32BE(entries.length, 0);
    parts.push(entryCount);
    for (const entry of entries) {
        const idBuffer = Buffer.alloc(itemIdBytes);
        if (itemIdBytes === 2)
            idBuffer.writeUInt16BE(entry.itemId, 0);
        else
            idBuffer.writeUInt32BE(entry.itemId, 0);
        parts.push(idBuffer);
        const countBuffer = Buffer.alloc(1);
        countBuffer.writeUInt8(entry.associations.length, 0);
        parts.push(countBuffer);
        for (const association of entry.associations) {
            if (wide) {
                const buffer = Buffer.alloc(2);
                buffer.writeUInt16BE((association.essential ? 0x8000 : 0) |
                    (association.propertyIndex & 0x7fff), 0);
                parts.push(buffer);
            }
            else {
                const buffer = Buffer.alloc(1);
                buffer.writeUInt8((association.essential ? 0x80 : 0) |
                    (association.propertyIndex & 0x7f), 0);
                parts.push(buffer);
            }
        }
    }
    const payload = Buffer.concat(parts);
    return Buffer.concat([
        fullBoxHeader("ipma", version, flags, payload.length),
        payload,
    ]);
}
/**
 * D-13: build the minimal Exif item k's rewritten `infe` -- same `version` (2 or 3) and `hidden`
 * flag (bit 0) as the source, `item_protection_index` forced to 0, `item_type` "Exif", and an
 * **empty** `item_name` (one NUL byte). Never copies anything from the source's own `infe` bytes:
 * this is the one item the writer always re-synthesizes rather than re-emits verbatim, so no
 * residue (a free-text name, a non-zero protection index) can survive into the output.
 */
export function buildMinimalExifInfe(version, hidden, itemId) {
    const idBytes = version === 2 ? 2 : 4;
    const idBuffer = Buffer.alloc(idBytes);
    if (idBytes === 2)
        idBuffer.writeUInt16BE(itemId, 0);
    else
        idBuffer.writeUInt32BE(itemId, 0);
    const payload = Buffer.concat([
        idBuffer,
        Buffer.from([0, 0]), // item_protection_index = 0
        Buffer.from("Exif", "ascii"),
        Buffer.from([0]), // item_name: empty C-string
    ]);
    return Buffer.concat([
        fullBoxHeader("infe", version, hidden ? 1 : 0, payload.length),
        payload,
    ]);
}
/**
 * Rebuild `ipco`: a plain box (not a FullBox) whose children are each surviving property's own
 * verbatim bytes, re-emitted in the source's own declaration order (D-16) -- `propertyBytes`
 * already excludes any removed ICC (`colr` prof/rICC) property's bytes; every other property
 * (including every `nclx` `colr` property) is passed through unchanged.
 */
export function rebuildIpco(propertyBytes) {
    const payload = Buffer.concat(propertyBytes);
    return Buffer.concat([plainBoxHeader("ipco", payload.length), payload]);
}
/**
 * Rebuild `iprp`: a plain box whose children are re-emitted in source order -- `ipco` rebuilt via
 * `rebuildIpco` (D-16: verbatim when nothing is removed, so bytes stay identical to the source),
 * `ipma` substituted with its rebuilt bytes when present.
 */
export function rebuildIprp(childOrder, ipcoBytes, ipmaBytes) {
    const parts = [];
    for (const type of childOrder) {
        if (type === "ipco")
            parts.push(ipcoBytes);
        else if (ipmaBytes !== undefined)
            parts.push(ipmaBytes);
    }
    const payload = Buffer.concat(parts);
    return Buffer.concat([plainBoxHeader("iprp", payload.length), payload]);
}
//# sourceMappingURL=rebuild.js.map