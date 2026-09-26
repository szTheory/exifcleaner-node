import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonical,
  digest,
  execute,
  validateInput,
  withInput,
  type DifferentialProfile,
  type MetadataEntry,
  type PermittedKind,
} from "../kit/oracles.js";
import type { PayloadDigest } from "../kit/corpus.js";

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;
const SHA256 = /^[a-f0-9]{64}$/;

export const WEBP_EXTENSION = ".webp";

/**
 * The RIFF FourCCs whose payload identity `runQualificationCase` checks
 * (56-09 KIT-01 generalization: previously `kit/corpus.ts`'s own
 * `PAYLOAD_CHUNKS`, moved here as the WebP suite's own
 * `payloadDigests` callback).
 */
const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);

function riffDigest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Walks a RIFF/WebP chunk stream and returns the sha256 of every payload
 * chunk's data, keyed by its FourCC (`PayloadDigest.part`). The WebP suite's
 * own `payloadDigests` callback for `runQualificationCase` (KIT-01 D-03: the
 * kit itself carries no RIFF vocabulary).
 */
export function webpPayloadDigests(data: Buffer): readonly PayloadDigest[] {
  const payloads: PayloadDigest[] = [];
  for (let offset = 12; offset < data.length;) {
    const fourCc = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (PAYLOAD_CHUNKS.has(fourCc))
      payloads.push({
        part: fourCc,
        sha256: riffDigest(data.subarray(offset + 8, offset + 8 + size)),
      });
    offset += 8 + size + (size & 1);
  }
  return payloads;
}

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

interface LibwebpOracleOptions {
  readonly caseId: string;
  readonly kind: "still" | "animation";
  readonly source: Buffer;
  readonly output: Buffer;
}

let preparedTools: PreparedOracleTools | undefined;

function tools(): PreparedOracleTools {
  preparedTools ??= authorityBuilder.prepareOracleTools();
  return preparedTools;
}

process.once("exit", () => preparedTools?.dispose());

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
  return withInput(input, WEBP_EXTENSION, (inputPath) => ({
    inputSha256: digest(input),
    decode:
      kind === "still"
        ? runStillDecode(inputPath)
        : runAnimationDecode(inputPath),
    structure: runStructure(inputPath),
  }));
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

export function webpRawColorProfileSha256(input: Buffer): string | undefined {
  const fourCc = "ICCP";
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

/**
 * The exact title of the live test (webp/oracles.test.ts) that measures both permitted
 * WebP difference kinds together -- cited by both entries in `webpDifferentialProfile`
 * below, and checked for existence by a host-independent citation test.
 */
export const WEBP_ORIENTATION_ICC_MEASUREMENT_TITLE =
  "measures orientation and ICC preservation as the only permitted WebP differences";

/**
 * The tag name (family-1 group "RIFF", per ExifTool 13.59's own `-G1` output measured
 * against tests/corpus/sample.webp and a metadataWebp() fixture -- see the Plan 04
 * SUMMARY) that carries the WebP container's extended-feature flags byte. It exists
 * only when a VP8X chunk is present, so it appears in `native` but never in the
 * `reference` -- which ExifTool's own `-all=` always collapses to simple-format WebP --
 * whenever KIT-08 legitimately keeps VP8X for a preserved feature.
 */
const RIFF_FLAGS_TAG = "WebP_Flags";
const RIFF_ORIENTATION_FLAG_BIT = 0x08;
const RIFF_ICC_FLAG_BIT = 0x20;

/**
 * Both permitted WebP difference kinds also force this same single derived RIFF entry
 * to differ, as a side effect of the underlying preservation KIT-08 keeps VP8X for:
 * preserving Orientation sets the EXIF flag bit, preserving the ICC profile sets the
 * ICC flag bit. `explains` computes the exact flags value every *currently active*
 * grant declaring this namespace would jointly force, and requires the single observed
 * native-only entry to equal it precisely -- so a flags value with an extra, unexplained
 * bit set still fails, exactly like a value missing an expected bit.
 */
function explainsRiffFlags(
  onlyLeft: readonly MetadataEntry[],
  activeKindIds: readonly PermittedKind["id"][],
): boolean {
  if (onlyLeft.length !== 1) return false;
  const entry = onlyLeft[0]!;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || keys[0] !== RIFF_FLAGS_TAG) return false;
  const value = entry[RIFF_FLAGS_TAG];
  if (typeof value !== "number") return false;
  let expected = 0;
  if (activeKindIds.includes("EXIF:Orientation"))
    expected |= RIFF_ORIENTATION_FLAG_BIT;
  if (activeKindIds.includes("ICC_Profile:RawProfile"))
    expected |= RIFF_ICC_FLAG_BIT;
  return value === expected;
}

export const webpDifferentialProfile: DifferentialProfile = {
  format: "webp",
  extension: WEBP_EXTENSION,
  rawColorProfileSha256: webpRawColorProfileSha256,
  permittedKinds: [
    {
      id: "EXIF:Orientation",
      measurement: WEBP_ORIENTATION_ICC_MEASUREMENT_TITLE,
      impliedDifference: { namespace: "RIFF", explains: explainsRiffFlags },
    },
    {
      id: "ICC_Profile:RawProfile",
      measurement: WEBP_ORIENTATION_ICC_MEASUREMENT_TITLE,
      impliedDifference: { namespace: "RIFF", explains: explainsRiffFlags },
    },
  ],
};
