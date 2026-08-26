import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  alpha,
  anim,
  animationFrame,
  iccProfile,
  metadataWebp,
  vp8,
  vp8l,
  vp8x,
  webp,
} from "../fixtures.js";
import {
  MAX_BUFFERED_METADATA_BYTES,
  MAX_CHUNK_COUNT,
  MAX_RIFF_BYTES,
  type WebpStructureError,
} from "../../src/webp/riff.js";

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

export interface QualificationSample {
  readonly id: string;
  readonly bytes: Buffer;
  readonly expected: "success" | WebpStructureError["kind"];
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

export function qualificationArbitrary(): fc.Arbitrary<QualificationSample> {
  const bufferedHostile = hostileMutationCases.flatMap((item) => {
    const materialized = item.materialize();
    return materialized.fileSize === materialized.prefix.length
      ? [
          {
            id: item.id,
            bytes: materialized.prefix,
            expected: item.expectedKind,
          } satisfies QualificationSample,
        ]
      : [];
  });
  return fc.oneof(
    webpArbitrary().map((bytes) => ({
      id: `generated-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
      bytes,
      expected: "success" as const,
    })),
    fc.constantFrom(...bufferedHostile),
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
    replayCommand: `FC_SEED=${input.seed} FC_PATH=${input.path} npm test -- tests/qualification/property.test.ts`,
  };
}
