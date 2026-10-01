export declare const ISOBMFF_MAX_META_BYTES: number;
export declare const ISOBMFF_MAX_BOX_COUNT = 65536;
export declare const ISOBMFF_MAX_BOX_DEPTH = 8;
export declare const ISOBMFF_MAX_BUFFERED_BYTES_TOTAL: number;
export interface IsobmffCaps {
    readonly maxMetaBytes: number;
    readonly maxBoxCount: number;
    readonly maxBoxDepth: number;
    readonly maxBufferedBytesTotal: number;
}
export declare const DEFAULT_ISOBMFF_CAPS: IsobmffCaps;
/**
 * Running counters checked against an `IsobmffCaps` before the read/descent they guard. One
 * instance is threaded through an entire `parseIsobmff` call so box count and buffered bytes
 * accumulate across the whole file, not per-container.
 */
export declare class IsobmffBudget {
    #private;
    constructor(caps?: IsobmffCaps);
    /** Check a declared `meta` payload size before that payload is read into memory. */
    checkMetaSize(size: number): void;
    /** Record one more box before it is recorded in a box list. */
    countBox(): void;
    /** Check a container descent's depth before descending into it. */
    checkDepth(depth: number): void;
    /** Check an aggregate buffered-byte total before buffering `n` more bytes (wired in 61-08). */
    consumeBuffered(n: number): void;
    boxCount(): number;
    bufferedBytes(): number;
}
//# sourceMappingURL=caps.d.ts.map