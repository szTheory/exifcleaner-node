import type { IsobmffAdmission } from "./admission.js";
import type { IsobmffItem, IsobmffItemLayout } from "./items.js";
import {
  fullBoxHeader,
  plainBoxHeader,
  rebuildIinf,
  rebuildIloc,
  rebuildIpma,
  rebuildIprp,
  rebuildIref,
  type IlocRewrite,
} from "./rebuild.js";

// ISOBMFF output plan (Phase 62, D-11/D-12/D-14/D-15 subset): `buildIsobmffOutputPlan` is a pure
// transform over an already-admitted `IsobmffAdmission` -- it never reads a byte itself, only the
// plain data `parseIsobmff`/`admitIsobmff` already buffered (`admission.model.layout`). The
// resulting `IsobmffOutputPlan` is frozen plain data: `writeIsobmffOutput` (writer.ts) derives
// every byte it writes from (source, plan) only, never from the admission.
//
// Scope note: D-13 (minimal Exif synthesis) and D-16 (ICC removal) are deferred to a later plan --
// this plan's tracer exercises only `preserveOrientation`/`preserveColorProfile`/
// `preserveResolution` combinations where neither applies to the one committed fixture (no colr
// prof/rICC is present; only nclx). The three preservation parameters are accepted (to match the
// `FormatHandler` contract) but not yet acted on.

export type IsobmffOutputPlanPart =
  | { readonly kind: "copy"; readonly sourceOffset: number; readonly length: number }
  | { readonly kind: "bytes"; readonly data: Buffer };

export interface IsobmffOutputPlan {
  readonly parts: readonly IsobmffOutputPlanPart[];
  readonly removedItemIds: readonly number[];
  readonly declineReason?: string;
}

interface SourceExtentEntry {
  readonly itemId: number;
  readonly extentIndex: number;
  readonly absStart: number;
  readonly length: number;
}

/** One deduplicated, merged byte range of the source `mdat` payload that survives into the
 * output, and where its bytes land in the new `mdat` payload (D-15). */
interface MergedMdatRange {
  readonly start: number;
  readonly end: number;
  readonly newStart: number;
}

function declined(removedItemIds: readonly number[], reason: string): IsobmffOutputPlan {
  return { parts: [], removedItemIds, declineReason: reason };
}

/**
 * D-15: every surviving construction_method-0 extent, as a raw (possibly overlapping or
 * touching) absolute source range. Items with no construction_method-0 extents (e.g. a cm=1 grid
 * descriptor, which lives in `idat` and is copied verbatim as part of `meta`) contribute nothing
 * here. Not yet deduplicated -- `buildMergedMdatRanges` does that.
 */
function collectSourceExtents(
  survivingItems: readonly IsobmffItem[],
): readonly SourceExtentEntry[] {
  const entries: SourceExtentEntry[] = [];
  for (const item of survivingItems) {
    if (item.constructionMethod !== 0) continue;
    item.extents.forEach((extent, extentIndex) => {
      entries.push({
        itemId: item.id,
        extentIndex,
        absStart: item.baseOffset + extent.offset,
        length: extent.length,
      });
    });
  }
  return entries;
}

/**
 * D-15: merge `sourceExtents` into the ascending, non-overlapping union of byte ranges that must
 * survive into the new `mdat` payload -- two surviving extents that touch (one's end equals the
 * other's start) or overlap collapse into a single merged range, written to the output exactly
 * once. Each merged range also carries where its first byte lands in the new payload
 * (`newStart`), so the total is the sum of merged lengths, never the sum of (possibly
 * duplicate-counting) raw extent lengths. Zero-length extents (never present for a surviving
 * item, D3 rule 8) would sort arbitrarily against equal-start ranges; this function assumes none
 * exist, matching every caller's already-admitted input.
 */
function buildMergedMdatRanges(
  sourceExtents: readonly SourceExtentEntry[],
): readonly MergedMdatRange[] {
  const sorted = [...sourceExtents].sort((a, b) => a.absStart - b.absStart);
  const raw: { start: number; end: number }[] = [];
  for (const entry of sorted) {
    const start = entry.absStart;
    const end = entry.absStart + entry.length;
    const last = raw[raw.length - 1];
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      raw.push({ start, end });
    }
  }
  const merged: MergedMdatRange[] = [];
  let running = 0;
  for (const range of raw) {
    merged.push({ ...range, newStart: running });
    running += range.end - range.start;
  }
  return merged;
}

