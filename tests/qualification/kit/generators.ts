import fc from "fast-check";

/**
 * Format-neutral qualification-kit generator interface (D-18).
 *
 * A `FormatGenerator` is the seam every per-format property arbitrary satisfies so
 * a future format's property suite can reuse the same planting/absence assertions
 * this file provides, without this file ever naming a specific container format.
 */

export interface PlantedCanary<Kind extends string> {
  readonly kind: Kind;
  readonly canary: string;
}

export interface GeneratedSample<Kind extends string> {
  readonly bytes: Buffer;
  readonly planted: readonly PlantedCanary<Kind>[];
}

export interface FormatGenerator<Kind extends string> {
  readonly format: string;
  readonly metadataKinds: readonly Kind[];
  arbitrary(): fc.Arbitrary<GeneratedSample<Kind>>;
}

/**
 * A synthetic, uniquely identifying string for a metadata `kind`. At least 40 ASCII
 * bytes (well past any single-byte accidental collision) and unique per sample —
 * 16 random bytes rendered as 32 lowercase hex characters.
 */
export function canaryArbitrary<Kind extends string>(
  kind: Kind,
): fc.Arbitrary<PlantedCanary<Kind>> {
  return fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) => ({
    kind,
    canary: `EXIFCLEANER-CANARY-${kind}-${Buffer.from(bytes).toString("hex")}`,
  }));
}

/**
 * Planting sanity check: every planted canary must actually occur in the source
 * bytes the generator produced. A raw byte search only — never a format parse.
 */
export function assertPlanted(
  source: Buffer,
  planted: readonly PlantedCanary<string>[],
): void {
  for (const item of planted) {
    if (!source.includes(Buffer.from(item.canary, "ascii"))) {
      throw new Error(
        `Planted canary for kind ${item.kind} was not found in the source bytes.`,
      );
    }
  }
}

/**
 * The privacy assertion itself (D-19a): for every planted canary whose kind is not
 * in `preservedKinds`, its bytes must not occur anywhere in `output`. This is a raw
 * `Buffer.includes` search — it never parses `output` with format-aware code, so a
 * pure copy of the input cannot pass by accident.
 */
export function assertCanariesAbsent(
  output: Buffer,
  planted: readonly PlantedCanary<string>[],
  preservedKinds: readonly string[],
): void {
  for (const item of planted) {
    if (preservedKinds.includes(item.kind)) continue;
    if (output.includes(Buffer.from(item.canary, "ascii"))) {
      throw new Error(
        `Canary for kind ${item.kind} was found in the sanitized output.`,
      );
    }
  }
}
