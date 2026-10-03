// Independent structural ISOBMFF/HEIF inventory walker (test support only; D-21).
//
// This is the SECOND oracle: it must never import `src/isobmff/` (the engine under test) and must
// never import `./builder.ts` (the fixture builder) -- both are enforced by
// `tests/isobmff_isolation.test.ts`'s `ISOLATION_RULES`. It is deliberately written with a
// DataView-based cursor reader, a different code shape from the builder's Buffer-concatenation
// style, so the two never collapse into "one author's one reading of the spec, read twice."
//
// Every field width read here is the same cited libheif v1.19.7 `box.cc` grammar recorded in
// `docs/isobmff.md`'s `## Grammar` section -- the independence is in the implementation, not in a
// disagreement about what the bytes mean.

/** One top-level box: `ftyp`, `meta`, `mdat`, etc. */
export interface TopLevelBox {
  readonly type: string;
  readonly offset: number;
  readonly size: number;
}

/** One extent within an item's `iloc` record. */
export interface InventoryExtent {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

/** One item as recorded by `iinf`/`infe` and `iloc` together. */
export interface InventoryItem {
  readonly id: number;
  readonly type: string;
  readonly hidden: boolean;
  readonly contentType?: string;
  readonly contentEncoding?: string;
  readonly constructionMethod: number;
  readonly dataReferenceIndex: number;
  readonly baseOffset: number;
  readonly extents: readonly InventoryExtent[];
}

/** One `iref` reference: `type` is the reference's own box type (e.g. "dimg", "cdsc", "thmb"). */
export interface InventoryReference {
  readonly type: string;
  readonly from: number;
  readonly to: readonly number[];
}

/** One property inside `ipco`, 1-based index (the index `ipma` associations refer to). */
export interface InventoryProperty {
  readonly index: number;
  readonly type: string;
  /** Only present for `auxC` properties: the aux_type URN string. */
  readonly auxUrn?: string;
}

/** One `ipma` entry: which `ipco` property indices (and essential bits) an item carries. */
export interface InventoryAssociation {
  readonly itemId: number;
  readonly associations: readonly {
    readonly propertyIndex: number;
    readonly essential: boolean;
  }[];
}

/** `iloc` box version and the four declared field widths. */
export interface InventoryIloc {
  readonly version: number;
  readonly offsetSize: number;
  readonly lengthSize: number;
  readonly baseOffsetSize: number;
  readonly indexSize: number;
}

/** `idat` box: offset/length of its raw payload within the file. */
export interface InventoryIdat {
  readonly offset: number;
  readonly length: number;
}

export interface IsobmffInventory {
  readonly topLevel: readonly TopLevelBox[];
  readonly metaChildren: readonly string[];
  readonly primaryItemId: number | undefined;
  readonly items: readonly InventoryItem[];
  readonly references: readonly InventoryReference[];
  readonly properties: readonly InventoryProperty[];
  readonly associations: readonly InventoryAssociation[];
  readonly iloc: InventoryIloc | undefined;
  readonly idat: InventoryIdat | undefined;
}

/** A cursor-based reader over a `DataView`, distinct in shape from the builder's Buffer helpers. */
class Cursor {
  private position: number;
  private readonly view: DataView;

  constructor(view: DataView, start: number) {
    this.view = view;
    this.position = start;
  }

  get offset(): number {
    return this.position;
  }

  u8(): number {
    const value = this.view.getUint8(this.position);
    this.position += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.position);
    this.position += 2;
    return value;
  }

  u24(): number {
    const value =
      (this.view.getUint8(this.position) << 16) |
      (this.view.getUint8(this.position + 1) << 8) |
      this.view.getUint8(this.position + 2);
    this.position += 3;
    return value >>> 0;
  }

  u32(): number {
    const value = this.view.getUint32(this.position);
    this.position += 4;
    return value;
  }

  u64AsNumber(): number {
    const value = this.view.getBigUint64(this.position);
    this.position += 8;
    return Number(value);
  }

