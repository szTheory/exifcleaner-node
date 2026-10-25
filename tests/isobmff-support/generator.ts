// Shared ISOBMFF property generator with per-arm floors (D-19, Locked Decision 18).
//
// Built here as Phase 62 infrastructure (the QUA-03 pure-copy drill needs a generator that
// already meets floors), proven in this plan against the real `admitIsobmff` classifier --
// but deliberately NOT wired into `QUALIFICATION_FORMATS` until Phase 62 registers heic/avif
// handlers (D-19). Mirrors `tests/qualification/png/generators.ts`'s `FormatGenerator` shape and
// `tests/qualification/kit/generators.ts`'s canary-planting contract.
//
// D-19 independence: this file imports only the structural byte-level `./builder.js` encoder and
// the format-neutral kit modules (`../qualification/kit/generators.js`, `floors.js`) plus
// `../../src/metadata/exif.js` (a minimal valid TIFF builder, outside `src/isobmff/` entirely) --
// never anything from `src/isobmff/` itself, and never `./inventory.js` (the independent oracle).
// `tests/isobmff_isolation.test.ts`'s `ISOLATION_RULES` already carries a `generator.ts` entry
// forbidding both.
import fc from "fast-check";
import { createOrientationExif } from "../../src/metadata/exif.js";
import {
  canaryArbitrary,
  type FormatGenerator,
  type GeneratedSample,
  type PlantedCanary,
} from "../qualification/kit/generators.js";
import {
  auxC,
  box,
  colrNclx,
  colrProf,
  ftypBox,
  hdlrBox,
  hvcC,
  idatBox,
  iinfBox,
  ilocBox,
  imir as imirBox,
  infeBox,
  ipcoBox,
  ipmaBox,
  iprpBox,
  irefBox,
  irot as irotBox,
  ispe,
  mdatBox,
  metaBox,
  pitmBox,
  uuidBox,
  type IrefRef,
} from "./builder.js";

/**
 * The ICC profile the `colr-prof` and `colr-ricc` arms carry (62.1-10, maintainer decision
 * 2026-10-03): a minimal well-formed v4.4 display (`mntr`) RGB/XYZ profile -- 128-byte header with
 * the `acsp` signature, declared size equal to its length, a valid creation date, the D50
 * illuminant, an all-zero profile ID and reserved bytes, then a one-record tag table (`rTRC`, an
 * 8-byte `curv` tag with zero entries). Constant bytes, so the fast-check draw sequence is
 * unchanged. It replaced a 4-byte stand-in (`00 01 02 03`) that the engine's ICC-preservation
 * gate refused as truncated whenever `preserveColorProfile` was true; the qualification property
 * suite keeps that old payload as a dedicated refusal control (`GENERATOR_TRUNCATED_ICC`).
 */
function minimalIccProfile(canary?: string): Buffer {
  // Tag table: `rTRC` (an 8-byte `curv` tag with zero entries) and, with a canary, `cprt` (a
  // `text` tag whose payload is the canary and a NUL, zero padded to a 4-byte boundary).
  const tagCount = canary === undefined ? 1 : 2;
  const tableEnd = 128 + 4 + tagCount * 12;
  const textBody =
    canary === undefined
      ? Buffer.alloc(0)
      : Buffer.concat([
          Buffer.from(canary, "ascii"),
          Buffer.alloc(1 + ((4 - ((canary.length + 1) % 4)) % 4)),
        ]);
  const cprtSize = 8 + (canary === undefined ? 0 : canary.length + 1);
  const profile = Buffer.alloc(
    tableEnd + 8 + (canary === undefined ? 0 : 8 + textBody.length),
  );
  profile.writeUInt32BE(profile.length, 0);
  profile.write("TEST", 4, 4, "ascii");
  profile[8] = 4;
  profile[9] = 0x40;
  profile.write("mntr", 12, 4, "ascii");
  profile.write("RGB ", 16, 4, "ascii");
  profile.write("XYZ ", 20, 4, "ascii");
  profile.writeUInt16BE(2024, 24);
  profile.writeUInt16BE(2, 26);
  profile.writeUInt16BE(29, 28);
  profile.writeUInt16BE(12, 30);
  profile.writeUInt16BE(34, 32);
  profile.writeUInt16BE(56, 34);
  profile.write("acsp", 36, 4, "ascii");
  profile.write("APPL", 40, 4, "ascii");
  profile.write("TEST", 48, 4, "ascii");
  profile.write("MODL", 52, 4, "ascii");
  profile.writeUInt32BE(0x0000_f6d6, 68);
  profile.writeUInt32BE(0x0001_0000, 72);
  profile.writeUInt32BE(0x0000_d32d, 76);
  profile.writeUInt32BE(tagCount, 128);
  profile.write("rTRC", 132, 4, "ascii");
  profile.writeUInt32BE(tableEnd, 136);
  profile.writeUInt32BE(8, 140);
  profile.write("curv", tableEnd, 4, "ascii");
  if (canary !== undefined) {
    profile.write("cprt", 144, 4, "ascii");
    profile.writeUInt32BE(tableEnd + 8, 148);
    profile.writeUInt32BE(cprtSize, 152);
    profile.write("text", tableEnd + 8, 4, "ascii");
    textBody.copy(profile, tableEnd + 16);
  }
  return profile;
}

