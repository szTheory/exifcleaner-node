import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;
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
  readonly dwebp: ExecutableAuthority;
  readonly webpinfo: ExecutableAuthority;
  readonly animation: ExecutableAuthority;
  readonly exiftool: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly prepareOracleTools: () => PreparedOracleTools;
}

export interface StructureChunk {
  readonly fourCc: string;
  readonly headerOffset: number;
  readonly payloadBytes: number;
  readonly spanBytes: number;
}

export interface StructureTranscript {
  readonly status: "success" | "rejected";
  readonly warnings: readonly string[];
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly alpha: boolean;
  readonly animation: boolean;
  readonly chunks: readonly StructureChunk[];
}

interface StillDecodeTranscript {
  readonly status: "success";
  readonly width: number;
  readonly height: number;
  readonly format: "lossy" | "lossless";
  readonly pamSha256: string;
}

interface AnimationFrameTranscript {
  readonly index: number;
  readonly timestampMs: number;
  readonly durationMs: number;
  readonly rgbaSha256: string;
}

interface AnimationDecodeTranscript {
  readonly status: "success";
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly frameCount: number;
  readonly loopCount: number;
  readonly backgroundColor: number;
  readonly frames: readonly AnimationFrameTranscript[];
}

type DecodeTranscript = StillDecodeTranscript | AnimationDecodeTranscript;

interface MediaEvidence {
  readonly inputSha256: string;
  readonly decode: DecodeTranscript;
  readonly structure: StructureTranscript;
}

export interface StillTranscript {
  readonly version: 1;
  readonly caseId: string;
  readonly kind: "still" | "animation";
  readonly authority: {
    readonly libwebpRevision: string;
    readonly archiveSha256: string;
    readonly artifactSha256: Readonly<Record<string, string>>;
  };
  readonly source: MediaEvidence;
  readonly output: MediaEvidence;
  readonly equivalent: true;
}

type MetadataEntry = Readonly<Record<string, unknown>>;

export interface MetadataProjection {
  readonly warnings: readonly string[];
  readonly namespaces: Readonly<
    Record<"EXIF" | "XMP" | "ICC_Profile", readonly MetadataEntry[]>
  >;
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

interface LibwebpOracleOptions {
  readonly caseId: string;
  readonly kind: "still" | "animation";
  readonly source: Buffer;
  readonly output: Buffer;
}

interface ExiftoolOracleOptions {
  readonly caseId: string;
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

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateInput(caseId: string, bytes: Buffer): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(caseId))
    throw new Error("Invalid oracle case ID");
  if (bytes.length === 0 || bytes.length > MAX_ORACLE_INPUT_BYTES)
    throw new Error(`Oracle input outside bounds: ${caseId}`);
}

