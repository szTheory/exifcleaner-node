// Structural ISOBMFF/HEIF fixture builder (test support only).
//
// This file deliberately imports nothing from `src/isobmff/` (D-19) -- it is an independent
// byte-level encoder so the hex-literal tests in `tests/isobmff_builder.test.ts` and the real
// parser under test never share a single misreading of the spec. Every field width below is
// pinned against libheif v1.19.7 (`box.cc`); see `docs/isobmff.md`'s `## Grammar` section for
// the full citation table.

function fourCc(code: string): Buffer {
  if (code.length !== 4) {
    throw new Error(`fourCc: "${code}" must be exactly 4 ASCII characters`);
  }
  return Buffer.from(code, "ascii");
}

function uint8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function uint64(value: number | bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

/** Widths an `iloc`/`ipma`-style field may declare, per the Grammar section. */
export type FieldWidth = 0 | 4 | 8;

function writeWidth(value: number, width: FieldWidth): Buffer {
  if (width === 0) return Buffer.alloc(0);
  if (width === 4) return uint32(value);
  return uint64(value);
}

function nullTerminatedString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

/** `opts.size` override for box() -- used to build framing (and hostile-framing) fixtures. */
export interface BoxSizeOverride {
  /**
   * `"zero"` writes a literal 32-bit size field of 0 (ISO/IEC 14496-12 S4.2's "extends to end of
   * file" convention -- libheif's `BoxHeader::parse_header` stores the literal value with no
   * special-case, per docs/isobmff.md).
   * `"largesize"` writes size field `1` followed by a 64-bit largesize field holding the true
   * total box size (header + payload).
   * A `number` writes that literal value as the declared 32-bit size field, regardless of the
   * box's actual byte length -- for hostile/mismatched-framing fixtures.
   */
  readonly size?: "zero" | "largesize" | number;
}

/**
 * Encode one ISOBMFF box: `size(32) type(32) [largesize(64)] [usertype(16) if type=="uuid"]
 * payload`. See docs/isobmff.md `## Grammar` -> "Box header" for the cited source.
 */
export function box(
  type: string,
  payload: Buffer,
  opts: BoxSizeOverride = {},
): Buffer {
  const typeBuffer = fourCc(type);

  if (opts.size === "zero") {
    return Buffer.concat([uint32(0), typeBuffer, payload]);
  }

  if (opts.size === "largesize") {
    const total = 16 + payload.length; // 4 (size=1) + 4 (type) + 8 (largesize) + payload
    return Buffer.concat([uint32(1), typeBuffer, uint64(total), payload]);
  }

  const declaredSize =
    typeof opts.size === "number" ? opts.size : 8 + payload.length;
  return Buffer.concat([uint32(declaredSize), typeBuffer, payload]);
}

/**
 * Encode a FullBox: `box(type, version(8) flags(24) payload)`.
 * See docs/isobmff.md `## Grammar` -> "Box header" (`FullBox::parse_full_box_header`).
 */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  payload: Buffer,
  opts: BoxSizeOverride = {},
): Buffer {
  const versionFlags = Buffer.alloc(4);
  versionFlags.writeUInt8(version & 0xff, 0);
  versionFlags.writeUIntBE(flags & 0xffffff, 1, 3);
  return box(type, Buffer.concat([versionFlags, payload]), opts);
}

/** `ftyp` -- not a FullBox. See docs/isobmff.md Grammar -> "ftyp" (`Box_ftyp::parse`). */
export function ftypBox(
  majorBrand: string,
  minorVersion: number,
  compatibleBrands: readonly string[],
): Buffer {
  const parts = [
    fourCc(majorBrand),
    uint32(minorVersion),
    ...compatibleBrands.map(fourCc),
  ];
  return box("ftyp", Buffer.concat(parts));
}

/**
 * `hdlr` (HandlerBox) -- FullBox version 0 only (`Box_hdlr::parse`, box.cc:1236-1253):
 * pre_defined(32) handler_type(32) reserved[3](32 each) name(null-terminated string).
 */
export function hdlrBox(handlerType: string, name = ""): Buffer {
  const payload = Buffer.concat([
    uint32(0), // pre_defined
    fourCc(handlerType),
    Buffer.alloc(12), // reserved[3]
    nullTerminatedString(name),
  ]);
  return fullBox("hdlr", 0, 0, payload);
}

