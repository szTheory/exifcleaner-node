import type { FileHandle } from "node:fs/promises";
import {
  createMinimalExif,
  parseExif,
  readIfd0Resolution,
  type MinimalExifResolution,
  type MinimalExifTags,
} from "../metadata/exif.js";
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
  Result,
  WebpCapabilities,
} from "../types.js";
import {
  COPY_BLOCK_BYTES,
  MAX_BUFFERED_METADATA_BYTES,
  MAX_CHUNK_COUNT,
  MAX_RIFF_BYTES,
  encodeChunkHeader,
  encodeRiffHeader,
  parseWebp,
  WebpStructureError,
  type ParsedWebp,
  type WebpChunk,
} from "../webp/riff.js";
import { ICC_PRESERVATION_POLICY_ID } from "../metadata/icc_admission.js";

export interface WebpOutputChunk {
  readonly fourCc: string;
  readonly size: number;
  readonly source?: WebpChunk;
  readonly data?: Buffer;
}

export interface WebpAdmission extends FormatAdmission {
  readonly parsed: ParsedWebp;
  /** The raw IFD0 XResolution/YResolution/ResolutionUnit of the source EXIF chunk, when complete. */
  readonly sourceResolution: MinimalExifResolution | undefined;
}

export type WebpOutputPlan = readonly WebpOutputChunk[];

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function collectMetadata(parsed: ParsedWebp): Omit<WebpAdmission, "parsed"> {
  const entries: MetadataEntry[] = [];
  const warnings: MetadataWarning[] = [];
  let orientation: OrientationState = { status: "absent" };
  let colorProfile: Buffer | undefined;
  let sourceResolution: MinimalExifResolution | undefined;
  const namespaces = new Set<"EXIF" | "XMP" | "ICC">();
  for (const chunk of parsed.chunks) {
    if (chunk.fourCc === "EXIF") {
      namespaces.add("EXIF");
      if (chunk.metadata !== undefined) {
        const found = parseExif(chunk.metadata);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
        orientation = found.orientation;
        sourceResolution = readIfd0Resolution(chunk.metadata);
      }
    } else if (chunk.fourCc === "XMP ") {
      namespaces.add("XMP");
      if (chunk.metadata !== undefined) {
        const found = parseXmp(chunk.metadata);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
      }
    } else if (chunk.fourCc === "ICCP") {
      namespaces.add("ICC");
      if (chunk.metadata !== undefined) {
        colorProfile = chunk.metadata;
        const found = parseIcc(chunk.metadata);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
      }
    }
  }
  return {
    entries,
    warnings,
    orientation,
    colorProfile,
    namespaces: [...namespaces],
    // The resolution record lives in the EXIF IFD0 triple; it exists only when
    // both X and Y were read (a one-sided pair is no resolution).
    resolutionNamespace: sourceResolution === undefined ? undefined : "EXIF",
    sourceResolution,
  };
}

// The minimal IFD0 tags the output EXIF chunk may carry: the valid source
// orientation when requested, the source resolution triple when requested;
// undefined when neither applies (the EXIF chunk is then dropped).
function webpExifTags(
  admission: WebpAdmission,
  preserveOrientation: boolean,
  preserveResolution: boolean,
  orientation: number | undefined,
): MinimalExifTags | undefined {
  const keepOrientation = preserveOrientation && orientation !== undefined;
  const resolution = preserveResolution
    ? admission.sourceResolution
    : undefined;
  if (keepOrientation && resolution !== undefined)
    return { orientation, resolution };
  if (keepOrientation) return { orientation };
  if (resolution !== undefined) return { resolution };
  return undefined;
}

