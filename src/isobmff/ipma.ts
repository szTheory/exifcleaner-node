import { IsobmffStructureError } from "./errors.js";

// `ipma` (ItemPropertyAssociationBox) table-driven resolver (BMF-01, D1, D-20) -- RED stub. The
// real `IPMA_LAYOUTS`-driven implementation lands in the paired `feat` commit.

export interface IpmaLayout {
  readonly itemIdBytes: 2 | 4;
  readonly associationBytes: 1 | 2;
  readonly indexBits: 7 | 15;
}

export const IPMA_LAYOUTS: Readonly<Record<string, IpmaLayout>> =
  Object.freeze({
    "0:0": { itemIdBytes: 2, associationBytes: 1, indexBits: 7 },
    "0:1": { itemIdBytes: 2, associationBytes: 2, indexBits: 15 },
    "1:0": { itemIdBytes: 4, associationBytes: 1, indexBits: 7 },
    "1:1": { itemIdBytes: 4, associationBytes: 2, indexBits: 15 },
  });

export interface IpmaAssociation {
  readonly essential: boolean;
  readonly propertyIndex: number;
}

export interface IpmaEntry {
  readonly itemId: number;
  readonly associations: readonly IpmaAssociation[];
}

export function parseIpma(
  _payload: Buffer,
  _version: number,
  _flags: number,
): readonly IpmaEntry[] {
  throw new IsobmffStructureError(
    "box-framing",
    "parseIpma: not implemented (RED).",
  );
}