/**
 * `pitm` (PrimaryItemBox) -- FullBox version 0/1. See Grammar -> "pitm" (`Box_pitm::parse`).
 * v0: item_ID is 16-bit. v1: item_ID is 32-bit.
 */
export function pitmBox(version: 0 | 1, itemId: number): Buffer {
  const payload = version === 0 ? uint16(itemId) : uint32(itemId);
  return fullBox("pitm", version, 0, payload);
}

/**
 * `infe` (ItemInfoEntry) -- FullBox version 0-3. See Grammar -> "infe" (`Box_infe::parse`).
 * v<=1: item_ID(16) item_protection_index(16) item_name item_name/content_type/content_encoding.
 * v>=2: item_ID(16 for v2, 32 for v3) item_protection_index(16) item_type(32) item_name, then
 * content_type/content_encoding only when item_type=="mime", or item_uri_type when =="uri ".
 * `hidden` sets FullBox flags bit 0 (v>=2 only, per `Box_infe::set_hidden_item`).
 */
export interface InfeConfig {
  readonly version: 0 | 1 | 2 | 3;
  readonly itemId: number;
  readonly itemProtectionIndex?: number;
  /** Required for version >= 2; a 4-character code such as "hvc1", "Exif", "mime", "grid". */
  readonly itemType?: string;
  readonly hidden?: boolean;
  readonly name?: string;
  readonly contentType?: string;
  readonly contentEncoding?: string;
  readonly uriType?: string;
}

export function infeBox(config: InfeConfig): Buffer {
  const protectionIndex = config.itemProtectionIndex ?? 0;
  const parts: Buffer[] = [];

  if (config.version <= 1) {
    parts.push(uint16(config.itemId));
    parts.push(uint16(protectionIndex));
    parts.push(nullTerminatedString(config.name ?? ""));
    parts.push(nullTerminatedString(config.contentType ?? ""));
    parts.push(nullTerminatedString(config.contentEncoding ?? ""));
  } else {
    parts.push(
      config.version === 2 ? uint16(config.itemId) : uint32(config.itemId),
    );
    parts.push(uint16(protectionIndex));
    const itemType = config.itemType ?? "";
    parts.push(fourCc(itemType));
    parts.push(nullTerminatedString(config.name ?? ""));
    if (itemType === "mime") {
      parts.push(nullTerminatedString(config.contentType ?? ""));
      parts.push(nullTerminatedString(config.contentEncoding ?? ""));
    } else if (itemType === "uri ") {
      parts.push(nullTerminatedString(config.uriType ?? ""));
    }
  }

  const flags = config.hidden === true ? 1 : 0;
  return fullBox("infe", config.version, flags, Buffer.concat(parts));
}

/**
 * `iinf` (ItemInfoBox) -- FullBox. entry_count is 16-bit for version 0, 32-bit otherwise.
 * See Grammar -> "iinf" (`Box_iinf::parse`).
 */
export function iinfBox(version: 0 | 1, entries: readonly Buffer[]): Buffer {
  const countBuffer =
    version === 0 ? uint16(entries.length) : uint32(entries.length);
  return fullBox("iinf", version, 0, Buffer.concat([countBuffer, ...entries]));
}

/** One extent within an `iloc` item record. */
export interface IlocExtent {
  /** Only encoded for version 1/2, and only when `indexSize > 0`. */
  readonly index?: number;
  readonly offset: number;
  readonly length: number;
}

/** One item record within an `iloc` box. */
export interface IlocItem {
  readonly itemId: number;
  /** Only encoded for version >= 1 (absent entirely in v0). Defaults to 0 (file-relative). */
  readonly constructionMethod?: number;
  readonly dataReferenceIndex?: number;
  /** Width-gated by `baseOffsetSize`; ignored (written as 0 width) when that is 0. */
  readonly baseOffset?: number;
  readonly extents: readonly IlocExtent[];
}

/**
 * `iloc` (ItemLocationBox) -- FullBox version 0/1/2. See Grammar -> "iloc" (`Box_iloc::parse`,
 * `Box_iloc::read_data`). Field order per item: item_ID, construction_method (v>=1 only),
 * data_reference_index, base_offset, extent_count, then per extent (extent_index [v1/v2 only],
 * extent_offset, extent_length) in that order.
 */