/** The generator's ICC profile carrying `canary` in a `cprt` text tag (PBT-01). */
export function iccProfileWithCanary(canary: string): Buffer {
  return minimalIccProfile(canary);
}

export const GENERATOR_ICC_PROFILE: Buffer = minimalIccProfile();

/** The 4-byte ICC stand-in the generator carried before 62.1-10 (a truncated profile). */
export const GENERATOR_TRUNCATED_ICC: Buffer = Buffer.from([
  0x00, 0x01, 0x02, 0x03,
]);

/** The metadata kinds this generator plants canaries for (D-19, PBT-01). */
export type IsobmffMetadataKind = "EXIF" | "XMP" | "ICC" | "C2PA";

const ALL_METADATA_KINDS: readonly IsobmffMetadataKind[] = [
  "EXIF",
  "XMP",
  "ICC",
  "C2PA",
];

/** The C2PA `uuid` usertype, a literal equal to (not imported from, per D-19) `C2PA_UUID_USERTYPE`
 * in `src/isobmff/boxes.ts`; `tests/isobmff_generator.test.ts` asserts the equality. */
export const GENERATOR_C2PA_USERTYPE = "d8fec3d61b0e483c92975828877ec481";

/**
 * Every structural dimension this generator exercises (D-19). `"hazard"` is the one arm a sample
 * must NOT be admitted under -- every other arm is a feature present in an admitted sample.
 */
export type IsobmffArm =
  | "exif-offset"
  | "xmp"
  | "colr-none"
  | "colr-nclx"
  | "colr-prof"
  | "colr-ricc"
  | "irot-essential"
  | "irot-non-essential"
  | "imir-essential"
  | "imir-non-essential"
  | "grid-idat"
  | "thmb"
  | "auxl"
  | "c2pa-uuid"
  | "mutation"
  | "hazard";

/**
 * The decline classes this generator's hazard arm draws from -- literal string values equal to
 * (but not imported from, per D-19/isolation) the real `IsobmffDeclineClass` members in
 * `src/isobmff/errors.ts`. `tests/isobmff_generator.test.ts` (unrestricted, outside
 * `tests/isobmff-support/`) imports the real union and asserts these literals still belong to it.
 */
export type IsobmffHazardClass =
  | "unknown-item-type"
  | "construction-method-2"
  | "external-data-reference"
  | "removable-item-referenced";

const HAZARD_CLASSES: readonly IsobmffHazardClass[] = [
  "unknown-item-type",
  "construction-method-2",
  "external-data-reference",
  "removable-item-referenced",
];

