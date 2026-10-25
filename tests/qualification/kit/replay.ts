import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

/**
 * Shared fast-check replay machinery for every qualification property family (D-08).
 * The only module under tests/ that parses FC_SEED/FC_RUNS/FC_PATH or builds the
 * replay record, so a printed record means the same thing for every format.
 */

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const REPLAY_PATH_PATTERN = /^\d+(?::\d+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ReplayConfig {
  readonly seed: number;
  readonly numRuns: number;
  readonly path?: string;
  readonly endOnFailure?: true;
}

export interface ReplayDefaults {
  readonly seed: number;
  readonly numRuns: number;
}

export const REPLAY_RECORD_KEYS = Object.freeze([
  "architecture",
  "fastCheckVersion",
  "faultPlan",
  "fixtureSha256",
  "format",
  "generatorHash",
  "nodeVersion",
  "note",
  "path",
  "platform",
  "replayCommand",
  "seed",
  "version",
]);

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

export function resolveReplayConfig(
  environment: NodeJS.ProcessEnv,
  defaults: ReplayDefaults = { seed: 460_046, numRuns: 200 },
): ReplayConfig {
  const seed = boundedInteger(
    environment.FC_SEED,
    defaults.seed,
    0,
    0x7fff_ffff,
    "FC_SEED",
  );
  const numRuns = boundedInteger(
    environment.FC_RUNS,
    environment.FC_PATH === undefined ? defaults.numRuns : 1,
    1,
    200,
    "FC_RUNS",
  );
  const path = environment.FC_PATH;
  if (path !== undefined && !REPLAY_PATH_PATTERN.test(path))
    throw new Error("FC_PATH is not a bounded fast-check replay path");
  return path === undefined
    ? { seed, numRuns }
    : { seed, numRuns, path, endOnFailure: true };
}

/** SHA-256 over sorted `path NUL bytes NUL` entries read from the package root. */
export function generatorHash(relativePaths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const relativePath of [...relativePaths].sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(resolve(PACKAGE_ROOT, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ReplayRecordInput {
  readonly format: string;
  readonly seed: number;
  readonly path: string | null;
  readonly bytes: Uint8Array;
  readonly generatorSources: readonly string[];
  readonly faultPlan: unknown;
}

export function formatReplayRecord(input: ReplayRecordInput) {
  if (
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    input.path === null ||
    !REPLAY_PATH_PATTERN.test(input.path) ||
    !/^[a-z0-9-]+$/.test(input.format)
  )
    throw new Error("Replay identity is incomplete");
  const fixtureSha256 = bytesDigest(input.bytes);
  if (!SHA256_PATTERN.test(fixtureSha256))
    throw new Error("Replay identity is incomplete");
  return Object.freeze({
    version: 2 as const,
    format: input.format,
    seed: input.seed,
    path: input.path,
    fastCheckVersion: fc.__version as string,
    generatorHash: generatorHash(input.generatorSources),
    fixtureSha256,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    faultPlan: input.faultPlan,
    replayCommand: `FC_SEED=${input.seed} FC_PATH=${input.path} npm test -- tests/qualification/${input.format}/property.test.ts`,
    note: "A generatorHash or fastCheckVersion mismatch means the path may not reproduce.",
  });
}

export type ReplayRecord = ReturnType<typeof formatReplayRecord>;

export function parseReplayRecord(message: string): ReplayRecord {
  const parsed: unknown = JSON.parse(message);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Replay record is not an object");
  const keys = Object.keys(parsed).sort();
  if (keys.join() !== [...REPLAY_RECORD_KEYS].join())
    throw new Error("Replay record keys do not match version 2");
  const record = parsed as ReplayRecord;
  if (
    record.version !== 2 ||
    !SHA256_PATTERN.test(record.fixtureSha256) ||
    !SHA256_PATTERN.test(record.generatorHash) ||
    !REPLAY_PATH_PATTERN.test(record.path)
  )
    throw new Error("Replay record fields are invalid");
  return record;
}

export interface CheckWithReplayOptions<T> {
  readonly format: string;
  readonly toBytes: (counterexample: T) => Uint8Array;
  readonly generatorSources: readonly string[];
  readonly faultPlan?: unknown;
}

/**
 * Runs the property and, on failure, throws an Error whose message is the JSON v2
 * replay record built from the counterexample's actual bytes.
 */
export async function checkWithReplay<T>(
  property: fc.IAsyncProperty<[T]>,
  config: ReplayConfig,
  options: CheckWithReplayOptions<T>,
): Promise<void> {
  const result = await fc.check(property, config);
  if (!result.failed) return;
  const counterexample = result.counterexample?.[0] as T | undefined;
  if (counterexample === undefined)
    throw new Error("Replay failure carried no counterexample");
  throw new Error(
    JSON.stringify(
      formatReplayRecord({
        format: options.format,
        seed: config.seed,
        path: result.counterexamplePath,
        bytes: options.toBytes(counterexample),
        generatorSources: options.generatorSources,
        faultPlan: options.faultPlan ?? null,
      }),
    ),
  );
}
