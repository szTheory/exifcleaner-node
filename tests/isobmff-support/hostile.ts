// Hostile ISOBMFF/HEIF fixture catalog (BMF-03, D-14): exactly one fixture per
// `IsobmffDeclineClass`, proving every class declines with its own public code and class. D-19
// independence: this file imports only `./builder.js` (the structural byte-level encoder) and, as
// its one narrow, explicitly-allowed exception (see `tests/isobmff_isolation.test.ts`'s
// `allowedTypeOnlySpecifierSubstrings`), a `import type` of `IsobmffDeclineClass` from
// `src/isobmff/errors.js` -- needed only so `HOSTILE_FIXTURES`'s key type can be checked against
// the real union at compile time (a class added without a fixture then fails typecheck, not just
// a runtime walk). No value is ever imported from `src/isobmff/`.
import { open } from "node:fs/promises";
import type { IsobmffDeclineClass } from "../../src/isobmff/errors.js";
import {
  ftypBox,
  fullBox,
  hdlrBox,
  hvcC,
  idatBox,
  iinfBox,
  ilocBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  irefBox,
  grplBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
  uuidBox,
  box,
  type FieldWidth,
  type GrplGroup,
  type IpmaEntry,
  type IrefRef,
} from "./builder.js";

// The four `DEFAULT_ISOBMFF_CAPS` values (src/isobmff/caps.ts), hardcoded here rather than
// imported: `caps.ts` lives under `src/isobmff/`, and this file may only take a type-only import
// of `IsobmffDeclineClass` from that tree (see the file banner above). Mirrors docs/isobmff.md's
// "## Memory caps" section -- if those defaults ever change, this file and that doc must be
// updated together.
const CAP_META_BYTES = 16 * 1024 * 1024;
const CAP_BOX_COUNT = 65_536;
const CAP_BOX_DEPTH = 8;
const CAP_BUFFERED_BYTES_TOTAL = 32 * 1024 * 1024;

/** A non-C2PA `uuid` usertype (16 bytes, arbitrary) -- deliberately NOT the registered C2PA value
 * (`d8fec3d61b0e483c92975828877ec481`, src/isobmff/boxes.ts), which this file may not import. */
const NON_C2PA_UUID_USERTYPE = "00112233445566778899aabbccddeeff";

export interface HostileFixture {
  /** Write this fixture's bytes to `path` (a fresh, caller-owned file). */
  write(path: string): Promise<void>;
  /** The public `MetadataErrorDetails["code"]` this fixture's decline must report. */
  readonly expectedCode:
    "unsupported-format" | "unsafe-structure" | "malformed-file";
  /**
   * `"admission"` (23 of 25 classes): `admitIsobmff` on the written fixture rejects with this
   * class. `"selection"` (`sequence-brand` only, D-12): the fixture already declines at handler
   * *selection* time (`classifyIsobmffBrand` on its first 256 bytes), before any full parse --
   * `admitIsobmff` called directly on it still declines the same class, as defense in depth.
   * `"plan"` (`offset-rewrite-overflow` only, 62-05 D-12): `admitIsobmff` on the written fixture
   * *resolves* (it is a structurally valid, fully admitted file) -- the decline happens one stage
   * later, in `checkIsobmffOutputPlan`, strictly before `writeOutput` ever runs.
   */
  readonly stage: "selection" | "admission" | "plan";
}

async function writeBytes(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
}

// --- Generic structurally-valid-by-default HEIF/AVIF assembler ---
//
// Every catalog/variant fixture below is a *deliberate single deviation* from an otherwise
// structurally valid file, built through this one assembler so each deviation is obvious at the
// call site. `twoPass` is the one knob needed for `removable-extent-overlap` only: that is the
// single `DECLINE_RULE_ORDER` class whose own rule (10) can only be *reached* once rule 9
// (`extent-outside-mdat`) has already passed for every item in the file, so its extents must sit
// at their real (not placeholder-zero) absolute file offsets. Every other class declines at a
// rule strictly before rule 9 is ever evaluated (`DECLINE_RULE_ORDER` runs one full pass per rule,
// not per item -- the first rule with any violation across the whole item set wins), so a
// placeholder `baseOffset` of 0 is harmless there: the fixture never reaches rule 9 or 10 at all.