/**
 * Absolute per-arm floors (D-20) over the fixed sample count `tests/isobmff_generator.test.ts` runs.
 *
 * Rule (as for the other formats): each floor is half the minimum count measured over 200 runs at
 * seeds 460046, 1, 2 and 3 (FC_SEED), rounded down, with a hard minimum of 10, and a floor is
 * never lowered. 66-14 added the `c2pa-uuid` arm and the ICC canary and re-measured; the heic and
 * avif counters are identical at each seed (the brand is fixed, not drawn). Measured at seed
 * 460046 / 1 / 2 / 3 (66-14 Task 2, before the mutation arm took weight 10 from the non-hazard
 * share):
 *
 *   exif-offset 78 / 75 / 94 / 82       xmp 161 / 168 / 171 / 172
 *   colr-none 40 / 47 / 52 / 47         colr-nclx 38 / 46 / 46 / 33
 *   colr-prof 43 / 39 / 40 / 41         colr-ricc 40 / 36 / 33 / 51
 *   irot-essential 50 / 63 / 56 / 54    irot-non-essential 46 / 48 / 52 / 58
 *   imir-essential 60 / 47 / 58 / 50    imir-non-essential 50 / 75 / 64 / 67
 *   grid-idat 94 / 95 / 83 / 82         thmb 74 / 84 / 86 / 90
 *   auxl 83 / 91 / 79 / 76              c2pa-uuid 83 / 82 / 88 / 90
 *   hazard 39 / 32 / 29 / 28
 *
 * 66-14 Task 3 re-measurement after the mutation arm took weight 10 from the non-hazard share
 * (75 / 10 / 15 non-hazard / mutation / hazard; the zero-byte example counts as one `mutation`
 * run inside the 200). Seed 460046 / 1 / 2 / 3:
 *
 *   mutation 18 / 22 / 17 / 21          hazard 38 / 32 / 28 / 28
 *   exif-offset 70 / 65 / 84 / 76       xmp 144 / 146 / 155 / 151
 *   colr-none 36 / 42 / 47 / 44         colr-nclx 35 / 38 / 40 / 29
 *   colr-prof 38 / 33 / 38 / 32         colr-ricc 35 / 33 / 30 / 46
 *   irot-essential 45 / 53 / 49 / 43    irot-non-essential 42 / 43 / 48 / 52
 *   imir-essential 56 / 39 / 53 / 45    imir-non-essential 46 / 67 / 59 / 57
 *   grid-idat 86 / 82 / 74 / 70         thmb 65 / 69 / 80 / 79
 *   auxl 74 / 78 / 70 / 63              c2pa-uuid 73 / 75 / 81 / 81
 *
 * `mutation` is new: half its minimum (8) is below the hard minimum, so its floor is 10. Every
 * other floor set at Task 2 stays: half of the Task 3 minimum is lower for the counters the
 * weight change shrank, but a floor is never lowered, and every counter still clears its floor
 * at all four seeds (the property suite binds the floors at any seed with 200 runs).
 */
export const ISOBMFF_ARM_FLOORS: Readonly<Record<IsobmffArm, number>> =
  Object.freeze({
    "exif-offset": 37,
    xmp: 80,
    "colr-none": 20,
    "colr-nclx": 16,
    "colr-prof": 19,
    "colr-ricc": 16,
    "irot-essential": 25,
    "irot-non-essential": 23,
    "imir-essential": 23,
    "imir-non-essential": 25,
    "grid-idat": 41,
    thmb: 37,
    auxl: 38,
    "c2pa-uuid": 41,
    mutation: 10,
    hazard: 14,
  });

/**
 * The counter floor key each metadata slot's minimum printed rate derives from (PBT-01, D-09):
 * the slot's minimum rate is `ISOBMFF_ARM_FLOORS[key] / 200`. EXIF and ICC keys are lower bounds:
 * every non-hazard, non-mutation sample plants EXIF (the `exif-offset` arm counts only the
 * offset-16 ones) and every `colr-prof` sample plants the ICC canary (so do `colr-ricc` ones).
 */
export const ISOBMFF_SLOT_FLOOR_KEYS: Readonly<
  Record<IsobmffMetadataKind, IsobmffArm>
> = Object.freeze({
  EXIF: "exif-offset",
  XMP: "xmp",
  ICC: "colr-prof",
  C2PA: "c2pa-uuid",
});

export interface IsobmffArmSample {
  readonly sample: GeneratedSample<IsobmffMetadataKind>;
  readonly arms: readonly IsobmffArm[];
  /** Present only when `arms` includes `"hazard"`. */
  readonly hazardClass?: IsobmffHazardClass;
}

function majorBrandFor(brand: "heic" | "avif"): {
  readonly major: string;
  readonly compatible: readonly string[];
} {
  return brand === "heic"
    ? { major: "heic", compatible: ["mif1", "heic"] }
    : { major: "avif", compatible: ["mif1", "avif"] };
}

/** `[4-byte exif_tiff_header_offset][offset bytes of filler][valid minimal TIFF][canary]`. The
 * canary trails the self-contained TIFF structure (IFD-offset-bounded, not length-tied), so it
 * never disturbs `parseExif`. */