export interface IlocConfig {
  readonly version: 0 | 1 | 2;
  readonly offsetSize: FieldWidth;
  readonly lengthSize: FieldWidth;
  readonly baseOffsetSize: FieldWidth;
  /** Reserved (ignored) in v0; only consulted for v1/v2. */
  readonly indexSize: FieldWidth;
  readonly items: readonly IlocItem[];
}

export function ilocBox(config: IlocConfig): Buffer {
  const header = Buffer.from([
    ((config.offsetSize & 0xf) << 4) | (config.lengthSize & 0xf),
    ((config.baseOffsetSize & 0xf) << 4) | (config.indexSize & 0xf),
  ]);

  const itemCount =
    config.version === 2
      ? uint32(config.items.length)
      : uint16(config.items.length);

  const itemBuffers = config.items.map((item) => {
    const parts: Buffer[] = [];
    parts.push(
      config.version === 2 ? uint32(item.itemId) : uint16(item.itemId),
    );
    if (config.version !== 0) {
      parts.push(uint16((item.constructionMethod ?? 0) & 0xf));
    }
    parts.push(uint16(item.dataReferenceIndex ?? 0));
    parts.push(writeWidth(item.baseOffset ?? 0, config.baseOffsetSize));
    parts.push(uint16(item.extents.length));
    for (const extent of item.extents) {
      if (config.version !== 0) {
        parts.push(writeWidth(extent.index ?? 0, config.indexSize));
      }
      parts.push(writeWidth(extent.offset, config.offsetSize));
      parts.push(writeWidth(extent.length, config.lengthSize));
    }
    return Buffer.concat(parts);
  });

  const payload = Buffer.concat([header, itemCount, ...itemBuffers]);
  return fullBox("iloc", config.version, 0, payload);
}

/** One property-association entry in `ipma`. */
export interface IpmaAssociation {
  readonly propertyIndex: number;
  readonly essential: boolean;
}

export interface IpmaEntry {
  readonly itemId: number;
  readonly associations: readonly IpmaAssociation[];
}

/**
 * `ipma` (ItemPropertyAssociationBox) -- FullBox version 0/1. See Grammar -> "ipma"
 * (`Box_ipma::parse`). `item_ID` width is version-gated (16-bit v0, 32-bit v1); the
 * association-index width (and therefore essential-bit position / property_index bit width) is
 * gated independently by FullBox flags bit 0 (1 byte when clear, 2 bytes when set) -- these are
 * two separate axes, not one (Pitfall 7).
 */
export interface IpmaConfig {
  readonly version: 0 | 1;
  readonly flags: number;
  readonly entries: readonly IpmaEntry[];
}

export function ipmaBox(config: IpmaConfig): Buffer {
  const wideAssociation = (config.flags & 1) === 1;
  const parts: Buffer[] = [uint32(config.entries.length)];
  for (const entry of config.entries) {
    parts.push(
      config.version === 0 ? uint16(entry.itemId) : uint32(entry.itemId),
    );
    parts.push(uint8(entry.associations.length));
    for (const association of entry.associations) {
      if (wideAssociation) {
        const value =
          (association.essential ? 0x8000 : 0) |
          (association.propertyIndex & 0x7fff);
        parts.push(uint16(value));
      } else {
        const value =
          (association.essential ? 0x80 : 0) |
          (association.propertyIndex & 0x7f);
        parts.push(uint8(value));
      }
    }
  }
  return fullBox("ipma", config.version, config.flags, Buffer.concat(parts));
}

/**
 * `ipco` (ItemPropertyContainerBox) -- NOT a FullBox; a plain box whose children are the raw
 * property boxes in declaration order (1-based index referenced by `ipma`). See Grammar note on
 * `Box_ipco::parse` (`parse_full_box_header` is commented out at box.cc:2395).
 */
export function ipcoBox(properties: readonly Buffer[]): Buffer {
  return box("ipco", Buffer.concat(properties));
}

/**
 * `iprp` (ItemPropertiesBox) -- NOT a FullBox; wraps exactly one `ipco` followed by one `ipma`.
 * (`Box_iprp::parse` also has `parse_full_box_header` commented out, box.cc:2347-2350 region.)
 */
