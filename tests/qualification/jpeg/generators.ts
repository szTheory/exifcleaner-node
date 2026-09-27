import { createHash } from "node:crypto";
import fc from "fast-check";
import { iccCanaryProfile, minimalJpeg } from "../../fixtures.js";
import {
  canaryArbitrary,
  type FormatGenerator,
  type GeneratedSample,
  type PlantedCanary,
} from "../kit/generators.js";
import {
  JPEG_MAX_EXTENDED_XMP_BYTES,
  JPEG_MAX_FILE_BYTES,
  JPEG_MAX_ICC_SEGMENTS,
  JPEG_MAX_SCAN_COUNT,
  JPEG_MAX_SEGMENT_COUNT,
  JPEG_MAX_TABLE_SEGMENT_COUNT,
  type JpegRefusal,
} from "../../../src/jpeg/markers.js";
import { MAX_PROFILE_BYTES } from "../../../src/metadata/icc_admission.js";
import {
  appSegment,
  appendTrailer,
  buildCipaMpfTwoImages,
  iccSegments,
  jpegAdobePayload,
  jpegJfifPayload,
  spliceSegments,
} from "./fixtures.js";

// JPEG's qualification-kit property generator (57-12). Widens the 57-05/57-11
// tracer slice into the full D-01-identifier-class metadata arm, a hostile
// arm covering every JpegRefusal literal, and a no-metadata arm -- mirroring
// tests/qualification/png/generators.ts's shape (56-10).

/**
 * One literal per D-01 identifier class the metadata arm plants a canary
 * into, plus `TRAILER` (appended raw bytes after the primary EOI) and `ICC`
 * (a preservable multi-segment APP2 ICC_PROFILE, canary in its description
 * tag -- kept iff `preserveColorProfile`). Every other kind is always
 * removed by a bare sanitize; there is no flag that preserves any of them.
 */
export type JpegMetadataKind =
  | "APP0-JFXX"
  | "APP0-OTHER"
  | "APP1-EXIF"
  | "APP1-XMP"
  | "APP1-EXTENDED-XMP"
  | "APP2-FPXR"
  | "APP2-MPF"
  | "APP2-OTHER"
  | "APP3"
  | "APP4"
  | "APP5"
  | "APP6"
  | "APP7"
  | "APP8"
  | "APP9"
  | "APP10"
  | "APP11-JUMBF"
  | "APP12"
  | "APP13-PHOTOSHOP"
  | "APP14-NON-ADOBE"
  | "APP15"
  | "COM"
  | "TRAILER"
  | "ICC";

const ALL_METADATA_KINDS: readonly JpegMetadataKind[] = [
  "APP0-JFXX",
  "APP0-OTHER",
  "APP1-EXIF",
  "APP1-XMP",
  "APP1-EXTENDED-XMP",
  "APP2-FPXR",
  "APP2-MPF",
  "APP2-OTHER",
  "APP3",
  "APP4",
  "APP5",
  "APP6",
  "APP7",
  "APP8",
  "APP9",
  "APP10",
  "APP11-JUMBF",
  "APP12",
  "APP13-PHOTOSHOP",
  "APP14-NON-ADOBE",
  "APP15",
  "COM",
  "TRAILER",
  "ICC",
];

/** The subset of `ALL_METADATA_KINDS` handled by the generic identifier
 * builder below -- `APP1-EXIF`, `TRAILER` and `ICC` each need bespoke shape
 * (a TIFF IFD, raw appended bytes, and a multi-segment ICC container) and
 * are planted through their own dedicated paths instead. */
const GENERIC_KINDS: readonly Exclude<
  JpegMetadataKind,
  "APP1-EXIF" | "TRAILER" | "ICC"
>[] = [
  "APP0-JFXX",
  "APP0-OTHER",
  "APP1-XMP",
  "APP1-EXTENDED-XMP",
  "APP2-FPXR",
  "APP2-MPF",
  "APP2-OTHER",
  "APP3",
  "APP4",
  "APP5",
  "APP6",
  "APP7",
  "APP8",
  "APP9",
  "APP10",
  "APP11-JUMBF",
  "APP12",
  "APP13-PHOTOSHOP",
  "APP14-NON-ADOBE",
  "APP15",
  "COM",
];

const GENERIC_MARKER: Readonly<Record<(typeof GENERIC_KINDS)[number], number>> =
  Object.freeze({
    "APP0-JFXX": 0xe0,
    "APP0-OTHER": 0xe0,
    "APP1-XMP": 0xe1,
    "APP1-EXTENDED-XMP": 0xe1,
    "APP2-FPXR": 0xe2,
    "APP2-MPF": 0xe2,
    "APP2-OTHER": 0xe2,
    APP3: 0xe3,
    APP4: 0xe4,
    APP5: 0xe5,
    APP6: 0xe6,
    APP7: 0xe7,
    APP8: 0xe8,
    APP9: 0xe9,
    APP10: 0xea,
    "APP11-JUMBF": 0xeb,
    APP12: 0xec,
    "APP13-PHOTOSHOP": 0xed,
    "APP14-NON-ADOBE": 0xee,
    APP15: 0xef,
    COM: 0xfe,
  });

