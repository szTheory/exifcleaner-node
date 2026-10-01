import { IsobmffStructureError } from "./errors.js";
import type { IsobmffBudget } from "./caps.js";
import { parseBoxHeader, type BoxHeader } from "./boxes.js";
import { parseIloc, type IlocExtent, type IlocTable } from "./iloc.js";
import { parseIpma, type IpmaEntry } from "./ipma.js";

// `meta`'s item graph (BMF-04/BMF-05, D1, D-21): joins `iinf`/`infe`, `iloc`, `iref`, `ipco`/
// `ipma`, `idat`, `grpl` and `pitm` into one validated `IsobmffItemModel`. Proven against the
// independent inventory walker (`tests/isobmff-support/inventory.ts`, D-21) on real `heif-enc`
// fixtures -- this module never imports `tests/` (D-21 independence runs both ways) and never
// reads `mdat` (BMF-05): every field read here comes from `metaPayload`, the single buffer
// `parseIsobmff` already read once under `budget.checkMetaSize`.

/** `meta` children this engine resolves; anything else declines `unknown-meta-child`. */
const META_CHILD_ALLOWLIST: ReadonlySet<string> = new Set([
  "hdlr",
  "dinf",
  "pitm",
  "iinf",
  "iref",
  "iprp",
  "idat",
  "iloc",
  "grpl",
]);

export interface IsobmffItemPropertyAssociation {
  readonly index: number;
  readonly essential: boolean;
}

export interface IsobmffItem {
  readonly id: number;
  /** `item_type_4cc` from a v2/v3 `infe` (e.g. "hvc1", "av01", "grid", "Exif", "mime", "uri "). */
  readonly type: string;
  readonly name: string;
  /** Only present when `type === "mime"`. */
  readonly contentType?: string;
  /** Only present when `type === "mime"`. */
  readonly contentEncoding?: string;
  /** Only present when `type === "uri "`. */
  readonly uri?: string;
  readonly hidden: boolean;
  /** 0 for a v0 `iloc` item (the field does not exist there) or a v1/v2 item without an `iloc` entry. */
  readonly constructionMethod: number;
  readonly dataReferenceIndex: number;
  readonly baseOffset: number;
  /** Literal `iloc` extents (D-10a: a `length: 0` extent is an empty extent, never rebased). */
  readonly extents: readonly IlocExtent[];
  readonly properties: readonly IsobmffItemPropertyAssociation[];
}

/** One `iref` `SingleItemTypeReferenceBox` record: `type` is the record's own box type. */
export interface IsobmffReference {
  readonly type: string;
  readonly fromItemId: number;
  readonly toItemIds: readonly number[];
}

/** One `ipco` property, 1-based index order (the index `ipma` associations refer to). */
export interface IsobmffProperty {
  readonly index: number;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  /** Only present for an `auxC` property: the `aux_type` URN string. */
  readonly auxUrn?: string;
  /** Only present for a `colr` property: its `colour_type` ("nclx", "prof", or "rICC"). */
  readonly colourType?: string;
}

export interface IsobmffEntityGroup {
  readonly type: string;
  readonly groupId: number;
  readonly entityIds: readonly number[];
}

export interface IsobmffByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface IsobmffItemModel {
  readonly items: readonly IsobmffItem[];
  readonly itemsById: ReadonlyMap<number, IsobmffItem>;
  readonly primaryItemId: number;
  readonly references: readonly IsobmffReference[];
  readonly properties: readonly IsobmffProperty[];
  readonly groups: readonly IsobmffEntityGroup[];
  readonly idatRange?: IsobmffByteRange;
  readonly handlerType: string;
  /** The primary item's `colr` ICC payload (colour_type `prof`/`rICC` only), copied out of
   * `metaPayload`. `nclx` or no `colr` property on the primary item yields `undefined` (D-12). */
  readonly colorProfile?: Buffer;
  /** Raw resolved `iloc` table -- `parseIsobmff` reuses this for its existing `model.iloc` field
   * (61-05) rather than parsing `iloc` a second time. */
  readonly ilocTable: IlocTable;
  /** Raw resolved `ipma` entries -- `parseIsobmff` reuses this for its existing `model.ipma`
   * field (61-05) rather than parsing `ipma` a second time. */
  readonly ipmaEntries: readonly IpmaEntry[];
}

