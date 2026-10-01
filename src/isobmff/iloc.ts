import { IsobmffStructureError } from "./errors.js";

// `iloc` (ItemLocationBox) table-driven resolver (BMF-01, D1, D-20) -- RED stub. The real
// `ILOC_LAYOUTS`-driven implementation lands in the paired `feat` commit; this stub exists only
// so the test suite committed alongside it fails for the right reason (not implemented yet).

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

export const ILOC_FIELD_WIDTHS: ReadonlySet<number> = new Set([0, 4, 8]);

export interface IlocExtent {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

export interface IlocItem {
  readonly itemId: number;
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

export function readSizedUint(
  _buffer: Buffer,
  _position: number,
  _width: number,
): number {
  throw new IsobmffStructureError(
    "box-framing",
    "readSizedUint: not implemented (RED).",
  );
}

export function parseIloc(
  _payload: Buffer,
  _version: number,
  _flags: number,
): IlocTable {
  throw new IsobmffStructureError(
    "box-framing",
    "parseIloc: not implemented (RED).",
  );
}
