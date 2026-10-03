// AVIF ExifTool differential profile (D-27, QUA-01). Still unregistered (D-03) -- native output
// is produced only through the `setRegisteredHandlersForTests` test seam.
import { createRequire } from "node:module";
import {
  isobmffPayloadDigests,
  isobmffRawColorProfileSha256,
  isobmffStructuralParts,
  type IsobmffPermittedDifference,
} from "../../isobmff-support/differential.js";
import type { DifferentialProfile } from "../kit/oracles.js";

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;

interface PreparedOracleTools {
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly loadOrPrepareOracleTools: () => PreparedOracleTools;
}

let preparedTools: PreparedOracleTools | undefined;

/** AVIF needs no format-specific oracle executable beyond the shared ExifTool authority
 * `tests/isobmff-support/differential.ts` already drives via `kit/oracles.ts`'s own internal
 * loader -- but KIT-09 D-04 requires every `oracles.ts` module to route through the one cached
 * `loadOrPrepareOracleTools()` loader itself (never the raw per-process builder directly), so a
 * per-process rebuild is never triggered twice across formats. `oracles.test.ts`'s live legs
 * call this once before producing a native output, to fail fast on a missing/broken authority
 * rather than inside the differential itself. */
function tools(): PreparedOracleTools {
  preparedTools ??= authorityBuilder.loadOrPrepareOracleTools();
  return preparedTools;
}

process.once("exit", () => preparedTools?.dispose());

export function assertAvifOracleToolsAvailable(): void {
  tools();
}

export const AVIF_EXTENSION = ".avif";

/**
 * The exact titles of the live tests (this directory's own `oracles.test.ts`) that measure each
 * D-27 entry, checked for existence by this file's own citation test.
 */
export const AVIF_EMPTIED_METADATA_MEASUREMENT_TITLE =
  "measures emptied Exif/XMP metadata entries as the only permitted AVIF structural difference (62.1-05)";
export const AVIF_ICC_NOT_PRESERVING_MEASUREMENT_TITLE =
  "measures ExifTool keeping ICC when not preserving as a permitted AVIF difference (62.1-05)";
export const AVIF_YCBCR_POSITIONING_MEASUREMENT_TITLE =
  "measures ExifTool's minimal-Exif YCbCrPositioning companion as a permitted AVIF difference (62.1-05)";
export const AVIF_BYTE_LAYOUT_MEASUREMENT_TITLE =
  "sanitizes heif-enc-grid.avif through the seam with default settings and passes the ExifTool differential (62.1-05)";
export const AVIF_FREE_SKIP_MEASUREMENT_TITLE =
  "measures ExifTool keeping top-level free/skip as a permitted AVIF difference (62.1-05)";

/**
 * The closed, five-entry AVIF permitted-difference list (D-27, D-15) -- same ids as HEIC's own
 * list (D-27 measured both brands identically), each cited to this file's own live tests. Never
 * widened, never reordered to add a sixth entry.
 */
export const AVIF_PERMITTED_DIFFERENCES: readonly IsobmffPermittedDifference[] =
  [
    {
      id: "exiftool-keeps-emptied-metadata-entries",
      measurement: AVIF_EMPTIED_METADATA_MEASUREMENT_TITLE,
      docsHeading: "### Measured structural effect of `exiftool -all=`",
    },
    {
      id: "exiftool-keeps-icc-when-not-preserving",
      measurement: AVIF_ICC_NOT_PRESERVING_MEASUREMENT_TITLE,
      docsHeading: "### Measured structural effect of `exiftool -all=`",
    },
    {
      id: "exiftool-minimal-exif-ycbcr-positioning",
      measurement: AVIF_YCBCR_POSITIONING_MEASUREMENT_TITLE,
      docsHeading:
        "### ExifTool 13.59 minimal-Exif YCbCrPositioning companion (62.1-05)",
    },
    {
      id: "byte-layout-differs",
      measurement: AVIF_BYTE_LAYOUT_MEASUREMENT_TITLE,
      docsHeading: "### ExifTool 13.59 minimal-Exif placement",
    },
    {
      id: "exiftool-keeps-free-skip",
      measurement: AVIF_FREE_SKIP_MEASUREMENT_TITLE,
      docsHeading: "### ExifTool and top-level free/skip",
    },
  ];

/**
 * The one ExifTool unknown tag AVIF admits (maintainer decision, 2026-10-03, option A).
 * ExifTool 13.59 QuickTime.pm:2910-2912 decodes a top-level-meta `idat` as `MetaImageSize`
 * only when FileType is HEIC, so in AVIF the same 8-byte grid descriptor surfaces as this
 * unknown tag. Admitted by exact key only, and only when its value is identical in source,
 * native and reference (`compareAdmittedUnknownTags`); the grid bytes themselves stay
 * covered by `compareIsobmffPayloadDigests`. Any other unknown tag still fails closed.
 */
export const AVIF_ADMITTED_UNKNOWN_IDAT_TAG = "Meta:Unknown_idat";

export const avifDifferentialProfile: DifferentialProfile = {
  format: "avif",
  extension: AVIF_EXTENSION,
  rawColorProfileSha256: isobmffRawColorProfileSha256,
  permittedKinds: [],
  structuralParts: isobmffStructuralParts,
  admittedUnknownTags: [AVIF_ADMITTED_UNKNOWN_IDAT_TAG],
};

export const avifPayloadDigests = isobmffPayloadDigests;