function buildExifPayload(offset: number, canary: string): Buffer {
  const offsetField = Buffer.alloc(4);
  offsetField.writeUInt32BE(offset, 0);
  const filler = offset > 0 ? Buffer.alloc(offset, 0x00) : Buffer.alloc(0);
  const tiff = createOrientationExif(1);
  return Buffer.concat([
    offsetField,
    filler,
    tiff,
    Buffer.from(canary, "ascii"),
  ]);
}

function buildXmpPayload(canary: string): Buffer {
  return Buffer.from(`<x:xmpmeta>${canary}</x:xmpmeta>`, "ascii");
}

interface MdatItem {
  readonly itemId: number;
  readonly payload: Buffer;
}

/** `iloc` v1, widths (4,4,4,0): shared `baseOffset` across every cm=0 item is the mdat payload's
 * own absolute start; `extents[].offset` is relative to that start. Mirrors
 * `tests/isobmff_admission.test.ts`'s own `buildFile`/`ilocBox` convention exactly. */
function buildIlocEntries(
  mdatItems: readonly MdatItem[],
  mdatPayloadStart: number,
  extra: readonly {
    readonly itemId: number;
    readonly constructionMethod: number;
    readonly dataReferenceIndex: number;
    readonly offset: number;
    readonly length: number;
  }[],
): Parameters<typeof ilocBox>[0]["items"] {
  let running = mdatPayloadStart;
  const entries = mdatItems.map((item) => {
    const entry = {
      itemId: item.itemId,
      constructionMethod: 0,
      dataReferenceIndex: 0,
      baseOffset: mdatPayloadStart,
      extents: [
        { offset: running - mdatPayloadStart, length: item.payload.length },
      ],
    };
    running += item.payload.length;
    return entry;
  });
  for (const item of extra) {
    entries.push({
      itemId: item.itemId,
      constructionMethod: item.constructionMethod,
      dataReferenceIndex: item.dataReferenceIndex,
      baseOffset: 0,
      extents: [{ offset: item.offset, length: item.length }],
    });
  }
  return entries;
}

export interface NonHazardConfig {
  readonly brand: "heic" | "avif";
  readonly exifOffset: number;
  readonly colrVariant: "none" | "nclx" | "prof" | "ricc";
  /** Required-but-nullable (not optional): `exactOptionalPropertyTypes` would otherwise reject
   * `fc.record`'s explicit `undefined` values for these two fields. */
  readonly irot: "essential" | "non-essential" | undefined;
  readonly imir: "essential" | "non-essential" | undefined;
  readonly includeGridIdat: boolean;
  readonly includeThmb: boolean;
  readonly includeAuxl: boolean;
  readonly includeC2pa: boolean;
  readonly exifCanary: string;
  readonly xmpCanary: string;
  /** Planted in the ICC profile's `cprt` tag of a `prof` or `rICC` colr (PBT-01). */
  readonly iccCanary: string;
  /** Planted in the top-level C2PA `uuid` box when `includeC2pa` is true (PBT-01). */
  readonly c2paCanary: string;
}

/** Composes a structurally-admitted HEIC/AVIF file carrying an Exif and an XMP item (each with a
 * planted canary) plus whichever optional structural dimensions `config` turns on. Two-pass
 * (mirrors `builder.ts`'s own `heifFile`/`tests/isobmff_admission.test.ts`'s `buildFile`): the
 * `iloc` entries' byte length depends only on the declared widths, never the numeric values. */
