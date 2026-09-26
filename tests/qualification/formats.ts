// Per-format qualification registry; keyed by NativeFormat so a new format
// fails typecheck until its gates exist.
import type { NativeFormat } from "../../src/types.js";
import type { DifferentialProfile } from "./kit/oracles.js";
import type { FormatGenerator } from "./kit/generators.js";
import { webpDifferentialProfile } from "./webp/oracles.js";
import { webpMetadataGenerator } from "./webp/generators.js";
import { pngDifferentialProfile } from "./png/oracles.js";
import { pngMetadataGenerator } from "./png/generators.js";
import { metadataPng, metadataWebp } from "../fixtures.js";

/**
 * The compile-time-exhaustive per-format qualification wiring (KIT-01).
 * `QUALIFICATION_FORMATS` is declared `satisfies Record<NativeFormat, ...>`,
 * so adding a new `NativeFormat` literal to `src/types.ts` fails typecheck
 * here until its differential profile, generator and sample all exist.
 */
export interface QualificationFormat {
  readonly differential: DifferentialProfile;
  readonly generator: FormatGenerator<string>;
  /** A minimal, admitted sample of this format, as raw bytes. */
  readonly sample: () => Buffer;
}

export const QUALIFICATION_FORMATS = {
  webp: {
    differential: webpDifferentialProfile,
    generator: webpMetadataGenerator,
    sample: metadataWebp,
  },
  png: {
    differential: pngDifferentialProfile,
    generator: pngMetadataGenerator,
    sample: metadataPng,
  },
} as const satisfies Record<NativeFormat, QualificationFormat>;

export type QualificationFormats = typeof QUALIFICATION_FORMATS;

/**
 * Runtime coverage check (KIT-01 D-28-equivalent): every currently registered
 * format must have a qualification entry, and every qualification entry must
 * correspond to a currently registered format. Either direction throws,
 * naming the offending format(s), so a registry/kit drift fails loudly
 * instead of silently qualifying nothing or qualifying a ghost format.
 */
export function assertFormatsCovered(
  registered: readonly string[],
  qualification: Readonly<Record<string, QualificationFormat>>,
): void {
  const registeredSet = new Set(registered);
  const qualifiedKeys = Object.keys(qualification);
  const qualifiedSet = new Set(qualifiedKeys);

  const missing = registered.filter((format) => !qualifiedSet.has(format));
  if (missing.length > 0) {
    throw new Error(
      `No qualification entry for registered format(s): ${missing.join(", ")}`,
    );
  }

  const unregistered = qualifiedKeys.filter(
    (format) => !registeredSet.has(format),
  );
  if (unregistered.length > 0) {
    throw new Error(
      `Qualification entry for unregistered format(s): ${unregistered.join(", ")}`,
    );
  }
}