export interface HostileItemSpec {
  readonly itemId: number;
  readonly itemType: string;
  readonly hidden?: boolean;
  readonly contentType?: string;
  readonly contentEncoding?: string;
  readonly omitContentEncoding?: boolean;
  readonly infeVersion?: 0 | 1 | 2 | 3;
  readonly constructionMethod?: number;
  readonly dataReferenceIndex?: number;
  readonly extents: readonly {
    readonly relOffset: number;
    readonly length: number;
  }[];
  readonly propertyIndices?: readonly number[];
}

export interface AssembleHeifSpec {
  readonly majorBrand?: string;
  readonly compatibleBrands?: readonly string[];
  readonly primaryItemId?: number;
  readonly items?: readonly HostileItemSpec[];
  readonly properties?: readonly Buffer[];
  readonly refs?: readonly IrefRef[];
  readonly groups?: readonly GrplGroup[];
  readonly idatPayload?: Buffer;
  readonly mdatPayload?: Buffer;
  readonly hdlrType?: string;
  readonly omitHdlr?: boolean;
  readonly omitPitm?: boolean;
  readonly omitIinf?: boolean;
  readonly omitIloc?: boolean;
  readonly extraMetaChildren?: readonly Buffer[];
  readonly ilocWidths?: {
    readonly offsetSize: FieldWidth;
    readonly lengthSize: FieldWidth;
    readonly baseOffsetSize: FieldWidth;
  };
  /** Appended between `meta` and `mdat` (sequence-box/top-level-box-not-allowed fixtures). */
  readonly topLevelExtraBeforeMdat?: readonly Buffer[];
  readonly secondMdat?: boolean;
  readonly secondMeta?: boolean;
  readonly quickTimeMeta?: boolean;
  /** See the module banner: only `removable-extent-overlap` needs this. */
  readonly twoPass?: boolean;
  /**
   * D-17 (62-04): extra `ipma` entries appended verbatim after the ones the assembler derives
   * from `items`' own `propertyIndices` -- the only way to produce an `ipma` entry whose
   * `item_ID` is not declared in `iinf` at all (every other field on this spec that mentions an
   * item ID requires that ID to already exist in `items`).
   */
  readonly extraIpmaEntries?: readonly IpmaEntry[];
}

const DEFAULT_ITEMS: readonly HostileItemSpec[] = [
  {
    itemId: 1,
    itemType: "hvc1",
    extents: [{ relOffset: 0, length: 4 }],
    propertyIndices: [1, 2],
  },
];

const DEFAULT_WIDTHS: AssembleHeifSpec["ilocWidths"] = {
  offsetSize: 4,
  lengthSize: 4,
  baseOffsetSize: 4,
};

