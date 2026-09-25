import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  alpha,
  anim,
  animationFrame,
  exifWithOrientation,
  iccProfile,
  iccProfileV4,
  metadataWebp,
  vp8,
  vp8l,
  vp8x,
  webp,
  xmpPacket,
  type FixtureChunk,
} from "../../fixtures.js";
import {
  MAX_BUFFERED_METADATA_BYTES,
  MAX_CHUNK_COUNT,
  MAX_RIFF_BYTES,
  type WebpStructureError,
} from "../../../src/webp/riff.js";
import { canaryArbitrary, type PlantedCanary } from "../kit/generators.js";

export type HostileCategory =
  | "aggregate-limit"
  | "chunk-count-limit"
  | "declared-size"
  | "duplicate-singleton"
  | "empty-input"
  | "feature-flag"
  | "metadata-limit"
  | "nested-animation"
  | "odd-padding"
  | "ordering"
  | "payload-mutation"
  | "private-chunk"
  | "trailer"
  | "truncation";

export interface MaterializedMutationCase {
  readonly prefix: Buffer;
  readonly fileSize: number;
}

export interface HostileMutationCase {
  readonly id: string;
  readonly category: HostileCategory;
  readonly sourceCase: string;
  readonly seed: number;
  readonly expectedKind: WebpStructureError["kind"];
  readonly materialize: () => MaterializedMutationCase;
}

export interface ValidGrammarCase {
  readonly id: string;
  readonly bytes: Buffer;
}

export type WebpMetadataKind = "EXIF" | "XMP" | "ICCP";

export interface WebpSampleOptions {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
}

export interface QualificationSample {
  readonly id: string;
  readonly bytes: Buffer;
  readonly expected: "success" | WebpStructureError["kind"];
  readonly arm: "metadata" | "no-metadata" | "hostile";
  readonly planted: readonly PlantedCanary<WebpMetadataKind>[];
  readonly options: WebpSampleOptions;
  /** The EXIF orientation value planted alongside an EXIF canary, when any. */
  readonly plantedOrientation?: number;
}

export interface ReplayRecordInput {
  readonly seed: number;
  readonly path: string | null;
  readonly fixtureSha256: string;
  readonly faultPlan: unknown;
}

const BASE_SEED = 460046;

function bytesCase(prefix: Buffer): MaterializedMutationCase {
  return { prefix, fileSize: prefix.length };
}

function sparseCase(
  prefix: Buffer,
  fileSize: number,
): MaterializedMutationCase {
  return { prefix, fileSize };
}

function metadataLimitCase(): MaterializedMutationCase {
  const metadataSize = MAX_BUFFERED_METADATA_BYTES + 1;
  const fileSize = 12 + 18 + 8 + metadataSize + (metadataSize & 1) + 18;
  const prefix = Buffer.alloc(38);
  prefix.write("RIFF", 0, 4, "ascii");
  prefix.writeUInt32LE(fileSize - 8, 4);
  prefix.write("WEBP", 8, 4, "ascii");
  prefix.write("VP8X", 12, 4, "ascii");
  prefix.writeUInt32LE(10, 16);
  prefix[20] = 0x20;
  prefix.write("ICCP", 30, 4, "ascii");
  prefix.writeUInt32LE(metadataSize, 34);
  return sparseCase(prefix, fileSize);
}

function aggregateLimitCase(): MaterializedMutationCase {
  const fileSize = MAX_RIFF_BYTES + 1;
  const prefix = Buffer.alloc(12);
  prefix.write("RIFF", 0, 4, "ascii");
  prefix.writeUInt32LE(fileSize - 8, 4);
  prefix.write("WEBP", 8, 4, "ascii");
  return sparseCase(prefix, fileSize);
}

const validLossy = webp([{ fourCc: "VP8 ", data: vp8(2, 2) }]);
const validAnimation = webp([
  { fourCc: "VP8X", data: vp8x(0x02, 2, 1) },
  { fourCc: "ANIM", data: anim() },
  { fourCc: "ANMF", data: animationFrame({ width: 2 }) },
]);