  /** Read an unsigned integer of `width` bytes (0, 4, or 8), returning 0 for width 0. */
  width(width: number): number {
    if (width === 0) return 0;
    if (width === 4) return this.u32();
    if (width === 8) return this.u64AsNumber();
    throw new Error(`inventory: unsupported field width ${width}`);
  }

  fourCc(): string {
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.position,
      4,
    );
    this.position += 4;
    return String.fromCharCode(...bytes);
  }

  cString(): string {
    const start = this.position;
    let end = start;
    const maxOffset = this.view.byteOffset + this.view.byteLength;
    while (
      this.view.byteOffset + end < maxOffset &&
      this.view.getUint8(end) !== 0
    ) {
      end += 1;
    }
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + start,
      end - start,
    );
    this.position = end + 1; // skip the terminating NUL
    return String.fromCharCode(...bytes);
  }

  skip(count: number): void {
    this.position += count;
  }

  seek(position: number): void {
    this.position = position;
  }
}

interface RawBox {
  readonly type: string;
  /** Absolute file offset of the box's `size` field (the very first byte of the box). */
  readonly offset: number;
  /** Total box size (header + payload), after resolving size-0/largesize framing. */
  readonly size: number;
  /** Absolute file offset of the first payload byte after the header (and largesize, if any). */
  readonly payloadOffset: number;
}

