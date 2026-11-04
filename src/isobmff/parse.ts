import type { FileHandle } from "node:fs/promises";
import { IsobmffStructureError } from "./errors.js";
import {
  DEFAULT_ISOBMFF_CAPS,
  IsobmffBudget,
  type IsobmffCaps,
} from "./caps.js";
import {
  C2PA_UUID_USERTYPE,
  parseBoxHeader,
  readExactly,
  readTopLevelBoxes,
  TOP_LEVEL_ALLOWLIST,
  walkContainer,
  type BoxHeader,
} from "./boxes.js";
import type { IlocTable } from "./iloc.js";
import type { IpmaEntry } from "./ipma.js";
import {
  buildItemModel,
  type IsobmffByteRange,
  type IsobmffEntityGroup,
  type IsobmffItem,
  type IsobmffItemLayout,
  type IsobmffProperty,
  type IsobmffReference,
} from "./items.js";

// `parseIsobmff` entry point (BMF-01/BMF-05): reads a file's top-level box list, validates the
// D5 top-level allowlist and the `ftyp`/`meta`/`mdat` singleton rules, and walks `meta`'s
// children for structural (box-count/depth) purposes. Item tables (`iloc`/`ipma`/`iinf`/`iref`
// resolution) are built by 61-05/61-07 on top of this model -- this plan stops at the box level.

export interface IsobmffRange {
  readonly offset: number;
  readonly length: number;
}

export interface IsobmffModel {
  readonly majorBrand: string;
  readonly minorVersion: number;
  readonly compatibleBrands: readonly string[];
  readonly topLevel: readonly { readonly type: string }[];
  readonly metaRange: IsobmffRange;
  readonly mdatRanges: readonly IsobmffRange[];
  /** Top-level boxes admitted as removable (currently: the C2PA `uuid` box, D5). */
  readonly removableTopLevel: readonly IsobmffRange[];
  /** `meta`'s `iloc` child, resolved through the table-driven resolver (61-05, D1). */
  readonly iloc?: IlocTable;
  /** `meta/iprp`'s `ipma` child, resolved through the table-driven resolver (61-05, D1). */
  readonly ipma?: readonly IpmaEntry[];
  /** The validated item graph (61-07, D1): `iinf`/`infe` joined with `iloc`, `iref`, `ipco`/
   * `ipma`, `idat` and `grpl`, in `iinf` order. */
  readonly items: readonly IsobmffItem[];
  readonly itemsById: ReadonlyMap<number, IsobmffItem>;
  readonly primaryItemId: number;
  readonly references: readonly IsobmffReference[];
  readonly properties: readonly IsobmffProperty[];
  readonly groups: readonly IsobmffEntityGroup[];
  readonly idatRange?: IsobmffByteRange;
  readonly handlerType: string;
  /** The primary item's `colr` ICC payload (colour_type `prof`/`rICC` only); `nclx` or absent
   * yields `undefined` (D-12). */
  readonly colorProfile?: Buffer;
  /** Phase 62 writer layout (D-11..D-14): top-level box ranges plus `meta`'s own buffered payload
   * and item-graph layout, everything the rebuild encoders need, all already read once by this
   * same `parseIsobmff` call -- no new file reads. */
  readonly layout: IsobmffLayout;
}

