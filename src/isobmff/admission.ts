import type { FileHandle } from "node:fs/promises";
import { readExactly } from "./boxes.js";
import { SEQUENCE_BRANDS } from "./brand.js";
import {
  DEFAULT_ISOBMFF_CAPS,
  IsobmffBudget,
  type IsobmffCaps,
} from "./caps.js";
import { IsobmffStructureError, type IsobmffDeclineClass } from "./errors.js";
import { parseIsobmff, type IsobmffModel, type IsobmffRange } from "./parse.js";
import { parseExif, readIfd0Resolution } from "../metadata/exif.js";
import { parseIcc } from "../metadata/icc.js";
import { parseXmp } from "../metadata/xmp.js";
import type {
  FormatAdmission,
  OrientationState,
} from "../admission/handler.js";
import type { MetadataEntry, MetadataWarning } from "../types.js";

// D3/D5 admission classifier (BMF-04): joins the validated item graph (61-07) with the D3
// removable/surviving rules and the D5 safety rules into one `FormatAdmission`-shaped result.
// `classifyIsobmffModel` is pure over an already-parsed `IsobmffModel` -- it never reads a byte
// itself -- so every rule can be proven with hand-built models/fixtures without touching a file
// handle. `admitIsobmff` is the only function in this module that reads bytes outside `meta`: it
// reads exactly the non-emptied removable items' own extents, each guarded by
// `budget.consumeBuffered` before the matching `readExactly` (T-61-25).

/** Restates the base `FormatAdmission` namespace union (D-15); see handler.ts. */
type IsobmffMetadataNamespace =
  "EXIF" | "XMP" | "ICC" | "PNG" | "C2PA" | "JPEG";

/** D3/D7: image item types this engine preserves verbatim, never decodes. */
export const PRESERVED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "hvc1",
  "av01",
  "grid",
  "iden",
  "iovl",
  "tmap",
]);

/** D-07: the only `mime` content types admitted as a removable XMP item. */
export const XMP_CONTENT_TYPES: readonly string[] = ["application/rdf+xml"];

/**
 * BMF-03: the fixed rule order `classifyIsobmffModel` evaluates in, after every parse-time
 * decline (box framing, cap breaches, item-graph validity -- all already thrown by the time a
 * caller has an `IsobmffModel` to pass in). Within each rule, items are visited in `iinf`
 * declaration order (`model.items`'s own order, per 61-07); the first violation is thrown.
 */
export const DECLINE_RULE_ORDER: readonly IsobmffDeclineClass[] = Object.freeze(
  [
    "sequence-brand",
    "unknown-item-type",
    "construction-method-2",
    "external-data-reference",
    "removable-item-in-idat",
    "removable-item-referenced",
    "surviving-offset-width-zero",
    "surviving-zero-length-extent",
    "extent-outside-mdat",
    "removable-extent-overlap",
  ],
);

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
 * Add two independently-`MAX_SAFE_INTEGER`-bounded offsets, declining `extent-outside-mdat`
 * rather than silently losing precision if their sum would exceed `Number.isSafeInteger` (WR-01,
 * code review 2026-10-01). `item.baseOffset` and `extent.offset`/`extent.length` are each
 * validated individually by `readSizedUint` (iloc.ts), but their sum is not -- this is the single
 * choke point every such sum in this module must route through.
 */
function addSafeOffsets(a: number, b: number, context: string): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new IsobmffStructureError(
      "extent-outside-mdat",
      `${context}: offset arithmetic (${a} + ${b}) exceeds safe integer precision.`,
    );
  }
  return sum;
}

function mdatBounds(
  model: IsobmffModel,
): { readonly start: number; readonly end: number } | undefined {
  const range = model.mdatRanges[0];
  return range === undefined
    ? undefined
    : { start: range.offset, end: range.offset + range.length };
}

/**
 * Pure classifier over an already-parsed `IsobmffModel` (BMF-03/BMF-04). Throws
 * `IsobmffStructureError` for the first `DECLINE_RULE_ORDER` violation (iinf order within each
 * rule), else returns the admitted disposition.
 */
