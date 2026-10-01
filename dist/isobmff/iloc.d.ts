export interface IlocVersionLayout {
    readonly itemCountBytes: 2 | 4;
    readonly itemIdBytes: 2 | 4;
    readonly hasConstructionMethod: boolean;
    readonly hasIndexSize: boolean;
}
export declare const ILOC_LAYOUTS: Readonly<Record<0 | 1 | 2, IlocVersionLayout>>;
export declare const ILOC_FIELD_WIDTHS: ReadonlySet<number>;
export interface IlocExtent {
    readonly index: number;
    readonly offset: number;
    readonly length: number;
}
export interface IlocItem {
    readonly itemId: number;
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
export declare function readSizedUint(_buffer: Buffer, _position: number, _width: number): number;
export declare function parseIloc(_payload: Buffer, _version: number, _flags: number): IlocTable;
//# sourceMappingURL=iloc.d.ts.map