function withInput<T>(bytes: Buffer, operation: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-input-"));
  const inputPath = join(directory, "input.webp");
  try {
    writeFileSync(inputPath, bytes, { flag: "wx" });
    return operation(inputPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(
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

export function normalizeWebpInfo(output: string): StructureTranscript {
  if (output.length > 1024 * 1024)
    throw new Error("webpinfo output outside bounds");
  const warnings = output
    .split(/\r?\n/)
    .filter((line) => /warning/i.test(line))
    .map((line) => line.trim().slice(0, 256));
  const chunks: StructureChunk[] = [];
  const chunkPattern = /^Chunk (.{4}) at offset\s+(\d+), length\s+(\d+)$/gm;
  for (const match of output.matchAll(chunkPattern)) {
    const spanBytes = Number(match[3]);
    chunks.push({
      fourCc: match[1]!,
      headerOffset: Number(match[2]),
      payloadBytes: spanBytes - 8,
      spanBytes,
    });
  }
  const number = (label: string): number | undefined => {
    const match = output.match(new RegExp(`^\\s*${label}:\\s*(\\d+)$`, "m"));
    return match === null ? undefined : Number(match[1]);
  };
  return {
    status:
      /No error detected\./.test(output) && warnings.length === 0
        ? "success"
        : "rejected",
    warnings,
    width: number("Width"),
    height: number("Height"),
    alpha: number("Alpha") === 1,
    animation: number("Animation") === 1,
    chunks,
  };
}

function runStructure(inputPath: string): StructureTranscript {
  const result = execute(tools().webpinfo, ["-diag", inputPath]);
  const transcript = normalizeWebpInfo(`${result.stdout}\n${result.stderr}`);
  if (result.status !== 0 || transcript.status !== "success")
    throw new Error("libwebp oracle rejected structure");
  return transcript;
}

function runStillDecode(inputPath: string): StillDecodeTranscript {
  const outputPath = join(inputPath, "..", "decoded.pam");
  const result = execute(tools().dwebp, [inputPath, "-pam", "-o", outputPath]);
  if (result.status !== 0) throw new Error("libwebp oracle rejected decode");
  const text = `${result.stdout}\n${result.stderr}`;
  const dimensions = text.match(/Dimensions:\s*(\d+) x (\d+)/);
  const format = text.match(/Format:\s*(lossy|lossless)/i);
  if (dimensions === null || format === null)
    throw new Error("libwebp oracle emitted an unknown decode transcript");
  return {
    status: "success",
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    format: format[1]!.toLowerCase() as "lossy" | "lossless",
    pamSha256: digest(readFileSync(outputPath)),
  };
}

function runAnimationDecode(inputPath: string): AnimationDecodeTranscript {
  const result = execute(tools().animation, [inputPath]);
  if (result.status !== 0) throw new Error("libwebp oracle rejected animation");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("libwebp animation transcript was not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("status" in parsed) ||
    parsed.status !== "success" ||
    !("frames" in parsed) ||
    !Array.isArray(parsed.frames)
  )
    throw new Error("libwebp animation transcript was invalid");
  const record = parsed as Record<string, unknown>;
  const integers = [
    record.canvasWidth,
    record.canvasHeight,
    record.frameCount,
    record.loopCount,
    record.backgroundColor,
  ];
  if (
    integers.some(
      (value) => !Number.isSafeInteger(value) || Number(value) < 0,
    ) ||
    Number(record.canvasWidth) === 0 ||
    Number(record.canvasHeight) === 0 ||
    Number(record.frameCount) !== parsed.frames.length ||
    parsed.frames.some((frame, index) => {
      if (typeof frame !== "object" || frame === null) return true;
      const item = frame as Record<string, unknown>;
      return (
        item.index !== index ||
        !Number.isSafeInteger(item.timestampMs) ||
        Number(item.timestampMs) < 0 ||
        !Number.isSafeInteger(item.durationMs) ||
        Number(item.durationMs) < 0 ||
        typeof item.rgbaSha256 !== "string" ||
        !SHA256.test(item.rgbaSha256)
      );
    })
  )
    throw new Error("libwebp animation transcript was invalid");
  return parsed as unknown as AnimationDecodeTranscript;
}

function inspectMedia(
  input: Buffer,
  kind: "still" | "animation",
): MediaEvidence {
  return withInput(input, (inputPath) => ({
    inputSha256: digest(input),
    decode:
      kind === "still"
        ? runStillDecode(inputPath)
        : runAnimationDecode(inputPath),
    structure: runStructure(inputPath),
  }));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function runLibwebpOracle(
  options: LibwebpOracleOptions,
): StillTranscript {
  validateInput(options.caseId, options.source);
  validateInput(options.caseId, options.output);
  let source: MediaEvidence;
  let output: MediaEvidence;
  try {
    source = inspectMedia(options.source, options.kind);
    output = inspectMedia(options.output, options.kind);
  } catch {
    throw new Error(`libwebp oracle rejected: ${options.caseId}`);
  }
  if (
    canonical(source.decode) !== canonical(output.decode) ||
    source.structure.status !== "success" ||
    output.structure.status !== "success"
  )
    throw new Error(`libwebp oracle mismatch: ${options.caseId}`);
  const authority = tools().authority.authorities.find(
    (item) => item.id === "libwebp-1.5.0",
  );
  if (authority === undefined) throw new Error("libwebp authority missing");
  return {
    version: 1,
    caseId: options.caseId,
    kind: options.kind,
    authority: {
      libwebpRevision: authority.revision,
      archiveSha256: authority.archiveSha256,
      artifactSha256: {
        dwebp: tools().dwebp.sha256,
        webpinfo: tools().webpinfo.sha256,
        ...(options.kind === "animation"
          ? { animation: tools().animation.sha256 }
          : {}),
      },
    },
    source,
    output,
    equivalent: true,
  };
}

function metadataNamespace(
  group: string,
): "EXIF" | "XMP" | "ICC_Profile" | undefined {
  if (/^(?:IFD\d*|ExifIFD|GPS|InteropIFD|SubIFD|MakerNotes)$/.test(group))
    return "EXIF";
  if (group.startsWith("XMP")) return "XMP";
  if (group === "ICC_Profile") return "ICC_Profile";
  return undefined;
}

function rawChunkDigest(input: Buffer, fourCc: string): string | undefined {
  for (let offset = 12; offset + 8 <= input.length;) {
    const size = input.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > input.length) return undefined;
    if (input.toString("ascii", offset, offset + 4) === fourCc)
      return digest(input.subarray(offset + 8, end));
    offset = end + (size & 1);
  }
  return undefined;
}

function runMetadata(input: Buffer): MetadataProjection {
  return withInput(input, (inputPath) => {
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
    const namespaces: Record<"EXIF" | "XMP" | "ICC_Profile", MetadataEntry[]> =
      { EXIF: [], XMP: [], ICC_Profile: [] };
    const warnings: string[] = [];
    for (const [key, value] of Object.entries(parsed[0]!)) {
      const [group = "", tag = ""] = key.split(":", 2);
      if (/warning|error/i.test(tag))
        warnings.push(String(value).slice(0, 256));
      if (/unknown/i.test(tag))
        throw new Error("ExifTool oracle found an unknown tag");
      const namespace = metadataNamespace(group);
      if (namespace !== undefined) namespaces[namespace].push({ [tag]: value });
    }
    for (const values of Object.values(namespaces))
      values.sort((left, right) =>
        canonical(left).localeCompare(canonical(right)),
      );
    const rawIccSha256 = rawChunkDigest(input, "ICCP");
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

  if (output.namespaces.XMP.length > 0)
    throw new Error("Unpermitted metadata difference: XMP");
  if (expectedOrientation === undefined) {
    if (output.namespaces.EXIF.length > 0)
      throw new Error("Unpermitted metadata difference: EXIF");
  } else {
    const sourceOrientations = tagValues(source.namespaces.EXIF, "Orientation");
    const outputOrientations = tagValues(output.namespaces.EXIF, "Orientation");
    if (
      sourceOrientations.every((value) => value !== expectedOrientation) ||
      outputOrientations.length !== 1 ||
      outputOrientations[0] !== expectedOrientation
    )
      throw new Error("Requested Orientation was not preserved");
    if (
      output.namespaces.EXIF.some((entry) =>
        Object.keys(entry).some((tag) => tag !== "Orientation"),
      )
    )
      throw new Error("Unpermitted metadata difference: EXIF");
  }

  if (expectedIcc === undefined) {
    if (
      output.namespaces.ICC_Profile.length > 0 ||
      output.rawIccSha256 !== undefined
    )
      throw new Error("Unpermitted metadata difference: ICC_Profile");
  } else if (
    source.rawIccSha256 !== expectedIcc ||
    output.rawIccSha256 !== expectedIcc ||
    canonical(source.namespaces.ICC_Profile) !==
      canonical(output.namespaces.ICC_Profile)
  )
    throw new Error("Requested ICC profile was not preserved");

  return [];
}

export function runExiftoolOracle(
  options: ExiftoolOracleOptions,
): MetadataTranscript {
  validateInput(options.caseId, options.source);
  validateInput(options.caseId, options.output);
  const source = runMetadata(options.source);
  const output = runMetadata(options.output);
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
