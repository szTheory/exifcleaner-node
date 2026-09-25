import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/**
 * Format-neutral golden digest capture and assert harness (KIT-02, D-22 steps 1-2).
 *
 * A golden file pins a permanent SHA-256 digest of a sanitize output for a given
 * case, keyed by a stable string. It is deliberately never overwritten by
 * `captureGolden` (flag "wx") — re-capturing requires deleting the checked-in file
 * in a reviewed commit that states why.
 */

/** The three preservation flags every case is sanitized under, in a fixed order. */
export interface PreservationOptions {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
}

export interface GoldenFile {
  readonly version: 1;
  readonly reason: string;
  readonly capturedFrom: {
    readonly commit: string;
    readonly engine: string;
  };
  readonly seed: number;
  readonly numRuns: number;
  readonly entries: Readonly<Record<string, string>>;
}

const HEX64 = /^[a-f0-9]{64}$/;
const REFUSED_VALUE = /^refused:.+$/;

/** SHA-256 hex digest of a sanitize output's bytes. */
export function digestOutput(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * An `o0c0t0`-style key fragment for the three preservation flags, so a golden
 * entry key can distinguish the same case sanitized under different flag
 * combinations without embedding a container format's own vocabulary.
 */
export function flagKey(options: PreservationOptions): string {
  const o = options.preserveOrientation ? 1 : 0;
  const c = options.preserveColorProfile ? 1 : 0;
  const t = options.preserveTimestamps ? 1 : 0;
  return `o${o}c${c}t${t}`;
}

function isValidEntryValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (HEX64.test(value) || REFUSED_VALUE.test(value))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function invalid(detail: string): never {
  throw new Error(`Invalid golden file: ${detail}`);
}

/**
 * Reads and validates a golden file's shape: `version: 1`, a non-empty `reason`,
 * a `capturedFrom.{commit,engine}` string pair, integer `seed`/`numRuns`, and an
 * `entries` map whose every value is a 64-hex digest or `refused:<code>`.
 */
export async function readGolden(path: string): Promise<GoldenFile> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(parsed)) invalid("must be an object");
  if (parsed.version !== 1) invalid("version must be 1");
  if (typeof parsed.reason !== "string" || parsed.reason.length === 0)
    invalid("reason must be a non-empty string");
  const capturedFrom = parsed.capturedFrom;
  if (
    !isObject(capturedFrom) ||
    typeof capturedFrom.commit !== "string" ||
    capturedFrom.commit.length === 0 ||
    typeof capturedFrom.engine !== "string" ||
    capturedFrom.engine.length === 0
  )
    invalid("capturedFrom must have non-empty commit and engine strings");
  if (!isSafeInteger(parsed.seed)) invalid("seed must be an integer");
  if (!isSafeInteger(parsed.numRuns)) invalid("numRuns must be an integer");
  if (!isObject(parsed.entries)) invalid("entries must be an object");
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!isValidEntryValue(value))
      invalid(`entry ${key} is not a 64-hex digest or refused:<code>`);
    entries[key] = value;
  }
  return {
    version: 1,
    reason: parsed.reason,
    capturedFrom: {
      commit: capturedFrom.commit,
      engine: capturedFrom.engine,
    },
    seed: parsed.seed,
    numRuns: parsed.numRuns,
    entries,
  };
}

/**
 * Throws one `Error` naming every mismatched, missing and extra key between
 * `actual` (freshly computed) and `golden.entries` (the checked-in baseline),
 * plus a count mismatch when the two entry counts differ. Returns silently on a
 * full match.
 */
export function assertGoldenMatch(
  actual: Readonly<Record<string, string>>,
  golden: GoldenFile,
): void {
  const actualKeys = Object.keys(actual);
  const goldenKeys = Object.keys(golden.entries);
  const actualSet = new Set(actualKeys);
  const goldenSet = new Set(goldenKeys);
  const missing = goldenKeys.filter((key) => !actualSet.has(key)).sort();
  const extra = actualKeys.filter((key) => !goldenSet.has(key)).sort();
  const mismatched = actualKeys
    .filter((key) => goldenSet.has(key) && actual[key] !== golden.entries[key])
    .sort();
  if (missing.length === 0 && extra.length === 0 && mismatched.length === 0)
    return;
  const lines: string[] = [];
  if (mismatched.length > 0)
    lines.push(
      `Mismatched (${mismatched.length}): ${mismatched
        .map(
          (key) =>
            `${key} (expected ${golden.entries[key]}, got ${actual[key]})`,
        )
        .join(", ")}`,
    );
  if (missing.length > 0)
    lines.push(`Missing (${missing.length}): ${missing.join(", ")}`);
  if (extra.length > 0)
    lines.push(`Extra (${extra.length}): ${extra.join(", ")}`);
  lines.push(
    `Count mismatch: golden has ${goldenKeys.length} entries, actual has ${actualKeys.length}.`,
  );
  throw new Error(`Golden digest mismatch.\n${lines.join("\n")}`);
}

/**
 * Writes `file` as sorted-key (by entry key), 2-space-indented JSON with a
 * trailing newline, using `flag: "wx"` so an existing file is never overwritten.
 * Re-capturing requires deleting the file first, in a reviewed commit.
 */
export async function captureGolden(
  path: string,
  file: GoldenFile,
): Promise<void> {
  const sortedEntries: Record<string, string> = {};
  for (const key of Object.keys(file.entries).sort()) {
    const value = file.entries[key];
    if (value !== undefined) sortedEntries[key] = value;
  }
  const sorted: GoldenFile = {
    version: file.version,
    reason: file.reason,
    capturedFrom: file.capturedFrom,
    seed: file.seed,
    numRuns: file.numRuns,
    entries: sortedEntries,
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  await writeFile(path, text, { flag: "wx" });
}
