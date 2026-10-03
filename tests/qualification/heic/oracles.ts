// HEIC ExifTool differential profile (D-27, QUA-01). Registered since 62.1-07: the corpus legs
// sanitize through the registered engine; the 62.1-05 synthetic legs still build their output
// through the `setRegisteredHandlersForTests` test seam.
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

/** HEIC needs no format-specific oracle executable beyond the shared ExifTool authority
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

export function assertHeicOracleToolsAvailable(): void {
  tools();
}

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

export const HEIC_AUXILIARY_ITEM_XMP_MEASUREMENT_TITLE =
  "measures ExifTool keeping the iPhone gain-map auxiliary item's XMP as a permitted HEIC difference (62.1-09)";

/**
 * The closed HEIC permitted-difference list (D-27, D-15): the five measured entries plus a sixth,
 * `exiftool-keeps-auxiliary-item-xmp`, admitted by maintainer decision on 2026-10-03 (62.1-09)
 * for the iPhone sample only. Never widened further without a maintainer decision -- a measured
 * difference outside this list is a stop condition, not something this list may absorb.
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
    {
      id: "exiftool-keeps-auxiliary-item-xmp",
      measurement: HEIC_AUXILIARY_ITEM_XMP_MEASUREMENT_TITLE,
      docsHeading:
        "### ExifTool 13.59 keeps the gain-map auxiliary item's XMP (62.1-09)",
    },
  ];

/**
 * The three ExifTool unknown tags HEIC admits (maintainer decision 2026-10-03, 62.1-09), measured
 * on the curated Nokia conformance records: ExifTool 13.59 reports their `ster`, `base` and
 * top-level-meta `idat` boxes without a tag name. Admitted by
 * exact key only, and only when the tag's raw bytes are identical in source, native and
 * reference: `kit/oracles.ts` reads every instance back with `-b` and compares per-instance
 * sha256 digests (`admittedUnknownTagBytes`, `compareAdmittedUnknownTags`), never ExifTool's
 * length-only "(Binary data N bytes ...)" text -- so a same-length change to a `ster`/`base`
 * entity group (62.1-REVIEW-INDEPENDENT WR-03) still differs. Any other unknown tag still fails
 * closed.
 */
export const HEIC_ADMITTED_UNKNOWN_TAGS: readonly string[] = [
  "QuickTime:Unknown_ster",
  "QuickTime:Unknown_base",
  "Meta:Unknown_idat",
];

/** A preservation setting the corpus legs run. */
export type HeicCorpusSetting = "default" | "all-false";

/**
 * Corpus records whose default-settings native outcome is a measured fail-safe refusal rather
 * than an output (maintainer decision 2026-10-03, 62.1-09). The record stays in scope: the
 * refusal itself is asserted exactly, and every other setting still runs the full oracles.
 */
export const HEIC_DEFAULT_SETTINGS_REFUSALS: Readonly<
  Record<
    string,
    {
      readonly code: string;
      readonly feature: string;
      readonly detail: string;
    }
  >
> = {
  "nokia-heif-conformance-c034": {
    code: "unsupported-feature",
    feature: "orientation-preservation",
    detail: "EXIF TIFF header is truncated",
  },
};

/**
 * Exact source-side ExifTool warnings admitted for one record and one setting only (maintainer
 * decision 2026-10-03, 62.1-09). Reading c034's source Exif item, ExifTool warns `Missing Exif
 * header` (measured); native's all-flags-false output and the `-all=` reference never warn.
 */
const HEIC_ADMITTED_SOURCE_WARNINGS: Readonly<
  Record<string, Partial<Record<HeicCorpusSetting, readonly string[]>>>
> = {
  "nokia-heif-conformance-c034": { "all-false": ["Missing Exif header"] },
};

/** The exact source warnings `recordId` admits under `setting` (none unless listed above). */
export function heicAdmittedSourceWarnings(
  recordId: string,
  setting: HeicCorpusSetting,
): readonly string[] {
  return HEIC_ADMITTED_SOURCE_WARNINGS[recordId]?.[setting] ?? [];
}

export const heicDifferentialProfile: DifferentialProfile = {
  format: "heic",
  extension: HEIC_EXTENSION,
  rawColorProfileSha256: isobmffRawColorProfileSha256,
  permittedKinds: [],
  structuralParts: isobmffStructuralParts,
  admittedUnknownTags: HEIC_ADMITTED_UNKNOWN_TAGS,
};

export const heicPayloadDigests = isobmffPayloadDigests;