/** Walk sibling boxes from `start` to `end` (exclusive), resolving size-0 and largesize framing. */
function readBoxes(view: DataView, start: number, end: number): RawBox[] {
  const boxes: RawBox[] = [];
  let offset = start;
  while (offset < end) {
    const cursor = new Cursor(view, offset);
    let size = cursor.u32();
    const type = cursor.fourCc();
    let payloadOffset = offset + 8;
    if (size === 1) {
      size = cursor.u64AsNumber();
      payloadOffset = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (type === "uuid") {
      payloadOffset += 16;
    }
    boxes.push({ type, offset, size, payloadOffset });
    offset += size;
  }
  return boxes;
}

/** Read a FullBox's version/flags header (4 bytes: version(8) flags(24)) and advance past it. */
function readFullBoxHeader(
  view: DataView,
  payloadOffset: number,
): {
  readonly version: number;
  readonly flags: number;
  readonly afterHeader: number;
} {
  const cursor = new Cursor(view, payloadOffset);
  const version = cursor.u8();
  const flags = cursor.u24();
  return { version, flags, afterHeader: cursor.offset };
}

function parsePitm(view: DataView, box: RawBox): number {
  const { version, afterHeader } = readFullBoxHeader(view, box.payloadOffset);
  const cursor = new Cursor(view, afterHeader);
  return version === 0 ? cursor.u16() : cursor.u32();
}

function parseIinf(view: DataView, box: RawBox): InventoryItem[] {
  const { version, afterHeader } = readFullBoxHeader(view, box.payloadOffset);
  const cursor = new Cursor(view, afterHeader);
  const entryCount = version === 0 ? cursor.u16() : cursor.u32();
  const boxEnd = box.offset + box.size;

  const items: InventoryItem[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (cursor.offset >= boxEnd) break;
    const infeSize = new Cursor(view, cursor.offset).u32();
    const infeStart = cursor.offset;
    const infeCursor = new Cursor(view, infeStart + 4);
    const infeType = infeCursor.fourCc();
    if (infeType !== "infe") {
      cursor.seek(infeStart + infeSize);
      continue;
    }
    const {
      version: infeVersion,
      flags: infeFlags,
      afterHeader: infeAfterHeader,
    } = readFullBoxHeader(view, infeStart + 8);
    const body = new Cursor(view, infeAfterHeader);

    let itemId: number;
    if (infeVersion <= 1) {
      itemId = body.u16();
    } else {
      itemId = infeVersion === 2 ? body.u16() : body.u32();
    }

    let itemType = "";
    let contentType: string | undefined;
    let contentEncoding: string | undefined;

    if (infeVersion <= 1) {
      body.skip(2); // item_protection_index
      body.cString(); // item_name
      contentType = body.cString();
      contentEncoding = body.cString();
    } else {
      body.skip(2); // item_protection_index
      itemType = body.fourCc();
      body.cString(); // item_name
      if (itemType === "mime") {
        contentType = body.cString();
        contentEncoding = body.cString();
      } else if (itemType === "uri ") {
        body.cString(); // item_uri_type
      }
    }

    items.push({
      id: itemId,
      type: itemType,
      hidden: (infeFlags & 1) === 1,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(contentEncoding !== undefined ? { contentEncoding } : {}),
      constructionMethod: 0, // filled in from `iloc` by the caller
      dataReferenceIndex: 0, // filled in from `iloc` by the caller
      baseOffset: 0, // filled in from `iloc` by the caller
      extents: [], // filled in from `iloc` by the caller
    });
    cursor.seek(infeStart + infeSize);
  }
  return items;
}

interface IlocResult {
  readonly iloc: InventoryIloc;
  readonly byItemId: ReadonlyMap<
    number,
    {
      readonly constructionMethod: number;
      readonly dataReferenceIndex: number;
      readonly baseOffset: number;
      readonly extents: readonly InventoryExtent[];
    }
  >;
}

function parseIloc(view: DataView, box: RawBox): IlocResult {
  const { version, afterHeader } = readFullBoxHeader(view, box.payloadOffset);
  const cursor = new Cursor(view, afterHeader);

  const widthByte1 = cursor.u8();
  const widthByte2 = cursor.u8();
  const offsetSize = (widthByte1 >> 4) & 0xf;
  const lengthSize = widthByte1 & 0xf;
  const baseOffsetSize = (widthByte2 >> 4) & 0xf;
  const indexSize = widthByte2 & 0xf;

  const itemCount = version === 2 ? cursor.u32() : cursor.u16();
  const byItemId = new Map<
    number,
    {
      constructionMethod: number;
      dataReferenceIndex: number;
      baseOffset: number;
      extents: InventoryExtent[];
    }
  >();

  for (let i = 0; i < itemCount; i++) {
    const itemId = version === 2 ? cursor.u32() : cursor.u16();
    let constructionMethod = 0;
    if (version !== 0) {
      constructionMethod = cursor.u16() & 0xf;
    }
    const dataReferenceIndex = cursor.u16();
    const baseOffset = cursor.width(baseOffsetSize);
    const extentCount = cursor.u16();
    const extents: InventoryExtent[] = [];
    for (let e = 0; e < extentCount; e++) {
      const index = version !== 0 ? cursor.width(indexSize) : 0;
      const offset = cursor.width(offsetSize);
      const length = cursor.width(lengthSize);
      extents.push({ index, offset, length });
    }
    byItemId.set(itemId, {
      constructionMethod,
      dataReferenceIndex,
      baseOffset,
      extents,
    });
  }

  return {
    iloc: { version, offsetSize, lengthSize, baseOffsetSize, indexSize },
    byItemId,
  };
}

function parseIref(view: DataView, box: RawBox): InventoryReference[] {
  const { version, afterHeader } = readFullBoxHeader(view, box.payloadOffset);
  const boxEnd = box.offset + box.size;
  const references: InventoryReference[] = [];
  let offset = afterHeader;
  while (offset < boxEnd) {
    const header = new Cursor(view, offset);
    const recordSize = header.u32();
    const recordType = header.fourCc();
    const body = new Cursor(view, header.offset);
    const fromItemId = version === 0 ? body.u16() : body.u32();
    const toCount = body.u16();
    const to: number[] = [];
    for (let i = 0; i < toCount; i++) {
      to.push(version === 0 ? body.u16() : body.u32());
    }
    references.push({ type: recordType, from: fromItemId, to });
    offset += recordSize;
  }
  return references;
}

function parseIpco(view: DataView, box: RawBox): InventoryProperty[] {
  const boxEnd = box.offset + box.size;
  const properties: InventoryProperty[] = [];
  let offset = box.payloadOffset;
  let index = 1;
  while (offset < boxEnd) {
    const header = new Cursor(view, offset);
    let size = header.u32();
    const type = header.fourCc();
    let payloadOffset = offset + 8;
    if (size === 1) {
      size = header.u64AsNumber();
      payloadOffset = offset + 16;
    } else if (size === 0) {
      size = boxEnd - offset;
    }

    let auxUrn: string | undefined;
    if (type === "auxC") {
      // auxC is a FullBox: version(8) flags(24) aux_type(cString) aux_subtype(raw bytes).
      const { afterHeader } = readFullBoxHeader(view, payloadOffset);
      auxUrn = new Cursor(view, afterHeader).cString();
    }

    properties.push({
      index,
      type,
      ...(auxUrn !== undefined ? { auxUrn } : {}),
    });
    index += 1;
    offset += size;
  }
  return properties;
}

function parseIpma(view: DataView, box: RawBox): InventoryAssociation[] {
  const { version, flags, afterHeader } = readFullBoxHeader(
    view,
    box.payloadOffset,
  );
  const cursor = new Cursor(view, afterHeader);
  const wideAssociation = (flags & 1) === 1;
  const entryCount = cursor.u32();
  const associations: InventoryAssociation[] = [];
  for (let i = 0; i < entryCount; i++) {
    const itemId = version === 0 ? cursor.u16() : cursor.u32();
    const associationCount = cursor.u8();
    const entryAssociations: { propertyIndex: number; essential: boolean }[] =
      [];
    for (let a = 0; a < associationCount; a++) {
      if (wideAssociation) {
        const value = cursor.u16();
        entryAssociations.push({
          propertyIndex: value & 0x7fff,
          essential: (value & 0x8000) !== 0,
        });
      } else {
        const value = cursor.u8();
        entryAssociations.push({
          propertyIndex: value & 0x7f,
          essential: (value & 0x80) !== 0,
        });
      }
    }
    associations.push({ itemId, associations: entryAssociations });
  }
  return associations;
}

/**
 * Walk the top-level boxes of an ISOBMFF/HEIF file and build an independent structural inventory.
 * Never imports `src/isobmff/` or `./builder.ts` (D-21, enforced by `isobmff_isolation.test.ts`).
 */
export function inventoryIsobmff(bytes: Buffer): IsobmffInventory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const topLevelRaw = readBoxes(view, 0, bytes.byteLength);
  const topLevel: TopLevelBox[] = topLevelRaw.map((b) => ({
    type: b.type,
    offset: b.offset,
    size: b.size,
  }));

  const metaBox = topLevelRaw.find((b) => b.type === "meta");
  if (metaBox === undefined) {
    return {
      topLevel,
      metaChildren: [],
      primaryItemId: undefined,
      items: [],
      references: [],
      properties: [],
      associations: [],
      iloc: undefined,
      idat: undefined,
    };
  }

  // `meta` is a FullBox (version 0) in every fixture this inventory targets; QuickTime's
  // non-FullBox `meta` variant is out of scope for this walker (PITFALLS.md).
  const { afterHeader: metaPayloadStart } = readFullBoxHeader(
    view,
    metaBox.payloadOffset,
  );
  const metaChildrenRaw = readBoxes(
    view,
    metaPayloadStart,
    metaBox.offset + metaBox.size,
  );
  const metaChildren = metaChildrenRaw.map((b) => b.type);

  const pitmBox = metaChildrenRaw.find((b) => b.type === "pitm");
  const primaryItemId =
    pitmBox !== undefined ? parsePitm(view, pitmBox) : undefined;

  const iinfBox = metaChildrenRaw.find((b) => b.type === "iinf");
  const itemsFromIinf = iinfBox !== undefined ? parseIinf(view, iinfBox) : [];

  const ilocBox = metaChildrenRaw.find((b) => b.type === "iloc");
  const ilocResult =
    ilocBox !== undefined ? parseIloc(view, ilocBox) : undefined;

  const items: InventoryItem[] = itemsFromIinf.map((item) => {
    const ilocEntry = ilocResult?.byItemId.get(item.id);
    if (ilocEntry === undefined) return item;
    return {
      ...item,
      constructionMethod: ilocEntry.constructionMethod,
      dataReferenceIndex: ilocEntry.dataReferenceIndex,
      baseOffset: ilocEntry.baseOffset,
      extents: ilocEntry.extents,
    };
  });

  const irefBox = metaChildrenRaw.find((b) => b.type === "iref");
  const references = irefBox !== undefined ? parseIref(view, irefBox) : [];

  const iprpBox = metaChildrenRaw.find((b) => b.type === "iprp");
  let properties: InventoryProperty[] = [];
  let associations: InventoryAssociation[] = [];
  if (iprpBox !== undefined) {
    const iprpChildren = readBoxes(
      view,
      iprpBox.payloadOffset,
      iprpBox.offset + iprpBox.size,
    );
    const ipcoBox = iprpChildren.find((b) => b.type === "ipco");
    if (ipcoBox !== undefined) properties = parseIpco(view, ipcoBox);
    const ipmaBox = iprpChildren.find((b) => b.type === "ipma");
    if (ipmaBox !== undefined) associations = parseIpma(view, ipmaBox);
  }

  const idatBox = metaChildrenRaw.find((b) => b.type === "idat");
  const idat: InventoryIdat | undefined =
    idatBox !== undefined
      ? {
          offset: idatBox.payloadOffset,
          length: idatBox.size - (idatBox.payloadOffset - idatBox.offset),
        }
      : undefined;

  return {
    topLevel,
    metaChildren,
    primaryItemId,
    items,
    references,
    properties,
    associations,
    iloc: ilocResult?.iloc,
    idat,
  };
}