function totalMergedLength(merged: readonly MergedMdatRange[]): number {
  return merged.reduce((total, range) => total + (range.end - range.start), 0);
}

/** Map one absolute source `mdat` offset to its new position in the output payload (D-15). */
function mapAbsoluteOffset(merged: readonly MergedMdatRange[], abs: number): number {
  for (const range of merged) {
    if (abs >= range.start && abs <= range.end) {
      return range.newStart + (abs - range.start);
    }
  }
  throw new Error(
    `mapAbsoluteOffset: source offset ${abs} falls outside every merged surviving range.`,
  );
}

/** Each surviving extent's new offset relative to the new mdat payload's own start (0-based),
 * resolved through the deduplicated merged-range union (D-15), never a flat running sum. */
function newRelativeOffsets(
  sourceExtents: readonly SourceExtentEntry[],
  merged: readonly MergedMdatRange[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of sourceExtents) {
    map.set(
      `${entry.itemId}:${entry.extentIndex}`,
      mapAbsoluteOffset(merged, entry.absStart),
    );
  }
  return map;
}

const MAX_UINT32 = 0xffffffff;

/** The largest value a rewritten field of `width` bytes can carry (D-12); widths are never
 * widened to make a value fit. Width 0 never carries a rewritten value. */
function maxValueForWidth(width: number): number {
  if (width === 4) return MAX_UINT32;
  if (width === 8) return Number.MAX_SAFE_INTEGER;
  return 0;
}

/**
 * D-12: decline `offset-rewrite-overflow` before any byte is written when a rewritten `iloc`
 * base or extent offset would be negative (the item's own first extent is not actually the
 * smallest -- e.g. its extents are declared out of ascending-source-offset order) or does not
 * fit its declared field width. Lengths are never rewritten (copied verbatim from the source),
 * so they need no check here.
 */
function checkIlocRewriteFit(
  survivingItems: readonly IsobmffItem[],
  rewrites: ReadonlyMap<number, IlocRewrite>,
  baseOffsetSize: number,
  offsetSize: number,
): string | undefined {
  for (const item of survivingItems) {
    if (item.constructionMethod !== 0) continue;
    const rewrite = rewrites.get(item.id);
    if (rewrite === undefined) continue;
    if (baseOffsetSize > 0) {
      const max = maxValueForWidth(baseOffsetSize);
      if (rewrite.newBaseOffset < 0 || rewrite.newBaseOffset > max) {
        return (
          `offset-rewrite-overflow: item ${item.id}'s rewritten base_offset ` +
          `${rewrite.newBaseOffset} does not fit its declared width (${baseOffsetSize} bytes).`
        );
      }
    }
    const max = maxValueForWidth(offsetSize);
    for (let index = 0; index < rewrite.extentOffsets.length; index += 1) {
      const offset = rewrite.extentOffsets[index]!;
      if (offset < 0) {
        return (
          `offset-rewrite-overflow: item ${item.id}'s rewritten extent ${index} offset ` +
          `${offset} would be negative.`
        );
      }
      if (offset > max) {
        return (
          `offset-rewrite-overflow: item ${item.id}'s rewritten extent ${index} offset ` +
          `${offset} does not fit its declared width (${offsetSize} bytes).`
        );
      }
    }
  }
  return undefined;
}

/**
 * D-12/D-15: decline `offset-rewrite-overflow` before any byte is written when the rewritten
 * `mdat` payload length would not fit the source's own header form -- a `largesize` source stays
 * `largesize` (effectively unbounded here, gated only by `Number.isSafeInteger`); a `normal` or
 * `size-zero` source must still fit an explicit 32-bit size (never promoted to `largesize`).
 */
function checkMdatSizeFit(
  sizeForm: "normal" | "largesize" | "size-zero",
  payloadLength: number,
): string | undefined {
  if (sizeForm === "largesize") {
    const total = 16 + payloadLength;
    if (!Number.isSafeInteger(total)) {
      return `offset-rewrite-overflow: rewritten mdat largesize ${total} exceeds safe integer precision.`;
    }
    return undefined;
  }
  const total = 8 + payloadLength;
  if (total > MAX_UINT32) {
    return (
      `offset-rewrite-overflow: rewritten mdat size ${total} does not fit a 32-bit header ` +
      `(the source used a normal/size-zero header, never widened to largesize).`
    );
  }
  return undefined;
}

