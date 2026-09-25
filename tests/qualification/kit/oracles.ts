import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type MetadataEntry = Readonly<Record<string, unknown>>;

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
  readonly permittedDifferences: readonly string[];
  readonly equivalent: true;
}

interface ExiftoolOracleOptions {
  readonly caseId: string;
  readonly source: Buffer;
  readonly output: Buffer;
  readonly permittedDifferences: readonly string[];
  readonly extension: string;
  readonly rawColorProfileSha256: (bytes: Buffer) => string | undefined;
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
): readonly string[] {
  if (source.warnings.length > 0 || output.warnings.length > 0)
    throw new Error("Oracle warning is not permitted");
  let expectedOrientation: number | undefined;
  let expectedIcc: string | undefined;
  for (const item of permittedDifferences) {
    const orientation = item.match(/^EXIF:Orientation=([1-8])$/);
    const icc = item.match(/^ICC_Profile:RawProfile=([a-f0-9]{64})$/);
    if (orientation !== null) expectedOrientation = Number(orientation[1]);
    else if (icc !== null) expectedIcc = icc[1];
    else throw new Error("Unknown permitted metadata difference");
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

  return [];
}

export function runExiftoolOracle(
  options: ExiftoolOracleOptions,
): MetadataTranscript {
  validateInput(options.caseId, options.source);
  validateInput(options.caseId, options.output);
  const source = runMetadata(
    options.source,
    options.extension,
    options.rawColorProfileSha256,
  );
  const output = runMetadata(
    options.output,
    options.extension,
    options.rawColorProfileSha256,
  );
  comparePermittedDifferences(source, output, options.permittedDifferences);
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
    permittedDifferences: [...options.permittedDifferences],
    equivalent: true,
  };
}
