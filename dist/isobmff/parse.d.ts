import type { FileHandle } from "node:fs/promises";
import { type IsobmffCaps } from "./caps.js";
import { type BoxHeader } from "./boxes.js";
import type { IlocTable } from "./iloc.js";
import type { IpmaEntry } from "./ipma.js";
import { type IsobmffByteRange, type IsobmffEntityGroup, type IsobmffItem, type IsobmffItemLayout, type IsobmffProperty, type IsobmffReference } from "./items.js";
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
    /** `meta/iprp`'s `ipma` child, resolved through the table-driven resolver (61-05, D1). */
    readonly ipma?: readonly IpmaEntry[];
    /** The validated item graph (61-07, D1): `iinf`/`infe` joined with `iloc`, `iref`, `ipco`/
     * `ipma`, `idat` and `grpl`, in `iinf` order. */
    readonly items: readonly IsobmffItem[];
    readonly itemsById: ReadonlyMap<number, IsobmffItem>;
    readonly primaryItemId: number;
    readonly references: readonly IsobmffReference[];
    readonly properties: readonly IsobmffProperty[];
    readonly groups: readonly IsobmffEntityGroup[];
    readonly idatRange?: IsobmffByteRange;
    readonly handlerType: string;
    /** The primary item's `colr` ICC payload (colour_type `prof`/`rICC` only); `nclx` or absent
     * yields `undefined` (D-12). */
    readonly colorProfile?: Buffer;
    /** Phase 62 writer layout (D-11..D-14): top-level box ranges plus `meta`'s own buffered payload
     * and item-graph layout, everything the rebuild encoders need, all already read once by this
     * same `parseIsobmff` call -- no new file reads. */
    readonly layout: IsobmffLayout;
}
export interface IsobmffLayout {
    /** Every top-level box, in source order (header ranges are file-absolute). */
    readonly topLevelBoxes: readonly BoxHeader[];
    /** File offset of `meta`'s own box start. */
    readonly metaOffset: number;
    /** Bytes of `meta`'s own box header (size+type, plus largesize/usertype if present) --
     * excludes the 4-byte FullBox version/flags field, which is the first 4 bytes of
     * `metaPayload` below. */
    readonly metaHeaderSize: number;
    /** `meta`'s already-buffered, cap-bounded FullBox payload (version/flags + children), the
     * exact buffer `parseIsobmff` read once under `budget.checkMetaSize`. */
    readonly metaPayload: Buffer;
    readonly item: IsobmffItemLayout;
}
export declare function parseIsobmff(handle: FileHandle, size: number, caps?: IsobmffCaps, signal?: AbortSignal): Promise<IsobmffModel>;
//# sourceMappingURL=parse.d.ts.map