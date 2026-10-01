import type { FileHandle } from "node:fs/promises";
import type { IsobmffBudget } from "./caps.js";
export interface BoxHeader {
    readonly type: string;
    readonly start: number;
    readonly headerSize: number;
    /** Total box size (header + payload), in bytes. */
    readonly size: number;
    readonly payloadStart: number;
    readonly end: number;
    /** Only present when `type === "uuid"`; lower-case hex, 32 characters (16 bytes). */
    readonly usertype?: string;
}
/** The container box types this walker recurses into (61-CONTEXT.md). */
export declare const CONTAINER_BOXES: ReadonlySet<string>;
export declare const TOP_LEVEL_ALLOWLIST: ReadonlySet<string>;
/** C2PA's registered `uuid` usertype (lower-case hex, no dashes), the one `uuid` box admitted at
 * the top level (D5) -- `d8fec3d6-1b0e-483c-9297-5828877ec481`. */
export declare const C2PA_UUID_USERTYPE = "d8fec3d61b0e483c92975828877ec481";
export declare function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer>;
/**
 * Decode an ISOBMFF box header from an in-memory buffer at `offset`, bounded by `end` (the
 * enclosing container's end, exclusive of anything past it). `size == 0` is never legal here
 * (reserved for the top-level `mdat` box, via `readTopLevelBoxes`).
 */
export declare function parseBoxHeader(buffer: Buffer, offset: number, end: number): BoxHeader;
/**
 * Read every top-level box's header (never its payload) from `handle`, bounded by `fileSize`.
 * `budget.countBox()` is checked before each header is recorded (BMF-05: declared values are
 * checked before the read/descent they guard, not after). The first box must be `ftyp`.
 */
export declare function readTopLevelBoxes(handle: FileHandle, fileSize: number, budget: IsobmffBudget): Promise<readonly BoxHeader[]>;
/**
 * Walk an in-memory container's children (`start`..`end` within `buffer`), checking
 * `budget.checkDepth(depth)` before processing this level and `budget.countBox()` before each
 * child is recorded. Recurses into any child whose type is in `CONTAINER_BOXES`, skipping the
 * 4-byte version/flags field first for `FULLBOX_CONTAINERS` members -- this walks structure only
 * (box framing, count, depth); per-box grammar (`iinf`'s `infe` entries, `iref`'s reference
 * records, etc.) is resolved by later plans.
 */
export declare function walkContainer(buffer: Buffer, start: number, end: number, depth: number, budget: IsobmffBudget): readonly BoxHeader[];
//# sourceMappingURL=boxes.d.ts.map