function identifierPayload(identifier: string, canary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${identifier}\0`, "latin1"),
    Buffer.from(canary, "ascii"),
  ]);
}

/** Builds a real, standard XMP RDF packet carrying `canary` inside a
 * `dc:description` value, for `APP1-XMP`. */
function xmpPacketWithCanary(canary: string): Buffer {
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"><dc:description>${canary}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`,
      "utf8",
    ),
  ]);
}

/** A two-segment ExtendedXMP payload (D-01: "APP1 ExtendedXMP
 * (multi-segment)"), the same 32-byte GUID in both chunks, each chunk
 * independently carrying the full canary so the generic removal-absence
 * check needs no reassembly awareness. */
function extendedXmpChunks(canary: string): readonly Buffer[] {
  const guid = Buffer.alloc(32, 0x41);
  const dataLength = Buffer.alloc(4);
  dataLength.writeUInt32BE(canary.length, 0);
  const chunk = (offset: number): Buffer => {
    const chunkOffset = Buffer.alloc(4);
    chunkOffset.writeUInt32BE(offset, 0);
    return appSegment(
      0xe1,
      Buffer.concat([
        Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
        guid,
        dataLength,
        chunkOffset,
        Buffer.from(canary, "ascii"),
      ]),
    );
  };
  return [chunk(0), chunk(canary.length)];
}

function genericSegment(
  kind: (typeof GENERIC_KINDS)[number],
  canary: string,
): Buffer {
  const marker = GENERIC_MARKER[kind];
  if (kind === "COM") return appSegment(marker, Buffer.from(canary, "ascii"));
  if (kind === "APP1-XMP")
    return appSegment(marker, xmpPacketWithCanary(canary));
  const identifier: Readonly<Record<string, string>> = {
    "APP0-JFXX": "JFXX",
    "APP0-OTHER": "AVI1",
    "APP2-FPXR": "FPXR",
    "APP2-MPF": "MPF",
    "APP2-OTHER": "ExifCleanerOther",
    APP3: "Meta",
    APP4: "App4Id",
    APP5: "RMETA",
    APP6: "EPPIM",
    APP7: "Qualcomm Camera Attributes",
    APP8: "SPIFF",
    APP9: "Media Jukebox",
    APP10: "UNICODE",
    "APP11-JUMBF": "JP",
    APP12: "Ducky",
    "APP13-PHOTOSHOP": "Photoshop 3.0",
    "APP14-NON-ADOBE": "NotAdobe",
    APP15: "Q 70",
  };
  return appSegment(marker, identifierPayload(identifier[kind]!, canary));
}

// --- APP1 Exif: a real TIFF IFD carrying the canary plus optional
// Orientation/XResolution/YResolution/ResolutionUnit (D-04's only tags). ---

interface ExifEntrySpec {
  readonly tag: number;
  readonly type: 2 | 3 | 5;
  readonly inlineValue?: number;
  readonly external?: Buffer;
  readonly count: number;
}

function buildTiffIfd(entries: readonly ExifEntrySpec[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const ifdBytes = 2 + sorted.length * 12 + 4;
  let externalTotal = 0;
  for (const entry of sorted)
    if (entry.external) externalTotal += entry.external.length;
  const result = Buffer.alloc(8 + ifdBytes + externalTotal);
  result.write("MM", 0, 2, "latin1");
  result.writeUInt16BE(42, 2);
  result.writeUInt32BE(8, 4);
  result.writeUInt16BE(sorted.length, 8);
  let externalOffset = 8 + ifdBytes;
  sorted.forEach((entry, index) => {
    const entryOffset = 10 + index * 12;
    result.writeUInt16BE(entry.tag, entryOffset);
    result.writeUInt16BE(entry.type, entryOffset + 2);
    result.writeUInt32BE(entry.count, entryOffset + 4);
    if (entry.external !== undefined) {
      result.writeUInt32BE(externalOffset, entryOffset + 8);
      entry.external.copy(result, externalOffset);
      externalOffset += entry.external.length;
    } else {
      result.writeUInt16BE(entry.inlineValue ?? 0, entryOffset + 8);
    }
  });
  result.writeUInt32BE(0, 8 + ifdBytes - 4);
  return result;
}

export interface PlantedResolution {
  readonly x: number;
  readonly y: number;
  readonly unit: number;
}

/** Builds a real APP1 Exif segment: an ASCII ImageDescription (0x010E)
 * carrying `canary`, plus Orientation (0x0112) and/or X/YResolution +
 * ResolutionUnit (0x011A/0x011B/0x0128) when given. */
export function jpegExifSegmentWithCanary(
  canary: string,
  orientation: number | undefined,
  resolution: PlantedResolution | undefined,
): Buffer {
  const description = Buffer.from(`${canary}\0`, "ascii");
  const entries: ExifEntrySpec[] = [
    { tag: 0x010e, type: 2, external: description, count: description.length },
  ];
  if (orientation !== undefined) {
    entries.push({ tag: 0x0112, type: 3, inlineValue: orientation, count: 1 });
  }
  if (resolution !== undefined) {
    const x = Buffer.alloc(8);
    x.writeUInt32BE(resolution.x, 0);
    x.writeUInt32BE(1, 4);
    const y = Buffer.alloc(8);
    y.writeUInt32BE(resolution.y, 0);
    y.writeUInt32BE(1, 4);
    entries.push({ tag: 0x011a, type: 5, external: x, count: 1 });
    entries.push({ tag: 0x011b, type: 5, external: y, count: 1 });
    entries.push({
      tag: 0x0128,
      type: 3,
      inlineValue: resolution.unit,
      count: 1,
    });
  }
  const tiff = buildTiffIfd(entries);
  return appSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]));
}

