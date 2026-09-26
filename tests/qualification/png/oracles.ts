import { inflateSync } from "node:zlib";
import {
  PNG_CONDITIONAL_CHUNK_TYPES,
  PNG_PRESERVED_CHUNK_TYPES,
  PNG_REMOVED_CHUNK_TYPES,
} from "../../../src/admission/png-handler.js";
import { PNG_REGISTERED_CHUNK_TYPES } from "../../../src/png/chunks.js";
import { digest, type DifferentialProfile } from "../kit/oracles.js";

export const PNG_EXTENSION = ".png";

/**
 * Walks a PNG chunk stream and returns the sha256 of the first `iCCP` chunk's
 * *decompressed* profile, or undefined when no `iCCP` chunk is present.
 * ExifTool re-deflates the profile it copies back, so a byte comparison of
 * the compressed chunk would fail even when the underlying profile is
 * unchanged -- matching webpRawColorProfileSha256's own rationale.
 */
export function pngRawColorProfileSha256(input: Buffer): string | undefined {
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > input.length) return undefined;
    if (type === "iCCP") {
      const data = input.subarray(dataOffset, dataOffset + length);
      const nul = data.indexOf(0);
      if (nul < 0 || nul + 1 >= data.length) return undefined;
      const compressed = data.subarray(nul + 2);
      try {
        return digest(inflateSync(compressed));
      } catch {
        return undefined;
      }
    }
    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }
  return undefined;
}

/**
 * The exact title of the live test (png/oracles.test.ts, Plan 09) that
 * measures orientation, ICC and resolution preservation together as the
 * only permitted PNG metadata differences -- cited by the three metadata
 * kinds below, and checked for existence by a host-independent citation
 * test.
 */
export const PNG_PRESERVATION_MEASUREMENT_TITLE =
  "measures orientation, ICC and resolution preservation as the only permitted PNG metadata differences";

/**
 * The exact title of the live test (png/oracles.test.ts, Plan 09) that
 * measures the unregistered-ancillary strip as the only permitted PNG
 * structural difference.
 */
export const PNG_UNREGISTERED_STRIP_MEASUREMENT_TITLE =
  "measures unregistered private ancillary chunk removal as the only permitted PNG structural difference";

/**
 * The ExifTool family-1 group (`-G1`) a preserved resolution chunk's tags
 * report under -- measured 2026-09-25, ExifTool 13.59, `-G1 -s -a -u -n
 * -struct -json` against a metadataPng()-shaped fixture: pHYs tags
 * (`PixelsPerUnitX`, `PixelsPerUnitY`, `PixelUnits`) report as `PNG-pHYs`,
 * which `metadataGroupDisposition`'s catch-all maps to the `PNG-pHYs`
 * namespace unchanged (see 56-CONTEXT.md's "Measured facts").
 */
export const PNG_RESOLUTION_GROUP = "PNG-pHYs";

/**
 * Walks a PNG chunk stream and returns every chunk type in file order,
 * including duplicates. A test-local walker (no `src` import), so the
 * oracle's structural comparison never shares a bug with the handler's own
 * chunk parser -- the two must independently agree.
 */
export function pngStructuralParts(bytes: Buffer): readonly string[] {
  const types: string[] = [];
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    const next = offset + 8 + length + 4;
    if (next <= offset || next > bytes.length) break;
    offset = next;
    if (type === "IEND") break;
  }
  return types;
}

const LOWERCASE_FIRST_BYTE = /^[a-z]/;

/**
 * D-05's unregistered-private-ancillary eligibility predicate: a chunk type
 * whose first byte is lowercase (ancillary, per the PNG chunk-naming
 * convention) and which is not already accounted for by any of the
 * handler's own closed lists -- the preserve-list, the removed-by-default
 * list, the conditional (color/resolution) map, or the PNG extensions
 * registry itself. Anything meeting this predicate is a private, unmeasured
 * chunk type the handler strips and this kind's grant explains.
 */
export function pngAdmitsUnregisteredAncillaryPart(part: string): boolean {
  return (
    LOWERCASE_FIRST_BYTE.test(part) &&
    !PNG_REGISTERED_CHUNK_TYPES.has(part) &&
    !PNG_PRESERVED_CHUNK_TYPES.has(part) &&
    !PNG_REMOVED_CHUNK_TYPES.has(part) &&
    !PNG_CONDITIONAL_CHUNK_TYPES.has(part)
  );
}

export interface PngSanitizeOptionsForGrants {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveResolution: boolean;
  readonly preserveTimestamps: boolean;
}

/**
 * Derives sanitize preservation options from a fixture's own
 * `permittedDifferences` grants (mirrors WebP's `sanitizeOptionsForGrants`
 * in `webp/oracles.test.ts`), so granting an existing kind to one more
 * fixture is a one-line manifest data change. `preserveTimestamps` is
 * always `false` -- this kit exercises metadata/structure preservation
 * only.
 */
export function pngSanitizeOptionsForGrants(
  grants: readonly string[],
): PngSanitizeOptionsForGrants {
  return {
    preserveOrientation: grants.some((grant) =>
      grant.startsWith("EXIF:Orientation="),
    ),
    preserveColorProfile: grants.some((grant) =>
      grant.startsWith("ICC_Profile:RawProfile="),
    ),
    preserveResolution: grants.some(
      (grant) => grant === "Resolution:Preserved",
    ),
    preserveTimestamps: false,
  };
}

/**
 * The complete PNG differential profile (D-01/D-02/D-05/D-08/D-11 through
 * D-13): the closed four-kind permitted-difference list, plus the
 * structural-part extractor that lets `runExiftoolDifferential` catch the
 * D-05 unregistered-ancillary strip a metadata-only differential cannot
 * see. Plan 09 adds the live measurement tests these kinds cite.
 */
export const pngDifferentialProfile: DifferentialProfile = {
  format: "png",
  extension: PNG_EXTENSION,
  rawColorProfileSha256: pngRawColorProfileSha256,
  permittedKinds: [
    {
      id: "EXIF:Orientation",
      measurement: PNG_PRESERVATION_MEASUREMENT_TITLE,
      structuralPart: "eXIf",
    },
    {
      id: "ICC_Profile:RawProfile",
      measurement: PNG_PRESERVATION_MEASUREMENT_TITLE,
      structuralPart: "iCCP",
    },
    {
      id: "Resolution:Preserved",
      measurement: PNG_PRESERVATION_MEASUREMENT_TITLE,
      namespace: PNG_RESOLUTION_GROUP,
      structuralPart: "pHYs",
    },
    {
      id: "Structure:UnregisteredAncillaryStripped",
      measurement: PNG_UNREGISTERED_STRIP_MEASUREMENT_TITLE,
      admitsPart: pngAdmitsUnregisteredAncillaryPart,
    },
  ],
  structuralParts: pngStructuralParts,
};
