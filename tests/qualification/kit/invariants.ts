import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect } from "vitest";
import type { PlantedCanary } from "./generators.js";

/**
 * Format-neutral invariants every property family shares (PBT-03, G10, D-10).
 *
 * Every drill that expects a suite to reject a broken sanitizer asserts on one of
 * these labels, so a drill can only pass by driving the real gate: it can never
 * carry its own copy of the check.
 */
export const INVARIANT_MESSAGES = Object.freeze({
  sourceChanged:
    "invariant: a non-success result left the source bytes different from the sample",
  residue:
    "invariant: a non-success result left something other than the source in its directory",
  verificationFailed:
    "invariant: a generated input produced verification-failed, which no admitted or refused input may",
  untypedThrow:
    "invariant: a readable regular source produced an untyped read-failed instead of a typed outcome",
  canariesNotDistinct:
    "invariant: two planted canaries in one sample are equal or one contains the other",
  untypedParserThrow:
    "invariant: the parser threw something other than its typed error class",
} as const);

export interface SampleWorkspace {
  readonly directory: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/**
 * A fresh temporary directory holding `bytes` at `sourceName`, removed in `finally`
 * (one mkdtemp per sample, so samples cannot race over a shared directory).
 */
export async function withSampleWorkspace<T>(
  sourceName: string,
  destinationName: string,
  bytes: Buffer,
  fn: (workspace: SampleWorkspace) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-property-"));
  try {
    const sourcePath = join(directory, sourceName);
    await writeFile(sourcePath, bytes);
    return await fn({
      directory,
      sourcePath,
      destinationPath: join(directory, destinationName),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type OutcomeLike =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string } };

/**
 * Applies to every result for a readable regular source: no input may yield
 * verification-failed, and read-failed on such a source means an untyped throw.
 */
export function assertAdmittedOutcome(result: OutcomeLike): void {
  if (result.ok) return;
  expect(
    result.error.code === "verification-failed",
    INVARIANT_MESSAGES.verificationFailed,
  ).toBe(false);
  expect(
    result.error.code === "read-failed",
    INVARIANT_MESSAGES.untypedThrow,
  ).toBe(false);
}

/**
 * After a non-success the source is byte-identical to `sourceBytes` and the
 * directory holds exactly the source: no destination, stage or temp residue.
 * The listing is sorted and compared for equality, so a stage file that differs
 * from the destination only by a suffix is caught.
 */
export async function assertNonSuccessBlastRadius(input: {
  readonly directory: string;
  readonly sourcePath: string;
  readonly sourceBytes: Buffer;
}): Promise<void> {
  const current = await readFile(input.sourcePath);
  expect(
    current.equals(input.sourceBytes),
    INVARIANT_MESSAGES.sourceChanged,
  ).toBe(true);
  const listing = (await readdir(input.directory)).sort();
  expect(listing, INVARIANT_MESSAGES.residue).toEqual([
    basename(input.sourcePath),
  ]);
}

/** No canary may equal or be a substring of another canary in the same sample. */
export function assertCanariesDistinct(
  planted: readonly PlantedCanary<string>[],
): void {
  for (let i = 0; i < planted.length; i += 1) {
    for (let j = 0; j < planted.length; j += 1) {
      if (i === j) continue;
      const a = planted[i]!.canary;
      const b = planted[j]!.canary;
      expect(a.includes(b), INVARIANT_MESSAGES.canariesNotDistinct).toBe(false);
    }
  }
}

/**
 * Totality: `parse` either resolves or throws its module's typed error class.
 * Returns the outcome so a caller may inspect it; an untyped throw fails with
 * INVARIANT_MESSAGES.untypedParserThrow.
 */
export async function assertTotal<T>(
  parse: () => Promise<T>,
  isTypedError: (error: unknown) => boolean,
): Promise<
  | { readonly resolved: true; readonly value: T }
  | { readonly resolved: false; readonly error: unknown }
> {
  try {
    return { resolved: true, value: await parse() };
  } catch (error) {
    expect(isTypedError(error), INVARIANT_MESSAGES.untypedParserThrow).toBe(
      true,
    );
    return { resolved: false, error };
  }
}