function ensureBytes(
  buffer: Buffer,
  position: number,
  length: number,
  what: string,
): void {
  if (position + length > buffer.length) {
    throw new IsobmffStructureError(
      "box-framing",
      `${what} at offset ${position} runs past the end of its payload.`,
    );
  }
}

/** List one container level's direct children, using only `parseBoxHeader` (the structural
 * cap/depth walk over this same buffer already ran in `parseIsobmff`). */
function listSiblings(buffer: Buffer, start: number, end: number): BoxHeader[] {
  const boxes: BoxHeader[] = [];
  let position = start;
  while (position < end) {
    const header = parseBoxHeader(buffer, position, end);
    boxes.push(header);
    position = header.end;
  }
  return boxes;
}

/** Read a FullBox child's version/flags and hand back its payload with that 4-byte header
 * already stripped. */
function readFullBoxChild(
  buffer: Buffer,
  header: BoxHeader,
): { version: number; flags: number; payload: Buffer } {
  const full = buffer.subarray(header.payloadStart, header.end);
  if (full.length < 4) {
    throw new IsobmffStructureError(
      "box-framing",
      `"${header.type}" payload is too short to carry a FullBox version/flags field.`,
    );
  }
  const versionFlags = full.readUInt32BE(0);
  return {
    version: (versionFlags >>> 24) & 0xff,
    flags: versionFlags & 0x00ffffff,
    payload: full.subarray(4),
  };
}

function readCString(
  buffer: Buffer,
  position: number,
  what: string,
): { value: string; next: number } {
  let end = position;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  if (end >= buffer.length) {
    throw new IsobmffStructureError(
      "box-framing",
      `${what} is not NUL-terminated.`,
    );
  }
  return { value: buffer.toString("utf8", position, end), next: end + 1 };
}

function assertNoDuplicateIds(ids: readonly number[], context: string): void {
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new IsobmffStructureError(
        "item-graph-invalid",
        `Duplicate item_ID ${id} in ${context}.`,
      );
    }
    seen.add(id);
  }
}

/** `hdlr` -- FullBox version 0: `pre_defined(32) handler_type(32) reserved[3](32) name`. */
function parseHdlr(buffer: Buffer, header: BoxHeader): string {
  const { payload } = readFullBoxChild(buffer, header);
  ensureBytes(payload, 0, 8, "hdlr pre_defined/handler_type");
  return payload.toString("ascii", 4, 8);
}

/** `pitm` -- FullBox version 0 (16-bit `item_ID`) or 1 (32-bit). Declines `unsupported-box-version`
 * for any other version. */
function parsePitm(buffer: Buffer, header: BoxHeader): number {
  const { version, payload } = readFullBoxChild(buffer, header);
  if (version !== 0 && version !== 1) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `pitm version ${version} is not supported (only 0, 1 are admitted).`,
    );
  }
  const width = version === 0 ? 2 : 4;
  ensureBytes(payload, 0, width, "pitm item_ID");
  return width === 2 ? payload.readUInt16BE(0) : payload.readUInt32BE(0);
}

interface RawInfeEntry {
  readonly itemId: number;
  readonly type: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly contentType?: string;
  readonly contentEncoding?: string;
  readonly uri?: string;
}

/** `infe` -- only v2/v3 are admitted (v0/v1 lack `item_type`/the hidden flag this engine needs;
 * D-04/D-07 fields only exist from v2 on). */