function buildOutputPlan(
  admission: WebpAdmission,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  orientation: number | undefined,
): readonly WebpOutputChunk[] {
  const parsed = admission.parsed;
  const exifTags = webpExifTags(
    admission,
    preserveOrientation,
    preserveResolution,
    orientation,
  );
  const plan: WebpOutputChunk[] = [];
  for (const chunk of parsed.chunks) {
    if (chunk.fourCc === "XMP ") continue;
    if (chunk.fourCc === "ICCP" && !preserveColorProfile) continue;
    if (chunk.fourCc === "EXIF") {
      if (exifTags !== undefined) {
        const data = createMinimalExif(exifTags);
        plan.push({ fourCc: "EXIF", size: data.length, data });
      }
      continue;
    }
    if (chunk.fourCc === "VP8X") {
      const data = Buffer.from(parsed.vp8x?.data ?? Buffer.alloc(0));
      let flags = (data[0] ?? 0) & ~0x2c;
      if (
        preserveColorProfile &&
        parsed.chunks.some((item) => item.fourCc === "ICCP")
      )
        flags |= 0x20;
      if (exifTags !== undefined) flags |= 0x08;
      data[0] = flags;
      plan.push({ fourCc: "VP8X", size: data.length, data });
      continue;
    }
    plan.push({ fourCc: chunk.fourCc, size: chunk.size, source: chunk });
  }
  // KIT-08 (D-14 amendment): when every extended feature has been stripped
  // (the planned VP8X flags byte is 0) the only chunk left beside VP8X is the
  // single VP8 or VP8L bitstream (`parseWebp` admits ALPH, ANIM and ANMF only
  // together with the VP8X flags that keep the flags byte non-zero), so drop
  // VP8X and write simple-format WebP -- matching what ExifTool's own `-all=`
  // sanitize produces. Only a planned VP8X chunk can lead a plan that holds
  // inline data (`parseWebp` requires VP8X first and admits EXIF only behind
  // it), so the first data byte of the plan is that flags byte. `parseWebp`
  // already requires the VP8X canvas dimensions to match the VP8/VP8L
  // bitstream header exactly (src/webp/riff.ts), so dropping the canvas size
  // here is safe: the simple-format bitstream header alone still encodes the
  // true dimensions. `verifyOutput` re-parses the result, which refuses a
  // simple-format container that holds any other chunk.
  if (plan[0]?.data?.[0] === 0) return plan.slice(1);
  return plan;
}

export function webpOutputSize(plan: readonly WebpOutputChunk[]): number {
  return plan.reduce(
    (total, chunk) => total + 8 + chunk.size + (chunk.size & 1),
    12,
  );
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

async function copyChunkData(
  source: FileHandle,
  destination: FileHandle,
  chunk: WebpChunk,
  position: number,
  signal?: AbortSignal,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(
    Math.min(COPY_BLOCK_BYTES, Math.max(chunk.size, 1)),
  );
  let copied = 0;
  while (copied < chunk.size) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const length = Math.min(buffer.length, chunk.size - copied);
    const read = await source.read(
      buffer,
      0,
      length,
      chunk.dataOffset + copied,
    );
    if (read.bytesRead !== length)
      throw new Error("Source changed or became truncated while copying.");
    let written = 0;
    while (written < length) {
      const result = await destination.write(
        buffer,
        written,
        length - written,
        position + copied + written,
      );
      if (result.bytesWritten === 0)
        throw new Error("A file write made no progress.");
      written += result.bytesWritten;
    }
    copied += length;
  }
  return position + copied;
}