export const validGrammarCases: readonly ValidGrammarCase[] = Object.freeze([
  {
    id: "valid-alpha-lossy",
    bytes: webp([
      { fourCc: "VP8X", data: vp8x(0x10, 2, 1) },
      { fourCc: "ALPH", data: alpha(2, 1) },
      { fourCc: "VP8 ", data: vp8(2, 1) },
    ]),
  },
  { id: "valid-animation-nested", bytes: validAnimation },
  {
    id: "valid-lossless-alpha",
    bytes: webp([
      { fourCc: "VP8X", data: vp8x(0x10, 2, 2) },
      { fourCc: "VP8L", data: vp8l(2, 2, true) },
    ]),
  },
  { id: "valid-lossy-still", bytes: validLossy },
  { id: "valid-metadata-orientation", bytes: metadataWebp() },
]);

const cases: readonly HostileMutationCase[] = [
  {
    id: "aggregate-limit-plus-one",
    category: "aggregate-limit",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: aggregateLimitCase,
  },
  {
    id: "chunk-count-plus-one",
    category: "chunk-count-limit",
    sourceCase: "valid-animation-nested",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8X", data: vp8x(0x02) },
          { fourCc: "ANIM", data: anim() },
          ...Array.from({ length: MAX_CHUNK_COUNT - 1 }, () => ({
            fourCc: "ANMF",
            data: animationFrame(),
          })),
        ]),
      ),
  },
  {
    id: "declared-size-plus-one",
    category: "declared-size",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(webp([{ fourCc: "VP8 ", data: vp8(2, 2) }], 1)),
  },
  {
    id: "duplicate-vp8-singleton",
    category: "duplicate-singleton",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "VP8 ", data: vp8() },
        ]),
      ),
  },
  {
    id: "empty-input",
    category: "empty-input",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "unsupported-format",
    materialize: () => bytesCase(Buffer.alloc(0)),
  },
  {
    id: "exif-flag-without-chunk",
    category: "feature-flag",
    sourceCase: "valid-metadata-orientation",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8X", data: vp8x(0x08) },
          { fourCc: "VP8 ", data: vp8() },
        ]),
      ),
  },
  {
    id: "iccp-limit-plus-one",
    category: "metadata-limit",
    sourceCase: "valid-metadata-orientation",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: metadataLimitCase,
  },
  {
    id: "nested-private-chunk",
    category: "nested-animation",
    sourceCase: "valid-animation-nested",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8X", data: vp8x(0x02) },
          { fourCc: "ANIM", data: anim() },
          {
            fourCc: "ANMF",
            data: animationFrame({
              chunks: [
                { fourCc: "PRIV", data: Buffer.from("private") },
                { fourCc: "VP8 ", data: vp8() },
              ],
            }),
          },
        ]),
      ),
  },
  {
    id: "nonzero-odd-padding",
    category: "odd-padding",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8 ", data: vp8(1, 1, Buffer.from([1])), padding: 7 },
        ]),
      ),
  },
  {
    id: "ordered-iccp-after-image",
    category: "ordering",
    sourceCase: "valid-metadata-orientation",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "VP8X", data: vp8x(0x20) },
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "ICCP", data: iccProfile() },
        ]),
      ),
  },
  {
    id: "payload-invalid-vp8-signature",
    category: "payload-mutation",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () => {
      const payload = vp8();
      payload[3] = 0;
      return bytesCase(webp([{ fourCc: "VP8 ", data: payload }]));
    },
  },
  {
    id: "private-top-level-chunk",
    category: "private-chunk",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "unsafe-structure",
    materialize: () =>
      bytesCase(
        webp([
          { fourCc: "PRIV", data: Buffer.alloc(0) },
          { fourCc: "VP8 ", data: vp8() },
        ]),
      ),
  },
  {
    id: "trailer-after-declared-boundary",
    category: "trailer",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () => bytesCase(Buffer.concat([validLossy, Buffer.from([0])])),
  },
  {
    id: "truncated-last-byte",
    category: "truncation",
    sourceCase: "valid-lossy-still",
    seed: BASE_SEED,
    expectedKind: "malformed-file",
    materialize: () => bytesCase(validLossy.subarray(0, validLossy.length - 1)),
  },
];