function parseInfe(buffer: Buffer, header: BoxHeader): RawInfeEntry {
  const { version, flags, payload } = readFullBoxChild(buffer, header);
  if (version !== 2 && version !== 3) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `infe version ${version} is not supported (only 2, 3 are admitted).`,
    );
  }
  let position = 0;
  const idBytes = version === 2 ? 2 : 4;
  ensureBytes(payload, position, idBytes, "infe item_ID");
  const itemId =
    idBytes === 2
      ? payload.readUInt16BE(position)
      : payload.readUInt32BE(position);
  position += idBytes;
  ensureBytes(payload, position, 2, "infe item_protection_index");
  position += 2;
  ensureBytes(payload, position, 4, "infe item_type");
  const itemType = payload.toString("ascii", position, position + 4);
  position += 4;
  const name = readCString(payload, position, "infe item_name");
  position = name.next;

  let contentType: string | undefined;
  let contentEncoding: string | undefined;
  let uri: string | undefined;
  if (itemType === "mime") {
    const ct = readCString(payload, position, "infe content_type");
    contentType = ct.value;
    position = ct.next;
    // ISO/IEC 23008-12 9.2's content_encoding field is OPTIONAL: a conformant encoder may omit
    // it entirely rather than writing an explicit empty string (one NUL byte). Measured on the
    // real iPhone 13 Pro Max sample's XMP `mime` item (item 52): its infe payload ends exactly at
    // content_type's own terminator, with zero bytes remaining for content_encoding. Only attempt
    // to read it when bytes actually remain; an absent field is `undefined` here, the same
    // "no encoding declared" meaning as an explicit empty string (src/isobmff/admission.ts's
    // XMP-removable check already treats both identically).
    if (position < payload.length) {
      const ce = readCString(payload, position, "infe content_encoding");
      contentEncoding = ce.value;
      position = ce.next;
    }
  } else if (itemType === "uri ") {
    const u = readCString(payload, position, "infe item_uri_type");
    uri = u.value;
    position = u.next;
  }

  return {
    itemId,
    type: itemType,
    name: name.value,
    hidden: (flags & 1) === 1,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(contentEncoding !== undefined ? { contentEncoding } : {}),
    ...(uri !== undefined ? { uri } : {}),
  };
}

/** `iinf` -- FullBox; `entry_count` is 16-bit (v0) or 32-bit (v1), gating where its `infe`
 * children start. The declared `entry_count` value itself is not used to bound iteration: the
 * real sibling boxes are walked instead (naturally bounded by `metaPayload`, already under
 * `budget.checkMetaSize`), so a mismatched declared count cannot drive an over-large loop. */
function parseIinfEntries(buffer: Buffer, header: BoxHeader): RawInfeEntry[] {
  const { version, payload } = readFullBoxChild(buffer, header);
  if (version !== 0 && version !== 1) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `iinf version ${version} is not supported (only 0, 1 are admitted).`,
    );
  }
  const entryCountBytes = version === 0 ? 2 : 4;
  ensureBytes(payload, 0, entryCountBytes, "iinf entry_count");
  const childrenStart = header.payloadStart + 4 + entryCountBytes;
  const children = listSiblings(buffer, childrenStart, header.end);
  const entries: RawInfeEntry[] = [];
  for (const child of children) {
    if (child.type !== "infe") continue;
    entries.push(parseInfe(buffer, child));
  }
  return entries;
}

/** `iref` -- FullBox; each child's own box type is the reference type. `from_item_ID`/
 * `to_item_ID` are 16-bit (v0) or 32-bit (v1); `reference_count` is always 16-bit. */