export function buildNonHazardFile(
  config: NonHazardConfig,
  iccBytes: Buffer = iccProfileWithCanary(config.iccCanary),
): Buffer {
  const { major, compatible } = majorBrandFor(config.brand);

  const primaryId = 1;
  const exifId = 2;
  const xmpId = 3;
  let nextId = 4;
  const gridId = config.includeGridIdat ? nextId++ : undefined;
  const thumbId = config.includeThmb ? nextId++ : undefined;
  const auxId = config.includeAuxl ? nextId++ : undefined;

  const primaryPayload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const exifPayload = buildExifPayload(config.exifOffset, config.exifCanary);
  const xmpPayload = buildXmpPayload(config.xmpCanary);
  const thumbPayload = Buffer.from([0x11, 0x22]);
  const auxPayload = Buffer.from([0x33, 0x44]);
  const idatPayload = Buffer.from([0x99, 0x99, 0x99, 0x99]);

  const mdatItems: MdatItem[] = [
    { itemId: primaryId, payload: primaryPayload },
    { itemId: exifId, payload: exifPayload },
    { itemId: xmpId, payload: xmpPayload },
  ];
  if (thumbId !== undefined)
    mdatItems.push({ itemId: thumbId, payload: thumbPayload });
  if (auxId !== undefined)
    mdatItems.push({ itemId: auxId, payload: auxPayload });

  const hdlr = hdlrBox("pict");
  const pitm = pitmBox(0, primaryId);

  const infeEntries = [
    infeBox({ version: 2, itemId: primaryId, itemType: "hvc1" }),
    infeBox({ version: 2, itemId: exifId, itemType: "Exif" }),
    infeBox({
      version: 2,
      itemId: xmpId,
      itemType: "mime",
      contentType: "application/rdf+xml",
    }),
  ];
  if (gridId !== undefined) {
    infeEntries.push(infeBox({ version: 2, itemId: gridId, itemType: "grid" }));
  }
  if (thumbId !== undefined) {
    infeEntries.push(
      infeBox({ version: 2, itemId: thumbId, itemType: "hvc1", hidden: true }),
    );
  }
  if (auxId !== undefined) {
    infeEntries.push(
      infeBox({ version: 2, itemId: auxId, itemType: "hvc1", hidden: true }),
    );
  }
  const iinf = iinfBox(0, infeEntries);

  const properties: Buffer[] = [ispe(32, 32), hvcC()];
  const primaryAssociations: { propertyIndex: number; essential: boolean }[] = [
    { propertyIndex: 1, essential: false },
    { propertyIndex: 2, essential: false },
  ];
  let propertyIndex = 2;

  if (config.colrVariant !== "none") {
    propertyIndex += 1;
    const colrBox =
      config.colrVariant === "nclx"
        ? colrNclx(1, 13, 6, true)
        : config.colrVariant === "prof"
          ? colrProf(iccBytes)
          : box(
              "colr",
              Buffer.concat([Buffer.from("rICC", "ascii"), iccBytes]),
            );
    properties.push(colrBox);
    primaryAssociations.push({ propertyIndex, essential: false });
  }

  if (config.irot !== undefined) {
    propertyIndex += 1;
    properties.push(irotBox(1));
    primaryAssociations.push({
      propertyIndex,
      essential: config.irot === "essential",
    });
  }

  if (config.imir !== undefined) {
    propertyIndex += 1;
    properties.push(imirBox(0));
    primaryAssociations.push({
      propertyIndex,
      essential: config.imir === "essential",
    });
  }

  const ipmaEntries: {
    itemId: number;
    associations: { propertyIndex: number; essential: boolean }[];
  }[] = [{ itemId: primaryId, associations: primaryAssociations }];

  if (auxId !== undefined) {
    propertyIndex += 1;
    properties.push(auxC("urn:exifcleaner:test:aux"));
    ipmaEntries.push({
      itemId: auxId,
      associations: [{ propertyIndex, essential: true }],
    });
  }

  const ipco = ipcoBox(properties);
  const ipma = ipmaBox({ version: 0, flags: 0, entries: ipmaEntries });
  const iprp = iprpBox(ipco, ipma);

  const idat = gridId !== undefined ? idatBox(idatPayload) : undefined;

  const refs: IrefRef[] = [];
  if (thumbId !== undefined) {
    refs.push({ type: "thmb", fromItemId: thumbId, toItemIds: [primaryId] });
  }
  if (auxId !== undefined) {
    refs.push({ type: "auxl", fromItemId: auxId, toItemIds: [primaryId] });
  }
  const iref = refs.length > 0 ? irefBox(0, refs) : undefined;

  function assemble(mdatPayloadStart: number): Buffer {
    const ftyp = ftypBox(major, 0, compatible);
    const extraIloc =
      gridId !== undefined
        ? [
            {
              itemId: gridId,
              constructionMethod: 1,
              dataReferenceIndex: 0,
              offset: 0,
              length: idatPayload.length,
            },
          ]
        : [];
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: buildIlocEntries(mdatItems, mdatPayloadStart, extraIloc),
    });
    const metaChildren = [
      hdlr,
      pitm,
      ...(idat !== undefined ? [idat] : []),
      iloc,
      iinf,
      iprp,
      ...(iref !== undefined ? [iref] : []),
    ];
    const meta = metaBox(metaChildren);
    const mdatPayload = Buffer.concat(mdatItems.map((item) => item.payload));
    const mdat = mdatBox(mdatPayload);
    const c2pa = config.includeC2pa
      ? [
          uuidBox(
            GENERATOR_C2PA_USERTYPE,
            Buffer.from(`c2pa-manifest-store:${config.c2paCanary}`, "ascii"),
          ),
        ]
      : [];
    return Buffer.concat([ftyp, meta, mdat, ...c2pa]);
  }

  const pass1 = assemble(0);
  const mdatTotal =
    8 + mdatItems.reduce((sum, item) => sum + item.payload.length, 0);
  const trailerLength = config.includeC2pa
    ? 8 + 16 + `c2pa-manifest-store:${config.c2paCanary}`.length
    : 0;
  const headerLength = pass1.length - mdatTotal - trailerLength;
  const final = assemble(headerLength + 8);
  if (final.length !== pass1.length) {
    throw new Error(
      "buildNonHazardFile: header length changed between placeholder and final passes",
    );
  }
  return final;
}