async function chunksEqual(
  sourceHandle: FileHandle,
  source: WebpChunk,
  destinationHandle: FileHandle,
  destination: WebpChunk,
  signal?: AbortSignal,
): Promise<boolean> {
  if (source.size !== destination.size) return false;
  const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(source.size, 1));
  const sourceBuffer = Buffer.allocUnsafe(bufferSize);
  const destinationBuffer = Buffer.allocUnsafe(bufferSize);
  for (let offset = 0; offset < source.size;) {
    if (isAborted(signal))
      // Stryker disable next-line LogicalOperator, StringLiteral: unobservable-message — verifyOutput is the only caller and its catch discards the cause whenever the signal is aborted, reporting the typed aborted error; neither the abort reason nor the fallback exception's name or message reaches any result.
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const length = Math.min(COPY_BLOCK_BYTES, source.size - offset);
    // Keep the two bounded reads serialized.  Concurrent MiB reads make the
    // verification pass contend for libuv's file-I/O scheduling window and
    // can create large tail-latency spikes on fresh benchmark children.
    const left = await sourceHandle.read(
      sourceBuffer,
      0,
      length,
      source.dataOffset + offset,
    );
    const right = await destinationHandle.read(
      destinationBuffer,
      0,
      length,
      destination.dataOffset + offset,
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

const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);

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
  admission: WebpAdmission,
  destinationHandle: FileHandle,
  destinationSize: number,
  destinationPath: string,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  expectedOrientation: number | undefined,
  signal?: AbortSignal,
): Promise<Result<void>> {
  const source = admission.parsed;
  try {
    const destination = await parseWebp(
      destinationHandle,
      destinationSize,
      signal,
    );
    if (destination.chunks.some((chunk) => chunk.fourCc === "XMP "))
      return err(
        verificationError("XMP remained after sanitization.", destinationPath),
      );
    const sourceIcc = source.chunks.find((chunk) => chunk.fourCc === "ICCP");
    const destinationIcc = destination.chunks.find(
      (chunk) => chunk.fourCc === "ICCP",
    );
    if (preserveColorProfile && sourceIcc !== undefined) {
      if (
        destinationIcc === undefined ||
        !(await chunksEqual(
          sourceHandle,
          sourceIcc,
          destinationHandle,
          destinationIcc,
          signal,
        ))
      )
        return err(
          verificationError(
            "ICC color profile was not preserved byte-for-byte.",
            destinationPath,
          ),
        );
    } else if (destinationIcc !== undefined)
      return err(
        verificationError(
          "ICC metadata remained after sanitization.",
          destinationPath,
        ),
      );
    const destinationExif = destination.chunks.find(
      (chunk) => chunk.fourCc === "EXIF",
    );
    // The expected tag set is recomputed here from the request flags and the
    // source admission, never read back from the output plan.
    const wantsOrientation =
      preserveOrientation && expectedOrientation !== undefined;
    const expectedResolution = preserveResolution
      ? admission.sourceResolution
      : undefined;
    if (wantsOrientation || expectedResolution !== undefined) {
      const exifData = destinationExif?.metadata;
      if (
        exifData === undefined ||
        !exifData.equals(
          createMinimalExif({
            ...(wantsOrientation ? { orientation: expectedOrientation } : {}),
            ...(expectedResolution !== undefined
              ? { resolution: expectedResolution }
              : {}),
          }),
        )
      )
        return err(
          verificationError(
            "EXIF chunk did not match the requested minimal tags.",
            destinationPath,
          ),
        );
    } else if (destinationExif !== undefined)
      return err(
        verificationError(
          "EXIF metadata remained after sanitization.",
          destinationPath,
        ),
      );
    const sourcePayload = source.chunks.filter((chunk) =>
      PAYLOAD_CHUNKS.has(chunk.fourCc),
    );
    const destinationPayload = destination.chunks.filter((chunk) =>
      PAYLOAD_CHUNKS.has(chunk.fourCc),
    );
    if (sourcePayload.length !== destinationPayload.length)
      return err(
        verificationError(
          "Image or animation chunk count changed.",
          destinationPath,
        ),
      );
    for (let index = 0; index < sourcePayload.length; index += 1) {
      const left = sourcePayload[index];
      const right = destinationPayload[index];
      if (
        left === undefined ||
        right === undefined ||
        left.fourCc !== right.fourCc ||
        !(await chunksEqual(
          sourceHandle,
          left,
          destinationHandle,
          right,
          signal,
        ))
      )
        return err(
          verificationError(
            "Image or animation payload bytes changed.",
            destinationPath,
          ),
        );
    }
    return ok(undefined);
  } catch (cause) {
    if (isAborted(signal)) return err(verificationAborted(destinationPath));
    return err(
      verificationError(
        cause instanceof WebpStructureError
          ? cause.message
          : "Could not reopen and verify the destination.",
        destinationPath,
      ),
    );
  }
}