export interface IsobmffLayout {
  /** Every top-level box, in source order (header ranges are file-absolute). */
  readonly topLevelBoxes: readonly BoxHeader[];
  /** File offset of `meta`'s own box start. */
  readonly metaOffset: number;
  /** Bytes of `meta`'s own box header (size+type, plus largesize/usertype if present) --
   * excludes the 4-byte FullBox version/flags field, which is the first 4 bytes of
   * `metaPayload` below. */
  readonly metaHeaderSize: number;
  /** `meta`'s already-buffered, cap-bounded FullBox payload (version/flags + children), the
   * exact buffer `parseIsobmff` read once under `budget.checkMetaSize`. */
  readonly metaPayload: Buffer;
  readonly item: IsobmffItemLayout;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/**
 * List one container level's direct children from an already-buffered payload, using only
 * `parseBoxHeader` (no budget checks -- the structural walk via `walkContainer` already enforced
 * every cap for this same buffer). Used to locate specific item-table boxes (`iloc`, `iprp`'s
 * `ipma`) that `walkContainer` itself does not surface outside its own recursion.
 */
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

function parseFtyp(payload: Buffer): {
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: readonly string[];
} {
  if (payload.length < 8) {
    throw new IsobmffStructureError(
      "box-framing",
      "ftyp payload is shorter than its required major_brand/minor_version fields.",
    );
  }
  const majorBrand = payload.toString("ascii", 0, 4);
  const minorVersion = payload.readUInt32BE(4);
  const compatibleBrands: string[] = [];
  for (let offset = 8; offset + 4 <= payload.length; offset += 4) {
    compatibleBrands.push(payload.toString("ascii", offset, offset + 4));
  }
  return { majorBrand, minorVersion, compatibleBrands };
}

export async function parseIsobmff(
  handle: FileHandle,
  size: number,
  caps: IsobmffCaps = DEFAULT_ISOBMFF_CAPS,
  signal?: AbortSignal,
): Promise<IsobmffModel> {
  const budget = new IsobmffBudget(caps);
  const topLevel = await readTopLevelBoxes(handle, size, budget);

  let majorBrand: string | undefined;
  let minorVersion = 0;
  let compatibleBrands: readonly string[] = [];
  let metaRange: IsobmffRange | undefined;
  const mdatRanges: IsobmffRange[] = [];
  const removableTopLevel: IsobmffRange[] = [];
  let sawFtyp = false;
  let sawMeta = false;
  let sawMdat = false;
  let iloc: IlocTable | undefined;
  let ipma: readonly IpmaEntry[] | undefined;
  let itemModel: ReturnType<typeof buildItemModel> | undefined;
  const topLevelBoxes: BoxHeader[] = [];
  let metaOffset: number | undefined;
  let metaHeaderSize: number | undefined;
  let metaPayloadBuf: Buffer | undefined;

  for (const header of topLevel) {
    if (isAborted(signal)) {
      throw new IsobmffStructureError("box-framing", "Parsing aborted.");
    }
    topLevelBoxes.push(header);

    if (header.type === "ftyp") {
      if (sawFtyp) {
        throw new IsobmffStructureError(
          "box-framing",
          'A second top-level "ftyp" box is not permitted.',
        );
      }
      sawFtyp = true;
      const payload = await readExactly(
        handle,
        header.end - header.payloadStart,
        header.payloadStart,
      );
      const parsed = parseFtyp(payload);
      majorBrand = parsed.majorBrand;
      minorVersion = parsed.minorVersion;
      compatibleBrands = parsed.compatibleBrands;
      continue;
    }

    if (header.type === "meta") {
      if (sawMeta) {
        throw new IsobmffStructureError(
          "duplicate-meta",
          'A second top-level "meta" box is not permitted.',
        );
      }
      sawMeta = true;
      const payloadLength = header.end - header.payloadStart;
      budget.checkMetaSize(payloadLength);
      const payload = await readExactly(
        handle,
        payloadLength,
        header.payloadStart,
      );
      if (payload.length < 4) {
        throw new IsobmffStructureError(
          "meta-not-fullbox",
          "meta payload is too short to carry a FullBox version/flags field.",
        );
      }
      const versionFlags = payload.readUInt32BE(0);
      if (versionFlags !== 0) {
        throw new IsobmffStructureError(
          "meta-not-fullbox",
          "meta is not a version-0 FullBox (QuickTime-style meta or an unsupported meta version).",
        );
      }
      walkContainer(payload, 4, payload.length, 1, budget);
      const metaChildren = listSiblings(payload, 4, payload.length);
      itemModel = buildItemModel(payload, metaChildren, budget);
      iloc = itemModel.ilocTable;
      ipma = itemModel.ipmaEntries;
      metaRange = { offset: header.start, length: header.end - header.start };
      metaOffset = header.start;
      metaHeaderSize = header.payloadStart - header.start;
      metaPayloadBuf = payload;
      continue;
    }

    if (header.type === "mdat") {
      if (sawMdat) {
        throw new IsobmffStructureError(
          "multiple-mdat",
          'A second top-level "mdat" box is not permitted.',
        );
      }
      sawMdat = true;
      mdatRanges.push({
        offset: header.payloadStart,
        length: header.end - header.payloadStart,
      });
      continue;
    }

    if (header.type === "moov") {
      throw new IsobmffStructureError(
        "sequence-box",
        'A top-level "moov" box indicates a sequence/fragmented file, which is not admitted.',
      );
    }

    if (TOP_LEVEL_ALLOWLIST.has(header.type)) {
      // free / skip: admitted, structurally inert.
      continue;
    }

    if (header.type === "uuid" && header.usertype === C2PA_UUID_USERTYPE) {
      removableTopLevel.push({
        offset: header.start,
        length: header.end - header.start,
      });
      continue;
    }

    throw new IsobmffStructureError(
      "top-level-box-not-allowed",
      `Top-level box "${header.type}" is not in the admitted set.`,
    );
  }

  if (majorBrand === undefined) {
    throw new IsobmffStructureError(
      "box-framing",
      'No top-level "ftyp" box was found.',
    );
  }
  if (metaRange === undefined || itemModel === undefined) {
    // A missing top-level `meta` is a missing required item-graph component, the same family as
    // a missing `hdlr`/`pitm`/`iinf`/`iloc` inside an existing `meta` (items.ts's buildItemModel,
    // all `item-graph-invalid`) -- not a byte-framing defect (61-09, D-14 BMF-03 empty-input edge).
    throw new IsobmffStructureError(
      "item-graph-invalid",
      'No top-level "meta" box was found.',
    );
  }

  // metaOffset/metaHeaderSize/metaPayloadBuf are always set together with itemModel (both only
  // assigned inside the "meta" branch above), so this cast is safe once itemModel is defined.
  const layout: IsobmffLayout = {
    topLevelBoxes,
    metaOffset: metaOffset as number,
    metaHeaderSize: metaHeaderSize as number,
    metaPayload: metaPayloadBuf as Buffer,
    item: itemModel.layout,
  };

  return {
    majorBrand,
    minorVersion,
    compatibleBrands,
    topLevel: topLevel.map((header) => ({ type: header.type })),
    metaRange,
    mdatRanges,
    removableTopLevel,
    ...(iloc !== undefined ? { iloc } : {}),
    ...(ipma !== undefined ? { ipma } : {}),
    items: itemModel.items,
    itemsById: itemModel.itemsById,
    primaryItemId: itemModel.primaryItemId,
    references: itemModel.references,
    properties: itemModel.properties,
    groups: itemModel.groups,
    ...(itemModel.idatRange !== undefined
      ? { idatRange: itemModel.idatRange }
      : {}),
    handlerType: itemModel.handlerType,
    ...(itemModel.colorProfile !== undefined
      ? { colorProfile: itemModel.colorProfile }
      : {}),
    layout,
  };
}