/** Composes a structurally-valid-except-one-deviation HEIC/AVIF file for one `IsobmffHazardClass`
 * (two items only: a primary and one mutated second item). No metadata canary is planted -- a
 * hazard sample is never expected to admit. */
function buildHazardFile(
  brand: "heic" | "avif",
  hazard: IsobmffHazardClass,
): Buffer {
  const { major, compatible } = majorBrandFor(brand);
  const primaryId = 1;
  const secondId = 2;
  const primaryPayload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const secondPayload = Buffer.from([0x01, 0x02]);
  const mdatItems: MdatItem[] = [
    { itemId: primaryId, payload: primaryPayload },
    { itemId: secondId, payload: secondPayload },
  ];

  const hdlr = hdlrBox("pict");
  const pitm = pitmBox(0, primaryId);
  const secondItemType = hazard === "unknown-item-type" ? "zzzz" : "Exif";
  const iinf = iinfBox(0, [
    infeBox({ version: 2, itemId: primaryId, itemType: "hvc1" }),
    infeBox({ version: 2, itemId: secondId, itemType: secondItemType }),
  ]);
  const ipco = ipcoBox([ispe(32, 32), hvcC()]);
  const ipma = ipmaBox({
    version: 0,
    flags: 0,
    entries: [
      {
        itemId: primaryId,
        associations: [
          { propertyIndex: 1, essential: false },
          { propertyIndex: 2, essential: false },
        ],
      },
    ],
  });
  const iprp = iprpBox(ipco, ipma);

  const refs: IrefRef[] =
    hazard === "removable-item-referenced"
      ? [{ type: "cdsc", fromItemId: primaryId, toItemIds: [secondId] }]
      : [];
  const iref = refs.length > 0 ? irefBox(0, refs) : undefined;

  function assemble(mdatPayloadStart: number): Buffer {
    const ftyp = ftypBox(major, 0, compatible);
    const iloc = ilocBox({
      version: 1,
      offsetSize: 4,
      lengthSize: 4,
      baseOffsetSize: 4,
      indexSize: 0,
      items: [
        {
          itemId: primaryId,
          constructionMethod: 0,
          dataReferenceIndex: 0,
          baseOffset: mdatPayloadStart,
          extents: [{ offset: 0, length: primaryPayload.length }],
        },
        {
          itemId: secondId,
          constructionMethod: hazard === "construction-method-2" ? 2 : 0,
          dataReferenceIndex: hazard === "external-data-reference" ? 1 : 0,
          baseOffset: mdatPayloadStart,
          extents: [
            { offset: primaryPayload.length, length: secondPayload.length },
          ],
        },
      ],
    });
    const metaChildren = [
      hdlr,
      pitm,
      iloc,
      iinf,
      iprp,
      ...(iref !== undefined ? [iref] : []),
    ];
    const meta = metaBox(metaChildren);
    const mdat = mdatBox(Buffer.concat(mdatItems.map((item) => item.payload)));
    return Buffer.concat([ftyp, meta, mdat]);
  }

  const pass1 = assemble(0);
  const mdatTotal =
    8 + mdatItems.reduce((sum, item) => sum + item.payload.length, 0);
  const headerLength = pass1.length - mdatTotal;
  const final = assemble(headerLength + 8);
  if (final.length !== pass1.length) {
    throw new Error(
      "buildHazardFile: header length changed between placeholder and final passes",
    );
  }
  return final;
}