function parseIref(buffer: Buffer, header: BoxHeader): IsobmffReference[] {
  const { version } = readFullBoxChild(buffer, header);
  if (version !== 0 && version !== 1) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `iref version ${version} is not supported (only 0, 1 are admitted).`,
    );
  }
  const idBytes = version === 0 ? 2 : 4;
  const childrenStart = header.payloadStart + 4;
  const children = listSiblings(buffer, childrenStart, header.end);
  const references: IsobmffReference[] = [];
  for (const child of children) {
    const body = buffer.subarray(child.payloadStart, child.end);
    ensureBytes(body, 0, idBytes, "iref from_item_ID");
    const fromItemId =
      idBytes === 2 ? body.readUInt16BE(0) : body.readUInt32BE(0);
    let position = idBytes;
    ensureBytes(body, position, 2, "iref reference_count");
    const toCount = body.readUInt16BE(position);
    position += 2;
    const toItemIds: number[] = [];
    for (let i = 0; i < toCount; i++) {
      ensureBytes(body, position, idBytes, "iref to_item_ID");
      toItemIds.push(
        idBytes === 2
          ? body.readUInt16BE(position)
          : body.readUInt32BE(position),
      );
      position += idBytes;
    }
    references.push({ type: child.type, fromItemId, toItemIds });
  }
  return references;
}

interface RawIpcoProperty extends IsobmffProperty {
  readonly iccBytes?: Buffer;
}

/** `ipco` -- a plain box (not a FullBox); children are the raw property boxes in 1-based
 * declaration order. `auxC` and `colr` are the only property types this engine interprets;
 * every other type is recorded as an opaque range (no pixel/codec decoding). */
function parseIpco(buffer: Buffer, header: BoxHeader): RawIpcoProperty[] {
  const children = listSiblings(buffer, header.payloadStart, header.end);
  const properties: RawIpcoProperty[] = [];
  let index = 1;
  for (const child of children) {
    let auxUrn: string | undefined;
    let colourType: string | undefined;
    let iccBytes: Buffer | undefined;
    if (child.type === "auxC") {
      const { payload } = readFullBoxChild(buffer, child);
      auxUrn = readCString(payload, 0, "auxC aux_type").value;
    } else if (child.type === "colr") {
      const payload = buffer.subarray(child.payloadStart, child.end);
      ensureBytes(payload, 0, 4, "colr colour_type");
      colourType = payload.toString("ascii", 0, 4);
      if (colourType === "prof" || colourType === "rICC") {
        iccBytes = Buffer.from(payload.subarray(4));
      }
    }
    properties.push({
      index,
      type: child.type,
      start: child.start,
      end: child.end,
      ...(auxUrn !== undefined ? { auxUrn } : {}),
      ...(colourType !== undefined ? { colourType } : {}),
      ...(iccBytes !== undefined ? { iccBytes } : {}),
    });
    index += 1;
  }
  return properties;
}

/** `grpl` -- a plain box whose children are `EntityToGroupBox` entries, each a FullBox version 0:
 * `group_id(32) num_entities_in_group(32) entity_id[32-bit each]`. */
function parseGrpl(buffer: Buffer, header: BoxHeader): IsobmffEntityGroup[] {
  const children = listSiblings(buffer, header.payloadStart, header.end);
  const groups: IsobmffEntityGroup[] = [];
  for (const child of children) {
    const { payload } = readFullBoxChild(buffer, child);
    ensureBytes(payload, 0, 8, "grpl group_id/num_entities_in_group");
    const groupId = payload.readUInt32BE(0);
    const entityCount = payload.readUInt32BE(4);
    const entityIds: number[] = [];
    let position = 8;
    for (let i = 0; i < entityCount; i++) {
      ensureBytes(payload, position, 4, "grpl entity_id");
      entityIds.push(payload.readUInt32BE(position));
      position += 4;
    }
    groups.push({ type: child.type, groupId, entityIds });
  }
  return groups;
}