/**
 * Read an item's extent bytes back out of the file, resolving construction_method 0 (file-
 * relative: `baseOffset + extent.offset` into `fileBytes`) and construction_method 1 (idat-
 * relative: `baseOffset + extent.offset` into the `idat` box's own payload). Concatenates
 * multiple extents in declaration order. Used by cross-check tests to prove the inventory's
 * recorded offsets actually locate the configured payload bytes (D-21/D-20).
 */
export function readItemExtentBytes(
  fileBytes: Buffer,
  inventory: IsobmffInventory,
  item: InventoryItem,
): Buffer {
  if (item.constructionMethod === 1) {
    if (inventory.idat === undefined) {
      throw new Error(
        `readItemExtentBytes: item ${item.id} is construction_method 1 but no idat box was found`,
      );
    }
    const idatPayload = fileBytes.subarray(
      inventory.idat.offset,
      inventory.idat.offset + inventory.idat.length,
    );
    return Buffer.concat(
      item.extents.map((extent) =>
        idatPayload.subarray(
          item.baseOffset + extent.offset,
          item.baseOffset + extent.offset + extent.length,
        ),
      ),
    );
  }

  if (item.constructionMethod === 0) {
    return Buffer.concat(
      item.extents.map((extent) =>
        fileBytes.subarray(
          item.baseOffset + extent.offset,
          item.baseOffset + extent.offset + extent.length,
        ),
      ),
    );
  }

  throw new Error(
    `readItemExtentBytes: unsupported construction_method ${item.constructionMethod} for item ${item.id}`,
  );
}

/**
 * The item ids in `iloc` declaration order (62.1-08, ISO-01 ordering edge). `inventory.items`
 * follows `iinf` order and `associations` follows `ipma` order; `iloc` keeps its own order, which
 * this exposes without changing `IsobmffInventory`'s shape.
 */
export function ilocItemOrder(bytes: Buffer): readonly number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaBox = readBoxes(view, 0, bytes.byteLength).find(
    (b) => b.type === "meta",
  );
  if (metaBox === undefined) return [];
  const { afterHeader } = readFullBoxHeader(view, metaBox.payloadOffset);
  const ilocBox = readBoxes(
    view,
    afterHeader,
    metaBox.offset + metaBox.size,
  ).find((b) => b.type === "iloc");
  if (ilocBox === undefined) return [];
  return [...parseIloc(view, ilocBox).byItemId.keys()];
}