export function iprpBox(ipco: Buffer, ipma: Buffer): Buffer {
  return box("iprp", Buffer.concat([ipco, ipma]));
}

/** `ispe` (ImageSpatialExtentsProperty) -- FullBox version 0: image_width(32) image_height(32). */
export function ispe(width: number, height: number): Buffer {
  return fullBox("ispe", 0, 0, Buffer.concat([uint32(width), uint32(height)]));
}

function minimalHevcDecoderConfigurationRecord(): Buffer {
  // A structurally-shaped (not decodable) HEVCDecoderConfigurationRecord: 23 fixed bytes plus
  // numOfArrays=0. hvcC is not a FullBox (ISO/IEC 14496-15); the record is the box payload as-is.
  const record = Buffer.alloc(23);
  record[0] = 1; // configurationVersion
  record[1] = 0x01; // profile_space(2)=0, tier_flag(1)=0, profile_idc(5)=1
  record.writeUInt32BE(0x60000000, 2); // general_profile_compatibility_flags
  // general_constraint_indicator_flags (6 bytes) left at 0
  record[12] = 93; // general_level_idc
  record.writeUInt16BE(0xf000, 13); // reserved(4)=1111, min_spatial_segmentation_idc(12)=0
  record[15] = 0xfc; // reserved(6)=111111, parallelismType(2)=0
  record[16] = 0xfd; // reserved(6)=111111, chroma_format_idc(2)=1 (4:2:0)
  record[17] = 0xf8; // reserved(5)=11111, bit_depth_luma_minus8(3)=0
  record[18] = 0xf8; // reserved(5)=11111, bit_depth_chroma_minus8(3)=0
  record.writeUInt16BE(0, 19); // avgFrameRate
  record[21] = 0x0f; // constantFrameRate(2)=0, numTemporalLayers(3)=0, temporalIdNested(1)=0, lengthSizeMinusOne(2)=3
  record[22] = 0; // numOfArrays
  return record;
}

/** `hvcC` (HEVCConfigurationBox) -- NOT a FullBox; wraps an HEVCDecoderConfigurationRecord. */
export function hvcC(raw?: Buffer): Buffer {
  return box("hvcC", raw ?? minimalHevcDecoderConfigurationRecord());
}

/** Minimal structural primary item, Exif item and mime (XMP) item composed into one HEIF file. */
export interface HeifFileConfig {
  readonly majorBrand?: string;
  readonly compatibleBrands?: readonly string[];
  readonly primary: {
    readonly itemId: number;
    readonly itemType: string;
    readonly width: number;
    readonly height: number;
    readonly payload: Buffer;
  };
  readonly exif?: {
    readonly itemId: number;
    readonly payload: Buffer;
  };
  readonly mime?: {
    readonly itemId: number;
    readonly contentType: string;
    readonly payload: Buffer;
  };
}

/**
 * Compose a minimal structurally-valid HEIF file: ftyp, meta (hdlr "pict", pitm, iinf, iprp with
 * one ipco[ispe,hvcC]/ipma pair on the primary item, iloc v1 widths (4,4,0,0)) and one trailing
 * mdat. Extent offsets are computed in two passes (iloc's encoded byte length does not depend on
 * the numeric offset values, only on the declared widths) so construction_method 0 extents are
 * correctly file-relative against the final mdat payload position.
 */
