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

function declined(removedItemIds: readonly number[], reason: string): IsobmffOutputPlan {
  return { parts: [], removedItemIds, declineReason: reason };
}

/**
 * D-15: the union of surviving construction_method-0 extents, merged in ascending source offset.
 * Items with no construction_method-0 extents (e.g. a cm=1 grid descriptor, which lives in
 * `idat` and is copied verbatim as part of `meta`) contribute nothing here.
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
  return [...entries].sort((a, b) => a.absStart - b.absStart);
}

/** Each surviving extent's new offset relative to the new mdat payload's own start (0-based). */
function newRelativeOffsets(
  sourceExtents: readonly SourceExtentEntry[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  let running = 0;
  for (const entry of sourceExtents) {
    map.set(`${entry.itemId}:${entry.extentIndex}`, running);
    running += entry.length;
  }
  return map;
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

  const ftypBox = layout.topLevelBoxes.find((box) => box.type === "ftyp");
  const mdatBox = layout.topLevelBoxes.find((box) => box.type === "mdat");
  if (ftypBox === undefined || mdatBox === undefined) {
    return declined(
      classification.removableItemIds,
      "Source is missing a top-level ftyp or mdat box.",
    );
  }
  if (mdatBox.headerSize !== 8) {
    return declined(
      classification.removableItemIds,
      "Unsupported mdat box header form (largesize) for this build.",
    );
  }

  const sourceExtents = collectSourceExtents(survivingItems);
  const relativeOffsets = newRelativeOffsets(sourceExtents);
  const newMdatPayloadLength = sourceExtents.reduce(
    (total, entry) => total + entry.length,
    0,
  );

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
  const probeMetaBytes = buildMetaBytes(
    layout.item,
    layout.metaPayload,
    survivingItems,
    iinfBytes,
    irefBytes,
    iprpBytes,
    probeRewrites,
  );

  const ftypTotalSize = ftypBox.end - ftypBox.start;
  const newMetaTotalSize = probeMetaBytes.length;
  const newMdatPayloadStart = ftypTotalSize + newMetaTotalSize + mdatBox.headerSize;

  const finalRewrites = computeIlocRewrites(
    survivingItems,
    relativeOffsets,
    layout.item.ilocBaseOffsetSize,
    newMdatPayloadStart,
  );
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

  const mdatHeaderBytes = plainBoxHeader("mdat", newMdatPayloadLength);

  const parts: IsobmffOutputPlanPart[] = [
    { kind: "copy", sourceOffset: ftypBox.start, length: ftypTotalSize },
    { kind: "bytes", data: metaBytes },
    { kind: "bytes", data: mdatHeaderBytes },
    ...sourceExtents.map(
      (entry): IsobmffOutputPlanPart => ({
        kind: "copy",
        sourceOffset: entry.absStart,
        length: entry.length,
      }),
    ),
  ];

  return { parts, removedItemIds: classification.removableItemIds };
}

export function checkIsobmffOutputPlan(plan: IsobmffOutputPlan): string | undefined {
  return plan.declineReason;
}
