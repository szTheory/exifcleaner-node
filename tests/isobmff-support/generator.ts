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
function minimalIccProfile(): Buffer {
  const tableEnd = 128 + 4 + 12;
  const profile = Buffer.alloc(tableEnd + 8);
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
  profile.writeUInt32BE(1, 128);
  profile.write("rTRC", 132, 4, "ascii");
  profile.writeUInt32BE(tableEnd, 136);
  profile.writeUInt32BE(8, 140);
  profile.write("curv", tableEnd, 4, "ascii");
  return profile;
}

export const GENERATOR_ICC_PROFILE: Buffer = minimalIccProfile();

/** The 4-byte ICC stand-in the generator carried before 62.1-10 (a truncated profile). */
export const GENERATOR_TRUNCATED_ICC: Buffer = Buffer.from([
  0x00, 0x01, 0x02, 0x03,
]);

/** The two metadata kinds this generator plants canaries for (D-19). */
export type IsobmffMetadataKind = "EXIF" | "XMP";

const ALL_METADATA_KINDS: readonly IsobmffMetadataKind[] = ["EXIF", "XMP"];

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

/** Absolute per-arm floors (D-20) over the fixed sample count `tests/isobmff_generator.test.ts` runs. */
export const ISOBMFF_ARM_FLOORS: Readonly<Record<IsobmffArm, number>> =
  Object.freeze({
    "exif-offset": 10,
    xmp: 50,
    "colr-none": 10,
    "colr-nclx": 10,
    "colr-prof": 10,
    "colr-ricc": 10,
    "irot-essential": 5,
    "irot-non-essential": 5,
    "imir-essential": 5,
    "imir-non-essential": 5,
    "grid-idat": 10,
    thmb: 10,
    auxl: 10,
    hazard: 10,
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
  readonly exifCanary: string;
  readonly xmpCanary: string;
}

/** Composes a structurally-admitted HEIC/AVIF file carrying an Exif and an XMP item (each with a
 * planted canary) plus whichever optional structural dimensions `config` turns on. Two-pass
 * (mirrors `builder.ts`'s own `heifFile`/`tests/isobmff_admission.test.ts`'s `buildFile`): the
 * `iloc` entries' byte length depends only on the declared widths, never the numeric values. */
export function buildNonHazardFile(
  config: NonHazardConfig,
  iccBytes: Buffer = GENERATOR_ICC_PROFILE,
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
    return Buffer.concat([ftyp, meta, mdat]);
  }

  const pass1 = assemble(0);
  const mdatTotal =
    8 + mdatItems.reduce((sum, item) => sum + item.payload.length, 0);
  const headerLength = pass1.length - mdatTotal;
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
  return arms;
}

/**
 * The non-hazard structural config for one brand. IN-01 (62.1-06): the brand is fixed to the
 * argument, never drawn, so `isobmffArmSampleArbitrary("heic")` emits only heic files and the
 * per-brand floors measure genuinely per-brand sequences.
 */
function nonHazardConfigArbitrary(
  brand: "heic" | "avif",
): fc.Arbitrary<Omit<NonHazardConfig, "exifCanary" | "xmpCanary">> {
  return fc.record({
    brand: fc.constant(brand),
    exifOffset: fc.constantFrom(0, 16),
    colrVariant: fc.constantFrom("none", "nclx", "prof", "ricc"),
    irot: fc.constantFrom(undefined, "essential", "non-essential"),
    imir: fc.constantFrom(undefined, "essential", "non-essential"),
    includeGridIdat: fc.boolean(),
    includeThmb: fc.boolean(),
    includeAuxl: fc.boolean(),
  });
}

/**
 * The per-arm sample arbitrary (D-19): ~85% of samples are structurally-admitted combinations of
 * the non-hazard arms, each carrying a planted Exif and XMP canary; ~15% are a single hazard
 * mutation drawn from `IsobmffHazardClass`, carrying no canary and expected to decline.
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

  const nonHazardArbitrary: fc.Arbitrary<IsobmffArmSample> = fc
    .tuple(
      nonHazardConfigArbitrary(brand),
      canaryArbitrary<IsobmffMetadataKind>("EXIF"),
      canaryArbitrary<IsobmffMetadataKind>("XMP"),
    )
    .map(([base, exifCanary, xmpCanary]): IsobmffArmSample => {
      const config: NonHazardConfig = {
        ...base,
        exifCanary: exifCanary.canary,
        xmpCanary: xmpCanary.canary,
      };
      return {
        sample: {
          bytes: buildNonHazardFile(config),
          planted: [exifCanary, xmpCanary],
        },
        arms: armsFor(config),
      };
    });

  return fc.oneof(
    { weight: 85, arbitrary: nonHazardArbitrary },
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
        .filter((armSample) => !armSample.arms.includes("hazard"))
        .map((armSample) => armSample.sample),
  });

// Re-exported only for type-checking convenience in the test file -- not part of the kit seam.
export type { PlantedCanary };