/**
 * Build the validated item graph from `meta`'s already-walked children (`parseIsobmff` passes
 * `metaChildren` = `listSiblings(metaPayload, 4, metaPayload.length)`, the same buffer and list
 * its own structural walk already covered under `budget`). Declines `unknown-meta-child` for any
 * child outside the admitted set, `item-graph-invalid` for a missing `hdlr`/`pitm`/`iinf`/`iloc`,
 * a duplicate `item_ID` in `iinf`/`iloc`/`ipma`, or any dangling id (`iloc` entry, `pitm`, or
 * `iref` naming an item `iinf` never declared), `meta-handler-not-pict` for a non-`pict` `hdlr`,
 * and `unsupported-box-version` for an unadmitted `infe`/`iinf`/`iref`/`pitm` version.
 */
export function buildItemModel(
  metaPayload: Buffer,
  metaChildren: readonly BoxHeader[],
  _budget: IsobmffBudget,
): IsobmffItemModel {
  for (const child of metaChildren) {
    if (!META_CHILD_ALLOWLIST.has(child.type)) {
      throw new IsobmffStructureError(
        "unknown-meta-child",
        `meta child "${child.type}" is not in the admitted set.`,
      );
    }
  }

  const hdlrHeader = metaChildren.find((c) => c.type === "hdlr");
  if (hdlrHeader === undefined) {
    throw new IsobmffStructureError(
      "item-graph-invalid",
      "meta is missing its required hdlr child.",
    );
  }
  const handlerType = parseHdlr(metaPayload, hdlrHeader);
  if (handlerType !== "pict") {
    throw new IsobmffStructureError(
      "meta-handler-not-pict",
      `hdlr handler_type "${handlerType}" is not "pict".`,
    );
  }

  const iinfHeader = metaChildren.find((c) => c.type === "iinf");
  if (iinfHeader === undefined) {
    throw new IsobmffStructureError(
      "item-graph-invalid",
      "meta is missing its required iinf child.",
    );
  }
  const rawEntries = parseIinfEntries(metaPayload, iinfHeader);
  assertNoDuplicateIds(
    rawEntries.map((entry) => entry.itemId),
    "iinf",
  );
  const itemIds = new Set(rawEntries.map((entry) => entry.itemId));

  const pitmHeader = metaChildren.find((c) => c.type === "pitm");
  if (pitmHeader === undefined) {
    throw new IsobmffStructureError(
      "item-graph-invalid",
      "meta is missing its required pitm child.",
    );
  }
  const primaryItemId = parsePitm(metaPayload, pitmHeader);
  if (!itemIds.has(primaryItemId)) {
    throw new IsobmffStructureError(
      "item-graph-invalid",
      `pitm names undeclared item ${primaryItemId}.`,
    );
  }

  const ilocHeader = metaChildren.find((c) => c.type === "iloc");
  if (ilocHeader === undefined) {
    throw new IsobmffStructureError(
      "item-graph-invalid",
      "meta is missing its required iloc child.",
    );
  }
  const {
    version: ilocVersion,
    flags: ilocFlags,
    payload: ilocPayload,
  } = readFullBoxChild(metaPayload, ilocHeader);
  const ilocTable = parseIloc(ilocPayload, ilocVersion, ilocFlags);
  assertNoDuplicateIds(
    ilocTable.items.map((item) => item.itemId),
    "iloc",
  );
  for (const ilocItem of ilocTable.items) {
    if (!itemIds.has(ilocItem.itemId)) {
      throw new IsobmffStructureError(
        "item-graph-invalid",
        `iloc entry names undeclared item ${ilocItem.itemId}.`,
      );
    }
  }
  const ilocByItemId = new Map(
    ilocTable.items.map((item) => [item.itemId, item]),
  );

  let references: IsobmffReference[] = [];
  const irefHeader = metaChildren.find((c) => c.type === "iref");
  if (irefHeader !== undefined) {
    references = parseIref(metaPayload, irefHeader);
    for (const reference of references) {
      if (!itemIds.has(reference.fromItemId)) {
        throw new IsobmffStructureError(
          "item-graph-invalid",
          `iref "${reference.type}" names undeclared from-item ${reference.fromItemId}.`,
        );
      }
      for (const toItemId of reference.toItemIds) {
        if (!itemIds.has(toItemId)) {
          throw new IsobmffStructureError(
            "item-graph-invalid",
            `iref "${reference.type}" names undeclared to-item ${toItemId}.`,
          );
        }
      }
    }
  }

  let rawProperties: RawIpcoProperty[] = [];
  let ipmaEntries: readonly IpmaEntry[] = [];
  const iprpHeader = metaChildren.find((c) => c.type === "iprp");
  if (iprpHeader !== undefined) {
    const iprpChildren = listSiblings(
      metaPayload,
      iprpHeader.payloadStart,
      iprpHeader.end,
    );
    const ipcoHeader = iprpChildren.find((c) => c.type === "ipco");
    if (ipcoHeader !== undefined) {
      rawProperties = parseIpco(metaPayload, ipcoHeader);
    }
    const ipmaHeader = iprpChildren.find((c) => c.type === "ipma");
    if (ipmaHeader !== undefined) {
      const { version, flags, payload } = readFullBoxChild(
        metaPayload,
        ipmaHeader,
      );
      ipmaEntries = parseIpma(payload, version, flags);
      assertNoDuplicateIds(
        ipmaEntries.map((entry) => entry.itemId),
        "ipma",
      );
    }
  }
  const ipmaByItemId = new Map(
    ipmaEntries.map((entry) => [entry.itemId, entry]),
  );

  let idatRange: IsobmffByteRange | undefined;
  const idatHeader = metaChildren.find((c) => c.type === "idat");
  if (idatHeader !== undefined) {
    idatRange = {
      offset: idatHeader.payloadStart,
      length: idatHeader.end - idatHeader.payloadStart,
    };
  }

  let groups: IsobmffEntityGroup[] = [];
  const grplHeader = metaChildren.find((c) => c.type === "grpl");
  if (grplHeader !== undefined) {
    groups = parseGrpl(metaPayload, grplHeader);
  }

  let colorProfile: Buffer | undefined;
  const primaryAssociations = ipmaByItemId.get(primaryItemId);
  if (primaryAssociations !== undefined) {
    for (const association of primaryAssociations.associations) {
      const property = rawProperties.find(
        (candidate) => candidate.index === association.propertyIndex,
      );
      if (property?.iccBytes !== undefined) {
        colorProfile = property.iccBytes;
        break;
      }
    }
  }

  const properties: IsobmffProperty[] = rawProperties.map(
    ({ iccBytes: _iccBytes, ...rest }) => rest,
  );

  const items: IsobmffItem[] = rawEntries.map((entry) => {
    const ilocItem = ilocByItemId.get(entry.itemId);
    const assocEntry = ipmaByItemId.get(entry.itemId);
    return {
      id: entry.itemId,
      type: entry.type,
      name: entry.name,
      ...(entry.contentType !== undefined
        ? { contentType: entry.contentType }
        : {}),
      ...(entry.contentEncoding !== undefined
        ? { contentEncoding: entry.contentEncoding }
        : {}),
      ...(entry.uri !== undefined ? { uri: entry.uri } : {}),
      hidden: entry.hidden,
      constructionMethod: ilocItem?.constructionMethod ?? 0,
      dataReferenceIndex: ilocItem?.dataReferenceIndex ?? 0,
      baseOffset: ilocItem?.baseOffset ?? 0,
      extents: ilocItem?.extents ?? [],
      properties: (assocEntry?.associations ?? []).map((association) => ({
        index: association.propertyIndex,
        essential: association.essential,
      })),
    };
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return {
    items,
    itemsById,
    primaryItemId,
    references,
    properties,
    groups,
    ...(idatRange !== undefined ? { idatRange } : {}),
    handlerType,
    ...(colorProfile !== undefined ? { colorProfile } : {}),
    ilocTable,
    ipmaEntries,
  };
}
