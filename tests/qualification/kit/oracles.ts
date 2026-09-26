import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

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
  readonly authority: {
    readonly authorities: readonly {
      readonly id: string;
      readonly version: string;
      readonly revision: string;
      readonly archiveSha256: string;
    }[];
  };
  readonly exiftool: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly prepareOracleTools: () => PreparedOracleTools;
}

export type MetadataEntry = Readonly<Record<string, unknown>>;

export interface MetadataProjection {
  readonly warnings: readonly string[];
  readonly namespaces: Readonly<Record<string, readonly MetadataEntry[]>>;
  readonly rawIccSha256?: string;
}

export interface MetadataTranscript {
  readonly version: 1;
  readonly caseId: string;
  readonly authority: {
    readonly exiftoolRevision: string;
    readonly archiveSha256: string;
    readonly artifactSha256: string;
  };
  readonly source: MetadataProjection;
  readonly output: MetadataProjection;
  readonly reference: MetadataProjection;
  readonly permittedDifferences: readonly string[];
  readonly equivalent: true;
}

/**
 * A permitted-difference kind. `id` is a closed, code-defined enum (not free text) --
 * see `compareDifferential`'s grant parser -- and `measurement` names the exact test
 * title in the format's own oracles.test.ts that measures this kind, so a citation
 * pointing at a nonexistent test fails a dedicated check rather than going unnoticed.
 *
 * `impliedDifference` is optional, format-neutral coverage for a *derived* tag that a
 * format's own container structure forces to differ as a side effect of this same
 * grant -- for example, a container-level flags value that changes because a
 * preservation flag stayed on. The kit never names the implied namespace or tag
 * itself; the profile supplies both, and `explains` decides -- given only the
 * native-only entries in that namespace and the set of grant kinds active in this
 * differential run -- whether the observed delta is exactly what this grant (plus
 * whichever other active grants also declare that namespace) would produce. An
 * implied difference that does not explain the observed delta falls through to the
 * ordinary leak/over-strip failure, so a mismatched implied-tag value still fails.
 */
export interface PermittedKind {
  readonly id:
    | "EXIF:Orientation"
    | "ICC_Profile:RawProfile"
    | "Resolution:Preserved"
    | "Structure:UnregisteredAncillaryStripped";
  readonly measurement: string;
  readonly impliedDifference?: {
    readonly namespace: string;
    readonly explains: (
      onlyLeft: readonly MetadataEntry[],
      activeKindIds: readonly PermittedKind["id"][],
    ) => boolean;
  };
  /**
   * Profile-supplied only. For `Resolution:Preserved`, the ExifTool group
   * (namespace) this kind's metadata lives under -- the kit itself names no
   * format, so a format's own oracles.ts supplies the concrete group.
   */
  readonly namespace?: string;
  /**
   * Profile-supplied only. For a kind whose grant also explains a native-only
   * *container* part (as opposed to a metadata tag), the part name this kind
   * declares -- consumed by `compareStructuralDifferential`, never by the
   * metadata-only comparisons.
   */
  readonly structuralPart?: string;
  /**
   * Profile-supplied only. For `Structure:UnregisteredAncillaryStripped`, the
   * eligibility predicate deciding whether a reference-only container part
   * may be explained by this kind's grant.
   */
  readonly admitsPart?: (part: string) => boolean;
}

/**
 * Per-format parameters the kit needs to run a two-directional ExifTool differential:
 * a name/extension for temp-file materialization, a raw-color-profile digest callback
 * (mirrors the one `runMetadata` already takes), and the closed set of permitted-
 * difference kinds this format admits.
 */
export interface DifferentialProfile {
  readonly format: string;
  readonly extension: string;
  readonly rawColorProfileSha256: (bytes: Buffer) => string | undefined;
  readonly permittedKinds: readonly PermittedKind[];
  /**
   * Optional, profile-supplied structural part extractor for a container
   * whose ExifTool differential alone cannot see every permitted difference
   * -- for example a stripped part ExifTool never reports as metadata. When
   * present, `runExiftoolDifferential` also runs
   * `compareStructuralDifferential` against `structuralParts(output)` and
   * `structuralParts(reference)`. A format that omits it keeps its existing
   * differential behaviour unchanged.
   */
  readonly structuralParts?: (bytes: Buffer) => readonly string[];
}