export function assembleHeif(spec: AssembleHeifSpec = {}): Buffer {
  const items = spec.items ?? DEFAULT_ITEMS;
  const primaryItemId = spec.primaryItemId ?? items[0]?.itemId ?? 1;
  const mdatPayload = spec.mdatPayload ?? Buffer.from([1, 2, 3, 4]);
  const widths = spec.ilocWidths ?? DEFAULT_WIDTHS;

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox(
      spec.majorBrand ?? "heic",
      0,
      spec.compatibleBrands ?? ["mif1", "heic"],
    );
    const hdlr = hdlrBox(spec.hdlrType ?? "pict");
    const pitm = pitmBox(0, primaryItemId);
    const infeEntries = items.map((item) =>
      infeBox({
        version: item.infeVersion ?? 2,
        itemId: item.itemId,
        itemType: item.itemType,
        ...(item.hidden !== undefined ? { hidden: item.hidden } : {}),
        ...(item.contentType !== undefined
          ? { contentType: item.contentType }
          : {}),
        ...(item.contentEncoding !== undefined
          ? { contentEncoding: item.contentEncoding }
          : {}),
        ...(item.omitContentEncoding === true
          ? { omitContentEncoding: true }
          : {}),
      }),
    );
    const iinf = iinfBox(0, infeEntries);
    const ipco = ipcoBox(spec.properties ?? [ispe(32, 32), hvcC()]);
    const ipmaEntries = [
      ...items
        .filter((item) => (item.propertyIndices?.length ?? 0) > 0)
        .map((item) => ({
          itemId: item.itemId,
          associations: (item.propertyIndices ?? []).map((index) => ({
            propertyIndex: index,
            essential: false,
          })),
        })),
      ...(spec.extraIpmaEntries ?? []),
    ];
    const ipma = ipmaBox({ version: 0, flags: 0, entries: ipmaEntries });
    const iprp = iprpBox(ipco, ipma);
    const idat =
      spec.idatPayload !== undefined ? idatBox(spec.idatPayload) : undefined;
    const iloc = ilocBox({
      version: 1,
      offsetSize: widths?.offsetSize ?? 4,
      lengthSize: widths?.lengthSize ?? 4,
      baseOffsetSize: widths?.baseOffsetSize ?? 4,
      indexSize: 0,
      items: items.map((item) => ({
        itemId: item.itemId,
        constructionMethod: item.constructionMethod ?? 0,
        dataReferenceIndex: item.dataReferenceIndex ?? 0,
        baseOffset: (item.constructionMethod ?? 0) === 0 ? mdatPayloadStart : 0,
        extents: item.extents.map((extent) => ({
          offset: extent.relOffset,
          length: extent.length,
        })),
      })),
    });
    const iref =
      spec.refs !== undefined && spec.refs.length > 0
        ? irefBox(0, spec.refs)
        : undefined;
    const grpl =
      spec.groups !== undefined && spec.groups.length > 0
        ? grplBox(spec.groups)
        : undefined;

    const metaChildren: Buffer[] = [];
    if (spec.omitHdlr !== true) metaChildren.push(hdlr);
    if (spec.omitPitm !== true) metaChildren.push(pitm);
    if (idat !== undefined) metaChildren.push(idat);
    if (spec.omitIloc !== true) metaChildren.push(iloc);
    if (spec.omitIinf !== true) metaChildren.push(iinf);
    metaChildren.push(iprp);
    if (iref !== undefined) metaChildren.push(iref);
    if (grpl !== undefined) metaChildren.push(grpl);
    if (spec.extraMetaChildren !== undefined) {
      metaChildren.push(...spec.extraMetaChildren);
    }

    const meta = metaBox(metaChildren, {
      quickTime: spec.quickTimeMeta === true,
    });
    const metaBoxes = spec.secondMeta === true ? [meta, meta] : [meta];
    const header = Buffer.concat([
      ftyp,
      ...metaBoxes,
      ...(spec.topLevelExtraBeforeMdat ?? []),
    ]);
    const mdat = mdatBox(mdatPayload);
    const mdatBoxes = spec.secondMdat === true ? [mdat, mdat] : [mdat];
    return Buffer.concat([header, ...mdatBoxes]);
  };

  if (spec.twoPass !== true) return build(0);

  // Two-pass (removable-extent-overlap only): iloc's encoded byte length depends only on the
  // declared widths, never the numeric offset values stored, so a placeholder pass (baseOffset 0)
  // yields the real header length, used to compute the real (shared) baseOffset for the final
  // pass -- mirrors tests/isobmff_admission.test.ts's own `buildFile`.
  const pass1 = build(0);
  const mdatBoxTotal = 8 + mdatPayload.length;
  const mdatBoxesCount = spec.secondMdat === true ? 2 : 1;
  const headerLength = pass1.length - mdatBoxTotal * mdatBoxesCount;
  const final = build(headerLength + 8);
  if (final.length !== pass1.length) {
    throw new Error(
      "assembleHeif: header length changed between placeholder and final passes",
    );
  }
  return final;
}