export interface JpegSampleOptions {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
  readonly preserveResolution: boolean;
}

export interface QualificationSample {
  readonly id: string;
  readonly bytes: Buffer;
  readonly expected: "success" | "malformed-file" | "unsafe-structure";
  readonly arm: "metadata" | "no-metadata" | "hostile";
  readonly planted: readonly PlantedCanary<JpegMetadataKind>[];
  readonly options: JpegSampleOptions;
  /** Set only when an `APP1-EXIF` canary was planted with an orientation value. */
  readonly plantedOrientation?: number;
  /** Set only when an `APP1-EXIF` canary was planted with resolution values. */
  readonly plantedResolution?: PlantedResolution;
  /** Set only when a JFIF APP0 (no thumbnail) was planted. */
  readonly plantedJfif: boolean;
  /** Set only when an Adobe APP14 was planted. */
  readonly plantedAdobe: boolean;
  /** The hostile mutation case's own refusal literal, set only on `arm: "hostile"` samples. */
  readonly hostileRefusal?: JpegRefusal;
}

const preservationOptionsArbitrary: fc.Arbitrary<JpegSampleOptions> = fc.record(
  {
    preserveOrientation: fc.boolean(),
    preserveColorProfile: fc.boolean(),
    preserveTimestamps: fc.boolean(),
    preserveResolution: fc.boolean(),
  },
);

const NO_PRESERVATION: JpegSampleOptions = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

interface MetadataArmSample {
  readonly bytes: Buffer;
  readonly planted: readonly PlantedCanary<JpegMetadataKind>[];
  readonly options: JpegSampleOptions;
  readonly plantedOrientation?: number;
  readonly plantedResolution?: PlantedResolution;
  readonly plantedJfif: boolean;
  readonly plantedAdobe: boolean;
}

/**
 * Builds a structurally-admitted JPEG carrying 1-8 unique per-identifier-class
 * canaries (drawn from `GENERIC_KINDS`), an independently-weighted `APP1-EXIF`
 * canary (with independently-drawn Orientation/resolution), an independently
 * weighted multi-segment `ICC` canary, and independently-drawn JFIF/Adobe/
 * trailer structural elements -- all interleaved in random order after SOI
 * (D-01 classification is content-prefix-driven, not position-driven).
 * `APP1-EXIF`/`ICC` are drawn separately (not from the uniqueArray subset) so
 * their floor counts stay reliably above the D-20 re-measure threshold,
 * mirroring `pngMetadataArbitrary`'s own `includeOrientation` weighting fix.
 */