const capability: WebpCapabilities = Object.freeze({
  format: "webp" as const,
  mimeTypes: Object.freeze(["image/webp"] as const),
  extensions: Object.freeze([".webp"] as const),
  inspect: true as const,
  sanitize: true as const,
  preserves: Object.freeze({
    orientation: true as const,
    colorProfile: true as const,
    timestamps: true as const,
    resolution: true as const,
    imagePayload: true as const,
    animationPayload: true as const,
  }),
  animation: Object.freeze({
    supported: true as const,
    payloadPreservation: "byte-for-byte" as const,
    boundary: "aggregate-chunk-count" as const,
  }),
  validation: Object.freeze({
    container: "full" as const,
    codecBitstream: "header-only" as const,
  }),
  colorProfile: Object.freeze({
    policy: ICC_PRESERVATION_POLICY_ID,
    preservation: "preserve-if-present" as const,
    versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"] as const),
    classes: Object.freeze(["scnr", "mntr"] as const),
    spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "] as const),
    maxProfileBytes: MAX_BUFFERED_METADATA_BYTES,
    maxTagCount: 4_096,
  }),
  limits: Object.freeze({
    maxMetadataBytesPerChunk: MAX_BUFFERED_METADATA_BYTES,
    maxChunkCount: MAX_CHUNK_COUNT,
    maxRiffBytes: MAX_RIFF_BYTES,
  }),
  refuses: Object.freeze([
    "unknown-chunks",
    "malformed-container",
    "unsupported-features",
    "resource-limits",
    "trailing-data",
  ] as const),
  removes: Object.freeze(["EXIF", "XMP", "ICC"] as const),
  detection: "magic" as const,
});

export const webpHandler: FormatHandler<WebpAdmission, WebpOutputPlan> =
  Object.freeze({
    capability,
    stagingFileName: "output.webp",
    matches(magic: Buffer): boolean {
      // A magic shorter than 12 bytes yields a form-type slice shorter than four characters, which
      // can never equal the signature, so no separate length test is needed.
      return (
        magic.subarray(0, 4).toString("ascii") === "RIFF" &&
        magic.subarray(8, 12).toString("ascii") === "WEBP"
      );
    },
    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<WebpAdmission> {
      const parsed = await parseWebp(handle, size, signal);
      return { parsed, ...collectMetadata(parsed) };
    },
    inspect(admission: WebpAdmission): Inspection {
      return {
        format: "webp",
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },
    buildOutputPlan,
    checkOutputPlan(plan: readonly WebpOutputChunk[]): string | undefined {
      return plan.length === 0 || webpOutputSize(plan) > MAX_RIFF_BYTES
        ? "Sanitized output exceeds RIFF limits."
        : undefined;
    },
    classifyAdmissionFailure(
      cause: unknown,
      preserveColorProfile: boolean,
    ): AdmissionDeclineDetail | undefined {
      if (!(cause instanceof WebpStructureError)) return undefined;
      if (preserveColorProfile && cause.metadataLimit?.fourCc === "ICCP")
        return {
          code: "unsupported-feature",
          detail: `ICC profile size ${cause.metadataLimit.size} exceeds the ${cause.metadataLimit.limit}-byte policy limit.`,
          feature: "color-profile-preservation",
          reason: "policy-limit",
        };
      return { code: cause.kind, detail: cause.message };
    },
    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: readonly WebpOutputChunk[],
      signal?: AbortSignal,
    ): Promise<void> {
      const size = webpOutputSize(plan);
      let position = await writeAll(destination, encodeRiffHeader(size), 0);
      for (const chunk of plan) {
        if (isAborted(signal))
          throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        position = await writeAll(
          destination,
          encodeChunkHeader(chunk.fourCc, chunk.size),
          position,
        );
        position =
          chunk.data !== undefined
            ? await writeAll(destination, chunk.data, position)
            : chunk.source !== undefined
              ? await copyChunkData(
                  source,
                  destination,
                  chunk.source,
                  position,
                  signal,
                )
              : (() => {
                  throw new Error(
                    "Output plan contains a chunk with no data source.",
                  );
                })();
        if (chunk.size & 1)
          position = await writeAll(destination, Buffer.alloc(1), position);
      }
      if (position !== size)
        throw new Error("Output size did not match its RIFF declaration.");
    },
    verifyOutput,
  });
