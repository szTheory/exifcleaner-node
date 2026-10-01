import type { FileHandle } from "node:fs/promises";
import { type IsobmffCaps } from "./caps.js";
import { type IlocTable } from "./iloc.js";
export interface IsobmffRange {
    readonly offset: number;
    readonly length: number;
}
export interface IsobmffModel {
    readonly majorBrand: string;
    readonly minorVersion: number;
    readonly compatibleBrands: readonly string[];
    readonly topLevel: readonly {
        readonly type: string;
    }[];
    readonly metaRange: IsobmffRange;
    readonly mdatRanges: readonly IsobmffRange[];
    /** Top-level boxes admitted as removable (currently: the C2PA `uuid` box, D5). */
    readonly removableTopLevel: readonly IsobmffRange[];
    /** `meta`'s `iloc` child, resolved through the table-driven resolver (61-05, D1). */
    readonly iloc?: IlocTable;
}
export declare function parseIsobmff(handle: FileHandle, size: number, caps?: IsobmffCaps, signal?: AbortSignal): Promise<IsobmffModel>;
//# sourceMappingURL=parse.d.ts.map