export function heifFile(config: HeifFileConfig): Buffer {
  const majorBrand = config.majorBrand ?? "heic";
  const compatibleBrands = config.compatibleBrands ?? ["mif1", "heic"];
  const ftyp = ftypBox(majorBrand, 0, compatibleBrands);

  const hdlr = hdlrBox("pict");
  const pitm = pitmBox(0, config.primary.itemId);

  interface PlacedItem {
    readonly itemId: number;
    readonly payload: Buffer;
  }
  const infeEntries: Buffer[] = [
    infeBox({
      version: 2,
      itemId: config.primary.itemId,
      itemType: config.primary.itemType,
    }),
  ];
  const items: PlacedItem[] = [
    { itemId: config.primary.itemId, payload: config.primary.payload },
  ];

  if (config.exif !== undefined) {
    infeEntries.push(
      infeBox({ version: 2, itemId: config.exif.itemId, itemType: "Exif" }),
    );
    items.push({ itemId: config.exif.itemId, payload: config.exif.payload });
  }

  if (config.mime !== undefined) {
    infeEntries.push(
      infeBox({
        version: 2,
        itemId: config.mime.itemId,
        itemType: "mime",
        contentType: config.mime.contentType,
      }),
    );
    items.push({ itemId: config.mime.itemId, payload: config.mime.payload });
  }

  const iinf = iinfBox(0, infeEntries);

  const ipco = ipcoBox([
    ispe(config.primary.width, config.primary.height),
    hvcC(),
  ]);
  const ipma = ipmaBox({
    version: 0,
    flags: 0,
    entries: [
      {
        itemId: config.primary.itemId,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: true },
        ],
      },
    ],
  });
  const iprp = iprpBox(ipco, ipma);

  const metaChildrenWithoutIloc = [hdlr, pitm, iinf, iprp];

  function buildIloc(offsets: readonly number[]): Buffer {
    return ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 0,
      indexSize: 0,
      items: items.map((item, index) => ({
        itemId: item.itemId,
        constructionMethod: 0,
        dataReferenceIndex: 0,
        baseOffset: 0,
        extents: [{ offset: offsets[index] ?? 0, length: item.payload.length }],
      })),
    });
  }

  // Pass 1: placeholder offsets (0) -- iloc's byte length only depends on declared widths.
  const placeholderIloc = buildIloc(items.map(() => 0));
  const meta = metaBox([...metaChildrenWithoutIloc, placeholderIloc]);

  const mdatHeaderSize = 8;
  const headerLength = ftyp.length + meta.length + mdatHeaderSize;
  let runningOffset = headerLength;
  const offsets: number[] = [];
  for (const item of items) {
    offsets.push(runningOffset);
    runningOffset += item.payload.length;
  }

  // Pass 2: real offsets, same iloc byte length as pass 1.
  const finalIloc = buildIloc(offsets);
  const finalMeta = metaBox([...metaChildrenWithoutIloc, finalIloc]);
  if (finalMeta.length !== meta.length) {
    throw new Error(
      "heifFile: iloc byte length changed between placeholder and final passes",
    );
  }

  const mdatPayload = Buffer.concat(items.map((item) => item.payload));
  const mdat = mdatBox(mdatPayload);

  return Buffer.concat([ftyp, finalMeta, mdat]);
}

/** `meta` -- FullBox version 0 by default; `opts.quickTime` omits version/flags entirely. */
export interface MetaOptions {
  readonly quickTime?: boolean;
}

export function metaBox(
  children: readonly Buffer[],
  opts: MetaOptions = {},
): Buffer {
  const payload = Buffer.concat(children);
  if (opts.quickTime === true) {
    return box("meta", payload);
  }
  return fullBox("meta", 0, 0, payload);
}

/** `mdat` -- raw media data box, no FullBox header. */
export function mdatBox(payload: Buffer, opts: BoxSizeOverride = {}): Buffer {
  return box("mdat", payload, opts);
}

/** `idat` -- ItemDataBox; NOT a FullBox (`Box_idat::parse`, box.cc:3736-3743: the
 * `parse_full_box_header` call is commented out). Raw bytes referenced by cm=1 extents. */
export function idatBox(payload: Buffer): Buffer {
  return box("idat", payload);
}

/** One `SingleItemTypeReferenceBox` entry in `iref`: its own box type IS the reference type. */
export interface IrefRef {
  /** 4-character reference type, e.g. "dimg", "thmb", "auxl", "cdsc". */
  readonly type: string;
  readonly fromItemId: number;
  readonly toItemIds: readonly number[];
}

/**
 * `iref` (ItemReferenceBox) -- FullBox version 0/1. See Grammar -> "iref" (`Box_iref::parse`).
 * `from_item_ID`/`to_item_ID` are 16-bit (v0) or 32-bit (v1); `reference_count` is always 16-bit
 * regardless of version.
 */
export function irefBox(version: 0 | 1, refs: readonly IrefRef[]): Buffer {
  const writeId = (id: number) => (version === 0 ? uint16(id) : uint32(id));
  const children = refs.map((ref) =>
    box(
      ref.type,
      Buffer.concat([
        writeId(ref.fromItemId),
        uint16(ref.toItemIds.length),
        ...ref.toItemIds.map(writeId),
      ]),
    ),
  );
  return fullBox("iref", version, 0, Buffer.concat(children));
}