export const hostileMutationCases: readonly HostileMutationCase[] =
  Object.freeze(
    [...cases].sort((left, right) => left.id.localeCompare(right.id)),
  );

export function materializeMutationCase(id: string): MaterializedMutationCase {
  const record = hostileMutationCases.find((item) => item.id === id);
  if (record === undefined) throw new Error(`Unknown mutation case: ${id}`);
  const materialized = record.materialize();
  return {
    prefix: Buffer.from(materialized.prefix),
    fileSize: materialized.fileSize,
  };
}

export function webpArbitrary(): fc.Arbitrary<Buffer> {
  return fc
    .record({
      width: fc.integer({ min: 1, max: 8 }),
      height: fc.integer({ min: 1, max: 8 }),
      kind: fc.constantFrom("lossy", "lossless", "alpha-lossy", "animation"),
      payload: fc.uint8Array({ minLength: 0, maxLength: 8 }),
    })
    .map(({ width, height, kind, payload }) => {
      const data = Buffer.from(payload);
      if (kind === "lossy")
        return webp([{ fourCc: "VP8 ", data: vp8(width, height, data) }]);
      if (kind === "lossless")
        return webp([
          { fourCc: "VP8L", data: vp8l(width, height, false, data) },
        ]);
      if (kind === "alpha-lossy")
        return webp([
          { fourCc: "VP8X", data: vp8x(0x10, width, height) },
          { fourCc: "ALPH", data: alpha(width, height) },
          { fourCc: "VP8 ", data: vp8(width, height, data) },
        ]);
      return webp([
        { fourCc: "VP8X", data: vp8x(0x02, width, height) },
        { fourCc: "ANIM", data: anim() },
        {
          fourCc: "ANMF",
          data: animationFrame({
            width,
            height,
            chunks: [{ fourCc: "VP8 ", data: vp8(width, height, data) }],
          }),
        },
      ]);
    });
}

const NO_PRESERVATION: WebpSampleOptions = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
});

const preservationOptionsArbitrary: fc.Arbitrary<WebpSampleOptions> = fc.record(
  {
    preserveOrientation: fc.boolean(),
    preserveColorProfile: fc.boolean(),
    preserveTimestamps: fc.boolean(),
  },
);

interface MetadataArmSample {
  readonly bytes: Buffer;
  readonly planted: readonly PlantedCanary<WebpMetadataKind>[];
  readonly options: WebpSampleOptions;
  readonly plantedOrientation?: number;
}

/**
 * Builds a structurally-admitted ICC v4 profile (per `validateIccForPreservation`)
 * carrying the canary text inside a second `cprt`/`text` tag, after the default
 * `rTRC` tag. Offsets/sizes stay canonical contiguous ranges with zero padding,
 * since `iccProfileV4` computes them from the tag list and this only writes into
 * the already-zeroed data region past the 8-byte type+reserved tag header.
 */
function iccCanaryProfile(canaryText: string): Buffer {
  const canary = Buffer.from(canaryText, "ascii");
  const tags = [
    { signature: "rTRC" },
    { signature: "cprt", type: "text", size: 8 + canary.length },
  ] as const;
  const tableEnd = 132 + tags.length * 12;
  const cprtOffset = tableEnd + 1 * 8; // matches iccProfileV4's default per-index offset
  const profile = iccProfileV4({}, tags);
  canary.copy(profile, cprtOffset + 8);
  return profile;
}

/**
 * The metadata arm (D-19a/D-20). Plants a non-empty random subset of EXIF, XMP and
 * ICCP canaries into a VP8X-framed still. Chunk order and VP8X flag bits match
 * `metadataWebp()`: ICCP 0x20, EXIF 0x08, XMP 0x04. Preservation flags are drawn
 * independently so a real `sanitizeFile` call downstream is never given a
 * hard-coded flag.
 */
