// The avif qualification generator (62.1-06, QUA-03). One generator per format: every sample is a
// non-hazard `isobmffArmSampleArbitrary("avif")` draw, so its ftyp classifies avif (IN-01) and it
// carries a planted Exif and XMP canary. Not wired into `QUALIFICATION_FORMATS` until 62.1-07.
import type fc from "fast-check";
import type { FormatGenerator, GeneratedSample } from "../kit/generators.js";
import {
  isobmffArmSampleArbitrary,
  type IsobmffMetadataKind,
} from "../../isobmff-support/generator.js";

const METADATA_KINDS: readonly IsobmffMetadataKind[] = ["EXIF", "XMP"];

export const avifMetadataGenerator: FormatGenerator<IsobmffMetadataKind> =
  Object.freeze({
    format: "avif",
    metadataKinds: Object.freeze(METADATA_KINDS),
    arbitrary: (): fc.Arbitrary<GeneratedSample<IsobmffMetadataKind>> =>
      isobmffArmSampleArbitrary("avif")
        .filter((armSample) => !armSample.arms.includes("hazard"))
        .map((armSample) => armSample.sample),
  });
