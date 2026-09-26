import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import fc from "fast-check";
import {
  iccCanaryProfile,
  idotPayload,
  minimalPng,
  png,
  pngBomb,
  pngCaBX,
  pngChrm,
  pngChunk,
  pngCicp,
  pngIdat,
  pngIhdr,
  pngItxt,
  pngPhys,
  pngTextChunkData,
  screenshotShapedPng,
  xmpPacket,
  XMP_ITXT_KEYWORD,
} from "../../fixtures.js";
import {
  canaryArbitrary,
  type FormatGenerator,
  type GeneratedSample,
  type PlantedCanary,
} from "../kit/generators.js";
import {
  PNG_MAX_INFLATED_ICC_BYTES,
  PNG_MAX_INFLATED_TEXT_BYTES,
  PNG_MAX_METADATA_BYTES_PER_CHUNK,
  PNG_SIGNATURE,
  type PngStructureError,
} from "../../../src/png/chunks.js";

/**
 * Every metadata kind the PNG property gate plants a canary into (Plan 10).
 * `iTXt`/`iTXtCompressed` are the same `iTXt` chunk type at two different
 * compression flags; `XMP` is also an `iTXt` chunk, keyed by the reserved
 * `XML:com.adobe.xmp` keyword so the admission layer classifies it under the
 * `XMP` namespace instead of the generic `PNG` one; `private` is an
 * unregistered ancillary chunk type (D-05 strip-and-grant).
 */
export type PngMetadataKind =
  | "tEXt"
  | "zTXt"
  | "iTXt"
  | "iTXtCompressed"
  | "XMP"
  | "eXIf"
  | "caBX"
  | "private"
  | "iCCP";

const ALL_METADATA_KINDS: readonly PngMetadataKind[] = [
  "tEXt",
  "zTXt",
  "iTXt",
  "iTXtCompressed",
  "XMP",
  "eXIf",
  "caBX",
  "private",
  "iCCP",
];

/** An unregistered, lowercase-first ancillary chunk type (D-05 strip-and-grant). */
const PRIVATE_CHUNK_TYPE = "prVt";

function textChunkData(keyword: string, text: string): Buffer {
  return Buffer.from(`${keyword}\0${text}`, "latin1");
}

/**
 * Deflate at level 0 ("stored" blocks): still fully valid, round-trippable
 * deflate data (`inflateBounded` accepts it exactly as any other level), but
 * a stored block copies its input bytes verbatim after a short block header
 * instead of entropy-coding them -- so a canary this short (well under a
 * stored block's 65,535-byte limit) survives as a contiguous, raw-searchable
 * substring of the "compressed" bytes. Every compressed PNG kind this
 * generator plants (`zTXt`, `iTXtCompressed`, `iCCP`) needs this: the kit's
 * `assertPlanted`/`assertCanariesAbsent` are a raw `Buffer.includes` search
 * (D-19a), which a genuinely entropy-coded deflate stream would defeat even
 * for a canary that leaked byte-for-byte.
 */
function deflateStored(data: Buffer): Buffer {
  return deflateSync(data, { level: 0 });
}

function ztxtChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${keyword}\0`, "latin1"),
    Buffer.from([0]), // compression method 0 (zlib, the only defined method)
    deflateStored(Buffer.from(text, "latin1")),
  ]);
}

function itxtChunkData(
  keyword: string,
  text: string,
  compressed: boolean,
): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from(`${keyword}\0`, "latin1"),
    Buffer.from([compressed ? 1 : 0]), // compression flag
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag, null-terminated
    Buffer.from([0]), // empty translated keyword, null-terminated
    compressed ? deflateStored(payload) : payload,
  ]);
}

/**
 * A minimal little-endian TIFF/EXIF IFD0 carrying an ASCII `ImageDescription`
 * (0x010E) holding the canary, and an optional `Orientation` (0x0112) SHORT.
 * `Orientation` is small enough to live inline in its own 4-byte value field;
 * `ImageDescription`'s ASCII value is always external (the canary is far
 * longer than 4 bytes), placed immediately after the IFD.
 */
function pngExifWithCanary(canary: string, orientation?: number): Buffer {
  const description = Buffer.from(`${canary}\0`, "ascii");
  const entryCount = orientation === undefined ? 1 : 2;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const result = Buffer.alloc(dataOffset + description.length);

  result.write("II", 0, 2, "ascii");
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(ifdOffset, 4);
  result.writeUInt16LE(entryCount, ifdOffset);

  let entryOffset = ifdOffset + 2;
  // ImageDescription: type 2 (ASCII), count includes the trailing NUL.
  result.writeUInt16LE(0x010e, entryOffset);
  result.writeUInt16LE(2, entryOffset + 2);
  result.writeUInt32LE(description.length, entryOffset + 4);
  result.writeUInt32LE(dataOffset, entryOffset + 8);
  entryOffset += 12;

  if (orientation !== undefined) {
    // Orientation: type 3 (SHORT), count 1, value inline in the first 2 bytes.
    result.writeUInt16LE(0x0112, entryOffset);
    result.writeUInt16LE(3, entryOffset + 2);
    result.writeUInt32LE(1, entryOffset + 4);
    result.writeUInt16LE(orientation, entryOffset + 8);
    entryOffset += 12;
  }

  result.writeUInt32LE(0, entryOffset); // next-IFD offset: none
  description.copy(result, dataOffset);
  return result;
}

/** PNG `sBIT` payload: one significant-bits byte per channel (opaque to admission). */
function pngSbitData(channels = 3): Buffer {
  return Buffer.alloc(channels, 8);
}

/** PNG `tRNS` payload for a truecolor (colour type 2) source: one 16-bit RGB colour key. */
function pngTrnsData(): Buffer {
  return Buffer.alloc(6);
}

/** PNG `sPLT` payload: name, NUL, sample depth (8), one opaque 6-byte entry. */
function pngSpltData(): Buffer {
  return Buffer.concat([
    Buffer.from("test\0", "latin1"),
    Buffer.from([8]),
    Buffer.alloc(6),
  ]);
}

/** PNG `sCAL` payload: unit specifier, then two NUL-separated ASCII decimal strings. */
function pngScalData(): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.from("1.0\x001.0", "ascii")]);
}

/** PNG `oFFs` payload: two 4-byte signed offsets plus a 1-byte unit specifier. */
function pngOffsData(): Buffer {
  const data = Buffer.alloc(9);
  data.writeInt32BE(0, 0);
  data.writeInt32BE(0, 4);
  data[8] = 0;
  return data;
}

interface MetadataChunkResult {
  readonly type: string;
  readonly data: Buffer;
  /** Chunk order class, mirroring src/png/chunks.ts's PNG_ORDER. */
  readonly orderClass: "before-plte-and-idat" | "anywhere";
}

function chunkForKind(
  kind: PngMetadataKind,
  canary: string,
  orientation: number | undefined,
): MetadataChunkResult {
  switch (kind) {
    case "tEXt":
      return {
        type: "tEXt",
        data: textChunkData("Comment", canary),
        orderClass: "anywhere",
      };
    case "zTXt":
      return {
        type: "zTXt",
        data: ztxtChunkData("Comment", canary),
        orderClass: "anywhere",
      };
    case "iTXt":
      return {
        type: "iTXt",
        data: itxtChunkData("Comment", canary, false),
        orderClass: "anywhere",
      };
    case "iTXtCompressed":
      return {
        type: "iTXt",
        data: itxtChunkData("Comment", canary, true),
        orderClass: "anywhere",
      };
    case "XMP":
      return {
        type: "iTXt",
        data: pngItxt(XMP_ITXT_KEYWORD, xmpPacket(canary)),
        orderClass: "anywhere",
      };
    case "eXIf":
      return {
        type: "eXIf",
        data: pngExifWithCanary(canary, orientation),
        orderClass: "anywhere",
      };
    case "caBX":
      return {
        type: "caBX",
        data: pngCaBX(Buffer.from(canary, "ascii")),
        orderClass: "anywhere",
      };
    case "private":
      return {
        type: PRIVATE_CHUNK_TYPE,
        data: Buffer.from(canary, "ascii"),
        orderClass: "anywhere",
      };
    case "iCCP":
      // Not `pngIccp` (which deflates at the default level): the canary must
      // survive as a raw-searchable substring, so this chunk is built
      // directly with `deflateStored` (see its own doc comment above).
      return {
        type: "iCCP",
        data: Buffer.concat([
          Buffer.from("icc\0", "latin1"),
          Buffer.from([0]), // compression method 0 (deflate, the only defined method)
          deflateStored(iccCanaryProfile(canary)),
        ]),
        orderClass: "before-plte-and-idat",
      };
  }
}

/** The nine D-05 preserve-list chunk types this generator randomly interleaves. */
type PreserveListType =
  | "cHRM"
  | "bKGD"
  | "sBIT"
  | "tRNS"
  | "sPLT"
  | "cICP"
  | "sCAL"
  | "oFFs"
  | "pHYs";

const PRESERVE_LIST_TYPES: readonly PreserveListType[] = [
  "cHRM",
  "bKGD",
  "sBIT",
  "tRNS",
  "sPLT",
  "cICP",
  "sCAL",
  "oFFs",
  "pHYs",
];

const PRESERVE_LIST_ORDER: Readonly<
  Record<
    PreserveListType,
    "before-plte-and-idat" | "after-plte-before-idat" | "before-idat"
  >
> = {
  cHRM: "before-plte-and-idat",
  sBIT: "before-plte-and-idat",
  cICP: "before-plte-and-idat",
  bKGD: "after-plte-before-idat",
  tRNS: "after-plte-before-idat",
  sPLT: "before-idat",
  sCAL: "before-idat",
  oFFs: "before-idat",
  pHYs: "before-idat",
};

function preserveListChunkData(type: PreserveListType): Buffer {
  switch (type) {
    case "cHRM":
      return pngChrm();
    case "bKGD":
      return Buffer.alloc(6);
    case "sBIT":
      return pngSbitData();
    case "tRNS":
      return pngTrnsData();
    case "sPLT":
      return pngSpltData();
    case "cICP":
      return pngCicp();
    case "sCAL":
      return pngScalData();
    case "oFFs":
      return pngOffsData();
    case "pHYs":
      return pngPhys();
  }
}

export interface PngSampleOptions {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
  readonly preserveResolution: boolean;
}

export interface QualificationSample {
  readonly id: string;
  readonly bytes: Buffer;
  readonly expected:
    "success" | PngStructureError["kind"] | "unsupported-feature";
  readonly arm: "metadata" | "no-metadata" | "hostile";
  readonly planted: readonly PlantedCanary<PngMetadataKind>[];
  readonly options: PngSampleOptions;
  /** The EXIF orientation value planted alongside an eXIf canary, when any. */
  readonly plantedOrientation?: number;
}

interface MetadataArmSample {
  readonly bytes: Buffer;
  readonly planted: readonly PlantedCanary<PngMetadataKind>[];
  readonly options: PngSampleOptions;
  readonly plantedOrientation?: number;
}

const preservationOptionsArbitrary: fc.Arbitrary<PngSampleOptions> = fc.record({
  preserveOrientation: fc.boolean(),
  preserveColorProfile: fc.boolean(),
  preserveTimestamps: fc.boolean(),
  preserveResolution: fc.boolean(),
});

/**
 * Builds a structurally-admitted PNG carrying 1-5 unique metadata-kind
 * canaries plus a random subset of the D-05 preserve-list chunks, all placed
 * at legal `PNG_ORDER` positions. Mirrors `webpMetadataArbitrary`'s shape:
 * every preservation flag is drawn independently so a real `sanitizeFile`
 * call downstream is never given a hard-coded flag.
 */
export function pngMetadataArbitrary(): fc.Arbitrary<MetadataArmSample> {
  return fc
    .record({
      width: fc.integer({ min: 1, max: 4 }),
      height: fc.integer({ min: 1, max: 4 }),
      colorType: fc.constantFrom(2, 3, 6),
      kinds: fc.uniqueArray(fc.constantFrom(...ALL_METADATA_KINDS), {
        minLength: 1,
        maxLength: 5,
      }),
      preserveList: fc.subarray([...PRESERVE_LIST_TYPES]),
      // 90% weighted toward "included" (drawn via fc.integer rather than a
      // fc.boolean/fc.oneof coin -- those two consumed the fixed-seed random
      // stream differently and left `flag:preserveOrientation` under the
      // D-20 20-run re-measure threshold on at least one of the four
      // measured seeds at every weighting tried; this shape measured >=20 on
      // all four). An eXIf canary is already only planted when "eXIf" is
      // drawn into the 1-5 unique kind subset, so this still needs to be
      // weighted heavily to clear the threshold; the no-Orientation-in-eXIf
      // case (`orientation === undefined`) is still exercised, just less
      // often, and is separately covered by `pngExifWithCanary`'s own
      // no-orientation branch (screenshotShapedPng and other non-generator
      // fixtures plant an eXIf with no Orientation at all).
      includeOrientation: fc.integer({ min: 0, max: 9 }).map((v) => v > 0),
      orientation: fc.integer({ min: 1, max: 8 }),
      options: preservationOptionsArbitrary,
    })
    .chain((base) =>
      fc
        .tuple(
          ...base.kinds.map((kind) => canaryArbitrary<PngMetadataKind>(kind)),
        )
        .map((canaries) => ({ ...base, canaries })),
    )
    .map((sample): MetadataArmSample => {
      const {
        width,
        height,
        colorType,
        preserveList,
        includeOrientation,
        orientation,
        options,
        canaries,
      } = sample;
      const plantedOrientation =
        includeOrientation && canaries.some((item) => item.kind === "eXIf")
          ? orientation
          : undefined;

      const metadataChunks = canaries.map((canary) =>
        chunkForKind(canary.kind, canary.canary, plantedOrientation),
      );
      const preserveChunks = preserveList.map((type) => ({
        type,
        data: preserveListChunkData(type),
        orderClass: PRESERVE_LIST_ORDER[type],
      }));

      const beforePlte = [
        ...preserveChunks.filter(
          (item) => item.orderClass === "before-plte-and-idat",
        ),
        ...metadataChunks.filter(
          (item) => item.orderClass === "before-plte-and-idat",
        ),
      ];
      const afterPlteBeforeIdat = preserveChunks.filter(
        (item) => item.orderClass === "after-plte-before-idat",
      );
      const beforeIdat = preserveChunks.filter(
        (item) => item.orderClass === "before-idat",
      );
      const anywhere = metadataChunks.filter(
        (item) => item.orderClass === "anywhere",
      );

      const ordered: readonly { type: string; data: Buffer }[] = [
        ...beforePlte,
        ...(colorType === 3
          ? [{ type: "PLTE", data: Buffer.from([0, 0, 0]) }]
          : []),
        ...afterPlteBeforeIdat,
        ...beforeIdat,
      ];

      const bytes = png([
        pngChunk("IHDR", pngIhdr(width, height, 8, colorType)),
        ...ordered.map((item) => pngChunk(item.type, item.data)),
        pngChunk("IDAT", pngIdat()),
        ...anywhere.map((item) => pngChunk(item.type, item.data)),
        pngChunk("IEND", Buffer.alloc(0)),
      ]);

      return {
        bytes,
        planted: canaries,
        options,
        ...(plantedOrientation === undefined ? {} : { plantedOrientation }),
      };
    });
}

export const pngMetadataGenerator: FormatGenerator<PngMetadataKind> =
  Object.freeze({
    format: "png",
    metadataKinds: Object.freeze(ALL_METADATA_KINDS),
    arbitrary: (): fc.Arbitrary<GeneratedSample<PngMetadataKind>> =>
      pngMetadataArbitrary().map(({ bytes, planted }) => ({ bytes, planted })),
  });

function buildMetadataArm(): fc.Arbitrary<QualificationSample> {
  return pngMetadataArbitrary().map(
    ({ bytes, planted, options, plantedOrientation }): QualificationSample => ({
      id: `metadata-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
      bytes,
      expected: "success",
      arm: "metadata",
      planted,
      options,
      ...(plantedOrientation === undefined ? {} : { plantedOrientation }),
    }),
  );
}