export interface ExiftoolDifferentialOptions {
  readonly caseId: string;
  readonly profile: DifferentialProfile;
  readonly source: Buffer;
  readonly output: Buffer;
  readonly permittedDifferences: readonly string[];
}

let preparedTools: PreparedOracleTools | undefined;

function tools(): PreparedOracleTools {
  preparedTools ??= authorityBuilder.prepareOracleTools();
  return preparedTools;
}

process.once("exit", () => preparedTools?.dispose());

export function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateInput(caseId: string, bytes: Buffer): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(caseId))
    throw new Error("Invalid oracle case ID");
  if (bytes.length === 0 || bytes.length > MAX_ORACLE_INPUT_BYTES)
    throw new Error(`Oracle input outside bounds: ${caseId}`);
}

export function withInput<T>(
  bytes: Buffer,
  extension: string,
  operation: (path: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-input-"));
  const inputPath = join(directory, `input${extension}`);
  try {
    writeFileSync(inputPath, bytes, { flag: "wx" });
    return operation(inputPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function execute(
  authority: ExecutableAuthority,
  args: readonly string[],
): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  if (!SHA256.test(authority.sha256)) throw new Error("Invalid tool authority");
  const result = spawnSync(authority.path, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error !== undefined) throw new Error("Oracle process failed");
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const EXIF_GROUP_PATTERN =
  /^(?:IFD\d*|ExifIFD|GPS|InteropIFD|SubIFD|MakerNotes)$/;

/**
 * Groups measured (2026-09-24, ExifTool 13.59, `-G1 -s -a -u -n -struct -json`
 * against three real fixtures plus their native-sanitized and `-all=`-reference
 * projections; see the Plan 04 SUMMARY for the full per-fixture group list) as
 * file-system/tool-volatile or derived, never removable file content:
 * - `ExifTool`: tool version only (`ExifToolVersion`) -- tool-volatile.
 * - `System`: filesystem path/date/permission tags (`FileName`, `Directory`, `FileSize`,
 *   `FileModifyDate`, `FileAccessDate`, `FileInodeChangeDate`, `FilePermissions`) --
 *   host/filesystem-volatile, never part of the file's own bytes.
 * - `File`: container-identity tags ExifTool synthesizes from the bytes it just read
 *   (`FileType`, `FileTypeExtension`, `MIMEType`, container byte-order) -- derived,
 *   not removable metadata.
 * - `Composite`: ExifTool-computed values (`ImageSize`, `Megapixels`) derived from
 *   pixel dimensions, never removable metadata.
 *
 * Every other measured group is compared, deliberately including each format's own
 * container-structure group: a structural group's real differences are exactly what
 * D-12/KIT-04 exist to surface, not hide, by comparing it under its own name via the
 * catch-all rule below. This kit stays free of any single format's vocabulary (see the
 * token-clean acceptance criterion) -- format-specific evidence lives in the per-plan
 * SUMMARY, never as a named exception in this exclude set.
 */
export const EXCLUDED_GROUPS: ReadonlySet<string> = Object.freeze(
  new Set(["ExifTool", "System", "File", "Composite"]),
);

export function metadataGroupDisposition(
  group: string,
):
  | { readonly compared: false }
  | { readonly compared: true; readonly namespace: string } {
  if (EXCLUDED_GROUPS.has(group)) return { compared: false };
  if (EXIF_GROUP_PATTERN.test(group))
    return { compared: true, namespace: "EXIF" };
  if (group === "XMP" || group.startsWith("XMP-"))
    return { compared: true, namespace: "XMP" };
  if (group === "ICC_Profile" || group.startsWith("ICC-"))
    return { compared: true, namespace: "ICC_Profile" };
  return { compared: true, namespace: group };
}

function runMetadata(
  input: Buffer,
  extension: string,
  rawColorProfileSha256: (bytes: Buffer) => string | undefined,
): MetadataProjection {
  return withInput(input, extension, (inputPath) => {
    const result = execute(tools().exiftool, [
      "-G1",
      "-s",
      "-a",
      "-u",
      "-n",
      "-struct",
      "-json",
      inputPath,
    ]);
    if (result.status !== 0) throw new Error("ExifTool oracle rejected input");
    const parsed = JSON.parse(result.stdout) as readonly Record<
      string,
      unknown
    >[];
    if (!Array.isArray(parsed) || parsed.length !== 1)
      throw new Error("ExifTool oracle emitted an unknown transcript");
    const namespaces: Record<string, MetadataEntry[]> = {
      EXIF: [],
      XMP: [],
      ICC_Profile: [],
    };
    const warnings: string[] = [];
    for (const [key, value] of Object.entries(parsed[0]!)) {
      // ExifTool always injects this pseudo-field (the input path) alongside every
      // -G1 group tag; it is not a metadata group and would otherwise land in its
      // own catch-all namespace and differ on every run (temp-directory paths).
      if (key === "SourceFile") continue;
      const [group = "", tag = ""] = key.split(":", 2);
      if (/warning|error/i.test(tag))
        warnings.push(String(value).slice(0, 256));
      if (/unknown/i.test(tag))
        throw new Error("ExifTool oracle found an unknown tag");
      const disposition = metadataGroupDisposition(group);
      if (disposition.compared)
        (namespaces[disposition.namespace] ??= []).push({ [tag]: value });
    }
    for (const values of Object.values(namespaces))
      values.sort((left, right) =>
        canonical(left).localeCompare(canonical(right)),
      );
    const rawIccSha256 = rawColorProfileSha256(input);
    return {
      warnings,
      namespaces,
      ...(rawIccSha256 === undefined ? {} : { rawIccSha256 }),
    };
  });
}

/**
 * A named, single-file metadata projection for a format whose own source
 * ExifTool warns on read (measured: a format's own text chunk placed after
 * its own image data) -- `runMetadata`'s
 * warning rule only ever applies inside `runExiftoolDifferential`'s
 * two-projection comparison, so a format needing to project exactly one file
 * on its own calls this instead of going around `validateInput`.
 */
export function projectMetadata(
  bytes: Buffer,
  profile: DifferentialProfile,
): MetadataProjection {
  validateInput(profile.format, bytes);
  return runMetadata(bytes, profile.extension, profile.rawColorProfileSha256);
}

function tagValues(entries: readonly MetadataEntry[], tag: string): unknown[] {
  return entries.flatMap((entry) =>
    Object.entries(entry)
      .filter(([key]) => key === tag)
      .map(([, value]) => value),
  );
}

export function comparePermittedDifferences(
  source: MetadataProjection,
  output: MetadataProjection,
  permittedDifferences: readonly string[],
  kinds: readonly PermittedKind[] = [],
): readonly string[] {
  if (source.warnings.length > 0 || output.warnings.length > 0)
    throw new Error("Oracle warning is not permitted");
  let expectedOrientation: number | undefined;
  let expectedIcc: string | undefined;
  let resolutionGranted = false;
  for (const item of permittedDifferences) {
    const orientation = item.match(/^EXIF:Orientation=([1-8])$/);
    const icc = item.match(/^ICC_Profile:RawProfile=([a-f0-9]{64})$/);
    const structure =
      /^Structure:UnregisteredAncillaryStripped=[A-Za-z0-9 ]{1,16}$/.test(item);
    if (orientation !== null) expectedOrientation = Number(orientation[1]);
    else if (icc !== null) expectedIcc = icc[1];
    else if (item === "Resolution:Preserved") resolutionGranted = true;
    // A Structure:UnregisteredAncillaryStripped grant has no metadata
    // assertion here -- it is checked only by compareStructuralDifferential.
    else if (!structure)
      throw new Error("Unknown permitted metadata difference");
  }

  const sourceExif = source.namespaces.EXIF ?? [];
  const outputExif = output.namespaces.EXIF ?? [];
  const outputXmp = output.namespaces.XMP ?? [];
  const sourceIcc = source.namespaces.ICC_Profile ?? [];
  const outputIcc = output.namespaces.ICC_Profile ?? [];

  if (outputXmp.length > 0)
    throw new Error("Unpermitted metadata difference: XMP");
  if (expectedOrientation === undefined) {
    if (outputExif.length > 0)
      throw new Error("Unpermitted metadata difference: EXIF");
  } else {
    const sourceOrientations = tagValues(sourceExif, "Orientation");
    const outputOrientations = tagValues(outputExif, "Orientation");
    if (
      sourceOrientations.every((value) => value !== expectedOrientation) ||
      outputOrientations.length !== 1 ||
      outputOrientations[0] !== expectedOrientation
    )
      throw new Error("Requested Orientation was not preserved");
    if (
      outputExif.some((entry) =>
        Object.keys(entry).some((tag) => tag !== "Orientation"),
      )
    )
      throw new Error("Unpermitted metadata difference: EXIF");
  }

  if (expectedIcc === undefined) {
    if (outputIcc.length > 0 || output.rawIccSha256 !== undefined)
      throw new Error("Unpermitted metadata difference: ICC_Profile");
  } else if (
    source.rawIccSha256 !== expectedIcc ||
    output.rawIccSha256 !== expectedIcc ||
    canonical(sourceIcc) !== canonical(outputIcc)
  )
    throw new Error("Requested ICC profile was not preserved");

  if (resolutionGranted) {
    const resolutionKind = kinds.find(
      (kind) => kind.id === "Resolution:Preserved",
    );
    if (resolutionKind?.namespace === undefined)
      throw new Error("Unknown permitted metadata difference");
    const namespace = resolutionKind.namespace;
    const sourceEntries = source.namespaces[namespace] ?? [];
    const outputEntries = output.namespaces[namespace] ?? [];
    const { onlyLeft, onlyRight } = multisetDiff(sourceEntries, outputEntries);
    if (
      sourceEntries.length === 0 ||
      onlyLeft.length > 0 ||
      onlyRight.length > 0
    )
      throw new Error("Requested resolution was not preserved");
  }

  return [];
}

type ParsedGrantKind =
  | "EXIF:Orientation"
  | "ICC_Profile:RawProfile"
  | "Resolution:Preserved"
  | "Structure:UnregisteredAncillaryStripped";

interface ParsedGrant {
  readonly kind: ParsedGrantKind;
  readonly value: string;
}

function parseGrant(item: string): ParsedGrant {
  const orientation = item.match(/^EXIF:Orientation=([1-8])$/);
  if (orientation !== null)
    return { kind: "EXIF:Orientation", value: orientation[1]! };
  const icc = item.match(/^ICC_Profile:RawProfile=([a-f0-9]{64})$/);
  if (icc !== null) return { kind: "ICC_Profile:RawProfile", value: icc[1]! };
  if (item === "Resolution:Preserved")
    return { kind: "Resolution:Preserved", value: "" };
  const structure = item.match(
    /^Structure:UnregisteredAncillaryStripped=([A-Za-z0-9 ]{1,16})$/,
  );
  if (structure !== null)
    return {
      kind: "Structure:UnregisteredAncillaryStripped",
      value: structure[1]!,
    };
  throw new Error("Unknown permitted metadata difference");
}

/**
 * Order-insensitive multiset difference between two entry arrays, keyed by each
 * entry's canonical JSON form. `onlyLeft` holds entries present in `left` with no
 * matching entry left in `right` (and vice versa for `onlyRight`); a duplicate entry
 * on one side without a matching duplicate on the other counts once per unmatched
 * occurrence.
 */
function multisetDiff(
  left: readonly MetadataEntry[],
  right: readonly MetadataEntry[],
): {
  readonly onlyLeft: readonly MetadataEntry[];
  readonly onlyRight: readonly MetadataEntry[];
} {
  const remainingRight = right.map((entry) => canonical(entry));
  const onlyLeft: MetadataEntry[] = [];
  for (const entry of left) {
    const index = remainingRight.indexOf(canonical(entry));
    if (index === -1) onlyLeft.push(entry);
    else remainingRight.splice(index, 1);
  }
  const remainingLeft = left.map((entry) => canonical(entry));
  const onlyRight: MetadataEntry[] = [];
  for (const entry of right) {
    const index = remainingLeft.indexOf(canonical(entry));
    if (index === -1) onlyRight.push(entry);
    else remainingLeft.splice(index, 1);
  }
  return { onlyLeft, onlyRight };
}

/**
 * The generic, two-directional differential (D-10, D-12): every namespace present in
 * `native` or `reference` is compared as an order-insensitive multiset. A tag `native`
 * has that `reference` lacks is a leak; a tag `reference` keeps that `native` lacks is
 * an over-strip -- both fail unless a declared, code-defined `grants` kind explains the
 * exact delta. A grant naming a kind outside `kinds` is rejected outright, and a grant
 * that explains no actual delta is rejected as stale.
 *
 * A grant is explained ONLY by an observed delta in its own namespace (EXIF for
 * EXIF:Orientation, ICC_Profile for ICC_Profile:RawProfile). An `impliedDifference`
 * delta in a derived namespace (for example a container-level flags value) never
 * explains a grant by itself -- it is additional coverage for a side effect the same
 * grant also produces, not a substitute for the grant's own delta. The EXIF branch
 * also requires `source` to actually carry the granted Orientation value before
 * accepting a native delta as explained. This function is fail-closed on its own,
 * regardless of what runs before it -- WR-01: callers must not rely on
 * `comparePermittedDifferences` having already screened the same grant.
 */
export function compareDifferential(
  source: MetadataProjection,
  native: MetadataProjection,
  reference: MetadataProjection,
  grants: readonly string[],
  kinds: readonly PermittedKind[],
): readonly string[] {
  const kindById = new Map(kinds.map((kind) => [kind.id, kind] as const));
  const parsedGrants = grants.map(parseGrant);
  for (const grant of parsedGrants)
    if (!kindById.has(grant.kind))
      throw new Error("Unknown permitted metadata difference");

  const orientationGrant = parsedGrants.find(
    (grant) => grant.kind === "EXIF:Orientation",
  );
  const iccGrant = parsedGrants.find(
    (grant) => grant.kind === "ICC_Profile:RawProfile",
  );
  const resolutionGrant = parsedGrants.find(
    (grant) => grant.kind === "Resolution:Preserved",
  );
  const resolutionKind = kindById.get("Resolution:Preserved");
  let orientationExplainedDelta = false;
  let iccExplainedDelta = false;
  let resolutionExplainedDelta = false;
  const activeKindIds = parsedGrants.map((grant) => grant.kind);

  const namespaceNames = new Set([
    ...Object.keys(native.namespaces),
    ...Object.keys(reference.namespaces),
  ]);

  for (const namespace of namespaceNames) {
    const nativeEntries = native.namespaces[namespace] ?? [];
    const referenceEntries = reference.namespaces[namespace] ?? [];
    const { onlyLeft, onlyRight } = multisetDiff(
      nativeEntries,
      referenceEntries,
    );
    if (onlyLeft.length === 0 && onlyRight.length === 0) continue;

    if (namespace === "EXIF" && orientationGrant !== undefined) {
      const expected = Number(orientationGrant.value);
      // prettier-ignore
      const sourceOrientations = tagValues(source.namespaces.EXIF ?? [], "Orientation");
      if (!sourceOrientations.includes(expected))
        throw new Error("Requested Orientation was not preserved");
      const grantedEntry = onlyLeft[0];
      if (
        onlyRight.length === 0 &&
        onlyLeft.length === 1 &&
        grantedEntry !== undefined &&
        Object.keys(grantedEntry).length === 1 &&
        grantedEntry.Orientation === expected
      ) {
        orientationExplainedDelta = true;
        continue;
      }
      throw new Error("Requested Orientation was not preserved");
    }

    if (namespace === "ICC_Profile" && iccGrant !== undefined) {
      const sourceEntries = source.namespaces.ICC_Profile ?? [];
      const sourceDiff = multisetDiff(nativeEntries, sourceEntries);
      if (
        source.rawIccSha256 === iccGrant.value &&
        native.rawIccSha256 === iccGrant.value &&
        sourceDiff.onlyLeft.length === 0 &&
        sourceDiff.onlyRight.length === 0
      ) {
        iccExplainedDelta = true;
        continue;
      }
      throw new Error("Requested ICC profile was not preserved");
    }

    if (
      resolutionGrant !== undefined &&
      resolutionKind?.namespace !== undefined &&
      namespace === resolutionKind.namespace
    ) {
      const sourceEntries = source.namespaces[namespace] ?? [];
      const sourceDiff = multisetDiff(nativeEntries, sourceEntries);
      if (
        sourceEntries.length > 0 &&
        sourceDiff.onlyLeft.length === 0 &&
        sourceDiff.onlyRight.length === 0 &&
        referenceEntries.length === 0
      ) {
        resolutionExplainedDelta = true;
        continue;
      }
      throw new Error("Requested resolution was not preserved");
    }

    const impliedKinds = parsedGrants
      .map((grant) => kindById.get(grant.kind))
      .filter(
        (kind): kind is PermittedKind =>
          kind?.impliedDifference?.namespace === namespace,
      );
    if (
      impliedKinds.length > 0 &&
      onlyRight.length === 0 &&
      impliedKinds.every((kind) =>
        kind.impliedDifference!.explains(onlyLeft, activeKindIds),
      )
    ) {
      continue;
    }

    if (onlyLeft.length > 0)
      throw new Error(`Unpermitted metadata difference: ${namespace}`);
    throw new Error(`Over-strip: ${namespace}`);
  }

  if (orientationGrant !== undefined && !orientationExplainedDelta)
    throw new Error("Stale permitted difference: EXIF:Orientation");
  if (iccGrant !== undefined && !iccExplainedDelta)
    throw new Error("Stale permitted difference: ICC_Profile:RawProfile");
  if (resolutionGrant !== undefined && !resolutionExplainedDelta)
    throw new Error("Stale permitted difference: Resolution:Preserved");

  return [];
}

/**
 * A structural differential (D-12/KIT-04's metadata-only comparison has no
 * visibility into a container part ExifTool never reports as metadata --
 * for example a stripped unregistered ancillary chunk). Compares two
 * container-part multisets, order-insensitively:
 *
 * - A part `nativeParts` has that `referenceParts` lacks (native-only) is
 *   explained ONLY by an active grant whose declared kind carries a matching
 *   `structuralPart` -- any admitted kind, not only a structural-strip kind,
 *   since a preservation grant (for example a resolution or orientation
 *   grant) can itself be the reason a part survives natively that the
 *   reference lacks.
 * - A part `referenceParts` keeps that `nativeParts` lacks (reference-only)
 *   is explained ONLY by an active `Structure:UnregisteredAncillaryStripped`
 *   grant naming that exact part, whose kind's `admitsPart(part)` returns
 *   true. One such grant explains every reference-only occurrence of that
 *   same part type.
 * - A `Structure:UnregisteredAncillaryStripped` grant that explains no
 *   observed reference-only occurrence is stale and throws, exactly like the
 *   metadata-only differential's stale-grant rule.
 *
 * Fail-closed on its own, mirroring `compareDifferential`: a grant naming a
 * kind outside `kinds` is rejected outright before any comparison runs.
 */
export function compareStructuralDifferential(
  nativeParts: readonly string[],
  referenceParts: readonly string[],
  grants: readonly string[],
  kinds: readonly PermittedKind[],
): readonly string[] {
  const kindById = new Map(kinds.map((kind) => [kind.id, kind] as const));
  const parsedGrants = grants.map(parseGrant);
  for (const grant of parsedGrants)
    if (!kindById.has(grant.kind))
      throw new Error("Unknown permitted metadata difference");

  const activeStructuralParts = new Set(
    parsedGrants
      .map((grant) => kindById.get(grant.kind)?.structuralPart)
      .filter((part): part is string => part !== undefined),
  );
  const strippedGrants = parsedGrants.filter(
    (grant) => grant.kind === "Structure:UnregisteredAncillaryStripped",
  );
  const strippedKind = kindById.get("Structure:UnregisteredAncillaryStripped");
  const explainedStrippedValues = new Set<string>();

  const toEntries = (parts: readonly string[]): readonly MetadataEntry[] =>
    parts.map((part) => ({ part }));
  const { onlyLeft, onlyRight } = multisetDiff(
    toEntries(nativeParts),
    toEntries(referenceParts),
  );

  for (const entry of onlyLeft) {
    const part = String(entry.part);
    if (!activeStructuralParts.has(part))
      throw new Error(`Unpermitted structural difference: ${part}`);
  }

  for (const entry of onlyRight) {
    const part = String(entry.part);
    const grant = strippedGrants.find((item) => item.value === part);
    if (
      grant === undefined ||
      strippedKind?.admitsPart === undefined ||
      !strippedKind.admitsPart(part)
    )
      throw new Error(`Structural over-strip: ${part}`);
    explainedStrippedValues.add(part);
  }

  for (const grant of strippedGrants)
    if (!explainedStrippedValues.has(grant.value))
      throw new Error(
        `Stale permitted difference: Structure:UnregisteredAncillaryStripped=${grant.value}`,
      );

  return [];
}

/**
 * Runs the pinned ExifTool authority's own `-all=` sanitize against `input`, inside the
 * same temp directory `withInput` already created for materializing it, and returns the
 * resulting bytes. This is the reference baseline `compareDifferential` compares native
 * output against.
 */
export function runExiftoolReference(
  input: Buffer,
  profile: DifferentialProfile,
): Buffer {
  return withInput(input, profile.extension, (inputPath) => {
    const referencePath = join(
      dirname(inputPath),
      `reference${profile.extension}`,
    );
    const result = execute(tools().exiftool, [
      "-all=",
      "-o",
      referencePath,
      inputPath,
    ]);
    if (result.status !== 0)
      throw new Error("ExifTool reference authority rejected input");
    return readFileSync(referencePath);
  });
}

export function runExiftoolDifferential(
  options: ExiftoolDifferentialOptions,
): MetadataTranscript {
  validateInput(options.caseId, options.source);
  validateInput(options.caseId, options.output);
  const source = runMetadata(
    options.source,
    options.profile.extension,
    options.profile.rawColorProfileSha256,
  );
  const output = runMetadata(
    options.output,
    options.profile.extension,
    options.profile.rawColorProfileSha256,
  );
  comparePermittedDifferences(
    source,
    output,
    options.permittedDifferences,
    options.profile.permittedKinds,
  );
  const referenceBytes = runExiftoolReference(options.source, options.profile);
  const reference = runMetadata(
    referenceBytes,
    options.profile.extension,
    options.profile.rawColorProfileSha256,
  );
  compareDifferential(
    source,
    output,
    reference,
    options.permittedDifferences,
    options.profile.permittedKinds,
  );
  if (options.profile.structuralParts !== undefined) {
    compareStructuralDifferential(
      options.profile.structuralParts(options.output),
      options.profile.structuralParts(referenceBytes),
      options.permittedDifferences,
      options.profile.permittedKinds,
    );
  }
  const authority = tools().authority.authorities.find(
    (item) => item.id === "exiftool-13.59",
  );
  if (authority === undefined) throw new Error("ExifTool authority missing");
  return {
    version: 1,
    caseId: options.caseId,
    authority: {
      exiftoolRevision: authority.revision,
      archiveSha256: authority.archiveSha256,
      artifactSha256: tools().exiftool.sha256,
    },
    source,
    output,
    reference,
    permittedDifferences: [...options.permittedDifferences],
    equivalent: true,
  };
}
