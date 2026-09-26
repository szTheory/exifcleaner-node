import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import {
  PNG_CONDITIONAL_CHUNK_TYPES,
  PNG_PRESERVED_CHUNK_TYPES,
  PNG_REMOVED_CHUNK_TYPES,
} from "../../../src/admission/png-handler.js";
import { PNG_REGISTERED_CHUNK_TYPES } from "../../../src/png/chunks.js";
import {
  digest,
  execute,
  withInput,
  type DifferentialProfile,
  type MetadataEntry,
  type MetadataProjection,
} from "../kit/oracles.js";
import type { PayloadDigest } from "../kit/corpus.js";
import {
  png,
  pngCaBX,
  pngChunk,
  pngIdat,
  pngIhdr,
  pngTextChunkData,
} from "../../fixtures.js";

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ORACLE_INPUT_BYTES = 128 * 1024 * 1024;

interface ExecutableAuthority {
  readonly path: string;
  readonly sha256: string;
}

interface PreparedOracleTools {
  readonly pngDecode: ExecutableAuthority;
  readonly pngcheck: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly prepareOracleTools: () => PreparedOracleTools;
}

let preparedTools: PreparedOracleTools | undefined;

function tools(): PreparedOracleTools {
  preparedTools ??= authorityBuilder.prepareOracleTools();
  return preparedTools;
}

