/** Per-version `iloc` field presence/width, keyed by the FullBox `version` (0, 1, 2). */
export interface IlocVersionLayout {
    readonly itemCountBytes: 2 | 4;
    readonly itemIdBytes: 2 | 4;
    readonly hasConstructionMethod: boolean;
    readonly hasIndexSize: boolean;
}
export declare const ILOC_LAYOUTS: Readonly<Record<0 | 1 | 2, IlocVersionLayout>>;
/** The only field widths `iloc` (and `ipma`) nibbles are admitted to declare (D-18 fail-closed). */
export declare const ILOC_FIELD_WIDTHS: ReadonlySet<number>;
export interface IlocExtent {
    readonly index: number;
    readonly offset: number;
    readonly length: number;
}
export interface IlocItem {
    readonly itemId: number;
    /** 0 for every v0 item (the field does not exist in v0, per the Grammar). */
    readonly constructionMethod: number;
    readonly dataReferenceIndex: number;
    readonly baseOffset: number;
    readonly extents: readonly IlocExtent[];
}
export interface IlocTable {
    readonly version: 0 | 1 | 2;
    readonly offsetSize: number;
    readonly lengthSize: number;
    readonly baseOffsetSize: number;
    readonly indexSize: number;
    readonly items: readonly IlocItem[];
}
/**
 * Read a width-gated unsigned integer at `position` in `buffer`. Width 0 reads nothing and
 * returns 0; width 4 is `readUInt32BE`; width 8 is `readBigUInt64BE`, declining
 * `extent-outside-mdat` for any value above `Number.MAX_SAFE_INTEGER` (never a lossy `Number()`
 * cast past that point -- BMF-05's precision edge) and returning the exact integer at or below it.
 * Any other width (an `iloc`/`ipma` nibble outside `{0, 4, 8}`) declines `box-framing` -- this
 * engine fails closed where libheif itself silently treats such a width as 0 (documented
 * divergence, docs/isobmff.md `## Grammar`).
 */
export declare function readSizedUint(buffer: Buffer, position: number, width: number): number;
/**
 * Parse an `iloc` box's payload (the bytes immediately after the FullBox version/flags, which the
 * caller has already stripped -- `parseIsobmff` reads them once per D1). `version`/`flags` come
 * from that same FullBox header. Declines `unsupported-box-version` for anything outside
 * `{0, 1, 2}`, `box-framing` for a width nibble outside `{0, 4, 8}`, a truncated field or item
 * table, or an `item_count` the remaining payload could not possibly hold (checked before any
 * per-item allocation).
 */
export declare function parseIloc(payload: Buffer, version: number, _flags: number): IlocTable;
//# sourceMappingURL=iloc.d.ts.map