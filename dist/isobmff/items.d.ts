import type { IsobmffBudget } from "./caps.js";
import { type BoxHeader } from "./boxes.js";
import { type IlocExtent, type IlocTable } from "./iloc.js";
import { type IpmaEntry } from "./ipma.js";
export interface IsobmffItemPropertyAssociation {
    readonly index: number;
    readonly essential: boolean;
}
export interface IsobmffItem {
    readonly id: number;
    /** `item_type_4cc` from a v2/v3 `infe` (e.g. "hvc1", "av01", "grid", "Exif", "mime", "uri "). */
    readonly type: string;
    readonly name: string;
    /** Only present when `type === "mime"`. */
    readonly contentType?: string;
    /** Only present when `type === "mime"`. */
    readonly contentEncoding?: string;
    /** Only present when `type === "uri "`. */
    readonly uri?: string;
    readonly hidden: boolean;
    /** 0 for a v0 `iloc` item (the field does not exist there) or a v1/v2 item without an `iloc` entry. */
    readonly constructionMethod: number;
    readonly dataReferenceIndex: number;
    readonly baseOffset: number;
    /** Literal `iloc` extents (D-10a: a `length: 0` extent is an empty extent, never rebased). */
    readonly extents: readonly IlocExtent[];
    readonly properties: readonly IsobmffItemPropertyAssociation[];
}
/** One `iref` `SingleItemTypeReferenceBox` record: `type` is the record's own box type. */
export interface IsobmffReference {
    readonly type: string;
    readonly fromItemId: number;
    readonly toItemIds: readonly number[];
}
/** One `ipco` property, 1-based index order (the index `ipma` associations refer to). */
export interface IsobmffProperty {
    readonly index: number;
    readonly type: string;
    readonly start: number;
    readonly end: number;
    /** Only present for an `auxC` property: the `aux_type` URN string. */
    readonly auxUrn?: string;
    /** Only present for a `colr` property: its `colour_type` ("nclx", "prof", or "rICC"). */
    readonly colourType?: string;
}
export interface IsobmffEntityGroup {
    readonly type: string;
    readonly groupId: number;
    readonly entityIds: readonly number[];
}
export interface IsobmffByteRange {
    readonly offset: number;
    readonly length: number;
}
export interface IsobmffItemModel {
    readonly items: readonly IsobmffItem[];
    readonly itemsById: ReadonlyMap<number, IsobmffItem>;
    readonly primaryItemId: number;
    readonly references: readonly IsobmffReference[];
    readonly properties: readonly IsobmffProperty[];
    readonly groups: readonly IsobmffEntityGroup[];
    readonly idatRange?: IsobmffByteRange;
    readonly handlerType: string;
    /** The primary item's `colr` ICC payload (colour_type `prof`/`rICC` only), copied out of
     * `metaPayload`. `nclx` or no `colr` property on the primary item yields `undefined` (D-12). */
    readonly colorProfile?: Buffer;
    /** Raw resolved `iloc` table -- `parseIsobmff` reuses this for its existing `model.iloc` field
     * (61-05) rather than parsing `iloc` a second time. */
    readonly ilocTable: IlocTable;
    /** Raw resolved `ipma` entries -- `parseIsobmff` reuses this for its existing `model.ipma`
     * field (61-05) rather than parsing `ipma` a second time. */
    readonly ipmaEntries: readonly IpmaEntry[];
    /** Phase 62 writer layout (D-11..D-14): the raw box ranges and FullBox version/flags the
     * rebuild encoders (`src/isobmff/rebuild.ts`) need to re-emit `meta`'s children with removed
     * items dropped. Every range is relative to `metaPayload` (the buffer `parseIsobmff` already
     * read once under `budget.checkMetaSize`) -- no new file reads. */
    readonly layout: IsobmffItemLayout;
}
/** Phase 62 writer layout (D-11..D-14), returned by `buildItemModel`. */
export interface IsobmffItemLayout {
    /** `meta`'s direct children, in source order, each range relative to `metaPayload`. */
    readonly metaChildren: readonly BoxHeader[];
    readonly iinfVersion: number;
    /** Each surviving item's whole `infe` box range (header + payload), relative to `metaPayload`. */
    readonly infeRanges: ReadonlyMap<number, BoxHeader>;
    readonly ilocVersion: number;
    readonly ilocOffsetSize: number;
    readonly ilocLengthSize: number;
    readonly ilocBaseOffsetSize: number;
    readonly ilocIndexSize: number;
    /** Undefined when `meta` has no `iref` child. */
    readonly irefVersion?: number;
    /** `iprp`'s direct children (`ipco`/`ipma`), in source order, relative to `metaPayload`. Empty
     * when `meta` has no `iprp` child. */
    readonly iprpChildren: readonly BoxHeader[];
    /** Undefined when `iprp` has no `ipma` child. */
    readonly ipmaVersion?: number;
    readonly ipmaFlags?: number;
}
/**
 * Build the validated item graph from `meta`'s already-walked children (`parseIsobmff` passes
 * `metaChildren` = `listSiblings(metaPayload, 4, metaPayload.length)`, the same buffer and list
 * its own structural walk already covered under `budget`). Declines `unknown-meta-child` for any
 * child outside the admitted set, `item-graph-invalid` for a missing `hdlr`/`pitm`/`iinf`/`iloc`,
 * a duplicate `item_ID` in `iinf`/`iloc`/`ipma`, or any dangling id (`iloc` entry, `pitm`, or
 * `iref` naming an item `iinf` never declared), `meta-handler-not-pict` for a non-`pict` `hdlr`,
 * and `unsupported-box-version` for an unadmitted `infe`/`iinf`/`iref`/`pitm` version.
 */
export declare function buildItemModel(metaPayload: Buffer, metaChildren: readonly BoxHeader[], _budget: IsobmffBudget): IsobmffItemModel;
//# sourceMappingURL=items.d.ts.map