export function jpegQualificationMetadataArbitrary(): fc.Arbitrary<MetadataArmSample> {
  return fc
    .record({
      components: fc.constantFrom(1, 3, 4),
      kinds: fc.uniqueArray(fc.constantFrom(...GENERIC_KINDS), {
        minLength: 1,
        maxLength: GENERIC_KINDS.length,
      }),
      includeExif: fc.integer({ min: 0, max: 9 }).map((v) => v > 1), // ~80%
      includeOrientation: fc.integer({ min: 0, max: 9 }).map((v) => v > 2), // ~70%
      orientation: fc.integer({ min: 1, max: 8 }),
      includeResolution: fc.integer({ min: 0, max: 9 }).map((v) => v > 2), // ~70%
      resolutionX: fc.integer({ min: 1, max: 1000 }),
      resolutionY: fc.integer({ min: 1, max: 1000 }),
      resolutionUnit: fc.constantFrom(1, 2, 3),
      includeIcc: fc.integer({ min: 0, max: 9 }).map((v) => v > 3), // ~60%
      includeTrailer: fc.boolean(),
      includeJfif: fc.boolean(),
      includeAdobe: fc.boolean(),
      shuffleSeed: fc.integer({ min: 0, max: 0x7fffffff }),
      options: preservationOptionsArbitrary,
      // Always drawn (cheap, random bytes); `include*` gates whether the
      // canary is actually used in the final sample below. Drawing them
      // unconditionally keeps every branch of this record the same shape,
      // avoiding a `.chain()`-per-optional-field union-type headache.
      exifCanary: canaryArbitrary<JpegMetadataKind>("APP1-EXIF"),
      iccCanary: canaryArbitrary<JpegMetadataKind>("ICC"),
      trailerCanary: canaryArbitrary<JpegMetadataKind>("TRAILER"),
    })
    .chain((base) =>
      fc
        .tuple(...base.kinds.map((kind) => canaryArbitrary<JpegMetadataKind>(kind)))
        .map((genericCanaries) => ({ ...base, genericCanaries })),
    )
    .map((sample): MetadataArmSample => {
      const {
        components,
        genericCanaries,
        includeExif,
        includeIcc,
        includeTrailer,
        includeOrientation,
        orientation,
        includeResolution,
        resolutionX,
        resolutionY,
        resolutionUnit,
        includeJfif,
        includeAdobe,
        shuffleSeed,
        options,
      } = sample;
      const exifCanary = includeExif ? sample.exifCanary : undefined;
      const iccCanary = includeIcc ? sample.iccCanary : undefined;
      const trailerCanary = includeTrailer ? sample.trailerCanary : undefined;

      const planted: PlantedCanary<JpegMetadataKind>[] = [...genericCanaries];
      const segments: Buffer[] = genericCanaries.map((item) =>
        genericSegment(item.kind as (typeof GENERIC_KINDS)[number], item.canary),
      );

      let plantedOrientation: number | undefined;
      let plantedResolution: PlantedResolution | undefined;
      if (exifCanary !== undefined) {
        planted.push(exifCanary);
        plantedOrientation = includeOrientation ? orientation : undefined;
        plantedResolution = includeResolution
          ? { x: resolutionX, y: resolutionY, unit: resolutionUnit }
          : undefined;
        segments.push(
          jpegExifSegmentWithCanary(
            exifCanary.canary,
            plantedOrientation,
            plantedResolution,
          ),
        );
      }

      if (iccCanary !== undefined) {
        planted.push(iccCanary);
        const profile = iccCanaryProfile(iccCanary.canary);
        // Small chunk size so a genuinely small profile still splits into
        // 2-3 real APP2 segments (D-01 "multi-segment ICC").
        segments.push(...iccSegments(profile, 128));
      }

      const extendedXmpKind = genericCanaries.find(
        (item) => item.kind === "APP1-EXTENDED-XMP",
      );
      // APP1-EXTENDED-XMP was already planted above as a single generic
      // segment; replace it with the real two-chunk shape.
      if (extendedXmpKind !== undefined) {
        const index = segments.findIndex((segment) =>
          segment.includes(
            Buffer.from("http://ns.adobe.com/xmp/extension/", "ascii"),
          ),
        );
        if (index !== -1) {
          segments.splice(index, 1, ...extendedXmpChunks(extendedXmpKind.canary));
        }
      }

      if (includeJfif) segments.push(appSegment(0xe0, jpegJfifPayload(72, 72)));
      if (includeAdobe) segments.push(appSegment(0xee, jpegAdobePayload(1)));

      // Interleave order (D-01 classification is content-prefix-driven, so
      // any order among legal after-SOI positions is safe).
      const rng = mulberry32(shuffleSeed);
      for (let i = segments.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = segments[i]!;
        segments[i] = segments[j]!;
        segments[j] = tmp;
      }

      let bytes = spliceSegments(minimalJpeg({ components }), segments);
      if (trailerCanary !== undefined) {
        planted.push(trailerCanary);
        bytes = appendTrailer(bytes, Buffer.from(trailerCanary.canary, "ascii"));
      }

      return {
        bytes,
        planted,
        options,
        ...(plantedOrientation === undefined ? {} : { plantedOrientation }),
        ...(plantedResolution === undefined ? {} : { plantedResolution }),
        plantedJfif: includeJfif,
        plantedAdobe: includeAdobe,
      };
    });
}

/** Deterministic PRNG for the in-generator segment shuffle (fast-check
 * itself drives every other random choice; this only reorders an already-
 * drawn segment list, so a small local PRNG keeps that shuffle replayable
 * from the same fast-check seed without adding another arbitrary layer). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const jpegMetadataGenerator: FormatGenerator<JpegMetadataKind> =
  Object.freeze({
    format: "jpeg",
    metadataKinds: Object.freeze(ALL_METADATA_KINDS),
    arbitrary: (): fc.Arbitrary<GeneratedSample<JpegMetadataKind>> =>
      jpegQualificationMetadataArbitrary().map(({ bytes, planted }) => ({
        bytes,
        planted,
      })),
  });

// Retained for any external caller expecting the pre-57-12 tracer-slice name.
export const jpegMetadataArbitrary = jpegQualificationMetadataArbitrary;

function buildMetadataArm(): fc.Arbitrary<QualificationSample> {
  return jpegQualificationMetadataArbitrary().map(
    ({
      bytes,
      planted,
      options,
      plantedOrientation,
      plantedResolution,
      plantedJfif,
      plantedAdobe,
    }): QualificationSample => ({
      id: `metadata-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
      bytes,
      expected: "success",
      arm: "metadata",
      planted,
      options,
      ...(plantedOrientation === undefined ? {} : { plantedOrientation }),
      ...(plantedResolution === undefined ? {} : { plantedResolution }),
      plantedJfif,
      plantedAdobe,
    }),
  );
}

/** A structurally-admitted JPEG with no metadata segments at all --
 * `minimalJpeg()` alone, no trailer. */
