import type { FileHandle } from "node:fs/promises";
import { parseExif } from "../metadata/exif.js";
import { parseIcc } from "../metadata/icc.js";
import { parseXmp } from "../metadata/xmp.js";
import { err, ok } from "../result.js";
import { executionError } from "../errors.js";
import type {
  AdmissionDeclineDetail,
  FormatAdmission,
  FormatHandler,
  OrientationState,
} from "./handler.js";
import type {
  Inspection,
  MetadataEntry,
  MetadataError,
  MetadataWarning,
  PngCapabilities,
  Result,
} from "../types.js";
import {
  inflateBounded,
  InflateBudget,
  isPngSignature,
  parsePng,
  PNG_CRITICAL_CHUNK_TYPES,
  PNG_MAX_ANCILLARY_CHUNKS,
  PNG_MAX_INFLATED_BYTES_TOTAL,
  PNG_MAX_INFLATED_ICC_BYTES,
  PNG_MAX_INFLATED_TEXT_BYTES,
  PNG_MAX_METADATA_BYTES_PER_CHUNK,
  PNG_REGISTERED_CHUNK_TYPES,
  PNG_SIGNATURE,
  PngStructureError,
  type ParsedPng,
  type PngChunk,
} from "../png/chunks.js";
import {
  ICC_PRESERVATION_POLICY_ID,
  MAX_PROFILE_BYTES,
} from "../metadata/icc_admission.js";

// PNG's admission surface (D-05, D-08, D-09, D-15). Mirrors webp-handler.ts's
// structure (collectMetadata / buildOutputPlan / verifyOutput / capability
// literal / handler object), substituting src/png/chunks.ts for src/webp/riff.ts.

/** Restates src/types.ts's private `MetadataNamespace` alias (D-15); see handler.ts. */
type PngMetadataNamespace = "EXIF" | "XMP" | "ICC" | "PNG" | "C2PA";

export type PngChunkClass =
  "keep" | "remove" | "conditional-color" | "conditional-resolution";

// D-05 closed lists. Measured ExifTool 13.59 behaviour (56-CONTEXT.md,
// 56-RESEARCH.md): `-all=` keeps every type in PNG_PRESERVED_CHUNK_TYPES and
// removes every type in PNG_REMOVED_CHUNK_TYPES; `iCCP`/`pHYs` are removed
// unless the corresponding preservation flag is set (PNG_CONDITIONAL_CHUNK_TYPES).
// Casing note (carried from 56-02's flagged ambiguity): src/png/chunks.ts's own
// registry admits both `mDCV`/`cLLI` and `mDCv`/`cLLi`. This handler's D-05
// preserve-list uses exactly the casing 56-CONTEXT.md/56-RESEARCH.md measured
// (`mDCv`, `cLLi`) -- the upper-last-letter spellings are therefore
// registered-but-unmeasured (typed decline) today, not preserved. Plan 04
// settles this permanently.
export const PNG_PRESERVED_CHUNK_TYPES: ReadonlySet<string> = new Set([
  "tRNS",
  "cHRM",
  "bKGD",
  "sBIT",
  "sPLT",
  "hIST",
  "cICP",
  "mDCv",
  "cLLi",
  "sCAL",
  "oFFs",
  "pCAL",
  "sTER",
  "iDOT",
  "vpAg",
]);

export const PNG_REMOVED_CHUNK_TYPES: ReadonlySet<string> = new Set([
  "tEXt",
  "zTXt",
  "iTXt",
  "eXIf",
  "tIME",
  "caBX",
  "gAMA",
  "sRGB",
]);

export type PngConditionalChunkKind = "colorProfile" | "resolution";

export const PNG_CONDITIONAL_CHUNK_TYPES: ReadonlyMap<
  string,
  PngConditionalChunkKind
> = new Map([
  ["iCCP", "colorProfile"],
  ["pHYs", "resolution"],
]);

