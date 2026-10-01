import { IsobmffStructureError } from "./errors.js";
export const ILOC_LAYOUTS = Object.freeze({
    0: {
        itemCountBytes: 2,
        itemIdBytes: 2,
        hasConstructionMethod: false,
        hasIndexSize: false,
    },
    1: {
        itemCountBytes: 2,
        itemIdBytes: 2,
        hasConstructionMethod: true,
        hasIndexSize: true,
    },
    2: {
        itemCountBytes: 4,
        itemIdBytes: 4,
        hasConstructionMethod: true,
        hasIndexSize: true,
    },
});
export const ILOC_FIELD_WIDTHS = new Set([0, 4, 8]);
export function readSizedUint(_buffer, _position, _width) {
    throw new IsobmffStructureError("box-framing", "readSizedUint: not implemented (RED).");
}
export function parseIloc(_payload, _version, _flags) {
    throw new IsobmffStructureError("box-framing", "parseIloc: not implemented (RED).");
}
//# sourceMappingURL=iloc.js.map