function buildNoMetadataArm(): fc.Arbitrary<QualificationSample> {
  return fc
    .tuple(fc.constantFrom(1, 3, 4), preservationOptionsArbitrary)
    .map(([components, options]): QualificationSample => {
      const bytes = minimalJpeg({ components });
      return {
        id: `generated-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
        bytes,
        expected: "success",
        arm: "no-metadata",
        planted: [],
        options,
        plantedJfif: false,
        plantedAdobe: false,
      };
    });
}

// -----------------------------------------------------------------------------
// Task 2: hostile mutation cases, one per JpegRefusal literal (JPEG-04's
// hostile-corpus gate). Byte-construction mirrors tests/jpeg_parser.test.ts's
// own patch/insert helpers exactly (57-03/57-04's own unit-level proof of
// each refusal), ported here so the qualification kit exercises the identical
// shapes through the real `sanitizeFile` entry point.
// -----------------------------------------------------------------------------

function markerOffset(bytes: Buffer, marker: number, from = 2): number {
  let offset = from;
  while (offset < bytes.length - 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === marker) return offset;
    offset += 1;
  }
  throw new Error(`marker 0x${marker.toString(16)} not found in fixture`);
}

function segmentLength(bytes: Buffer, markerOff: number): number {
  return bytes.readUInt16BE(markerOff + 2);
}

function patchMarkerByte(bytes: Buffer, markerOff: number, newMarker: number): Buffer {
  const result = Buffer.from(bytes);
  result[markerOff + 1] = newMarker;
  return result;
}

function patchByte(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result[offset] = value;
  return result;
}

function patchU16(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result.writeUInt16BE(value, offset);
  return result;
}

function insertSegmentBefore(
  bytes: Buffer,
  beforeMarker: number,
  segment: Buffer,
  from = 2,
): Buffer {
  const offset = markerOffset(bytes, beforeMarker, from);
  return Buffer.concat([bytes.subarray(0, offset), segment, bytes.subarray(offset)]);
}

function removeSegment(bytes: Buffer, marker: number, from = 2): Buffer {
  const offset = markerOffset(bytes, marker, from);
  const length = segmentLength(bytes, offset);
  return Buffer.concat([
    bytes.subarray(0, offset),
    bytes.subarray(offset + 2 + length),
  ]);
}

function dropLastSofComponent(bytes: Buffer, sofMarker = 0xc0): Buffer {
  const offset = markerOffset(bytes, sofMarker);
  const length = segmentLength(bytes, offset);
  const nfOffset = offset + 4 + 5;
  const nf = bytes[nfOffset]!;
  const result = Buffer.from(bytes);
  result[nfOffset] = nf - 1;
  result.writeUInt16BE(length - 3, offset + 2);
  const componentTableEnd = offset + 4 + 6 + nf * 3;
  return Buffer.concat([
    result.subarray(0, componentTableEnd - 3),
    result.subarray(componentTableEnd),
  ]);
}

function insertRepeatedBefore(
  bytes: Buffer,
  beforeMarker: number,
  segment: Buffer,
  count: number,
): Buffer {
  const offset = markerOffset(bytes, beforeMarker);
  return Buffer.concat([
    bytes.subarray(0, offset),
    Buffer.concat(Array.from({ length: count }, () => segment)),
    bytes.subarray(offset),
  ]);
}

function comSegment(): Buffer {
  return appSegment(0xfe, Buffer.alloc(0));
}

function dqtSegment(): Buffer {
  return appSegment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
}

/** Builds a fixture with exactly `sosCount` per-component SOS(+entropy)
 * scans of a 1-component 8x8 frame. */
function withScanCount(sosCount: number): Buffer {
  const base = minimalJpeg({ components: 1 });
  const sosOffset = markerOffset(base, 0xda);
  const eoiOffset = base.length - 2;
  const scanSpan = base.subarray(sosOffset, eoiOffset);
  return Buffer.concat([
    base.subarray(0, sosOffset),
    Buffer.concat(Array.from({ length: sosCount }, () => scanSpan)),
    base.subarray(eoiOffset),
  ]);
}

function iccSegmentRaw(sequence: number, count: number, dataBytes: number): Buffer {
  return appSegment(
    0xe2,
    Buffer.concat([
      Buffer.from("ICC_PROFILE\0", "ascii"),
      Buffer.from([sequence, count]),
      Buffer.alloc(dataBytes, 0),
    ]),
  );
}

function extendedXmpSegmentRaw(dataBytes: number): Buffer {
  return appSegment(
    0xe1,
    Buffer.concat([
      Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
      Buffer.alloc(32, 0x41),
      Buffer.alloc(4, 0),
      Buffer.alloc(4, 0),
      Buffer.alloc(dataBytes, 0),
    ]),
  );
}

export interface JpegMaterializedMutationCase {
  readonly prefix: Buffer;
  readonly fileSize: number;
}

export interface JpegHostileMutationCase {
  readonly id: string;
  readonly expectedRefusal: JpegRefusal;
  readonly sourceCase: string;
  readonly options?: Partial<JpegSampleOptions>;
  readonly materialize: () => JpegMaterializedMutationCase;
}

function bytesCase(prefix: Buffer): JpegMaterializedMutationCase {
  return { prefix, fileSize: prefix.length };
}

function sparseCase(prefix: Buffer, fileSize: number): JpegMaterializedMutationCase {
  return { prefix, fileSize };
}

const hostileCases: readonly JpegHostileMutationCase[] = [
  // malformed-container (7 cases)
  {
    id: "malformed-second-soi",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      return bytesCase(
        Buffer.concat([bytes.subarray(0, 2), Buffer.from([0xff, 0xd8]), bytes.subarray(2)]),
      );
    },
  },
  {
    id: "malformed-length-below-2",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const dqtOffset = markerOffset(bytes, 0xdb);
      return bytesCase(patchU16(bytes, dqtOffset + 2, 1));
    },
  },
  {
    id: "malformed-sos-before-sof",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () => bytesCase(removeSegment(minimalJpeg(), 0xc0)),
  },
  {
    id: "malformed-duplicate-sof",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      const sofLength = segmentLength(bytes, sofOffset);
      const sofSegment = bytes.subarray(sofOffset, sofOffset + 2 + sofLength);
      return bytesCase(
        Buffer.concat([bytes.subarray(0, sofOffset), sofSegment, bytes.subarray(sofOffset)]),
      );
    },
  },
  {
    id: "malformed-reserved-marker",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const dqtOffset = markerOffset(bytes, 0xdb);
      return bytesCase(patchMarkerByte(bytes, dqtOffset, 0x02));
    },
  },
  {
    id: "malformed-stray-rstn",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    materialize: () =>
      bytesCase(
        insertSegmentBefore(minimalJpeg(), 0xdb, Buffer.from([0xff, 0xd0])),
      ),
  },
  {
    id: "malformed-icc-inconsistent-count",
    expectedRefusal: "malformed-container",
    sourceCase: "minimal",
    options: { preserveColorProfile: true },
    materialize: () => {
      const base = minimalJpeg();
      const segments = Buffer.concat([
        iccSegmentRaw(1, 2, 4),
        iccSegmentRaw(2, 3, 4), // declares a different total count
      ]);
      const offset = markerOffset(base, 0xdb);
      return bytesCase(
        Buffer.concat([base.subarray(0, offset), segments, base.subarray(offset)]),
      );
    },
  },
  // truncation (3 cases)
  {
    id: "truncation-length-past-eof",
    expectedRefusal: "truncation",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const dqtOffset = markerOffset(bytes, 0xdb);
      return bytesCase(patchU16(bytes, dqtOffset + 2, 0x7fff));
    },
  },
  {
    id: "truncation-in-a-segment",
    expectedRefusal: "truncation",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const dqtOffset = markerOffset(bytes, 0xdb);
      return bytesCase(bytes.subarray(0, dqtOffset + 10));
    },
  },
  {
    id: "truncation-entropy-data-without-eoi",
    expectedRefusal: "truncation",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      return bytesCase(bytes.subarray(0, bytes.length - 3));
    },
  },
  // undefined-table-reference (3 cases)
  {
    id: "undefined-table-dc-reference",
    expectedRefusal: "undefined-table-reference",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sosOffset = markerOffset(bytes, 0xda);
      const tdTaOffset = sosOffset + 4 + 1 + 1;
      return bytesCase(patchByte(bytes, tdTaOffset, 0x10));
    },
  },
  {
    id: "undefined-table-tq-slot",
    expectedRefusal: "undefined-table-reference",
    sourceCase: "minimal",
    materialize: () => bytesCase(removeSegment(minimalJpeg(), 0xdb)),
  },
  {
    id: "undefined-table-progressive-ac",
    expectedRefusal: "undefined-table-reference",
    sourceCase: "progressive",
    materialize: () => {
      const base = minimalJpeg({ sofMarker: 0xc2, components: 1 });
      const dhtOffset = markerOffset(base, 0xc4);
      const length = segmentLength(base, dhtOffset);
      const dcTableBytes = 1 + 16 + 1;
      const patched = Buffer.from(base);
      patched.writeUInt16BE(2 + dcTableBytes, dhtOffset + 2);
      const bytes = Buffer.concat([
        patched.subarray(0, dhtOffset + 4 + dcTableBytes),
        patched.subarray(dhtOffset + 2 + length),
      ]);
      const sosOffset = markerOffset(bytes, 0xda);
      const ssOffset = sosOffset + 4 + 1 + 1 + 1;
      return bytesCase(patchByte(bytes, ssOffset, 1));
    },
  },
  // lossless-frame (1)
  {
    id: "lossless-sof3",
    expectedRefusal: "lossless-frame",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      return bytesCase(patchMarkerByte(bytes, sofOffset, 0xc3));
    },
  },
  // hierarchical-frame (1)
  {
    id: "hierarchical-sof5",
    expectedRefusal: "hierarchical-frame",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      return bytesCase(patchMarkerByte(bytes, sofOffset, 0xc5));
    },
  },
  // arithmetic-frame (1)
  {
    id: "arithmetic-sof9",
    expectedRefusal: "arithmetic-frame",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      return bytesCase(patchMarkerByte(bytes, sofOffset, 0xc9));
    },
  },
  // non-t81-frame (1)
  {
    id: "non-t81-jpg-reserved",
    expectedRefusal: "non-t81-frame",
    sourceCase: "minimal",
    materialize: () => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      return bytesCase(patchMarkerByte(bytes, sofOffset, 0xc8));
    },
  },
  // non-8-bit-precision (1)
  {
    id: "non-8-bit-precision-12",
    expectedRefusal: "non-8-bit-precision",
    sourceCase: "minimal",
    materialize: () => bytesCase(minimalJpeg({ precision: 12 })),
  },
  // unsupported-component-count (1)
  {
    id: "unsupported-component-count-2",
    expectedRefusal: "unsupported-component-count",
    sourceCase: "minimal",
    materialize: () => bytesCase(dropLastSofComponent(minimalJpeg({ components: 3 }))),
  },
  // dnl-marker (1)
  {
    id: "dnl-height-zero",
    expectedRefusal: "dnl-marker",
    sourceCase: "minimal",
    materialize: () => bytesCase(minimalJpeg({ height: 0 })),
  },
  // mpf-secondary-image (1) -- the real D-13 refused class (57-11).
  {
    id: "mpf-secondary-image-cipa",
    expectedRefusal: "mpf-secondary-image",
    sourceCase: "mpf-two-images",
    materialize: () => bytesCase(buildCipaMpfTwoImages(minimalJpeg({ components: 3 }))),
  },
  // resource-limits (7 cases: 6 census caps + the ICC.1 profile-size cap)
  {
    id: "resource-limits-segment-count",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => {
      const base = minimalJpeg();
      const extra = JPEG_MAX_SEGMENT_COUNT - 4 + 1;
      return bytesCase(insertRepeatedBefore(base, 0xdb, comSegment(), extra));
    },
  },
  {
    id: "resource-limits-scan-count",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => bytesCase(withScanCount(JPEG_MAX_SCAN_COUNT + 1)),
  },
  {
    id: "resource-limits-table-segment-count",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => {
      const base = minimalJpeg();
      const extra = JPEG_MAX_TABLE_SEGMENT_COUNT - 2 + 1;
      return bytesCase(insertRepeatedBefore(base, 0xc0, dqtSegment(), extra));
    },
  },
  {
    id: "resource-limits-icc-segment-count",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => {
      const base = minimalJpeg();
      const count = JPEG_MAX_ICC_SEGMENTS + 1;
      const segments = Buffer.concat(
        Array.from({ length: count }, (_, index) => iccSegmentRaw(index + 1, count, 4)),
      );
      const offset = markerOffset(base, 0xdb);
      return bytesCase(
        Buffer.concat([base.subarray(0, offset), segments, base.subarray(offset)]),
      );
    },
  },
  {
    id: "resource-limits-extended-xmp-bytes",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => {
      const perSegment = 65_000;
      const segmentCount = Math.ceil(JPEG_MAX_EXTENDED_XMP_BYTES / perSegment) + 1;
      const base = minimalJpeg();
      const segments = Buffer.concat(
        Array.from({ length: segmentCount }, () => extendedXmpSegmentRaw(perSegment)),
      );
      const offset = markerOffset(base, 0xdb);
      return bytesCase(
        Buffer.concat([base.subarray(0, offset), segments, base.subarray(offset)]),
      );
    },
  },
  {
    id: "resource-limits-file-bytes",
    expectedRefusal: "resource-limits",
    sourceCase: "minimal",
    materialize: () => sparseCase(minimalJpeg(), JPEG_MAX_FILE_BYTES + 1),
  },
  // MEASURED FINDING (57-12): a distinct "oversize reassembled ICC profile"
  // resource-limits case (as opposed to icc-segment-count above) is
  // unreachable. ICC.1 Annex B.4's per-segment sequence-number ceiling (255,
  // JPEG_MAX_ICC_SEGMENTS) bounds the reassembled profile at 255 *
  // 65,519 usable bytes/segment = 16,707,345 bytes (~15.93 MiB) at the
  // maximum admitted segment count -- strictly below MAX_PROFILE_BYTES
  // (16,777,216 bytes) -- so `reassembleIccSegments` can never see a total
  // exceeding MAX_PROFILE_BYTES without first tripping icc-segment-count
  // during parsing. `resource-limits-icc-segment-count` above is the only
  // buildable ICC resource-limits hostile case; no separate "oversize ICC"
  // fixture is added (recorded as a deviation in the plan's SUMMARY, not
  // silently dropped).
];

export const hostileMutationCases: readonly JpegHostileMutationCase[] = Object.freeze(
  [...hostileCases].sort((left, right) => left.id.localeCompare(right.id)),
);

export function materializeMutationCase(id: string): JpegMaterializedMutationCase {
  const record = hostileMutationCases.find((item) => item.id === id);
  if (record === undefined) throw new Error(`Unknown mutation case: ${id}`);
  const materialized = record.materialize();
  return {
    prefix: Buffer.from(materialized.prefix),
    fileSize: materialized.fileSize,
  };
}

export interface JpegValidGrammarCase {
  readonly id: string;
  readonly bytes: Buffer;
}

export const validGrammarCases: readonly JpegValidGrammarCase[] = Object.freeze([
  { id: "minimal-1-component", bytes: minimalJpeg({ components: 1 }) },
  { id: "minimal-3-component", bytes: minimalJpeg({ components: 3 }) },
  { id: "minimal-4-component", bytes: minimalJpeg({ components: 4 }) },
  { id: "progressive", bytes: minimalJpeg({ sofMarker: 0xc2 }) },
  { id: "extended-sequential", bytes: minimalJpeg({ sofMarker: 0xc1 }) },
  {
    id: "with-restart-interval",
    bytes: minimalJpeg({ restartInterval: 1 }),
  },
]);

function toHostileSample(item: JpegHostileMutationCase): QualificationSample {
  const materialized = item.materialize();
  return {
    id: item.id,
    bytes: materialized.prefix,
    expected:
      item.expectedRefusal === "malformed-container" ||
      item.expectedRefusal === "truncation"
        ? "malformed-file"
        : "unsafe-structure",
    arm: "hostile" as const,
    planted: [] as PlantedCanary<JpegMetadataKind>[],
    options: { ...NO_PRESERVATION, ...item.options },
    plantedJfif: false,
    plantedAdobe: false,
    hostileRefusal: item.expectedRefusal,
  } satisfies QualificationSample;
}

/** Category-uniform-then-case sampling (56-10/56-16 lesson): picks an
 * `expectedRefusal` bucket uniformly first, then a case within it, so a
 * refusal with many cases (e.g. `malformed-container`, `resource-limits`)
 * does not dominate the hostile arm's draw. Only cases whose materialized
 * `fileSize` equals its real `prefix.length` are sampled here (a sparse
 * case's real on-disk bytes never reproduce its own refusal from a plain
 * in-memory sample -- `parser.test.ts`'s own materialization covers those). */
function buildHostileArm(): fc.Arbitrary<QualificationSample> {
  const byRefusal = new Map<JpegRefusal, JpegHostileMutationCase[]>();
  for (const item of hostileMutationCases) {
    const materialized = item.materialize();
    if (materialized.fileSize !== materialized.prefix.length) continue;
    const list = byRefusal.get(item.expectedRefusal) ?? [];
    list.push(item);
    byRefusal.set(item.expectedRefusal, list);
  }
  const refusals = [...byRefusal.keys()];
  return fc
    .constantFrom(...refusals)
    .chain((refusal) => fc.constantFrom(...byRefusal.get(refusal)!))
    .map(toHostileSample);
}

export function jpegQualificationArbitrary(): fc.Arbitrary<QualificationSample> {
  return fc.oneof(
    { weight: 10, arbitrary: buildMetadataArm() },
    { weight: 2, arbitrary: buildNoMetadataArm() },
    { weight: 7, arbitrary: buildHostileArm() },
  );
}

/**
 * D-21 negative control (3): the widened arbitrary with the metadata arm
 * removed, so no sample can ever plant a metadata canary.
 */
export function jpegQualificationArbitraryWithoutMetadataArm(): fc.Arbitrary<QualificationSample> {
  return fc.oneof(
    { weight: 2, arbitrary: buildNoMetadataArm() },
    { weight: 7, arbitrary: buildHostileArm() },
  );
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${label} is outside its admitted range`);
  return parsed;
}

const BASE_SEED = 460046;

export function resolveReplayConfig(environment: NodeJS.ProcessEnv): {
  readonly seed: number;
  readonly path?: string;
  readonly numRuns: number;
} {
  const seed = boundedInteger(environment.FC_SEED, BASE_SEED, 0, 0x7fff_ffff, "FC_SEED");
  const numRuns = boundedInteger(
    environment.FC_RUNS,
    environment.FC_PATH === undefined ? 200 : 1,
    1,
    200,
    "FC_RUNS",
  );
  const path = environment.FC_PATH;
  if (path !== undefined && !/^\d+(?::\d+)*$/.test(path))
    throw new Error("FC_PATH is not a bounded fast-check replay path");
  return { seed, numRuns, ...(path === undefined ? {} : { path }) };
}

export interface ReplayRecordInput {
  readonly seed: number;
  readonly path: string | null;
  readonly fixtureSha256: string;
  readonly faultPlan: unknown;
}

export function formatReplayRecord(input: ReplayRecordInput) {
  if (
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    input.path === null ||
    !/^\d+(?::\d+)*$/.test(input.path) ||
    !/^[a-f0-9]{64}$/.test(input.fixtureSha256)
  )
    throw new Error("Replay identity is incomplete");
  return {
    version: 1 as const,
    seed: input.seed,
    path: input.path,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    fixtureSha256: input.fixtureSha256,
    faultPlan: input.faultPlan,
    replayCommand: `FC_SEED=${input.seed} FC_PATH=${input.path} npm test -- tests/qualification/jpeg/property.test.ts`,
  };
}

export { NO_PRESERVATION as JPEG_NO_PRESERVATION, MAX_PROFILE_BYTES };