// --- Bespoke fixtures that don't fit the generic assembler ---

/** `box-framing`: a `meta` box declaring size 2 (below the 8-byte minimum header) is caught by
 * `readTopLevelBoxHeaderAt` before any payload is ever read -- no item graph is needed at all. */
function buildBoxFraming(): Buffer {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  return Buffer.concat([ftyp, box("meta", Buffer.alloc(0), { size: 2 })]);
}

/** `cap-meta-bytes`: `meta`'s declared total size is one byte over `CAP_META_BYTES`. Sparse --
 * `IsobmffBudget.checkMetaSize` throws from the declared size alone, before the payload is ever
 * read, so only the 8-byte header is written for real; the rest is a `truncate`d hole that is
 * provably never touched. */
async function writeCapMetaBytes(path: string): Promise<void> {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const declaredMetaTotal = 8 + 4 + CAP_META_BYTES + 1; // header(8) + version/flags(4) + 1 over cap
  const metaHeader = Buffer.alloc(8);
  metaHeader.writeUInt32BE(declaredMetaTotal, 0);
  metaHeader.write("meta", 4, 4, "ascii");
  const totalSize = ftyp.length + declaredMetaTotal;

  const handle = await open(path, "w");
  try {
    await handle.write(ftyp, 0, ftyp.length, 0);
    await handle.write(metaHeader, 0, 8, ftyp.length);
    await handle.truncate(totalSize);
  } finally {
    await handle.close();
  }
}

/** `cap-box-count`: `meta`'s only children are `CAP_BOX_COUNT + 1` empty `free` boxes (8 bytes
 * each, real -- `checkMetaSize` passes comfortably under `CAP_META_BYTES`, so these bytes are
 * actually read and walked; `IsobmffBudget.countBox` throws partway through). No hdlr/pitm/iinf/
 * iloc at all: the structural box-count walk runs before `buildItemModel` is ever reached. */
function buildCapBoxCount(): Buffer {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  const children = Array.from({ length: CAP_BOX_COUNT + 1 }, () =>
    box("free", Buffer.alloc(0)),
  );
  const meta = metaBox(children);
  return Buffer.concat([ftyp, meta]);
}

/** `cap-box-depth`: `meta`'s only child is a chain of `CAP_BOX_DEPTH` nested `dinf` boxes (meta
 * itself is depth 1; the innermost `dinf`'s own empty payload is processed at depth
 * `CAP_BOX_DEPTH + 1`, exceeding the cap). No item graph needed -- the depth check runs during the
 * structural walk, before `buildItemModel`. */
function buildCapBoxDepth(): Buffer {
  const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
  let nested = box("dinf", Buffer.alloc(0));
  for (let level = 1; level < CAP_BOX_DEPTH; level += 1) {
    nested = box("dinf", nested);
  }
  const meta = metaBox([nested]);
  return Buffer.concat([ftyp, meta]);
}

/** `cap-buffered-bytes`: a fully valid, fully admitted item graph (a surviving `hvc1` primary plus
 * a removable `Exif` item) whose `Exif` extent is `CAP_BUFFERED_BYTES_TOTAL + 1` bytes long.
 * Sparse -- `mdat`'s payload is a `truncate`d hole; `admitIsobmff`'s
 * `budget.consumeBuffered(extent.length)` must throw before the matching `readExactly` call ever
 * executes, so the oversized region is provably never allocated or read. */