process.once("exit", () => preparedTools?.dispose());

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
 * A PNG `iCCP` chunk carries its own keyword/name field (distinct from the
 * embedded ICC profile bytes `pngRawColorProfileSha256` hashes), which
 * ExifTool surfaces as `PNG:ProfileName` -- grouped under the generic `PNG`
 * namespace, not `ICC_Profile`/`ICC-header` (measured 2026-09-26, ExifTool
 * 13.59). Preserving `iCCP` byte-identical (the `ICC_Profile:RawProfile`
 * grant's own contract) therefore always reproduces this one derived `PNG`
 * tag as a side effect -- exactly the kind of container-level side effect
 * `PermittedKind.impliedDifference` exists to explain (55 D-14; mirrors
 * `webp/oracles.ts`'s `explainsRiffFlags` for the analogous WebP_Flags
 * side effect), not a reason to widen a grant or add a new kind.
 */
function explainsPngProfileName(onlyLeft: readonly MetadataEntry[]): boolean {
  if (onlyLeft.length !== 1) return false;
  const keys = Object.keys(onlyLeft[0]!);
  return keys.length === 1 && keys[0] === "ProfileName";
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
      impliedDifference: { namespace: "PNG", explains: explainsPngProfileName },
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

/**
 * Walks a PNG chunk stream and returns the concatenation of every `IDAT`
 * chunk's data bytes, in file order -- the raw, still-compressed image
 * payload libpng's own row decode is derived from. A test-local walker
 * (mirrors `pngStructuralParts`), never importing `src/png/chunks.ts`, so
 * this identity check cannot share a bug with the handler's own parser.
 */
export function pngIdatData(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > bytes.length) break;
    if (type === "IDAT")
      parts.push(bytes.subarray(dataOffset, dataOffset + length));
    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

/**
 * The PNG suite's own `payloadDigests` callback for `runQualificationCase`
 * (56-09 KIT-01 generalization, mirrors `webpPayloadDigests`): the sha256 of
 * every `IDAT` chunk's concatenated data, reported as one payload part
 * (`"IDAT"`) when the stream carries at least one `IDAT` chunk.
 */
export function pngPayloadDigests(data: Buffer): readonly PayloadDigest[] {
  const idat = pngIdatData(data);
  return idat.length === 0 ? [] : [{ part: "IDAT", sha256: digest(idat) }];
}

/**
 * A binary-safe sibling of the kit's own `execute` -- PNG row bytes are
 * arbitrary and would be corrupted by `execute`'s UTF-8 string decoding of
 * stdout (any byte sequence not valid UTF-8 is lossily replaced), which
 * would silently defeat the whole point of hashing the decoded rows. Same
 * authority-sha256 gate and process-spawn shape as the kit's `execute`,
 * differing only in the stdout encoding.
 */
function executeBinary(
  authority: ExecutableAuthority,
  args: readonly string[],
): {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
} {
  if (!SHA256.test(authority.sha256)) throw new Error("Invalid tool authority");
  const result = spawnSync(authority.path, args, {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error !== undefined) throw new Error("Oracle process failed");
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/**
 * Decodes a PNG through libpng with `PNG_TRANSFORM_IDENTITY` (no gamma, no
 * colour transform) and returns the exact IHDR line plus the sha256 of the
 * raw decoded row bytes. Throws on any oracle rejection (malformed input,
 * libpng error) or an unrecognized transcript shape.
 */
export function runPngDecodeOracle(bytes: Buffer): {
  readonly ihdr: string;
  readonly rowsSha256: string;
} {
  if (bytes.length === 0 || bytes.length > MAX_ORACLE_INPUT_BYTES)
    throw new Error("libpng oracle input outside bounds");
  return withInput(bytes, PNG_EXTENSION, (inputPath) => {
    const result = executeBinary(tools().pngDecode, [inputPath]);
    if (result.status !== 0) throw new Error("libpng oracle rejected input");
    const newline = result.stdout.indexOf(0x0a);
    if (newline < 0)
      throw new Error("libpng oracle emitted an unknown transcript");
    const ihdr = result.stdout.subarray(0, newline).toString("utf8");
    if (!ihdr.startsWith("IHDR "))
      throw new Error("libpng oracle emitted an unknown transcript");
    const rows = result.stdout.subarray(newline + 1);
    if (rows.length === 0)
      throw new Error("libpng oracle produced no decoded rows");
    return { ihdr, rowsSha256: digest(rows) };
  });
}

/**
 * Runs pngcheck's independent structural/CRC validator against the given
 * bytes. `ok` is true only when pngcheck exits 0 and its own brief summary
 * line reports `OK:` -- pngcheck's own convention for "no errors,
 * no warnings" (see pngcheck.c's `brief_OK`/`global_error` handling).
 */
export function runPngcheck(bytes: Buffer): {
  readonly ok: boolean;
  readonly summary: string;
} {
  if (bytes.length === 0 || bytes.length > MAX_ORACLE_INPUT_BYTES)
    throw new Error("pngcheck oracle input outside bounds");
  return withInput(bytes, PNG_EXTENSION, (inputPath) => {
    const result = execute(tools().pngcheck, [inputPath]);
    const summary = `${result.stdout}\n${result.stderr}`.trim().slice(0, 2_000);
    return {
      ok: result.status === 0 && /(?:^|\n)OK:/.test(result.stdout),
      summary,
    };
  });
}

/**
 * PNG-02 payload identity, proven by two independent authorities: libpng's
 * decode must be byte-identical between `source` and `output` (same IHDR,
 * same decoded row bytes -- no gamma or colour transform applied by
 * either), pngcheck must accept `output` outright, and the raw (still
 * zlib-compressed) `IDAT` payload bytes must match exactly. Any failure
 * throws with a named reason identifying which of the three independent
 * checks failed.
 */
export function assertPngPayloadIdentity(source: Buffer, output: Buffer): void {
  let sourceDecode: { readonly ihdr: string; readonly rowsSha256: string };
  let outputDecode: { readonly ihdr: string; readonly rowsSha256: string };
  try {
    sourceDecode = runPngDecodeOracle(source);
  } catch {
    throw new Error("png payload identity: libpng rejected the source");
  }
  try {
    outputDecode = runPngDecodeOracle(output);
  } catch {
    throw new Error("png payload identity: libpng rejected the output");
  }
  if (sourceDecode.ihdr !== outputDecode.ihdr)
    throw new Error("png payload identity: IHDR mismatch");
  if (sourceDecode.rowsSha256 !== outputDecode.rowsSha256)
    throw new Error("png payload identity: decoded pixel rows differ");
  const check = runPngcheck(output);
  if (!check.ok)
    throw new Error(
      `png payload identity: pngcheck rejected the output (${check.summary})`,
    );
  if (!pngIdatData(source).equals(pngIdatData(output)))
    throw new Error("png payload identity: IDAT payload bytes differ");
}

export interface SourceWarningCase {
  readonly id: string;
  readonly source: () => Buffer;
  /** The exact ExifTool warning text measured against this source (Plan 09). */
  readonly measuredWarning: string;
  /**
   * Asserts the native output carries none of this source's own leaked
   * content (the companion half of the source-warning check -- distinct per
   * case, since each source leaks a different kind of content).
   */
  readonly assertNoLeak: (projection: MetadataProjection) => void;
}

/**
 * Sources ExifTool itself warns on read (D-15's `compareStructuralDifferential`
 * plus `projectMetadata` companion check, Plan 09). `comparePermittedDifferences`
 * throws on ANY oracle warning, so a source ExifTool warns reading can never go
 * through the ordinary two-directional differential -- it is covered here
 * instead, against the `-all=` structural reference plus an assertion that the
 * native output itself carries no warning and no leaked content.
 *
 * Measured 2026-09-25/2026-09-26 (ExifTool 13.59, `-G1 -s -a -u -n -struct
 * -json`): a minimal PNG with one `tEXt` chunk placed after `IDAT`, and a
 * `caBX` (C2PA) chunk whose payload is not a well-formed JUMBF box (this
 * kit's own placeholder payload, shared with `png_classification.test.ts` --
 * the handler never parses `caBX` content (D-15), only ExifTool's own JUMBF
 * decoder does, and it warns on any payload it cannot parse as JUMBF).
 */
export const SOURCE_WARNING_CASES: readonly SourceWarningCase[] = [
  {
    id: "text-after-idat",
    source: () =>
      png([
        pngChunk("IHDR", pngIhdr()),
        pngChunk("IDAT", pngIdat()),
        pngChunk("tEXt", pngTextChunkData("Comment", "leaked-after-idat")),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    measuredWarning:
      "[minor] Text/EXIF chunk(s) found after PNG IDAT (may be ignored by some readers)",
    assertNoLeak: (projection) => {
      if ((projection.namespaces.PNG ?? []).some((entry) => "Comment" in entry))
        throw new Error("text-after-idat: native output leaked a Comment tag");
    },
  },
  {
    id: "cabx-invalid-jumbf",
    source: () =>
      png([
        pngChunk("IHDR", pngIhdr()),
        pngChunk(
          "caBX",
          pngCaBX(Buffer.from("c2pa-manifest-placeholder", "ascii")),
        ),
        pngChunk("IDAT", pngIdat()),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    measuredWarning: "Truncated JPEG 2000 box",
    assertNoLeak: (projection) => {
      if ((projection.namespaces.C2PA ?? []).length > 0)
        throw new Error("cabx-invalid-jumbf: native output leaked a C2PA tag");
    },
  },
];
