import { IsobmffStructureError } from "./errors.js";

// `ipma` (ItemPropertyAssociationBox) table-driven resolver (BMF-01, D1, D-20). Two independent
// axes (Pitfall 7, confirmed in docs/isobmff.md `## Grammar` -> "ipma"): `item_ID` width is
// gated by FullBox `version` (16-bit v0, 32-bit v1); association-index width (and therefore the
// essential-bit position and `property_index` bit width) is gated independently by `flags & 1`
// (1 byte when clear, 2 bytes when set). `IPMA_LAYOUTS` keys on both axes together
// (`${version}:${flags & 1}`) so the resolver never branches on either dimension outside the
// table.

export interface IpmaLayout {
  readonly itemIdBytes: 2 | 4;
  readonly associationBytes: 1 | 2;
  readonly indexBits: 7 | 15;
}

export const IPMA_LAYOUTS: Readonly<Record<string, IpmaLayout>> = Object.freeze(
  {
    "0:0": { itemIdBytes: 2, associationBytes: 1, indexBits: 7 },
    "0:1": { itemIdBytes: 2, associationBytes: 2, indexBits: 15 },
    "1:0": { itemIdBytes: 4, associationBytes: 1, indexBits: 7 },
    "1:1": { itemIdBytes: 4, associationBytes: 2, indexBits: 15 },
  },
);

export interface IpmaAssociation {
  readonly essential: boolean;
  readonly propertyIndex: number;
}

export interface IpmaEntry {
  readonly itemId: number;
  readonly associations: readonly IpmaAssociation[];
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
      `ipma payload is too short for its ${what} field at offset ${position}.`,
    );
  }
}

/**
 * Parse an `ipma` box's payload (the bytes immediately after the FullBox version/flags, which the
 * caller has already stripped). `version`/`flags` come from that same FullBox header. Declines
 * `unsupported-box-version` for anything outside `{0, 1}`, and `box-framing` for a truncated
 * payload or an `association_count` running past the payload end.
 */
export function parseIpma(
  payload: Buffer,
  version: number,
  flags: number,
): readonly IpmaEntry[] {
  if (version !== 0 && version !== 1) {
    throw new IsobmffStructureError(
      "unsupported-box-version",
      `ipma version ${version} is not supported (only 0, 1 are admitted).`,
    );
  }
  const layoutKey = `${version}:${flags & 1}`;
  const layout = IPMA_LAYOUTS[layoutKey];
  if (layout === undefined) {
    throw new IsobmffStructureError(
      "box-framing",
      `ipma has no layout for version/flags key "${layoutKey}".`,
    );
  }

  let position = 0;
  ensureBytes(payload, position, 4, "entry_count");
  const entryCount = payload.readUInt32BE(position);
  position += 4;

  const entries: IpmaEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    ensureBytes(payload, position, layout.itemIdBytes, "item_ID");
    const itemId =
      layout.itemIdBytes === 4
        ? payload.readUInt32BE(position)
        : payload.readUInt16BE(position);
    position += layout.itemIdBytes;

    ensureBytes(payload, position, 1, "association_count");
    const associationCount = payload.readUInt8(position);
    position += 1;

    const associations: IpmaAssociation[] = [];
    for (let a = 0; a < associationCount; a++) {
      ensureBytes(payload, position, layout.associationBytes, "association");
      if (layout.associationBytes === 2) {
        const value = payload.readUInt16BE(position);
        associations.push({
          essential: (value & 0x8000) !== 0,
          propertyIndex: value & 0x7fff,
        });
      } else {
        const value = payload.readUInt8(position);
        associations.push({
          essential: (value & 0x80) !== 0,
          propertyIndex: value & 0x7f,
        });
      }
      position += layout.associationBytes;
    }

    entries.push({ itemId, associations });
  }

  return entries;
}
