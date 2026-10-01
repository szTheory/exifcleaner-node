import type { FileHandle } from "node:fs/promises";
import { type IsobmffCaps } from "./caps.js";
import { type IsobmffDeclineClass } from "./errors.js";
import { type IsobmffModel, type IsobmffRange } from "./parse.js";
import type { FormatAdmission } from "../admission/handler.js";
/** D3/D7: image item types this engine preserves verbatim, never decodes. */
export declare const PRESERVED_ITEM_TYPES: ReadonlySet<string>;
/** D-07: the only `mime` content types admitted as a removable XMP item. */
export declare const XMP_CONTENT_TYPES: readonly string[];
/**
 * BMF-03: the fixed rule order `classifyIsobmffModel` evaluates in, after every parse-time
 * decline (box framing, cap breaches, item-graph validity -- all already thrown by the time a
 * caller has an `IsobmffModel` to pass in). Within each rule, items are visited in `iinf`
 * declaration order (`model.items`'s own order, per 61-07); the first violation is thrown.
 */
export declare const DECLINE_RULE_ORDER: readonly IsobmffDeclineClass[];
export interface IsobmffDisposition {
    readonly removableItemIds: readonly number[];
    /** Subset of `removableItemIds` whose extents are all length 0 (or `extent_count` 0, D-10a):
     * admitted, but removing them writes zero bytes. */
    readonly emptiedItemIds: readonly number[];
    readonly survivingItemIds: readonly number[];
    /** Top-level boxes admitted as removable (currently: the C2PA `uuid` box, D5). */
    readonly removableTopLevel: readonly IsobmffRange[];
}
export interface IsobmffAdmission extends FormatAdmission {
    readonly model: IsobmffModel;
    readonly classification: IsobmffDisposition;
}
/**
 * Pure classifier over an already-parsed `IsobmffModel` (BMF-03/BMF-04). Throws
 * `IsobmffStructureError` for the first `DECLINE_RULE_ORDER` violation (iinf order within each
 * rule), else returns the admitted disposition.
 */
export declare function classifyIsobmffModel(model: IsobmffModel, fileSize: number): IsobmffDisposition;
/**
 * Parse, classify, and read back the non-emptied removable items' own bytes (Exif/XMP), assembling
 * a `FormatAdmission`-shaped result (D-12). Every payload read is guarded by
 * `budget.consumeBuffered(length)` for that exact length, immediately before the matching
 * `readExactly` call (T-61-25) -- the only reads this function performs outside `meta`.
 */
export declare function admitIsobmff(handle: FileHandle, size: number, signal?: AbortSignal, caps?: IsobmffCaps): Promise<IsobmffAdmission>;
//# sourceMappingURL=admission.d.ts.map