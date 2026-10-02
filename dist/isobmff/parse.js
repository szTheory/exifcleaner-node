import { IsobmffStructureError } from "./errors.js";
import { DEFAULT_ISOBMFF_CAPS, IsobmffBudget, } from "./caps.js";
import { C2PA_UUID_USERTYPE, parseBoxHeader, readExactly, readTopLevelBoxes, TOP_LEVEL_ALLOWLIST, walkContainer, } from "./boxes.js";
import { buildItemModel, } from "./items.js";
function isAborted(signal) {
    return signal?.aborted ?? false;
}
/**
 * List one container level's direct children from an already-buffered payload, using only
 * `parseBoxHeader` (no budget checks -- the structural walk via `walkContainer` already enforced
 * every cap for this same buffer). Used to locate specific item-table boxes (`iloc`, `iprp`'s
 * `ipma`) that `walkContainer` itself does not surface outside its own recursion.
 */
function listSiblings(buffer, start, end) {
    const boxes = [];
    let position = start;
    while (position < end) {
        const header = parseBoxHeader(buffer, position, end);
        boxes.push(header);
        position = header.end;
    }
    return boxes;
}
function parseFtyp(payload) {
    if (payload.length < 8) {
        throw new IsobmffStructureError("box-framing", "ftyp payload is shorter than its required major_brand/minor_version fields.");
    }
    const majorBrand = payload.toString("ascii", 0, 4);
    const minorVersion = payload.readUInt32BE(4);
    const compatibleBrands = [];
    for (let offset = 8; offset + 4 <= payload.length; offset += 4) {
        compatibleBrands.push(payload.toString("ascii", offset, offset + 4));
    }
    return { majorBrand, minorVersion, compatibleBrands };
}
export async function parseIsobmff(handle, size, caps = DEFAULT_ISOBMFF_CAPS, signal) {
    const budget = new IsobmffBudget(caps);
    const topLevel = await readTopLevelBoxes(handle, size, budget);
    let majorBrand;
    let minorVersion = 0;
    let compatibleBrands = [];
    let metaRange;
    const mdatRanges = [];
    const removableTopLevel = [];
    let sawFtyp = false;
    let sawMeta = false;
    let sawMdat = false;
    let iloc;
    let ipma;
    let itemModel;
    for (const header of topLevel) {
        if (isAborted(signal)) {
            throw new IsobmffStructureError("box-framing", "Parsing aborted.");
        }
        if (header.type === "ftyp") {
            if (sawFtyp) {
                throw new IsobmffStructureError("box-framing", 'A second top-level "ftyp" box is not permitted.');
            }
            sawFtyp = true;
            const payload = await readExactly(handle, header.end - header.payloadStart, header.payloadStart);
            const parsed = parseFtyp(payload);
            majorBrand = parsed.majorBrand;
            minorVersion = parsed.minorVersion;
            compatibleBrands = parsed.compatibleBrands;
            continue;
        }
        if (header.type === "meta") {
            if (sawMeta) {
                throw new IsobmffStructureError("duplicate-meta", 'A second top-level "meta" box is not permitted.');
            }
            sawMeta = true;
            const payloadLength = header.end - header.payloadStart;
            budget.checkMetaSize(payloadLength);
            const payload = await readExactly(handle, payloadLength, header.payloadStart);
            if (payload.length < 4) {
                throw new IsobmffStructureError("meta-not-fullbox", "meta payload is too short to carry a FullBox version/flags field.");
            }
            const versionFlags = payload.readUInt32BE(0);
            if (versionFlags !== 0) {
                throw new IsobmffStructureError("meta-not-fullbox", "meta is not a version-0 FullBox (QuickTime-style meta or an unsupported meta version).");
            }
            walkContainer(payload, 4, payload.length, 1, budget);
            const metaChildren = listSiblings(payload, 4, payload.length);
            itemModel = buildItemModel(payload, metaChildren, budget);
            iloc = itemModel.ilocTable;
            ipma = itemModel.ipmaEntries;
            metaRange = { offset: header.start, length: header.end - header.start };
            continue;
        }
        if (header.type === "mdat") {
            if (sawMdat) {
                throw new IsobmffStructureError("multiple-mdat", 'A second top-level "mdat" box is not permitted.');
            }
            sawMdat = true;
            mdatRanges.push({
                offset: header.payloadStart,
                length: header.end - header.payloadStart,
            });
            continue;
        }
        if (header.type === "moov") {
            throw new IsobmffStructureError("sequence-box", 'A top-level "moov" box indicates a sequence/fragmented file, which is not admitted.');
        }
        if (TOP_LEVEL_ALLOWLIST.has(header.type)) {
            // free / skip: admitted, structurally inert.
            continue;
        }
        if (header.type === "uuid" && header.usertype === C2PA_UUID_USERTYPE) {
            removableTopLevel.push({
                offset: header.start,
                length: header.end - header.start,
            });
            continue;
        }
        throw new IsobmffStructureError("top-level-box-not-allowed", `Top-level box "${header.type}" is not in the admitted set.`);
    }
    if (majorBrand === undefined) {
        throw new IsobmffStructureError("box-framing", 'No top-level "ftyp" box was found.');
    }
    if (metaRange === undefined || itemModel === undefined) {
        // A missing top-level `meta` is a missing required item-graph component, the same family as
        // a missing `hdlr`/`pitm`/`iinf`/`iloc` inside an existing `meta` (items.ts's buildItemModel,
        // all `item-graph-invalid`) -- not a byte-framing defect (61-09, D-14 BMF-03 empty-input edge).
        throw new IsobmffStructureError("item-graph-invalid", 'No top-level "meta" box was found.');
    }
    return {
        majorBrand,
        minorVersion,
        compatibleBrands,
        topLevel: topLevel.map((header) => ({ type: header.type })),
        metaRange,
        mdatRanges,
        removableTopLevel,
        ...(iloc !== undefined ? { iloc } : {}),
        ...(ipma !== undefined ? { ipma } : {}),
        items: itemModel.items,
        itemsById: itemModel.itemsById,
        primaryItemId: itemModel.primaryItemId,
        references: itemModel.references,
        properties: itemModel.properties,
        groups: itemModel.groups,
        ...(itemModel.idatRange !== undefined
            ? { idatRange: itemModel.idatRange }
            : {}),
        handlerType: itemModel.handlerType,
        ...(itemModel.colorProfile !== undefined
            ? { colorProfile: itemModel.colorProfile }
            : {}),
    };
}
//# sourceMappingURL=parse.js.map