/**
 * A structurally-admitted PNG with no metadata canaries at all: IHDR, an
 * optional PLTE (colour type 3), IDAT, IEND. Exercises the no-metadata arm
 * (every removed/conditional chunk is simply absent).
 */
function pngNoMetadataArbitrary(): fc.Arbitrary<Buffer> {
  return fc
    .record({
      width: fc.integer({ min: 1, max: 4 }),
      height: fc.integer({ min: 1, max: 4 }),
      colorType: fc.constantFrom(2, 3, 6),
    })
    .map(({ width, height, colorType }) =>
      png([
        pngChunk("IHDR", pngIhdr(width, height, 8, colorType)),
        ...(colorType === 3 ? [pngChunk("PLTE", Buffer.from([0, 0, 0]))] : []),
        pngChunk("IDAT", pngIdat()),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    );
}

function buildNoMetadataArm(): fc.Arbitrary<QualificationSample> {
  return fc
    .tuple(pngNoMetadataArbitrary(), preservationOptionsArbitrary)
    .map(([bytes, options]): QualificationSample => ({
      id: `generated-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
      bytes,
      expected: "success",
      arm: "no-metadata",
      planted: [],
      options,
    }));
}

const NO_PRESERVATION: PngSampleOptions = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

// --- Task 2: hostile mutation cases, one per PNG-03 refusal class -------

/** Every PNG-03 refusal class this generator's hostile corpus covers. */
export type PngHostileCategory =
  | "crc"
  | "unknown-critical"
  | "chunk-order"
  | "truncation"
  | "trailing-data"
  | "apng"
  | "decompression-bomb"
  | "length-overflow"
  | "duplicate-singleton"
  | "idot-adjacency"
  | "registered-unmeasured"
  | "metadata-limit"
  | "aggregate-inflate";

export interface PngMaterializedMutationCase {
  readonly prefix: Buffer;
  readonly fileSize: number;
}

export interface PngHostileMutationCase {
  readonly id: string;
  readonly category: PngHostileCategory;
  readonly sourceCase: string;
  readonly seed: number;
  readonly expectedKind:
    "malformed-file" | "unsafe-structure" | "unsupported-feature";
  readonly options?: Partial<PngSampleOptions>;
  readonly materialize: () => PngMaterializedMutationCase;
}

const HOSTILE_BASE_SEED = 560056;

function bytesCase(prefix: Buffer): PngMaterializedMutationCase {
  return { prefix, fileSize: prefix.length };
}

/** A file whose declared size exceeds its real (sparse-truncated) byte count. */
function sparseCase(
  prefix: Buffer,
  fileSize: number,
): PngMaterializedMutationCase {
  return { prefix, fileSize };
}

function corruptCrc(chunkBuffer: Buffer): Buffer {
  const result = Buffer.from(chunkBuffer);
  result[result.length - 1] = (result[result.length - 1]! ^ 0xff) & 0xff;
  return result;
}

/** IHDR, the given middle chunks, IDAT, IEND -- mirrors png_chunks.test.ts's own `validImage`. */
function validImage(...middleChunks: readonly Buffer[]): Buffer {
  return png([
    pngChunk("IHDR", pngIhdr()),
    ...middleChunks,
    pngChunk("IDAT", pngIdat()),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A minimal chunk header (8 bytes: 4-byte length, 4-byte type) with no
 * corresponding data or CRC. `parsePng` rejects a chunk whose declared length
 * exceeds `MAX_CHUNK_LENGTH` immediately after reading its header -- before
 * any bounds check against the file's actual size -- so this header alone,
 * appended to a real (non-sparse) prefix, is enough to trigger the refusal.
 */
function overflowChunkHeader(type: string, length: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(length >>> 0, 0);
  header.write(type, 4, 4, "ascii");
  return header;
}

function metadataLimitCase(): PngMaterializedMutationCase {
  const oversized = PNG_MAX_METADATA_BYTES_PER_CHUNK + 1;
  const header = overflowChunkHeader("caBX", oversized);
  const prefix = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", pngIhdr()),
    header,
  ]);
  const fileSize = prefix.length + oversized + 4; // + CRC
  return sparseCase(prefix, fileSize);
}

function aggregateInflateCase(): PngMaterializedMutationCase {
  const bomb = pngBomb("zTXt", 15_000_000);
  return bytesCase(
    png([
      pngChunk("IHDR", pngIhdr()),
      pngChunk("zTXt", bomb),
      pngChunk("zTXt", bomb),
      pngChunk("zTXt", bomb),
      pngChunk("zTXt", bomb),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const hostileCases: readonly PngHostileMutationCase[] = [
  {
    id: "crc-ihdr",
    category: "crc",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(
        png([
          corruptCrc(pngChunk("IHDR", pngIhdr())),
          pngChunk("IDAT", pngIdat()),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      ),
  },
  {
    id: "crc-ancillary-chrm",
    category: "crc",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(validImage(corruptCrc(pngChunk("cHRM", pngChrm())))),
  },
  {
    id: "crc-idat",
    category: "crc",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(
        png([
          pngChunk("IHDR", pngIhdr()),
          corruptCrc(pngChunk("IDAT", pngIdat())),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      ),
  },
  {
    id: "unknown-critical-cgbi",
    category: "unknown-critical",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () => bytesCase(validImage(pngChunk("CgBI", Buffer.alloc(4)))),
  },
  {
    id: "chunk-order-noncontiguous-idat",
    category: "chunk-order",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        png([
          pngChunk("IHDR", pngIhdr()),
          pngChunk("IDAT", pngIdat()),
          pngChunk("tEXt", pngTextChunkData("Comment", "split")),
          pngChunk("IDAT", pngIdat()),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      ),
  },
  {
    id: "chunk-order-bkgd-before-plte",
    category: "chunk-order",
    sourceCase: "palette-with-trns",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        png([
          pngChunk("IHDR", pngIhdr(1, 1, 8, 3)),
          pngChunk("bKGD", Buffer.alloc(1)),
          pngChunk("PLTE", Buffer.from([0, 0, 0])),
          pngChunk("IDAT", pngIdat()),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      ),
  },
  {
    id: "truncated-iend",
    category: "truncation",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () => {
      const full = minimalPng();
      return bytesCase(full.subarray(0, full.length - 1));
    },
  },
  {
    id: "trailing-byte-after-iend",
    category: "trailing-data",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(Buffer.concat([minimalPng(), Buffer.from([0])])),
  },
  {
    id: "apng-actl",
    category: "apng",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () => bytesCase(validImage(pngChunk("acTL", Buffer.alloc(8)))),
  },
  {
    id: "apng-fctl",
    category: "apng",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(validImage(pngChunk("fcTL", Buffer.alloc(26)))),
  },
  {
    id: "apng-fdat",
    category: "apng",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () => bytesCase(validImage(pngChunk("fdAT", Buffer.alloc(4)))),
  },
  {
    id: "decompression-bomb-iccp",
    category: "decompression-bomb",
    sourceCase: "iccp-only",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        validImage(
          pngChunk("iCCP", pngBomb("iCCP", PNG_MAX_INFLATED_ICC_BYTES + 1)),
        ),
      ),
  },
  {
    id: "decompression-bomb-iccp-preserve-requested",
    category: "decompression-bomb",
    sourceCase: "iccp-only",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsupported-feature",
    options: { preserveColorProfile: true },
    materialize: () =>
      bytesCase(
        validImage(
          pngChunk("iCCP", pngBomb("iCCP", PNG_MAX_INFLATED_ICC_BYTES + 1)),
        ),
      ),
  },
  {
    id: "decompression-bomb-ztxt",
    category: "decompression-bomb",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        validImage(
          pngChunk("zTXt", pngBomb("zTXt", PNG_MAX_INFLATED_TEXT_BYTES + 1)),
        ),
      ),
  },
  {
    id: "decompression-bomb-itxt",
    category: "decompression-bomb",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        validImage(
          pngChunk("iTXt", pngBomb("iTXt", PNG_MAX_INFLATED_TEXT_BYTES + 1)),
        ),
      ),
  },
  {
    id: "length-overflow",
    category: "length-overflow",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(
        Buffer.concat([
          PNG_SIGNATURE,
          pngChunk("IHDR", pngIhdr()),
          overflowChunkHeader("tEXt", 0x8000_0000),
        ]),
      ),
  },
  {
    id: "duplicate-chrm",
    category: "duplicate-singleton",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        validImage(pngChunk("cHRM", pngChrm()), pngChunk("cHRM", pngChrm())),
      ),
  },
  {
    id: "idot-adjacency-text-between",
    category: "idot-adjacency",
    sourceCase: "screenshot-shaped",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        png([
          pngChunk("IHDR", pngIhdr()),
          pngChunk("iDOT", idotPayload(40)),
          pngChunk(
            "tEXt",
            pngTextChunkData("Comment", "between-idot-and-idat"),
          ),
          pngChunk("IDAT", pngIdat()),
          pngChunk("IEND", Buffer.alloc(0)),
        ]),
      ),
  },
  {
    id: "registered-unmeasured-gifg",
    category: "registered-unmeasured",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () => bytesCase(validImage(pngChunk("gIFg", Buffer.alloc(4)))),
  },
  {
    id: "metadata-limit-cabx",
    category: "metadata-limit",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: metadataLimitCase,
  },
  {
    id: "aggregate-inflate-four-ztxt",
    category: "aggregate-inflate",
    sourceCase: "minimal",
    seed: HOSTILE_BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: aggregateInflateCase,
  },
];

export const hostileMutationCases: readonly PngHostileMutationCase[] =
  Object.freeze(
    [...hostileCases].sort((left, right) => left.id.localeCompare(right.id)),
  );

export function materializeMutationCase(
  id: string,
): PngMaterializedMutationCase {
  const record = hostileMutationCases.find((item) => item.id === id);
  if (record === undefined) throw new Error(`Unknown mutation case: ${id}`);
  const materialized = record.materialize();
  return {
    prefix: Buffer.from(materialized.prefix),
    fileSize: materialized.fileSize,
  };
}

export interface PngValidGrammarCase {
  readonly id: string;
  readonly bytes: Buffer;
}

export const validGrammarCases: readonly PngValidGrammarCase[] = Object.freeze([
  { id: "minimal", bytes: minimalPng() },
  {
    id: "palette-with-trns",
    bytes: png([
      pngChunk("IHDR", pngIhdr(1, 1, 8, 3)),
      pngChunk("PLTE", Buffer.from([0, 0, 0])),
      pngChunk("tRNS", Buffer.from([0])),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  },
  {
    id: "16bit-with-sbit",
    bytes: png([
      pngChunk("IHDR", pngIhdr(1, 1, 16, 2)),
      pngChunk("sBIT", Buffer.alloc(3, 8)),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  },
  {
    id: "interlaced",
    bytes: png([
      pngChunk(
        "IHDR",
        (() => {
          const data = pngIhdr();
          data[12] = 1; // interlace method: Adam7
          return data;
        })(),
      ),
      pngChunk("IDAT", pngIdat()),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  },
  { id: "screenshot-shaped", bytes: screenshotShapedPng() },
]);

/** The hostile arm of `pngQualificationArbitrary` (Task 2): every hostile
 * mutation case whose materialization is not sparse (a sparse case's real
 * on-disk bytes would not reproduce its own declared refusal from a plain
 * in-memory sample, since fast-check samples never get truncated). */
function buildHostileArm(): fc.Arbitrary<QualificationSample> {
  const bufferedHostile = hostileMutationCases.flatMap((item) => {
    const materialized = item.materialize();
    if (materialized.fileSize !== materialized.prefix.length) return [];
    return [
      {
        id: item.id,
        bytes: materialized.prefix,
        expected: item.expectedKind,
        arm: "hostile" as const,
        planted: [] as PlantedCanary<PngMetadataKind>[],
        options: { ...NO_PRESERVATION, ...item.options },
      } satisfies QualificationSample,
    ];
  });
  return fc.constantFrom(...bufferedHostile);
}

export function pngQualificationArbitrary(): fc.Arbitrary<QualificationSample> {
  return fc.oneof(
    { weight: 10, arbitrary: buildMetadataArm() },
    { weight: 2, arbitrary: buildNoMetadataArm() },
    { weight: 2, arbitrary: buildHostileArm() },
  );
}

/**
 * D-21 negative control (3): the widened arbitrary with the metadata arm
 * removed, so no sample can ever plant a metadata canary. Proves the floor
 * assertion itself catches a generator whose metadata coverage silently
 * collapsed.
 */
export function pngQualificationArbitraryWithoutMetadataArm(): fc.Arbitrary<QualificationSample> {
  return fc.oneof(
    { weight: 2, arbitrary: buildNoMetadataArm() },
    { weight: 2, arbitrary: buildHostileArm() },
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
  const seed = boundedInteger(
    environment.FC_SEED,
    BASE_SEED,
    0,
    0x7fff_ffff,
    "FC_SEED",
  );
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
    replayCommand: `FC_SEED=${input.seed} FC_PATH=${input.path} npm test -- tests/qualification/png/property.test.ts`,
  };
}

export { NO_PRESERVATION as PNG_NO_PRESERVATION };