export function classifyIsobmffModel(
  model: IsobmffModel,
  fileSize: number,
): IsobmffDisposition {
  // Rule 1: sequence-brand. D-18's brand classifier already declines a magic-buffer-visible
  // msf1/avis brand before a handler is ever selected; this re-checks the fully parsed brand set
  // (which may include compatible brands past the 256-byte magic window) as defense in depth.
  const brands = new Set<string>([model.majorBrand, ...model.compatibleBrands]);
  for (const brand of brands) {
    if (SEQUENCE_BRANDS.has(brand)) {
      throw new IsobmffStructureError(
        "sequence-brand",
        `Brand "${brand}" is an image-sequence brand, never admitted as a still item file.`,
      );
    }
  }

  // Rule 2: unknown-item-type. Classifies every item as removable or surviving, in iinf order.
  const kinds = new Map<number, "removable" | "surviving">();
  for (const item of model.items) {
    if (item.type === "Exif") {
      kinds.set(item.id, "removable");
      continue;
    }
    if (item.type === "mime") {
      const hasEncoding =
        item.contentEncoding !== undefined && item.contentEncoding !== "";
      if (
        item.contentType !== undefined &&
        XMP_CONTENT_TYPES.includes(item.contentType) &&
        !hasEncoding
      ) {
        kinds.set(item.id, "removable");
        continue;
      }
      throw new IsobmffStructureError(
        "unknown-item-type",
        `mime item ${item.id} (content_type ${JSON.stringify(item.contentType)}` +
          `${hasEncoding ? ", content_encoding present" : ""}) is not an admitted XMP shape.`,
      );
    }
    if (PRESERVED_ITEM_TYPES.has(item.type)) {
      kinds.set(item.id, "surviving");
      continue;
    }
    throw new IsobmffStructureError(
      "unknown-item-type",
      `Item ${item.id} has type "${item.type}", which is not admitted.`,
    );
  }

  // Rule 3: construction-method-2.
  for (const item of model.items) {
    if (item.constructionMethod === 2) {
      throw new IsobmffStructureError(
        "construction-method-2",
        `Item ${item.id} uses construction_method 2, which is not admitted.`,
      );
    }
  }

  // Rule 4: external-data-reference.
  for (const item of model.items) {
    if (item.dataReferenceIndex !== 0) {
      throw new IsobmffStructureError(
        "external-data-reference",
        `Item ${item.id} has a non-zero data_reference_index (external data).`,
      );
    }
  }

  // Rule 5: removable-item-in-idat (D3).
  for (const item of model.items) {
    if (kinds.get(item.id) === "removable" && item.constructionMethod !== 0) {
      throw new IsobmffStructureError(
        "removable-item-in-idat",
        `Removable item ${item.id} uses construction_method ${item.constructionMethod}, not 0.`,
      );
    }
  }

  // Rule 6: removable-item-referenced (D-08). `to_item_ID` only -- a removable item's own `cdsc`
  // *from* the primary is normal and never checked here.
  const toTargets = new Set<number>();
  for (const reference of model.references) {
    for (const toId of reference.toItemIds) toTargets.add(toId);
  }
  const groupMembers = new Set<number>();
  for (const group of model.groups) {
    for (const entityId of group.entityIds) groupMembers.add(entityId);
  }
  for (const item of model.items) {
    if (kinds.get(item.id) !== "removable") continue;
    if (
      toTargets.has(item.id) ||
      item.id === model.primaryItemId ||
      groupMembers.has(item.id)
    ) {
      throw new IsobmffStructureError(
        "removable-item-referenced",
        `Removable item ${item.id} is referenced as an iref to-target, pitm, or grpl member.`,
      );
    }
  }

  // Rule 7: surviving-offset-width-zero.
  const offsetSize = model.iloc?.offsetSize ?? 0;
  for (const item of model.items) {
    if (
      kinds.get(item.id) === "surviving" &&
      item.constructionMethod === 0 &&
      offsetSize === 0
    ) {
      throw new IsobmffStructureError(
        "surviving-offset-width-zero",
        `Surviving item ${item.id} is construction_method 0 but iloc offset_size is 0.`,
      );
    }
  }

  // Rule 8: surviving-zero-length-extent.
  for (const item of model.items) {
    if (kinds.get(item.id) !== "surviving") continue;
    if (
      item.extents.length === 0 ||
      item.extents.some((extent) => extent.length === 0)
    ) {
      throw new IsobmffStructureError(
        "surviving-zero-length-extent",
        `Surviving item ${item.id} has no extents or a zero-length extent.`,
      );
    }
  }

  // Rule 9: extent-outside-mdat. D-10a: a length-0 cm=0 extent is admitted when its offset is
  // in-bounds (inside the single mdat payload, inclusive of its end, or equal to the file's own
  // size); any other length-0 offset, or any non-zero-length extent that does not fit entirely
  // inside its backing store, declines.
  const mdat = mdatBounds(model);
  const idat = model.idatRange;
  for (const item of model.items) {
    for (const extent of item.extents) {
      if (item.constructionMethod === 1) {
        if (idat === undefined) {
          throw new IsobmffStructureError(
            "extent-outside-mdat",
            `Item ${item.id} is construction_method 1 but meta has no idat.`,
          );
        }
        const start = addSafeOffsets(
          item.baseOffset,
          extent.offset,
          `Item ${item.id}'s idat extent start`,
        );
        const end = addSafeOffsets(
          start,
          extent.length,
          `Item ${item.id}'s idat extent end`,
        );
        if (start < 0 || end > idat.length) {
          throw new IsobmffStructureError(
            "extent-outside-mdat",
            `Item ${item.id}'s idat extent [${start}, ${end}) is outside idat (length ${idat.length}).`,
          );
        }
        continue;
      }

      const start = addSafeOffsets(
        item.baseOffset,
        extent.offset,
        `Item ${item.id}'s extent start`,
      );
      if (extent.length === 0) {
        const insideMdat =
          mdat !== undefined && start >= mdat.start && start <= mdat.end;
        const atFileEnd = start === fileSize;
        if (!insideMdat && !atFileEnd) {
          throw new IsobmffStructureError(
            "extent-outside-mdat",
            `Item ${item.id}'s zero-length extent at offset ${start} is neither inside mdat nor at the file's end.`,
          );
        }
        continue;
      }

      const end = addSafeOffsets(
        start,
        extent.length,
        `Item ${item.id}'s extent end`,
      );
      if (mdat === undefined || start < mdat.start || end > mdat.end) {
        throw new IsobmffStructureError(
          "extent-outside-mdat",
          `Item ${item.id}'s extent [${start}, ${end}) is outside the single mdat payload.`,
        );
      }
    }
  }

  // Rule 10: removable-extent-overlap. Only cm=0, non-zero-length extents participate (D-10a:
  // length-0 extents never overlap); surviving-versus-surviving overlap is never checked.
  interface AbsoluteExtent {
    readonly start: number;
    readonly end: number;
    readonly itemId: number;
  }
  const survivingRanges: AbsoluteExtent[] = [];
  for (const item of model.items) {
    if (kinds.get(item.id) !== "surviving" || item.constructionMethod !== 0) {
      continue;
    }
    for (const extent of item.extents) {
      if (extent.length === 0) continue;
      const start = addSafeOffsets(
        item.baseOffset,
        extent.offset,
        `Item ${item.id}'s surviving extent start`,
      );
      survivingRanges.push({
        start,
        end: addSafeOffsets(
          start,
          extent.length,
          `Item ${item.id}'s surviving extent end`,
        ),
        itemId: item.id,
      });
    }
  }
  for (const item of model.items) {
    if (kinds.get(item.id) !== "removable") continue;
    for (const extent of item.extents) {
      if (extent.length === 0) continue;
      const start = addSafeOffsets(
        item.baseOffset,
        extent.offset,
        `Item ${item.id}'s removable extent start`,
      );
      const end = addSafeOffsets(
        start,
        extent.length,
        `Item ${item.id}'s removable extent end`,
      );
      for (const surviving of survivingRanges) {
        if (start < surviving.end && surviving.start < end) {
          throw new IsobmffStructureError(
            "removable-extent-overlap",
            `Removable item ${item.id}'s extent [${start}, ${end}) overlaps surviving item ` +
              `${surviving.itemId}'s extent [${surviving.start}, ${surviving.end}).`,
          );
        }
      }
    }
  }

  const removableItemIds: number[] = [];
  const emptiedItemIds: number[] = [];
  const survivingItemIds: number[] = [];
  for (const item of model.items) {
    const kind = kinds.get(item.id);
    if (kind === "removable") {
      removableItemIds.push(item.id);
      if (
        item.extents.length === 0 ||
        item.extents.every((extent) => extent.length === 0)
      ) {
        emptiedItemIds.push(item.id);
      }
    } else if (kind === "surviving") {
      survivingItemIds.push(item.id);
    }
  }

  return {
    removableItemIds,
    emptiedItemIds,
    survivingItemIds,
    removableTopLevel: model.removableTopLevel,
  };
}