async function writeCapBufferedBytes(path: string): Promise<void> {
  const primaryPayloadLength = 4;
  const exifExtentLength = CAP_BUFFERED_BYTES_TOTAL + 1;

  const build = (mdatPayloadStart: number): Buffer => {
    const ftyp = ftypBox("heic", 0, ["mif1", "heic"]);
    const hdlr = hdlrBox("pict");
    const pitm = pitmBox(0, 1);
    const infePrimary = infeBox({ version: 2, itemId: 1, itemType: "hvc1" });
    const infeExif = infeBox({
      version: 2,
      itemId: 2,
      itemType: "Exif",
      hidden: true,
    });
    const iinf = iinfBox(0, [infePrimary, infeExif]);
    const ipco = ipcoBox([ispe(32, 32), hvcC()]);
    const ipma = ipmaBox({
      version: 0,
      flags: 0,
      entries: [
        {
          itemId: 1,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: true },
          ],
        },
      ],
    });
    const iprp = iprpBox(ipco, ipma);
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId: 1,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: 0, length: primaryPayloadLength }],
        },
        {
          itemId: 2,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: primaryPayloadLength, length: exifExtentLength }],
        },
      ],
    });
    const meta = metaBox([hdlr, pitm, iinf, iprp, iloc]);
    return Buffer.concat([ftyp, meta]);
  };

  const headerOnly = build(0);
  const mdatPayloadStart = headerOnly.length + 8;
  const header = build(mdatPayloadStart);
  if (header.length !== headerOnly.length) {
    throw new Error(
      "writeCapBufferedBytes: header length changed between placeholder and final passes",
    );
  }

  const mdatPayloadLength = primaryPayloadLength + exifExtentLength;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + mdatPayloadLength, 0);
  mdatHeader.write("mdat", 4, 4, "ascii");
  const primaryPayload = Buffer.from([1, 2, 3, 4]);
  const totalSize = header.length + 8 + mdatPayloadLength;

  const handle = await open(path, "w");
  try {
    await handle.write(header, 0, header.length, 0);
    await handle.write(mdatHeader, 0, 8, header.length);
    await handle.write(
      primaryPayload,
      0,
      primaryPayload.length,
      header.length + 8,
    );
    await handle.truncate(totalSize);
  } finally {
    await handle.close();
  }
}

// --- The catalog: exactly one entry per `IsobmffDeclineClass` ---

