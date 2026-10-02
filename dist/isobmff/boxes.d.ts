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
    /**
     * How the declared 32-bit size field actually read (Phase 62 D-15): `"normal"` is an ordinary
     * non-zero declared size (`headerSize` 8); `"largesize"` is the `size == 1` + 64-bit largesize
     * form (`headerSize` 16); `"size-zero"` is the literal declared-0 "extends to end" form
     * (`headerSize` 8, same as `"normal"` -- this field is the only way to tell them apart). The
     * ISOBMFF writer (`src/isobmff/plan.ts`) uses this to keep `mdat`'s own header in the source's
     * form rather than widening/narrowing it.
     */
    readonly sizeForm: "normal" | "largesize" | "size-zero";
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