export function webpMetadataArbitrary(): fc.Arbitrary<MetadataArmSample> {
  return fc
    .record({
      width: fc.integer({ min: 1, max: 8 }),
      height: fc.integer({ min: 1, max: 8 }),
      orientation: fc.integer({ min: 1, max: 8 }),
      includeExif: fc.boolean(),
      includeXmp: fc.boolean(),
      includeIccp: fc.boolean(),
      exifCanary: canaryArbitrary<WebpMetadataKind>("EXIF"),
      xmpCanary: canaryArbitrary<WebpMetadataKind>("XMP"),
      iccpCanary: canaryArbitrary<WebpMetadataKind>("ICCP"),
      options: preservationOptionsArbitrary,
    })
    .filter(
      ({ includeExif, includeXmp, includeIccp }) =>
        includeExif || includeXmp || includeIccp,
    )
    .map(
      ({
        width,
        height,
        orientation,
        includeExif,
        includeXmp,
        includeIccp,
        exifCanary,
        xmpCanary,
        iccpCanary,
        options,
      }): MetadataArmSample => {
        const planted: PlantedCanary<WebpMetadataKind>[] = [];
        let flags = 0;
        const middleChunks: FixtureChunk[] = [];
        if (includeIccp) {
          flags |= 0x20;
          middleChunks.push({
            fourCc: "ICCP",
            data: iccCanaryProfile(iccpCanary.canary),
          });
          planted.push(iccpCanary);
        }
        middleChunks.push({ fourCc: "VP8 ", data: vp8(width, height) });
        if (includeExif) {
          flags |= 0x08;
          middleChunks.push({
            fourCc: "EXIF",
            data: exifWithOrientation(orientation, exifCanary.canary),
          });
          planted.push(exifCanary);
        }
        if (includeXmp) {
          flags |= 0x04;
          middleChunks.push({
            fourCc: "XMP ",
            data: xmpPacket(xmpCanary.canary),
          });
          planted.push(xmpCanary);
        }
        const bytes = webp([
          { fourCc: "VP8X", data: vp8x(flags, width, height) },
          ...middleChunks,
        ]);
        return {
          bytes,
          planted,
          options,
          ...(includeExif ? { plantedOrientation: orientation } : {}),
        };
      },
    );
}

export const webpMetadataGenerator = Object.freeze({
  format: "webp",
  metadataKinds: Object.freeze(["EXIF", "XMP", "ICCP"] as const),
  arbitrary: webpMetadataArbitrary,
});

export function qualificationArbitrary(): fc.Arbitrary<QualificationSample> {
  const bufferedHostile = hostileMutationCases.flatMap((item) => {
    const materialized = item.materialize();
    return materialized.fileSize === materialized.prefix.length
      ? [
          {
            id: item.id,
            bytes: materialized.prefix,
            expected: item.expectedKind,
            arm: "hostile" as const,
            planted: [] as PlantedCanary<WebpMetadataKind>[],
            options: NO_PRESERVATION,
          } satisfies QualificationSample,
        ]
      : [];
  });
  const metadataArm = webpMetadataArbitrary().map(
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
  const noMetadataArm = fc
    .tuple(webpArbitrary(), preservationOptionsArbitrary)
    .map(([bytes, options]): QualificationSample => ({
      id: `generated-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
      bytes,
      expected: "success",
      arm: "no-metadata",
      planted: [],
      options,
    }));
  const hostileArm = fc.constantFrom(...bufferedHostile);
  return fc.oneof(
    { weight: 6, arbitrary: metadataArm },
    { weight: 2, arbitrary: noMetadataArm },
    { weight: 2, arbitrary: hostileArm },
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
    replayCommand: `FC_SEED=${input.seed} FC_PATH=${input.path} npm test -- tests/qualification/webp/property.test.ts`,
  };
}