const COPY_BLOCK_BYTES = 64 * 1024;
const CHUNK_FIXED_OVERHEAD_BYTES = 12; // 4-byte length + 4-byte type + 4-byte CRC

export interface PngAdmission extends FormatAdmission {
  readonly parsed: ParsedPng;
  /** One classification per entry in `parsed.chunks`, same index order. */
  readonly classes: readonly PngChunkClass[];
  /**
   * Unregistered private ancillary chunk types stripped under D-05, in order
   * of first appearance, deduplicated. Granted by a future permitted-
   * difference kind (Plans 07/09).
   */
  readonly unregisteredStripped: readonly string[];
}

export type PngOutputPlanPart =
  | {
      readonly kind: "copy";
      readonly sourceOffset: number;
      readonly length: number;
    }
  | { readonly kind: "insert"; readonly data: Buffer };

export interface PngOutputPlan {
  readonly parts: readonly PngOutputPlanPart[];
  readonly expectedTypes: readonly string[];
  readonly copiedChunks: readonly PngChunk[];
  /**
   * D-06: set when an iDOT chunk is present and a chunk strictly between it
   * and the first IDAT would be removed under the request's flags. When set,
   * checkOutputPlan declines before any write -- nothing is ever inserted or
   * removed between iDOT and IDAT.
   */
  readonly declineReason?: string;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function chunkSpan(chunk: PngChunk): number {
  return CHUNK_FIXED_OVERHEAD_BYTES + chunk.length;
}

const ICCP_MIN_KEYWORD_BYTES = 1;
const ICCP_MAX_KEYWORD_BYTES = 79;

function parseIccpChunk(data: Buffer, budget: InflateBudget): Buffer {
  const nul = data.indexOf(0);
  if (
    nul < ICCP_MIN_KEYWORD_BYTES ||
    nul > ICCP_MAX_KEYWORD_BYTES ||
    nul + 1 >= data.length
  ) {
    throw new PngStructureError(
      "malformed-file",
      "iCCP chunk profile name is missing or exceeds the 79-byte limit.",
    );
  }
  const method = data[nul + 1];
  if (method !== 0) {
    throw new PngStructureError(
      "malformed-file",
      "iCCP chunk compression method must be zero.",
    );
  }
  const compressed = data.subarray(nul + 2);
  return inflateBounded(compressed, "iCCP", PNG_MAX_INFLATED_ICC_BYTES, budget);
}

function parseZtxtChunk(data: Buffer, budget: InflateBudget): Buffer {
  const nul = data.indexOf(0);
  if (nul < 0 || nul + 1 >= data.length) {
    throw new PngStructureError(
      "malformed-file",
      "zTXt chunk is missing its keyword terminator.",
    );
  }
  const compressed = data.subarray(nul + 2);
  return inflateBounded(
    compressed,
    "zTXt",
    PNG_MAX_INFLATED_TEXT_BYTES,
    budget,
  );
}

interface ParsedItxt {
  readonly keyword: string;
  readonly text: Buffer;
}

function parseItxtChunk(data: Buffer, budget: InflateBudget): ParsedItxt {
  const keywordNul = data.indexOf(0);
  if (keywordNul < 0) {
    throw new PngStructureError(
      "malformed-file",
      "iTXt chunk is missing its keyword terminator.",
    );
  }
  const keyword = data.toString("latin1", 0, keywordNul);
  const compressionFlag = data[keywordNul + 1];
  let offset = keywordNul + 3; // past keyword\0, compression flag, compression method
  const languageNul = data.indexOf(0, offset);
  if (languageNul < 0) {
    throw new PngStructureError(
      "malformed-file",
      "iTXt chunk is missing its language-tag terminator.",
    );
  }
  offset = languageNul + 1;
  const translatedNul = data.indexOf(0, offset);
  if (translatedNul < 0) {
    throw new PngStructureError(
      "malformed-file",
      "iTXt chunk is missing its translated-keyword terminator.",
    );
  }
  const payload = data.subarray(translatedNul + 1);
  const text =
    compressionFlag === 1
      ? inflateBounded(payload, "iTXt", PNG_MAX_INFLATED_TEXT_BYTES, budget)
      : payload;
  return { keyword, text };
}

const XMP_ITXT_KEYWORD = "XML:com.adobe.xmp";

/** PNG `tEXt` chunk payload: Latin-1 keyword, NUL, Latin-1 text (D-15). */
function parseTextChunkData(data: Buffer): {
  readonly keyword: string;
  readonly text: string;
} {
  const nul = data.indexOf(0);
  return nul < 0
    ? { keyword: data.toString("latin1"), text: "" }
    : {
        keyword: data.toString("latin1", 0, nul),
        text: data.toString("latin1", nul + 1),
      };
}

/**
 * PNG `tIME` chunk payload (7 bytes: 2-byte year, then month/day/hour/
 * minute/second) formatted to match ExifTool's measured `PNG:ModifyDate`
 * output shape (D-15).
 */
function formatPngTime(data: Buffer): string {
  const pad = (value: number, width = 2): string =>
    value.toString().padStart(width, "0");
  const year = data.readUInt16BE(0);
  const month = data[2] ?? 0;
  const day = data[3] ?? 0;
  const hour = data[4] ?? 0;
  const minute = data[5] ?? 0;
  const second = data[6] ?? 0;
  return `${pad(year, 4)}:${pad(month)}:${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function collectMetadata(parsed: ParsedPng): Omit<PngAdmission, "parsed"> {
  const entries: MetadataEntry[] = [];
  const warnings: MetadataWarning[] = [];
  let orientation: OrientationState = { status: "absent" };
  let colorProfile: Buffer | undefined;
  const namespaces = new Set<PngMetadataNamespace>();
  let resolutionNamespace: PngMetadataNamespace | undefined;
  const classes: PngChunkClass[] = [];
  const unregisteredStripped: string[] = [];
  const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);

  parsed.chunks.forEach((chunk, index) => {
    const { type } = chunk;

    if (PNG_CRITICAL_CHUNK_TYPES.has(type)) {
      classes.push("keep");
      return;
    }

    // iDOT (Apple's private adjacency-constrained chunk, D-06) is a measured
    // "keep, measured-kept by ExifTool" entry like any other
    // PNG_PRESERVED_CHUNK_TYPES member -- unconditionally kept here. The
    // iDOT-to-first-IDAT adjacency invariant is enforced at the plan level
    // (buildOutputPlan), not during admission, because it depends on the
    // request's preservation flags.
    if (PNG_PRESERVED_CHUNK_TYPES.has(type)) {
      classes.push("keep");
      return;
    }

    const conditional = PNG_CONDITIONAL_CHUNK_TYPES.get(type);
    if (conditional === "resolution") {
      classes.push("conditional-resolution");
      resolutionNamespace = "PNG";
      return;
    }
    if (conditional === "colorProfile") {
      classes.push("conditional-color");
      namespaces.add("ICC");
      const data = parsed.buffered.get(index);
      if (data !== undefined) {
        colorProfile = parseIccpChunk(data, budget);
        const found = parseIcc(colorProfile);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
      }
      return;
    }

    if (!PNG_REMOVED_CHUNK_TYPES.has(type)) {
      if (PNG_REGISTERED_CHUNK_TYPES.has(type)) {
        // D-05: registered but unmeasured. The handler never guesses keep or
        // strip -- it becomes eligible once a measurement adds it to a list.
        throw new PngStructureError(
          "unsafe-structure",
          `PNG chunk ${type} is registered but its ExifTool behaviour is not measured; declining.`,
        );
      }
      // D-05: unregistered private ancillary chunk. src/png/chunks.ts's
      // structural pass already refused an uppercase-first (critical) unknown
      // as an unknown-critical chunk, so anything reaching here is a
      // lowercase-first ancillary type. Strip it and record its type so the
      // differential can grant it (Plans 07/09); its presence widens
      // removedNamespaces via PNG.
      classes.push("remove");
      if (!unregisteredStripped.includes(type)) unregisteredStripped.push(type);
      namespaces.add("PNG");
      return;
    }

    classes.push("remove");
    const data = parsed.buffered.get(index);

    if (type === "eXIf") {
      namespaces.add("EXIF");
      if (data !== undefined) {
        const found = parseExif(data);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
        // Tracer fail-closed (D-11/D-12, Plan 06 replaces this): PNG never
        // writes orientation yet, so a valid source Orientation is reported
        // as unsupported -- the engine declines preserveOrientation:true
        // against it, rather than silently dropping the value.
        orientation =
          found.orientation.status === "valid"
            ? {
                status: "unsupported",
                detail: "PNG orientation preservation is not yet admitted.",
              }
            : found.orientation;
      }
      return;
    }
    if (type === "caBX") {
      namespaces.add("C2PA");
      if (data !== undefined) {
        entries.push({ namespace: "C2PA", name: "JUMBF", value: data.length });
      }
      return;
    }
    if (type === "tIME") {
      namespaces.add("PNG");
      if (data !== undefined && data.length >= 7) {
        entries.push({
          namespace: "PNG",
          name: "ModifyDate",
          value: formatPngTime(data),
        });
      }
      return;
    }
    if (type === "gAMA" || type === "sRGB") {
      // D-15: gAMA/sRGB widen removedNamespaces but never produce an entry --
      // there is nothing here a user would recognize as "their" metadata.
      namespaces.add("PNG");
      return;
    }
    if (type === "tEXt") {
      namespaces.add("PNG");
      if (data !== undefined) {
        const { keyword, text } = parseTextChunkData(data);
        entries.push({ namespace: "PNG", name: keyword, value: text });
      }
      return;
    }
    if (type === "zTXt") {
      namespaces.add("PNG");
      if (data !== undefined) {
        const keywordNul = data.indexOf(0);
        const text = parseZtxtChunk(data, budget);
        const keyword =
          keywordNul < 0
            ? data.toString("latin1")
            : data.toString("latin1", 0, keywordNul);
        entries.push({
          namespace: "PNG",
          name: keyword,
          value: text.toString("latin1"),
        });
      }
      return;
    }
    if (type === "iTXt") {
      if (data === undefined) {
        namespaces.add("PNG");
        return;
      }
      const { keyword, text } = parseItxtChunk(data, budget);
      if (keyword === XMP_ITXT_KEYWORD) {
        namespaces.add("XMP");
        const found = parseXmp(text);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
      } else {
        namespaces.add("PNG");
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            text,
          );
          entries.push({ namespace: "PNG", name: keyword, value: decoded });
        } catch {
          warnings.push({
            code: "metadata-invalid",
            detail: `iTXt chunk ${keyword} text is not valid UTF-8.`,
          });
        }
      }
    }
  });

  return {
    entries,
    warnings,
    orientation,
    colorProfile,
    namespaces: [...namespaces],
    resolutionNamespace,
    classes,
    unregisteredStripped,
  };
}

function isKept(
  cls: PngChunkClass,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
): boolean {
  if (cls === "keep") return true;
  if (cls === "conditional-color") return preserveColorProfile;
  if (cls === "conditional-resolution") return preserveResolution;
  return false;
}

/**
 * D-06: iDOT's offsets are relative to the iDOT chunk's own start, so nothing
 * may be inserted between iDOT and the first IDAT, and nothing between them
 * may be removed. Returns a decline message when a chunk in that span would
 * be removed under the current flags; undefined when the file has no iDOT,
 * has no IDAT after it, or every in-between chunk is kept.
 */
function findIdotAdjacencyDecline(
  admission: PngAdmission,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
): string | undefined {
  const { chunks } = admission.parsed;
  const idotIndex = chunks.findIndex((item) => item.type === "iDOT");
  if (idotIndex < 0) return undefined;
  const firstIdatIndex = chunks.findIndex((item) => item.type === "IDAT");
  if (firstIdatIndex < 0 || firstIdatIndex <= idotIndex) return undefined;

  for (let index = idotIndex + 1; index < firstIdatIndex; index += 1) {
    const chunk = chunks[index]!;
    const cls = admission.classes[index] ?? "remove";
    if (!isKept(cls, preserveColorProfile, preserveResolution)) {
      return `PNG chunk ${chunk.type} sits between iDOT and the first IDAT and cannot be removed safely.`;
    }
  }
  return undefined;
}

function buildOutputPlan(
  admission: PngAdmission,
  _preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  _orientation: number | undefined,
): PngOutputPlan {
  // The tracer inserts nothing (Plan 06 adds the minimal eXIf insert); every
  // kept chunk is copied byte-for-byte from its original source range.
  // Adjacent kept chunks are coalesced into one copy range.
  const parts: PngOutputPlanPart[] = [];
  const expectedTypes: string[] = [];
  const copiedChunks: PngChunk[] = [];
  let pendingStart: number | undefined;
  let pendingEnd: number | undefined;

  const flush = (): void => {
    if (pendingStart === undefined || pendingEnd === undefined) return;
    parts.push({
      kind: "copy",
      sourceOffset: pendingStart,
      length: pendingEnd - pendingStart,
    });
    pendingStart = undefined;
    pendingEnd = undefined;
  };

  admission.parsed.chunks.forEach((chunk, index) => {
    const cls = admission.classes[index] ?? "remove";
    if (!isKept(cls, preserveColorProfile, preserveResolution)) {
      flush();
      return;
    }
    const chunkStart = chunk.offset;
    const chunkEnd = chunk.offset + chunkSpan(chunk);
    if (pendingEnd === chunkStart) {
      pendingEnd = chunkEnd;
    } else {
      flush();
      pendingStart = chunkStart;
      pendingEnd = chunkEnd;
    }
    expectedTypes.push(chunk.type);
    copiedChunks.push(chunk);
  });
  flush();

  const declineReason = findIdotAdjacencyDecline(
    admission,
    preserveColorProfile,
    preserveResolution,
  );

  return declineReason === undefined
    ? { parts, expectedTypes, copiedChunks }
    : { parts, expectedTypes, copiedChunks, declineReason };
}

function recomputeExpectedTypes(
  admission: PngAdmission,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
): readonly string[] {
  const types: string[] = [];
  admission.parsed.chunks.forEach((chunk, index) => {
    const cls = admission.classes[index] ?? "remove";
    if (isKept(cls, preserveColorProfile, preserveResolution))
      types.push(chunk.type);
  });
  return types;
}

async function writeAll(
  handle: FileHandle,
  data: Buffer,
  position: number,
): Promise<number> {
  let written = 0;
  while (written < data.length) {
    const next = await handle.write(
      data,
      written,
      data.length - written,
      position + written,
    );
    if (next.bytesWritten === 0)
      throw new Error("A file write made no progress.");
    written += next.bytesWritten;
  }
  return position + written;
}

async function copyRange(
  source: FileHandle,
  destination: FileHandle,
  sourceOffset: number,
  length: number,
  position: number,
  signal?: AbortSignal,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(
    Math.min(COPY_BLOCK_BYTES, Math.max(length, 1)),
  );
  let copied = 0;
  while (copied < length) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const take = Math.min(buffer.length, length - copied);
    const read = await source.read(buffer, 0, take, sourceOffset + copied);
    if (read.bytesRead !== take)
      throw new Error("Source changed or became truncated while copying.");
    let written = 0;
    while (written < take) {
      const result = await destination.write(
        buffer,
        written,
        take - written,
        position + copied + written,
      );
      if (result.bytesWritten === 0)
        throw new Error("A file write made no progress.");
      written += result.bytesWritten;
    }
    copied += take;
  }
  return position + copied;
}

async function chunksEqual(
  sourceHandle: FileHandle,
  source: PngChunk,
  destinationHandle: FileHandle,
  destination: PngChunk,
  signal?: AbortSignal,
): Promise<boolean> {
  const sourceSpan = chunkSpan(source);
  const destinationSpan = chunkSpan(destination);
  if (sourceSpan !== destinationSpan) return false;
  const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(sourceSpan, 1));
  const sourceBuffer = Buffer.allocUnsafe(bufferSize);
  const destinationBuffer = Buffer.allocUnsafe(bufferSize);
  for (let offset = 0; offset < sourceSpan;) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const length = Math.min(COPY_BLOCK_BYTES, sourceSpan - offset);
    const left = await sourceHandle.read(
      sourceBuffer,
      0,
      length,
      source.offset + offset,
    );
    const right = await destinationHandle.read(
      destinationBuffer,
      0,
      length,
      destination.offset + offset,
    );
    if (left.bytesRead !== length || right.bytesRead !== length)
      throw new Error(
        "Source or output changed or became truncated during verification.",
      );
    if (
      !sourceBuffer
        .subarray(0, length)
        .equals(destinationBuffer.subarray(0, length))
    )
      return false;
    offset += length;
  }
  return true;
}

function verificationError(detail: string, path: string): MetadataError {
  return executionError(
    { code: "verification-failed", detail, path },
    "started",
  );
}

function verificationAborted(path: string): MetadataError {
  return executionError(
    { code: "aborted", detail: "Operation was aborted.", path },
    "started",
  );
}

async function verifyOutput(
  sourceHandle: FileHandle,
  admission: PngAdmission,
  destinationHandle: FileHandle,
  destinationSize: number,
  destinationPath: string,
  _preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  _expectedOrientation: number | undefined,
  signal?: AbortSignal,
): Promise<Result<void>> {
  try {
    const destination = await parsePng(
      destinationHandle,
      destinationSize,
      signal,
    );
    const expectedTypes = recomputeExpectedTypes(
      admission,
      preserveColorProfile,
      preserveResolution,
    );
    const destinationTypes = destination.chunks.map((chunk) => chunk.type);
    if (
      destinationTypes.length !== expectedTypes.length ||
      destinationTypes.some((type, index) => type !== expectedTypes[index])
    )
      return err(
        verificationError(
          "Destination chunk sequence did not match the sanitized plan.",
          destinationPath,
        ),
      );

    for (const type of destinationTypes) {
      if (PNG_REMOVED_CHUNK_TYPES.has(type))
        return err(
          verificationError(
            `${type} remained after sanitization.`,
            destinationPath,
          ),
        );
    }

    const sourceKept = admission.parsed.chunks.filter((_chunk, index) =>
      isKept(
        admission.classes[index] ?? "remove",
        preserveColorProfile,
        preserveResolution,
      ),
    );
    if (sourceKept.length !== destination.chunks.length)
      return err(
        verificationError(
          "Destination chunk count did not match the sanitized plan.",
          destinationPath,
        ),
      );
    for (let index = 0; index < sourceKept.length; index += 1) {
      const left = sourceKept[index];
      const right = destination.chunks[index];
      if (
        left === undefined ||
        right === undefined ||
        left.type !== right.type ||
        !(await chunksEqual(
          sourceHandle,
          left,
          destinationHandle,
          right,
          signal,
        ))
      )
        return err(
          verificationError("Kept PNG chunk bytes changed.", destinationPath),
        );
    }

    return ok(undefined);
  } catch (cause) {
    if (isAborted(signal)) return err(verificationAborted(destinationPath));
    return err(
      verificationError(
        cause instanceof PngStructureError
          ? cause.message
          : "Could not reopen and verify the destination.",
        destinationPath,
      ),
    );
  }
}

function classifyAdmissionFailure(
  cause: unknown,
  preserveColorProfile: boolean,
): AdmissionDeclineDetail | undefined {
  if (!(cause instanceof PngStructureError)) return undefined;
  if (preserveColorProfile && cause.limit?.chunkType === "iCCP")
    return {
      code: "unsupported-feature",
      detail: `ICC profile size ${cause.limit.size} exceeds the ${cause.limit.limit}-byte policy limit.`,
      feature: "color-profile-preservation",
      reason: "policy-limit",
    };
  return { code: cause.kind, detail: cause.message };
}

const capability: PngCapabilities = Object.freeze({
  format: "png" as const,
  mimeTypes: Object.freeze(["image/png"] as const),
  extensions: Object.freeze([".png"] as const),
  inspect: true as const,
  sanitize: true as const,
  preserves: Object.freeze({
    orientation: true as const,
    colorProfile: true as const,
    timestamps: true as const,
    resolution: true as const,
    imagePayload: true as const,
    animationPayload: false as const,
  }),
  validation: Object.freeze({
    container: "full" as const,
    codecBitstream: "not-decoded" as const,
  }),
  colorProfile: Object.freeze({
    policy: ICC_PRESERVATION_POLICY_ID,
    preservation: "preserve-if-present" as const,
    versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"] as const),
    classes: Object.freeze(["scnr", "mntr"] as const),
    spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "] as const),
    maxProfileBytes: MAX_PROFILE_BYTES,
    maxTagCount: 4_096,
  }),
  limits: Object.freeze({
    maxMetadataBytesPerChunk: PNG_MAX_METADATA_BYTES_PER_CHUNK,
    maxAncillaryChunkCount: PNG_MAX_ANCILLARY_CHUNKS,
    maxInflatedIccBytes: PNG_MAX_INFLATED_ICC_BYTES,
    maxInflatedTextBytes: PNG_MAX_INFLATED_TEXT_BYTES,
    maxInflatedBytesTotal: PNG_MAX_INFLATED_BYTES_TOTAL,
  }),
  refuses: Object.freeze([
    "unknown-critical-chunks",
    "malformed-container",
    "crc-mismatch",
    "chunk-order",
    "truncation",
    "trailing-data",
    "animation",
    "resource-limits",
    "unmeasured-registered-chunks",
    "unsafe-chunk-adjacency",
  ] as const),
  removes: Object.freeze(["EXIF", "XMP", "ICC", "PNG", "C2PA"] as const),
  detection: "magic" as const,
});

export const pngHandler: FormatHandler<PngAdmission, PngOutputPlan> =
  Object.freeze({
    capability,
    stagingFileName: "output.png",
    matches(magic: Buffer): boolean {
      return isPngSignature(magic);
    },
    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<PngAdmission> {
      const parsed = await parsePng(handle, size, signal);
      return { parsed, ...collectMetadata(parsed) };
    },
    inspect(admission: PngAdmission): Inspection {
      return {
        format: "png",
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },
    buildOutputPlan,
    checkOutputPlan(plan: PngOutputPlan): string | undefined {
      if (plan.declineReason !== undefined) return plan.declineReason;
      return plan.expectedTypes.includes("IDAT")
        ? undefined
        : "Sanitized PNG plan is empty.";
    },
    classifyAdmissionFailure,
    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: PngOutputPlan,
      signal?: AbortSignal,
    ): Promise<void> {
      let position = await writeAll(destination, PNG_SIGNATURE, 0);
      for (const part of plan.parts) {
        if (isAborted(signal))
          throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        position =
          part.kind === "insert"
            ? await writeAll(destination, part.data, position)
            : await copyRange(
                source,
                destination,
                part.sourceOffset,
                part.length,
                position,
                signal,
              );
      }
    },
    verifyOutput,
  });