/**
 * Parse, classify, and read back the non-emptied removable items' own bytes (Exif/XMP), assembling
 * a `FormatAdmission`-shaped result (D-12). Every payload read is guarded by
 * `budget.consumeBuffered(length)` for that exact length, immediately before the matching
 * `readExactly` call (T-61-25) -- the only reads this function performs outside `meta`.
 */
export async function admitIsobmff(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
  caps: IsobmffCaps = DEFAULT_ISOBMFF_CAPS,
): Promise<IsobmffAdmission> {
  const model = await parseIsobmff(handle, size, caps, signal);
  const classification = classifyIsobmffModel(model, size);

  const entries: MetadataEntry[] = [];
  const warnings: MetadataWarning[] = [];
  let orientation: OrientationState = { status: "absent" };
  let colorProfile: Buffer | undefined;
  const namespaces = new Set<IsobmffMetadataNamespace>();
  let resolutionNamespace: IsobmffMetadataNamespace | undefined;

  if (model.colorProfile !== undefined) {
    colorProfile = model.colorProfile;
    namespaces.add("ICC");
    const found = parseIcc(colorProfile);
    entries.push(...found.entries);
    warnings.push(...found.warnings);
  }

  if (classification.removableTopLevel.length > 0) {
    namespaces.add("C2PA");
  }

  const budget = new IsobmffBudget(caps);
  const emptied = new Set(classification.emptiedItemIds);

  for (const itemId of classification.removableItemIds) {
    if (emptied.has(itemId)) continue;
    if (signal?.aborted === true) {
      throw new IsobmffStructureError("box-framing", "Parsing aborted.");
    }

    const item = model.itemsById.get(itemId);
    if (item === undefined) continue; // unreachable: classification is derived from model.items

    const parts: Buffer[] = [];
    for (const extent of item.extents) {
      const absoluteOffset = addSafeOffsets(
        item.baseOffset,
        extent.offset,
        `Item ${item.id}'s read extent start`,
      );
      budget.consumeBuffered(extent.length);
      parts.push(await readExactly(handle, extent.length, absoluteOffset));
    }
    const payload = Buffer.concat(parts);

    if (item.type === "Exif") {
      namespaces.add("EXIF");
      if (payload.length < 4) continue;
      // D-12: strip the 4-byte exif_tiff_header_offset prefix explicitly (the value names how
      // many further bytes of padding precede the TIFF header itself).
      const tiffHeaderOffset = payload.readUInt32BE(0);
      const tiff = payload.subarray(4 + tiffHeaderOffset);
      const found = parseExif(tiff);
      entries.push(...found.entries);
      warnings.push(...found.warnings);
      if (orientation.status === "absent") orientation = found.orientation;
      if (readIfd0Resolution(tiff) !== undefined) resolutionNamespace = "EXIF";
      continue;
    }

    if (item.type === "mime") {
      namespaces.add("XMP");
      const found = parseXmp(payload);
      entries.push(...found.entries);
      warnings.push(...found.warnings);
      continue;
    }
  }

  return {
    entries,
    warnings,
    orientation,
    colorProfile,
    namespaces: Array.from(namespaces),
    resolutionNamespace,
    model,
    classification,
  };
}
