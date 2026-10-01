import { IsobmffStructureError } from "./errors.js";

// `iloc` (ItemLocationBox) table-driven resolver (BMF-01, D1, D-20). Every version difference
// lives inside `ILOC_LAYOUTS`, cited against docs/isobmff.md `## Grammar` -> "iloc" (libheif
// v1.19.7 `box.cc` `Box_iloc::parse`/`Box_iloc::read_data`). This module never branches on
// `version`/`flags` outside that table; `readSizedUint` is the single width-gated reader every
// field (base_offset, extent_index, extent_offset, extent_length) goes through.

/** Per-version `iloc` field presence/width, keyed by the FullBox `version` (0, 1, 2). */
export interface IlocVersionLayout {
  readonly itemCountBytes: 2 | 4;
  readonly itemIdBytes: 2 | 4;
  readonly hasConstructionMethod: boolean;
  readonly hasIndexSize: boolean;
}

export const ILOC_LAYOUTS: Readonly<Record<0 | 1 | 2, IlocVersionLayout>> =
  Object.freeze({
    0: {
      itemCountBytes: 2,
      itemIdBytes: 2,
      hasConstructionMethod: false,
      hasIndexSize: false,
    },
    1: {
      itemCountBytes: 2,
      itemIdBytes: 2,
      hasConstructionMethod: true,
      hasIndexSize: true,
    },
    2: {
      itemCountBytes: 4,
      itemIdBytes: 4,
      hasConstructionMethod: true,
      hasIndexSize: true,
    },
  });

/** The only field widths `iloc` (and `ipma`) nibbles are admitted to declare (D-18 fail-closed). */
export const ILOC_FIELD_WIDTHS: ReadonlySet<number> = new Set([0, 4, 8]);

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
export function readSizedUint(
  buffer: Buffer,
  position: number,
  width: number,
): number {
  if (width === 0) return 0;
  if (width === 4) return buffer.readUInt32BE(position);
  if (width === 8) {
    const value = buffer.readBigUInt64BE(position);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new IsobmffStructureError(
        "extent-outside-mdat",
        `8-byte field at offset ${position} (${value}) exceeds Number.MAX_SAFE_INTEGER precision.`,
      );
    }
    return Number(value);
  }
  throw new IsobmffStructureError(
    "box-framing",
    `Field width ${width} at offset ${position} is not one of {0, 4, 8}.`,
  );
}

function ensureBytes(
  payload: Buffer,
  position: number,
  length: number,
  what: string,
): void {
  if (position + length > payload.length) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc payload is too short for its ${what} field at offset ${position}.`,
    );
  }
}

/**
 * Parse an `iloc` box's payload (the bytes immediately after the FullBox version/flags, which the
 * caller has already stripped -- `parseIsobmff` reads them once per D1). `version`/`flags` come
 * from that same FullBox header. Declines `unsupported-box-version` for anything outside
 * `{0, 1, 2}`, `box-framing` for a width nibble outside `{0, 4, 8}`, a truncated field or item
 * table, or an `item_count` the remaining payload could not possibly hold (checked before any
 * per-item allocation).
 */
export function parseIloc(
  payload: Buffer,
  version: number,
  _flags: number,
): IlocTable {
  if (version !== 0 && version !== 1 && version !== 2) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `iloc version ${version} is not supported (only 0, 1, 2 are admitted).`,
    );
  }
  const layout = ILOC_LAYOUTS[version];

  if (payload.length < 2) {
    throw new IsobmffStructureError(
      "box-framing",
      "iloc payload is too short for its field-width byte pair.",
    );
  }
  const widthByte1 = payload.readUInt8(0);
  const widthByte2 = payload.readUInt8(1);
  const offsetSize = (widthByte1 >> 4) & 0xf;
  const lengthSize = widthByte1 & 0xf;
  const baseOffsetSize = (widthByte2 >> 4) & 0xf;
  const indexSize = widthByte2 & 0xf;

  if (!ILOC_FIELD_WIDTHS.has(offsetSize)) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc offset_size nibble ${offsetSize} is not one of {0, 4, 8}.`,
    );
  }
  if (!ILOC_FIELD_WIDTHS.has(lengthSize)) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc length_size nibble ${lengthSize} is not one of {0, 4, 8}.`,
    );
  }
  if (!ILOC_FIELD_WIDTHS.has(baseOffsetSize)) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc base_offset_size nibble ${baseOffsetSize} is not one of {0, 4, 8}.`,
    );
  }
  if (layout.hasIndexSize && !ILOC_FIELD_WIDTHS.has(indexSize)) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc index_size nibble ${indexSize} is not one of {0, 4, 8}.`,
    );
  }

  let position = 2;
  ensureBytes(payload, position, layout.itemCountBytes, "item_count");
  const itemCount =
    layout.itemCountBytes === 4
      ? payload.readUInt32BE(position)
      : payload.readUInt16BE(position);
  position += layout.itemCountBytes;

  // Floor check (BMF-05 DoS cap, T-61-14): the minimum bytes every item must occupy (zero
  // extents each), checked against the remaining payload before any per-item allocation.
  const minPerItemBytes =
    layout.itemIdBytes +
    (layout.hasConstructionMethod ? 2 : 0) +
    2 /* data_reference_index */ +
    baseOffsetSize +
    2; /* extent_count */
  const remaining = payload.length - position;
  if (itemCount * minPerItemBytes > remaining) {
    throw new IsobmffStructureError(
      "box-framing",
      `iloc declares item_count ${itemCount}, more than its remaining ${remaining}-byte payload could hold.`,
    );
  }

  const items: IlocItem[] = [];
  for (let i = 0; i < itemCount; i++) {
    ensureBytes(payload, position, layout.itemIdBytes, "item_ID");
    const itemId =
      layout.itemIdBytes === 4
        ? payload.readUInt32BE(position)
        : payload.readUInt16BE(position);
    position += layout.itemIdBytes;

    let constructionMethod = 0;
    if (layout.hasConstructionMethod) {
      ensureBytes(payload, position, 2, "construction_method");
      constructionMethod = payload.readUInt16BE(position) & 0xf;
      position += 2;
    }

    ensureBytes(payload, position, 2, "data_reference_index");
    const dataReferenceIndex = payload.readUInt16BE(position);
    position += 2;

    ensureBytes(payload, position, baseOffsetSize, "base_offset");
    const baseOffset = readSizedUint(payload, position, baseOffsetSize);
    position += baseOffsetSize;

    ensureBytes(payload, position, 2, "extent_count");
    const extentCount = payload.readUInt16BE(position);
    position += 2;

    const extents: IlocExtent[] = [];
    for (let e = 0; e < extentCount; e++) {
      let index = 0;
      if (layout.hasIndexSize && indexSize > 0) {
        ensureBytes(payload, position, indexSize, "extent_index");
        index = readSizedUint(payload, position, indexSize);
        position += indexSize;
      }

      ensureBytes(payload, position, offsetSize, "extent_offset");
      const offset = readSizedUint(payload, position, offsetSize);
      position += offsetSize;

      ensureBytes(payload, position, lengthSize, "extent_length");
      const length = readSizedUint(payload, position, lengthSize);
      position += lengthSize;

      extents.push({ index, offset, length });
    }

    items.push({
      itemId,
      constructionMethod,
      dataReferenceIndex,
      baseOffset,
      extents,
    });
  }

  return {
    version,
    offsetSize,
    lengthSize,
    baseOffsetSize,
    indexSize,
    items,
  };
}