function armsFor(config: NonHazardConfig): readonly IsobmffArm[] {
  const arms: IsobmffArm[] = [
    "xmp",
    `colr-${config.colrVariant}` as IsobmffArm,
  ];
  if (config.exifOffset > 0) arms.push("exif-offset");
  if (config.irot !== undefined) arms.push(`irot-${config.irot}` as IsobmffArm);
  if (config.imir !== undefined) arms.push(`imir-${config.imir}` as IsobmffArm);
  if (config.includeGridIdat) arms.push("grid-idat");
  if (config.includeThmb) arms.push("thmb");
  if (config.includeAuxl) arms.push("auxl");
  if (config.includeC2pa) arms.push("c2pa-uuid");
  return arms;
}

/**
 * The non-hazard structural config for one brand. IN-01 (62.1-06): the brand is fixed to the
 * argument, never drawn, so `isobmffArmSampleArbitrary("heic")` emits only heic files and the
 * per-brand floors measure genuinely per-brand sequences.
 */
function nonHazardConfigArbitrary(
  brand: "heic" | "avif",
): fc.Arbitrary<
  Omit<NonHazardConfig, "exifCanary" | "xmpCanary" | "iccCanary" | "c2paCanary">
> {
  return fc.record({
    brand: fc.constant(brand),
    exifOffset: fc.constantFrom(0, 16),
    colrVariant: fc.constantFrom("none", "nclx", "prof", "ricc"),
    irot: fc.constantFrom(undefined, "essential", "non-essential"),
    imir: fc.constantFrom(undefined, "essential", "non-essential"),
    includeGridIdat: fc.boolean(),
    includeThmb: fc.boolean(),
    includeAuxl: fc.boolean(),
    includeC2pa: fc.boolean(),
  });
}

type MutationOperation =
  | {
      readonly kind: "flip";
      readonly edits: readonly (readonly [number, number])[];
    }
  | { readonly kind: "truncate"; readonly at: number }
  | { readonly kind: "append"; readonly bytes: Uint8Array };

const mutationOperationArbitrary: fc.Arbitrary<MutationOperation> = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    edits: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), {
      minLength: 1,
      maxLength: 4,
    }),
  }),
  fc.record({ kind: fc.constant("truncate" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("append" as const),
    bytes: fc.uint8Array({ minLength: 1, maxLength: 64 }),
  }),
);

function applyMutation(source: Buffer, operation: MutationOperation): Buffer {
  if (operation.kind === "truncate")
    return Buffer.from(source.subarray(0, operation.at % source.length));
  if (operation.kind === "append")
    return Buffer.concat([source, Buffer.from(operation.bytes)]);
  const mutated = Buffer.from(source);
  for (const [offset, mask] of operation.edits) {
    const index = offset % mutated.length;
    mutated[index] = (mutated[index] ?? 0) ^ mask;
  }
  return mutated;
}

/** The zero-byte mutation example (PBT-03): no bytes, no canary, any typed outcome is admitted. */
export const ISOBMFF_ZERO_BYTE_EXAMPLE: IsobmffArmSample = Object.freeze({
  sample: Object.freeze({ bytes: Buffer.alloc(0), planted: [] }),
  arms: Object.freeze(["mutation"] as const),
});

/**
 * True for a sample that is a structurally admitted metadata file: neither a hazard sample (never
 * admitted) nor a mutation sample (admitted or refused, no canary is guaranteed to be removable).
 */
export function isMetadataSample(armSample: IsobmffArmSample): boolean {
  return (
    !armSample.arms.includes("hazard") && !armSample.arms.includes("mutation")
  );
}

/**
 * The per-arm sample arbitrary (D-19, D-11): ~75% of samples are structurally-admitted
 * combinations of the non-hazard arms, each carrying a planted Exif and XMP canary (plus an ICC
 * canary on a `prof` or `rICC` colr and a C2PA canary when the C2PA `uuid` box is drawn); ~10% are
 * a mutation of such a file (1-4 byte flips, a truncation to 0..n-1 bytes, or 1-64 appended
 * bytes) whose `planted` holds only the canaries still verbatim in the mutated bytes; ~15% are a
 * single hazard mutation drawn from `IsobmffHazardClass`, carrying no canary and expected to
 * decline. The mutation share comes out of the non-hazard share, so the hazard weight is
 * unchanged.
 */
