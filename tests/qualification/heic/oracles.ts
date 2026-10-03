// HEIC ExifTool differential profile (D-27, QUA-01). Still unregistered (D-03) -- native output
// is produced only through the `setRegisteredHandlersForTests` test seam.
import {
  isobmffPayloadDigests,
  isobmffRawColorProfileSha256,
  isobmffStructuralParts,
  type IsobmffPermittedDifference,
} from "../../isobmff-support/differential.js";
import type { DifferentialProfile } from "../kit/oracles.js";

export const HEIC_EXTENSION = ".heic";

/**
 * The exact titles of the live tests (this directory's own `oracles.test.ts`) that measure each
 * D-27 entry, checked for existence by this file's own citation test.
 */
export const HEIC_EMPTIED_METADATA_MEASUREMENT_TITLE =
  "measures emptied Exif/XMP metadata entries as the only permitted HEIC structural difference (62.1-05)";
export const HEIC_ICC_NOT_PRESERVING_MEASUREMENT_TITLE =
  "measures ExifTool keeping ICC when not preserving as a permitted HEIC difference (62.1-05)";
export const HEIC_YCBCR_POSITIONING_MEASUREMENT_TITLE =
  "measures ExifTool's minimal-Exif YCbCrPositioning companion as a permitted HEIC difference (62.1-05)";
export const HEIC_BYTE_LAYOUT_MEASUREMENT_TITLE =
  "sanitizes heif-enc-grid.heic through the seam with default settings and passes the ExifTool differential (62.1-05)";
export const HEIC_FREE_SKIP_MEASUREMENT_TITLE =
  "measures ExifTool keeping top-level free/skip as a permitted HEIC difference (62.1-05)";

/**
 * The closed, five-entry HEIC permitted-difference list (D-27, D-15). Never widened, never
 * reordered to add a sixth entry -- a measured difference outside this list is a stop condition
 * for a maintainer decision, not something this list may absorb.
 */
export const HEIC_PERMITTED_DIFFERENCES: readonly IsobmffPermittedDifference[] =
  [
    {
      id: "exiftool-keeps-emptied-metadata-entries",
      measurement: HEIC_EMPTIED_METADATA_MEASUREMENT_TITLE,
      docsHeading: "### Measured structural effect of `exiftool -all=`",
    },
    {
      id: "exiftool-keeps-icc-when-not-preserving",
      measurement: HEIC_ICC_NOT_PRESERVING_MEASUREMENT_TITLE,
      docsHeading: "### Measured structural effect of `exiftool -all=`",
    },
    {
      id: "exiftool-minimal-exif-ycbcr-positioning",
      measurement: HEIC_YCBCR_POSITIONING_MEASUREMENT_TITLE,
      docsHeading:
        "### ExifTool 13.59 minimal-Exif YCbCrPositioning companion (62.1-05)",
    },
    {
      id: "byte-layout-differs",
      measurement: HEIC_BYTE_LAYOUT_MEASUREMENT_TITLE,
      docsHeading: "### ExifTool 13.59 minimal-Exif placement",
    },
    {
      id: "exiftool-keeps-free-skip",
      measurement: HEIC_FREE_SKIP_MEASUREMENT_TITLE,
      docsHeading: "### ExifTool and top-level free/skip",
    },
  ];

export const heicDifferentialProfile: DifferentialProfile = {
  format: "heic",
  extension: HEIC_EXTENSION,
  rawColorProfileSha256: isobmffRawColorProfileSha256,
  permittedKinds: [],
  structuralParts: isobmffStructuralParts,
};

export const heicPayloadDigests = isobmffPayloadDigests;
