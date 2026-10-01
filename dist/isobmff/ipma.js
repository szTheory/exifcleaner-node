import { IsobmffStructureError } from "./errors.js";
export const IPMA_LAYOUTS = Object.freeze({
    "0:0": { itemIdBytes: 2, associationBytes: 1, indexBits: 7 },
    "0:1": { itemIdBytes: 2, associationBytes: 2, indexBits: 15 },
    "1:0": { itemIdBytes: 4, associationBytes: 1, indexBits: 7 },
    "1:1": { itemIdBytes: 4, associationBytes: 2, indexBits: 15 },
});
export function parseIpma(_payload, _version, _flags) {
    throw new IsobmffStructureError("box-framing", "parseIpma: not implemented (RED).");
}
//# sourceMappingURL=ipma.js.map