/** One `EntityToGroupBox` entry inside a `grpl` (GroupListBox). */
export interface GrplGroup {
  /** 4-character group_type, e.g. "altr". */
  readonly type: string;
  readonly groupId: number;
  readonly entityIds: readonly number[];
}

/**
 * `grpl` (GroupListBox) -- a plain box (no FullBox header of its own) whose children are
 * `EntityToGroupBox` entries, each a FullBox version 0: group_id(32) num_entities_in_group(32)
 * entity_id[32-bit each].
 */
export function grplBox(groups: readonly GrplGroup[]): Buffer {
  const children = groups.map((group) =>
    fullBox(
      group.type,
      0,
      0,
      Buffer.concat([
        uint32(group.groupId),
        uint32(group.entityIds.length),
        ...group.entityIds.map(uint32),
      ]),
    ),
  );
  return box("grpl", Buffer.concat(children));
}

/**
 * Any box with `type == "uuid"`: `size(32) "uuid"(32) usertype(16 bytes) payload`. See Grammar ->
 * "Box header" (`BoxHeader::parse_header`, box.cc:264-277).
 */
export function uuidBox(usertypeHex: string, payload: Buffer): Buffer {
  const usertype = Buffer.from(usertypeHex, "hex");
  if (usertype.length !== 16) {
    throw new Error("uuidBox: usertypeHex must encode exactly 16 bytes");
  }
  return box("uuid", Buffer.concat([usertype, payload]));
}

/**
 * `colr` with `colour_type == "nclx"` -- not a FullBox; colour_primaries(16) transfer_
 * characteristics(16) matrix_coefficients(16) full_range_flag(1 bit)+reserved(7 bits, 1 byte).
 */
export function colrNclx(
  colourPrimaries: number,
  transferCharacteristics: number,
  matrixCoefficients: number,
  fullRange: boolean,
): Buffer {
  const payload = Buffer.concat([
    fourCc("nclx"),
    uint16(colourPrimaries),
    uint16(transferCharacteristics),
    uint16(matrixCoefficients),
    Buffer.from([fullRange ? 0x80 : 0x00]),
  ]);
  return box("colr", payload);
}

/** `colr` with `colour_type == "prof"` (restricted ICC profile), raw ICC bytes follow verbatim. */
export function colrProf(iccBytes: Buffer): Buffer {
  return box("colr", Buffer.concat([fourCc("prof"), iccBytes]));
}

/**
 * `irot` (ImageRotation transform property) -- a plain `ItemProperty`, not a FullBox: one byte,
 * low 2 bits hold the counter-clockwise rotation angle in units of 90 degrees.
 */
export function irot(angle: 0 | 1 | 2 | 3): Buffer {
  return box("irot", Buffer.from([angle & 0x3]));
}

/** `imir` (ImageMirror transform property) -- a plain box; one byte, low bit is the mirror axis. */
export function imir(axis: 0 | 1): Buffer {
  return box("imir", Buffer.from([axis & 0x1]));
}

/**
 * `pixi` (PixelInformationProperty) -- FullBox version 0: num_channels(8) then
 * bits_per_channel(8) per channel.
 */
export function pixi(bitsPerChannel: readonly number[]): Buffer {
  const payload = Buffer.concat([
    uint8(bitsPerChannel.length),
    Buffer.from(bitsPerChannel.map((value) => value & 0xff)),
  ]);
  return fullBox("pixi", 0, 0, payload);
}

/**
 * `auxC` (AuxiliaryTypeProperty) -- FullBox version 0: aux_type (null-terminated string) then
 * aux_subtype raw bytes to the end of the box. See `urn:com:apple:photo:2020:aux:hdrgainmap`
 * measured on the real iPhone sample (61-01-SUMMARY.md).
 */
export function auxC(urn: string, subtype: Buffer = Buffer.alloc(0)): Buffer {
  return fullBox(
    "auxC",
    0,
    0,
    Buffer.concat([nullTerminatedString(urn), subtype]),
  );
}

/** `av1C` (AV1CodecConfigurationBox) -- not a FullBox; wraps an AV1CodecConfigurationRecord. */
export function av1C(raw: Buffer): Buffer {
  return box("av1C", raw);
}
