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
import { parseIloc, type IlocTable } from "./iloc.js";
import { parseIpma, type IpmaEntry } from "./ipma.js";

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

/**
 * Read a child box's FullBox version/flags and hand back its payload with that 4-byte header
 * already stripped, for callers (`parseIloc`, `parseIpma`) that take version/flags separately.
 */
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
  let sawMeta = false;
  let sawMdat = false;
  let iloc: IlocTable | undefined;
  let ipma: readonly IpmaEntry[] | undefined;

  for (const header of topLevel) {
    if (isAborted(signal)) {
      throw new IsobmffStructureError("box-framing", "Parsing aborted.");
    }

    if (header.type === "ftyp") {
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
      const ilocHeader = metaChildren.find((child) => child.type === "iloc");
      if (ilocHeader !== undefined) {
        const {
          version,
          flags,
          payload: ilocPayload,
        } = readFullBoxChild(payload, ilocHeader);
        iloc = parseIloc(ilocPayload, version, flags);
      }
      const iprpHeader = metaChildren.find((child) => child.type === "iprp");
      if (iprpHeader !== undefined) {
        // `iprp` is a plain box (not a FullBox): its children (`ipco`, `ipma`) start at byte 0
        // of its own payload.
        const iprpChildren = listSiblings(
          payload,
          iprpHeader.payloadStart,
          iprpHeader.end,
        );
        const ipmaHeader = iprpChildren.find((child) => child.type === "ipma");
        if (ipmaHeader !== undefined) {
          const {
            version,
            flags,
            payload: ipmaPayload,
          } = readFullBoxChild(payload, ipmaHeader);
          ipma = parseIpma(ipmaPayload, version, flags);
        }
      }
      metaRange = { offset: header.start, length: header.end - header.start };
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
  if (metaRange === undefined) {
    throw new IsobmffStructureError(
      "box-framing",
      'No top-level "meta" box was found.',
    );
  }

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
  };
}