/** `mdat`'s own header, in the source's header form (D-15): `largesize` stays `largesize`;
 * `normal`/`size-zero` both become an explicit 32-bit size (never widened). */
function buildMdatHeader(
  sizeForm: "normal" | "largesize" | "size-zero",
  payloadLength: number,
): Buffer {
  if (sizeForm === "largesize") {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write("mdat", 4, "ascii");
    header.writeBigUInt64BE(BigInt(16 + payloadLength), 8);
    return header;
  }
  return plainBoxHeader("mdat", payloadLength);
}

/**
 * D-11: surviving construction_method-0 items' `iloc` rewrites, given where the new mdat payload
 * will start in the output file. `baseOffsetSize > 0`: base = the first extent's new absolute
 * position, other extent offsets are relative to it. `baseOffsetSize == 0`: every extent offset is
 * its own new absolute position (no base).
 */
function computeIlocRewrites(
  survivingItems: readonly IsobmffItem[],
  relativeOffsets: ReadonlyMap<string, number>,
  baseOffsetSize: number,
  newMdatPayloadStart: number,
): ReadonlyMap<number, IlocRewrite> {
  const rewrites = new Map<number, IlocRewrite>();
  for (const item of survivingItems) {
    if (item.constructionMethod !== 0) continue;
    const relatives = item.extents.map(
      (_extent, index) => relativeOffsets.get(`${item.id}:${index}`)!,
    );
    if (baseOffsetSize > 0) {
      const base = relatives[0]!;
      rewrites.set(item.id, {
        newBaseOffset: newMdatPayloadStart + base,
        extentOffsets: relatives.map((relative) => relative - base),
      });
    } else {
      rewrites.set(item.id, {
        newBaseOffset: 0,
        extentOffsets: relatives.map((relative) => newMdatPayloadStart + relative),
      });
    }
  }
  return rewrites;
}

function buildMetaBytes(
  layoutItem: IsobmffItemLayout,
  metaPayload: Buffer,
  survivingItems: readonly IsobmffItem[],
  iinfBytes: Buffer,
  irefBytes: Buffer | undefined,
  iprpBytes: Buffer | undefined,
  ilocRewrites: ReadonlyMap<number, IlocRewrite>,
): Buffer {
  const ilocBytes = rebuildIloc(
    layoutItem.ilocVersion,
    layoutItem.ilocOffsetSize,
    layoutItem.ilocLengthSize,
    layoutItem.ilocBaseOffsetSize,
    layoutItem.ilocIndexSize,
    survivingItems,
    ilocRewrites,
  );
  const parts: Buffer[] = [];
  for (const child of layoutItem.metaChildren) {
    if (child.type === "iinf") {
      parts.push(iinfBytes);
      continue;
    }
    if (child.type === "iloc") {
      parts.push(ilocBytes);
      continue;
    }
    if (child.type === "iref") {
      if (irefBytes !== undefined) parts.push(irefBytes);
      continue;
    }
    if (child.type === "iprp") {
      if (iprpBytes !== undefined) parts.push(iprpBytes);
      continue;
    }
    // hdlr, dinf, pitm, idat, grpl: copied verbatim (D-14).
    parts.push(metaPayload.subarray(child.start, child.end));
  }
  const childrenBytes = Buffer.concat(parts);
  return Buffer.concat([
    fullBoxHeader("meta", 0, 0, childrenBytes.length),
    childrenBytes,
  ]);
}

/**
 * D-14/D5: the top-level boxes that never survive into the output -- `free`/`skip` (structurally
 * inert, admitted but dropped) and `uuid` (the only admitted top-level `uuid` usertype is
 * `boxes.ts`'s `C2PA_UUID_USERTYPE`, D-09/D5: `parseIsobmff` throws `top-level-box-not-allowed`
 * for any other `uuid` usertype before an admission is ever produced, so every `uuid` box
 * reaching this function is a C2PA box -- dropping by `type === "uuid"` alone is exact here).
 */
