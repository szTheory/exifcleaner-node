import type { BoxHeader } from "./boxes.js";
import type { IsobmffItem, IsobmffReference } from "./items.js";
/** A plain (non-FullBox) box header: size(32) type(32) payload. */
export declare function plainBoxHeader(type: string, payloadLength: number): Buffer;
/** A FullBox header: size(32) type(32) version(8) flags(24). */
export declare function fullBoxHeader(type: string, version: number, flags: number, payloadLength: number): Buffer;
/**
 * Rebuild `iinf`: entry_count recomputed to the surviving count, surviving `infe` boxes copied
 * verbatim from `metaPayload` in their original (iinf) order (D-14). `infeOverrides` (D-13):
 * when present for an item id, its already-built `infe` bytes replace the verbatim copy -- used
 * only for the minimal Exif item k, whose rewritten `infe` (empty name, item_protection_index 0)
 * must never be the source's own bytes.
 */
export declare function rebuildIinf(metaPayload: Buffer, version: number, survivingItemIds: readonly number[], infeRanges: ReadonlyMap<number, BoxHeader>, infeOverrides?: ReadonlyMap<number, Buffer>): Buffer;
export interface IlocRewrite {
    readonly newBaseOffset: number;
    /** Same order/count as the item's own `extents` array. */
    readonly extentOffsets: readonly number[];
}
/**
 * Rebuild `iloc`: source version and the four field widths are written unchanged (D-11). Surviving
 * items are re-emitted in their original order; a `rewrites` entry replaces that item's base_offset
 * and per-extent offset values, everything else (construction_method, data_reference_index,
 * extent_index, extent_length) is copied from the item unchanged. An item with no `rewrites` entry
 * (construction_method 1, e.g. the grid descriptor) is copied byte-verbatim (D-11).
 */
export declare function rebuildIloc(version: number, offsetSize: number, lengthSize: number, baseOffsetSize: number, indexSize: number, items: readonly IsobmffItem[], rewrites: ReadonlyMap<number, IlocRewrite>): Buffer;
/** Rebuild `iref`: source version, every record whose from-item survives is re-emitted verbatim. */
export declare function rebuildIref(version: number, references: readonly IsobmffReference[]): Buffer;
export interface IpmaRebuildEntry {
    readonly itemId: number;
    readonly associations: readonly {
        readonly propertyIndex: number;
        readonly essential: boolean;
    }[];
}
/** Rebuild `ipma`: source version/flags, surviving entries only, associations copied unchanged. */
export declare function rebuildIpma(version: number, flags: number, entries: readonly IpmaRebuildEntry[]): Buffer;
/**
 * D-13: build the minimal Exif item k's rewritten `infe` -- same `version` (2 or 3) and `hidden`
 * flag (bit 0) as the source, `item_protection_index` forced to 0, `item_type` "Exif", and an
 * **empty** `item_name` (one NUL byte). Never copies anything from the source's own `infe` bytes:
 * this is the one item the writer always re-synthesizes rather than re-emits verbatim, so no
 * residue (a free-text name, a non-zero protection index) can survive into the output.
 */
export declare function buildMinimalExifInfe(version: number, hidden: boolean, itemId: number): Buffer;
/**
 * Rebuild `iprp`: a plain box whose children are re-emitted in source order -- `ipco` copied
 * verbatim (D-16 ICC removal is out of scope for this plan), `ipma` substituted with its rebuilt
 * bytes when present.
 */
export declare function rebuildIprp(childOrder: readonly ("ipco" | "ipma")[], ipcoBytes: Buffer, ipmaBytes: Buffer | undefined): Buffer;
//# sourceMappingURL=rebuild.d.ts.map