export const HOSTILE_FIXTURES: Record<IsobmffDeclineClass, HostileFixture> = {
  "removable-item-in-idat": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            DEFAULT_ITEMS[0]!,
            {
              itemId: 2,
              itemType: "Exif",
              hidden: true,
              constructionMethod: 1,
              extents: [{ relOffset: 0, length: 8 }],
            },
          ],
          idatPayload: Buffer.alloc(16),
        }),
      ),
  },

  "construction-method-2": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              constructionMethod: 2,
              extents: [{ relOffset: 0, length: 4 }],
              propertyIndices: [1, 2],
            },
          ],
        }),
      ),
  },

  "external-data-reference": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              dataReferenceIndex: 1,
              extents: [{ relOffset: 0, length: 4 }],
              propertyIndices: [1, 2],
            },
          ],
        }),
      ),
  },

  "multiple-mdat": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif({ secondMdat: true })),
  },

  "unknown-item-type": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            DEFAULT_ITEMS[0]!,
            {
              itemId: 2,
              itemType: "zzzz",
              extents: [{ relOffset: 0, length: 4 }],
            },
          ],
        }),
      ),
  },

  "sequence-box": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          topLevelExtraBeforeMdat: [box("moov", Buffer.alloc(4))],
        }),
      ),
  },

  "sequence-brand": {
    expectedCode: "unsupported-format",
    stage: "selection",
    write: (path) => writeBytes(path, assembleHeif({ majorBrand: "msf1" })),
  },

  "unknown-meta-child": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({ extraMetaChildren: [box("abcd", Buffer.alloc(4))] }),
      ),
  },

  "top-level-box-not-allowed": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          topLevelExtraBeforeMdat: [box("moof", Buffer.alloc(4))],
        }),
      ),
  },

  "meta-handler-not-pict": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif({ hdlrType: "vide" })),
  },

  "unsupported-box-version": {
    expectedCode: "unsupported-format",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              infeVersion: 1,
              extents: [{ relOffset: 0, length: 4 }],
              propertyIndices: [1, 2],
            },
          ],
        }),
      ),
  },

  "removable-extent-overlap": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          twoPass: true,
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              extents: [{ relOffset: 0, length: 8 }],
              propertyIndices: [1, 2],
            },
            {
              itemId: 2,
              itemType: "Exif",
              hidden: true,
              extents: [{ relOffset: 4, length: 8 }],
            },
          ],
          mdatPayload: Buffer.alloc(16, 7),
        }),
      ),
  },

  "removable-item-referenced": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            DEFAULT_ITEMS[0]!,
            {
              itemId: 2,
              itemType: "Exif",
              hidden: true,
              extents: [{ relOffset: 0, length: 8 }],
            },
          ],
          groups: [{ type: "altr", groupId: 1, entityIds: [2] }],
        }),
      ),
  },

  "surviving-zero-length-extent": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              extents: [],
              propertyIndices: [1, 2],
            },
          ],
        }),
      ),
  },

  "surviving-offset-width-zero": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          ilocWidths: { offsetSize: 0, lengthSize: 4, baseOffsetSize: 4 },
        }),
      ),
  },

  "cap-meta-bytes": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: writeCapMetaBytes,
  },

  "cap-box-count": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) => writeBytes(path, buildCapBoxCount()),
  },

  "cap-box-depth": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: (path) => writeBytes(path, buildCapBoxDepth()),
  },

  "cap-buffered-bytes": {
    expectedCode: "unsafe-structure",
    stage: "admission",
    write: writeCapBufferedBytes,
  },

  "extent-outside-mdat": {
    expectedCode: "malformed-file",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif()),
  },

  "meta-not-fullbox": {
    expectedCode: "malformed-file",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif({ quickTimeMeta: true })),
  },

  "duplicate-meta": {
    expectedCode: "malformed-file",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif({ secondMeta: true })),
  },

  "box-framing": {
    expectedCode: "malformed-file",
    stage: "admission",
    write: (path) => writeBytes(path, buildBoxFraming()),
  },

  "item-graph-invalid": {
    expectedCode: "malformed-file",
    stage: "admission",
    write: (path) => writeBytes(path, assembleHeif({ omitPitm: true })),
  },

  "offset-rewrite-overflow": {
    expectedCode: "unsafe-structure",
    stage: "plan",
    write: (path) =>
      writeBytes(
        path,
        assembleHeif({
          items: [
            {
              itemId: 1,
              itemType: "hvc1",
              // D-12: this item's own two extents are declared out of ascending-source-offset
              // order (the second extent's absolute position precedes the first's). Nothing in
              // Phase 61's classifier orders a single item's own extents, so this admits
              // cleanly -- but the writer's global mdat union (D-15) places the second extent
              // *before* the first in the new payload, which (with base_offset_size > 0)
              // rewrites the first extent's own offset to a negative value relative to the new
              // base. `checkIsobmffOutputPlan` must decline this before any byte is written.
              extents: [
                { relOffset: 100, length: 4 },
                { relOffset: 0, length: 4 },
              ],
              propertyIndices: [1, 2],
            },
          ],
          mdatPayload: Buffer.alloc(200, 0xab),
          twoPass: true,
        }),
      ),
  },
};

// Re-exported for the variant/ordering/empty-edge tests in tests/isobmff_hostile.test.ts, which
// build additional one-off fixtures outside the one-per-class catalog with the same assembler
// (D-19 independence: the test file may import src/isobmff/ freely -- only this support module is
// restricted).
export { box, fullBox, uuidBox, NON_C2PA_UUID_USERTYPE };