function isDroppedTopLevelBox(box: { readonly type: string }): boolean {
  return box.type === "free" || box.type === "skip" || box.type === "uuid";
}

export function buildIsobmffOutputPlan(
  admission: IsobmffAdmission,
  _preserveOrientation: boolean,
  _preserveColorProfile: boolean,
  _preserveResolution: boolean,
  _orientation: number | undefined,
): IsobmffOutputPlan {
  const { model, classification } = admission;
  const { layout } = model;
  const removedIds = new Set(classification.removableItemIds);
  const survivingItems = model.items.filter((item) => !removedIds.has(item.id));
  const survivingItemIds = survivingItems.map((item) => item.id);

  // D-14: walk every top-level box in its own source order, dropping free/skip/C2PA uuid
  // wherever they sit (right after ftyp, between meta and mdat, after mdat, or more than once) --
  // never a hardcoded ftyp-then-meta-then-mdat assumption. Whatever remains is always exactly one
  // ftyp, one meta and one mdat (every other admitted top-level type is in the drop set; anything
  // not in the drop set and not one of these three would already have failed parse-time
  // admission), so the loop below never needs an "else" branch for a fourth kept type.
  const keptTopLevelBoxes = layout.topLevelBoxes.filter(
    (box) => !isDroppedTopLevelBox(box),
  );
  const ftypBox = keptTopLevelBoxes.find((box) => box.type === "ftyp");
  const metaTopLevelBox = keptTopLevelBoxes.find((box) => box.type === "meta");
  const mdatBox = keptTopLevelBoxes.find((box) => box.type === "mdat");
  if (
    ftypBox === undefined ||
    metaTopLevelBox === undefined ||
    mdatBox === undefined
  ) {
    return declined(
      classification.removableItemIds,
      "Source is missing a top-level ftyp, meta or mdat box.",
    );
  }
  const sourceExtents = collectSourceExtents(survivingItems);
  const mergedRanges = buildMergedMdatRanges(sourceExtents);
  const relativeOffsets = newRelativeOffsets(sourceExtents, mergedRanges);
  const newMdatPayloadLength = totalMergedLength(mergedRanges);

  // iinf: always rebuilt (entry_count shrinks, surviving infe boxes copied verbatim).
  const iinfBytes = rebuildIinf(
    layout.metaPayload,
    layout.item.iinfVersion,
    survivingItemIds,
    layout.item.infeRanges,
  );

  // iref: rebuilt from records whose from-item survives; dropped entirely if that leaves none.
  let irefBytes: Buffer | undefined;
  if (layout.item.irefVersion !== undefined) {
    const survivingReferences = model.references.filter(
      (reference) => !removedIds.has(reference.fromItemId),
    );
    if (survivingReferences.length > 0) {
      irefBytes = rebuildIref(layout.item.irefVersion, survivingReferences);
    }
  }

  // iprp: ipco copied verbatim, ipma rebuilt (surviving entries only).
  let iprpBytes: Buffer | undefined;
  const iprpChildren = layout.item.iprpChildren;
  if (iprpChildren.length > 0) {
    const ipcoHeader = iprpChildren.find((child) => child.type === "ipco");
    const ipmaHeader = iprpChildren.find((child) => child.type === "ipma");
    const ipcoBytes =
      ipcoHeader !== undefined
        ? layout.metaPayload.subarray(ipcoHeader.start, ipcoHeader.end)
        : Buffer.alloc(0);
    let ipmaBytes: Buffer | undefined;
    if (ipmaHeader !== undefined && layout.item.ipmaVersion !== undefined) {
      const survivingAssociations = (model.ipma ?? []).filter(
        (entry) => !removedIds.has(entry.itemId),
      );
      ipmaBytes = rebuildIpma(
        layout.item.ipmaVersion,
        layout.item.ipmaFlags ?? 0,
        survivingAssociations.map((entry) => ({
          itemId: entry.itemId,
          associations: entry.associations.map((association) => ({
            propertyIndex: association.propertyIndex,
            essential: association.essential,
          })),
        })),
      );
    }
    const order = iprpChildren
      .map((child) => child.type)
      .filter((type): type is "ipco" | "ipma" => type === "ipco" || type === "ipma");
    iprpBytes = rebuildIprp(order, ipcoBytes, ipmaBytes);
  }

  // D-11: widths never change, so the rebuilt meta's length is independent of the actual offset
  // *values* -- probe with offset 0 to learn the new mdat payload's start, then rebuild once more
  // with the real values.
  const probeRewrites = computeIlocRewrites(
    survivingItems,
    relativeOffsets,
    layout.item.ilocBaseOffsetSize,
    0,
  );
  // D-12: the probe pass already carries the real relative deltas (only the absolute
  // `newMdatPayloadStart` term is a placeholder) -- a negative extent offset is just as real
  // here as in the final pass, and `rebuildIloc`'s `writeSizedUint` has no bounds check of its
  // own, so this must be caught before `buildMetaBytes` ever serializes it.
  const probeFitError = checkIlocRewriteFit(
    survivingItems,
    probeRewrites,
    layout.item.ilocBaseOffsetSize,
    layout.item.ilocOffsetSize,
  );
  if (probeFitError !== undefined) {
    return declined(classification.removableItemIds, probeFitError);
  }
  const probeMetaBytes = buildMetaBytes(
    layout.item,
    layout.metaPayload,
    survivingItems,
    iinfBytes,
    irefBytes,
    iprpBytes,
    probeRewrites,
  );

  // D-14: the new mdat payload's start is the running byte length of every KEPT top-level box
  // that precedes mdat in the *source's own order* -- ftyp contributes its verbatim total size,
  // meta contributes the probe pass's rebuilt length (D-11: widths never change, so that length
  // is already the real one), and nothing else can precede mdat here (every dropped box
  // contributes 0, and ftyp/meta/mdat are each a parse-time-enforced singleton).
  let runningOffsetBeforeMdat = 0;
  for (const box of keptTopLevelBoxes) {
    if (box.type === "mdat") break;
    runningOffsetBeforeMdat +=
      box.type === "ftyp" ? box.end - box.start : probeMetaBytes.length;
  }
  const newMdatPayloadStart = runningOffsetBeforeMdat + mdatBox.headerSize;

  const finalRewrites = computeIlocRewrites(
    survivingItems,
    relativeOffsets,
    layout.item.ilocBaseOffsetSize,
    newMdatPayloadStart,
  );
  const finalFitError = checkIlocRewriteFit(
    survivingItems,
    finalRewrites,
    layout.item.ilocBaseOffsetSize,
    layout.item.ilocOffsetSize,
  );
  if (finalFitError !== undefined) {
    return declined(classification.removableItemIds, finalFitError);
  }

  const mdatSizeFitError = checkMdatSizeFit(mdatBox.sizeForm, newMdatPayloadLength);
  if (mdatSizeFitError !== undefined) {
    return declined(classification.removableItemIds, mdatSizeFitError);
  }

  const metaBytes = buildMetaBytes(
    layout.item,
    layout.metaPayload,
    survivingItems,
    iinfBytes,
    irefBytes,
    iprpBytes,
    finalRewrites,
  );
  if (metaBytes.length !== probeMetaBytes.length) {
    return declined(
      classification.removableItemIds,
      "Rebuilt meta length changed between the probe and final passes.",
    );
  }

  const mdatHeaderBytes = buildMdatHeader(mdatBox.sizeForm, newMdatPayloadLength);

  // D-14: emit parts in the exact kept order (never reordered); free/skip/C2PA uuid simply have
  // no part at all, wherever they sat in the source.
  const parts: IsobmffOutputPlanPart[] = [];
  for (const box of keptTopLevelBoxes) {
    if (box.type === "ftyp") {
      parts.push({ kind: "copy", sourceOffset: box.start, length: box.end - box.start });
    } else if (box.type === "meta") {
      parts.push({ kind: "bytes", data: metaBytes });
    } else {
      // box.type === "mdat" (the only remaining kept type).
      parts.push({ kind: "bytes", data: mdatHeaderBytes });
      for (const range of mergedRanges) {
        parts.push({
          kind: "copy",
          sourceOffset: range.start,
          length: range.end - range.start,
        });
      }
    }
  }

  return { parts, removedItemIds: classification.removableItemIds };
}

export function checkIsobmffOutputPlan(plan: IsobmffOutputPlan): string | undefined {
  return plan.declineReason;
}