export function isobmffArmSampleArbitrary(
  brand: "heic" | "avif",
): fc.Arbitrary<IsobmffArmSample> {
  const hazardArbitrary: fc.Arbitrary<IsobmffArmSample> = fc
    .constantFrom(...HAZARD_CLASSES)
    .map((hazardClass): IsobmffArmSample => ({
      sample: { bytes: buildHazardFile(brand, hazardClass), planted: [] },
      arms: ["hazard"],
      hazardClass,
    }));

  const metadataArbitrary: fc.Arbitrary<
    IsobmffArmSample & { readonly config: NonHazardConfig }
  > = fc
    .tuple(
      nonHazardConfigArbitrary(brand),
      canaryArbitrary<IsobmffMetadataKind>("EXIF"),
      canaryArbitrary<IsobmffMetadataKind>("XMP"),
      canaryArbitrary<IsobmffMetadataKind>("ICC"),
      canaryArbitrary<IsobmffMetadataKind>("C2PA"),
    )
    .map(([base, exifCanary, xmpCanary, iccCanary, c2paCanary]) => {
      const config: NonHazardConfig = {
        ...base,
        exifCanary: exifCanary.canary,
        xmpCanary: xmpCanary.canary,
        iccCanary: iccCanary.canary,
        c2paCanary: c2paCanary.canary,
      };
      const planted: PlantedCanary<IsobmffMetadataKind>[] = [
        exifCanary,
        xmpCanary,
      ];
      if (config.colrVariant === "prof" || config.colrVariant === "ricc")
        planted.push(iccCanary);
      if (config.includeC2pa) planted.push(c2paCanary);
      return {
        sample: { bytes: buildNonHazardFile(config), planted },
        arms: armsFor(config),
        config,
      };
    });

  const nonHazardArbitrary: fc.Arbitrary<IsobmffArmSample> =
    metadataArbitrary.map(({ sample, arms }) => ({ sample, arms }));

  const mutationArbitrary: fc.Arbitrary<IsobmffArmSample> = fc
    .tuple(metadataArbitrary, mutationOperationArbitrary)
    .map(([base, operation]): IsobmffArmSample => {
      const bytes = applyMutation(base.sample.bytes, operation);
      return {
        sample: {
          bytes,
          planted: base.sample.planted.filter((item) =>
            bytes.includes(Buffer.from(item.canary, "ascii")),
          ),
        },
        arms: ["mutation"],
      };
    });

  return fc.oneof(
    { weight: 75, arbitrary: nonHazardArbitrary },
    { weight: 10, arbitrary: mutationArbitrary },
    { weight: 15, arbitrary: hazardArbitrary },
  );
}

/**
 * D-21 negative control (3) for ISOBMFF: the per-arm arbitrary with every Exif/XMP-carrying
 * (non-hazard) sample removed, so no sample can ever count toward the metadata arms. Proves the
 * floor assertion itself catches a generator whose metadata coverage silently collapsed. Never a
 * qualification generator.
 */
export function isobmffArmSampleArbitraryWithoutMetadataArm(
  brand: "heic" | "avif",
): fc.Arbitrary<IsobmffArmSample> {
  return isobmffArmSampleArbitrary(brand).filter((armSample) =>
    armSample.arms.includes("hazard"),
  );
}

/**
 * The format-neutral `FormatGenerator` seam (D-18/D-19). Only non-hazard samples are exposed here
 * -- a hazard sample is never expected to admit, so it has no place in the generic
 * plant-then-verify-preserved-or-absent contract this interface is for. Chooses a brand per
 * sample; never wired into `QUALIFICATION_FORMATS` in this phase.
 */
export const isobmffMetadataGenerator: FormatGenerator<IsobmffMetadataKind> =
  Object.freeze({
    format: "isobmff",
    metadataKinds: Object.freeze(ALL_METADATA_KINDS),
    arbitrary: (): fc.Arbitrary<GeneratedSample<IsobmffMetadataKind>> =>
      fc
        .constantFrom("heic" as const, "avif" as const)
        .chain((brand) => isobmffArmSampleArbitrary(brand))
        .filter(isMetadataSample)
        .map((armSample) => armSample.sample),
  });

// Re-exported only for type-checking convenience in the test file -- not part of the kit seam.
export type { PlantedCanary };
