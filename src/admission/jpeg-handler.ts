import type { FileHandle } from "node:fs/promises";
import {
  parseExif,
  readIfd0Resolution,
  type MinimalExifResolution,
} from "../metadata/exif.js";
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
  JpegCapabilities,
  MetadataEntry,
  MetadataError,
  MetadataWarning,
  Result,
} from "../types.js";
import {
  APP0,
  APP1,
  APP2,
  APP14,
  COM,
  DHT,
  DQT,
  DRI,
  EOI,
  JPEG_MAX_EXTENDED_XMP_BYTES,
  JPEG_MAX_FILE_BYTES,
  JPEG_MAX_ICC_SEGMENTS,
  JPEG_MAX_SCAN_COUNT,
  JPEG_MAX_SEGMENT_COUNT,
  JPEG_MAX_TABLE_SEGMENT_COUNT,
  JPEG_ADMITTED_SOF_MARKERS,
  JPEG_REFUSAL_DETAILS,
  SOI,
  SOS,
  isAppMarker,
} from "../jpeg/markers.js";
import {
  JpegStructureError,
  isJpegSignature,
  parseJpeg,
  type JpegSegment,
  type ParsedJpeg,
} from "../jpeg/parser.js";
import { ICC_SEGMENT_IDENTIFIER, reassembleIccSegments } from "../jpeg/icc.js";
import { STANDARD_XMP_IDENTIFIER } from "../jpeg/xmp.js";
import {
  classifyTrailerClasses,
  trailerRefusal,
  type JpegTrailerClass,
} from "../jpeg/trailer.js";
import {
  ICC_PRESERVATION_POLICY_ID,
  MAX_PROFILE_BYTES,
} from "../metadata/icc_admission.js";

// JPEG's admission surface (D-01, D-02, D-06, D-09/D-10/D-13, D-15 analog).
// Mirrors png-handler.ts's structure (collectMetadata / buildOutputPlan /
// verifyOutput / classifyAdmissionFailure / capability literal / handler
// object). Must not import anything from src/png or src/webp (57-03
// prohibition) -- format knowledge lives here and in src/jpeg/.

/** Restates src/types.ts's private `MetadataNamespace` alias (D-15 analog). */
type JpegMetadataNamespace = "EXIF" | "XMP" | "ICC" | "C2PA" | "JPEG";

export type JpegSegmentClass =
  | "structural"
  | "keep"
  | "conditional-color"
  | "conditional-resolution"
  | "remove";

export interface JpegAdmission extends FormatAdmission {
  readonly parsed: ParsedJpeg;
  /** One classification per entry in `parsed.segments`, same index order. */
  readonly classes: readonly JpegSegmentClass[];
  /** The `parsed.segments` index of the source's (first) Exif segment. */
  readonly exifSlot: number | undefined;
  /** D-06: true when an APP0 JFIF segment was removed unconditionally because
   * an APP14 Adobe segment is also present, regardless of preserveResolution. */
  readonly jfifDroppedForAdobe: boolean;
  /** The source's raw (unreduced) IFD0 X/YResolution, if its Exif carries one. */
  readonly sourceResolution: MinimalExifResolution | undefined;
  readonly trailerClasses: ReadonlySet<JpegTrailerClass>;
}

export type JpegOutputPlanPart =
  | {
      readonly kind: "copy";
      readonly sourceOffset: number;
      readonly length: number;
    }
  | { readonly kind: "insert"; readonly data: Buffer };

export interface JpegOutputPlan {
  readonly parts: readonly JpegOutputPlanPart[];
  readonly expectedMarkers: readonly number[];
  readonly copiedRanges: readonly {
    readonly sourceOffset: number;
    readonly length: number;
  }[];
  readonly preserveResolution: boolean;
  /**
   * Fail-closed placeholder (until 57-06 lands): set when the plan was built
   * with preserveResolution true and the source carries an EXIF IFD0
   * resolution -- JPEG resolution synthesis is not yet admitted, so
   * checkOutputPlan declines before any write.
   */
  readonly declineReason?: string;
}

const COPY_BLOCK_BYTES = 64 * 1024;
const TRAILER_TAIL_BYTES = 64;
const JPEG_SOI_BYTES = Buffer.from([0xff, SOI]);
const JPEG_EOI_BYTES = Buffer.from([0xff, EOI]);

const JFIF_PREFIX = Buffer.from("JFIF\0", "ascii");
const EXIF_PREFIX = Buffer.from("Exif\0\0", "ascii");
const ADOBE_PREFIX = Buffer.from("Adobe", "ascii");
const MPF_PREFIX = Buffer.from("MPF\0", "ascii");
const ICC_PROFILE_PREFIX = Buffer.from(`${ICC_SEGMENT_IDENTIFIER}\0`, "ascii");
const XMP_STANDARD_PREFIX = Buffer.from(STANDARD_XMP_IDENTIFIER, "ascii");
// APP11 (JUMBF/C2PA) and APP13 (Photoshop) have no admitted constants in
// src/jpeg/markers.ts -- both are treated generically there (every APPn is
// admitted structurally); their D-01/D-02 meaning is format-handler-only.
const APP11 = 0xeb;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function startsWith(payload: Buffer, prefix: Buffer): boolean {
  return (
    payload.length >= prefix.length &&
    payload.subarray(0, prefix.length).equals(prefix)
  );
}

type AppSegmentKind =
  "jfif" | "exif" | "xmp" | "icc" | "mpf" | "adobe" | "other";

/**
 * Classifies an APPn segment's raw payload (as buffered by `parseJpeg`) by
 * matching its own identifying byte prefix directly -- never the 32-byte
 * NUL-truncated `JpegSegment.identifier` field, which can misclassify a
 * genuine Adobe/JFIF/MPF segment if its content bytes happen to place the
 * first NUL byte somewhere other than immediately after the identifier
 * string. `payload` is `undefined` for every segment `parseJpeg` did not
 * buffer (COM, APP13, APP11, unknown APPn, and any duplicate jfif/exif/xmp/
 * mpf beyond the first) -- all correctly fall through to "other".
 */
function classifyAppSegment(
  marker: number,
  payload: Buffer | undefined,
): AppSegmentKind {
  if (payload === undefined) return "other";
  if (marker === APP0 && startsWith(payload, JFIF_PREFIX)) return "jfif";
  if (marker === APP1 && startsWith(payload, EXIF_PREFIX)) return "exif";
  if (marker === APP1 && startsWith(payload, XMP_STANDARD_PREFIX)) return "xmp";
  if (marker === APP2 && startsWith(payload, ICC_PROFILE_PREFIX)) return "icc";
  if (marker === APP2 && startsWith(payload, MPF_PREFIX)) return "mpf";
  if (marker === APP14 && startsWith(payload, ADOBE_PREFIX)) return "adobe";
  return "other";
}

function isStructuralMarker(marker: number): boolean {
  return (
    marker === SOS ||
    marker === DQT ||
    marker === DHT ||
    marker === DRI ||
    JPEG_ADMITTED_SOF_MARKERS.has(marker)
  );
}

/**
 * D-01's closed classification rule, the single source of truth for what
 * survives sanitization -- used both by `collectMetadata` (to decide what to
 * report and to build the output plan from) and independently re-run by
 * `verifyOutput` against the reparsed destination, so a bug in
 * `buildOutputPlan`/`writeOutput` can never leak a removed identifier past
 * verification undetected.
 */
function classifySegments(parsed: ParsedJpeg): readonly JpegSegmentClass[] {
  const adobePresent = parsed.segments.some(
    (segment, index) =>
      classifyAppSegment(segment.marker, parsed.buffered.get(index)) ===
      "adobe",
  );
  return parsed.segments.map((segment, index) => {
    const { marker } = segment;
    if (isStructuralMarker(marker)) return "structural";
    if (marker === COM || !isAppMarker(marker)) return "remove";
    const kind = classifyAppSegment(marker, parsed.buffered.get(index));
    if (kind === "adobe") return "keep";
    if (kind === "jfif")
      return adobePresent ? "remove" : "conditional-resolution";
    if (kind === "icc") return "conditional-color";
    // exif, xmp, mpf and "other" (APP0 JFXX, APP11, APP13, non-Adobe APP14,
    // APP15, unknown identifiers, duplicates beyond the first) are all
    // removed unconditionally (D-01).
    return "remove";
  });
}

/**
 * Extracted to a real function boundary so TypeScript widens `orientation`'s
 * type from its narrowed initializer literal (`{status:"absent"}`) instead of
 * carrying that narrowing past `collectMetadata`'s `parsed.segments.forEach`
 * closure, where every reassignment happens (mirrors png-handler.ts's
 * `validOrientationValue` precedent for the same TS control-flow limitation).
 */
function isValidOrientation(state: OrientationState): boolean {
  return state.status === "valid";
}

function isKept(
  cls: JpegSegmentClass,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
): boolean {
  if (cls === "structural" || cls === "keep") return true;
  if (cls === "conditional-color") return preserveColorProfile;
  if (cls === "conditional-resolution") return preserveResolution;
  return false;
}

function collectMetadata(
  parsed: ParsedJpeg,
  trailerTail: Buffer,
): Omit<JpegAdmission, "parsed"> {
  const entries: MetadataEntry[] = [];
  const warnings: MetadataWarning[] = [];
  let orientation: OrientationState = { status: "absent" };
  const iccPayloads: Buffer[] = [];
  let colorProfile: Buffer | undefined;
  const namespaces = new Set<JpegMetadataNamespace>();
  let resolutionNamespace: JpegMetadataNamespace | undefined;
  let exifSlot: number | undefined;
  let jfifDroppedForAdobe = false;
  let jfifConditionallyKept = false;
  let sourceResolution: MinimalExifResolution | undefined;
  let mpfPayload: Buffer | undefined;
  const xmpEntries: MetadataEntry[] = [];

  const classes = classifySegments(parsed);

  parsed.segments.forEach((segment, index) => {
    const cls = classes[index];
    const { marker } = segment;
    if (cls === "structural" || cls === "keep") return;
    if (cls === "conditional-color") {
      namespaces.add("ICC");
      const payload = parsed.buffered.get(index);
      if (payload !== undefined) iccPayloads.push(payload);
      return;
    }
    if (cls === "conditional-resolution") {
      jfifConditionallyKept = true;
      return;
    }
    // cls === "remove"
    if (marker === COM) {
      namespaces.add("JPEG");
      return;
    }
    const payload = parsed.buffered.get(index);
    const kind = classifyAppSegment(marker, payload);
    if (kind === "jfif") {
      // The only way a JFIF segment classifies "remove" is D-06's Adobe drop.
      namespaces.add("JPEG");
      jfifDroppedForAdobe = true;
      return;
    }
    if (kind === "exif") {
      namespaces.add("EXIF");
      exifSlot = index;
      if (payload !== undefined) {
        const found = parseExif(payload);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
        orientation = found.orientation;
        const tiff = startsWith(payload, EXIF_PREFIX)
          ? payload.subarray(EXIF_PREFIX.length)
          : payload;
        sourceResolution = readIfd0Resolution(tiff);
      }
      return;
    }
    if (kind === "xmp") {
      namespaces.add("XMP");
      if (payload !== undefined) {
        const found = parseXmp(payload.subarray(XMP_STANDARD_PREFIX.length));
        entries.push(...found.entries);
        warnings.push(...found.warnings);
        xmpEntries.push(...found.entries);
      }
      return;
    }
    if (kind === "mpf") {
      namespaces.add("JPEG");
      if (payload !== undefined) mpfPayload = payload;
      return;
    }
    if (marker === APP11) {
      namespaces.add("C2PA");
      entries.push({
        namespace: "C2PA",
        name: "JUMBF",
        value: segment.payloadLength,
      });
      return;
    }
    // APP0 JFXX, APP13 Photoshop, non-Adobe APP14, APP15, unknown
    // identifiers, and duplicate jfif/exif/xmp/mpf beyond the first.
    namespaces.add("JPEG");
  });

  // Fail-closed placeholder (until 57-06 lands): a valid source Orientation
  // always declines pre-write via engine.ts's generic orientation-
  // preservation check, since JPEG orientation synthesis is not yet admitted.
  if (isValidOrientation(orientation)) {
    orientation = {
      status: "unsupported",
      detail: "JPEG orientation preservation is not yet admitted.",
    };
  }

  if (iccPayloads.length > 0) {
    colorProfile = reassembleIccSegments(iccPayloads);
  }

  const fileSize = parsed.primaryEoiEnd + parsed.trailerBytes;
  const trailerClasses = classifyTrailerClasses({
    mpfPayload,
    xmpEntries,
    trailerTail,
    trailerBytes: parsed.trailerBytes,
    fileSize,
  });
  const refusal = trailerRefusal(trailerClasses);
  if (refusal !== undefined) {
    throw new JpegStructureError(refusal, JPEG_REFUSAL_DETAILS[refusal]);
  }

  // D-06: EXIF wins when the source carries its own IFD0 resolution; else
  // JFIF is the resolution source only when it was not dropped for Adobe;
  // else the source has no resolution to preserve.
  if (sourceResolution !== undefined) resolutionNamespace = "EXIF";
  else if (jfifConditionallyKept) resolutionNamespace = "JPEG";

  return {
    entries,
    warnings,
    orientation,
    colorProfile,
    namespaces: [...namespaces],
    resolutionNamespace,
    classes,
    exifSlot,
    jfifDroppedForAdobe,
    sourceResolution,
    trailerClasses,
  };
}

function buildOutputPlan(
  admission: JpegAdmission,
  _preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  _orientation: number | undefined,
): JpegOutputPlan {
  const parts: JpegOutputPlanPart[] = [];
  const expectedMarkers: number[] = [];
  const copiedRanges: { sourceOffset: number; length: number }[] = [];
  let pendingStart: number | undefined;
  let pendingEnd: number | undefined;

  const flush = (): void => {
    if (pendingStart === undefined || pendingEnd === undefined) return;
    const length = pendingEnd - pendingStart;
    parts.push({ kind: "copy", sourceOffset: pendingStart, length });
    copiedRanges.push({ sourceOffset: pendingStart, length });
    pendingStart = undefined;
    pendingEnd = undefined;
  };

  admission.parsed.segments.forEach((segment, index) => {
    const cls = admission.classes[index] ?? "remove";
    if (!isKept(cls, preserveColorProfile, preserveResolution)) {
      flush();
      return;
    }
    const segmentStart = segment.offset;
    const segmentEnd = segment.offset + segment.totalLength;
    if (pendingEnd === segmentStart) {
      pendingEnd = segmentEnd;
    } else {
      flush();
      pendingStart = segmentStart;
      pendingEnd = segmentEnd;
    }
    expectedMarkers.push(segment.marker);
  });
  flush();

  const declineReason =
    preserveResolution && admission.sourceResolution !== undefined
      ? "JPEG resolution synthesis is not yet admitted."
      : undefined;

  return {
    parts,
    expectedMarkers,
    copiedRanges,
    preserveResolution,
    ...(declineReason === undefined ? {} : { declineReason }),
  };
}

function recomputeExpectedMarkers(
  admission: JpegAdmission,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
): readonly number[] {
  const markers: number[] = [];
  admission.parsed.segments.forEach((segment, index) => {
    const cls = admission.classes[index] ?? "remove";
    if (isKept(cls, preserveColorProfile, preserveResolution))
      markers.push(segment.marker);
  });
  return markers;
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

async function readTail(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const next = await handle.read(
      result,
      read,
      length - read,
      position + read,
    );
    if (next.bytesRead === 0) break;
    read += next.bytesRead;
  }
  return result;
}

async function segmentsEqual(
  sourceHandle: FileHandle,
  source: JpegSegment,
  destinationHandle: FileHandle,
  destination: JpegSegment,
  signal?: AbortSignal,
): Promise<boolean> {
  if (source.totalLength !== destination.totalLength) return false;
  const span = source.totalLength;
  const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(span, 1));
  const sourceBuffer = Buffer.allocUnsafe(bufferSize);
  const destinationBuffer = Buffer.allocUnsafe(bufferSize);
  for (let offset = 0; offset < span;) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const length = Math.min(COPY_BLOCK_BYTES, span - offset);
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
  admission: JpegAdmission,
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
    const destination = await parseJpeg(
      destinationHandle,
      destinationSize,
      signal,
    );

    if (destination.trailerBytes !== 0)
      return err(
        verificationError(
          "Destination retains trailer bytes after the primary EOI.",
          destinationPath,
        ),
      );

    const expectedMarkers = recomputeExpectedMarkers(
      admission,
      preserveColorProfile,
      preserveResolution,
    );
    const destinationMarkers = destination.segments.map(
      (segment) => segment.marker,
    );
    if (
      destinationMarkers.length !== expectedMarkers.length ||
      destinationMarkers.some(
        (marker, index) => marker !== expectedMarkers[index],
      )
    )
      return err(
        verificationError(
          "Destination marker sequence did not match the sanitized plan.",
          destinationPath,
        ),
      );

    // D-01: independently re-derive the destination's own classification --
    // never merely trust the marker-sequence check above -- so a removed
    // identifier that somehow survived is always caught here.
    const destinationClasses = classifySegments(destination);
    for (const [index, cls] of destinationClasses.entries()) {
      if (!isKept(cls, preserveColorProfile, preserveResolution)) {
        const marker = destination.segments[index]?.marker ?? 0;
        return err(
          verificationError(
            `Marker 0x${marker.toString(16)} remained after sanitization.`,
            destinationPath,
          ),
        );
      }
    }

    const sourceKept = admission.parsed.segments.filter((_segment, index) =>
      isKept(
        admission.classes[index] ?? "remove",
        preserveColorProfile,
        preserveResolution,
      ),
    );
    if (sourceKept.length !== destination.segments.length)
      return err(
        verificationError(
          "Destination segment count did not match the sanitized plan.",
          destinationPath,
        ),
      );
    for (let index = 0; index < sourceKept.length; index += 1) {
      const left = sourceKept[index];
      const right = destination.segments[index];
      if (
        left === undefined ||
        right === undefined ||
        left.marker !== right.marker ||
        !(await segmentsEqual(
          sourceHandle,
          left,
          destinationHandle,
          right,
          signal,
        ))
      )
        return err(
          verificationError(
            "Kept JPEG segment bytes changed.",
            destinationPath,
          ),
        );
    }

    return ok(undefined);
  } catch (cause) {
    if (isAborted(signal)) return err(verificationAborted(destinationPath));
    return err(
      verificationError(
        cause instanceof JpegStructureError
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
  if (!(cause instanceof JpegStructureError)) return undefined;
  if (preserveColorProfile && cause.limit?.segment === ICC_SEGMENT_IDENTIFIER)
    return {
      code: "unsupported-feature",
      detail: `ICC profile size ${cause.limit.size} exceeds the ${cause.limit.limit}-byte policy limit.`,
      feature: "color-profile-preservation",
      reason: "policy-limit",
    };
  return { code: cause.kind, detail: cause.message };
}

const capability: JpegCapabilities = Object.freeze({
  format: "jpeg" as const,
  mimeTypes: Object.freeze(["image/jpeg"] as const),
  extensions: Object.freeze([".jpg", ".jpeg"] as const),
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
    maxFileBytes: JPEG_MAX_FILE_BYTES,
    maxSegmentCount: JPEG_MAX_SEGMENT_COUNT,
    maxScanCount: JPEG_MAX_SCAN_COUNT,
    maxTableSegmentCount: JPEG_MAX_TABLE_SEGMENT_COUNT,
    maxIccSegments: JPEG_MAX_ICC_SEGMENTS,
    maxReassembledIccBytes: MAX_PROFILE_BYTES,
    maxExtendedXmpBytes: JPEG_MAX_EXTENDED_XMP_BYTES,
  }),
  refuses: Object.freeze([
    "malformed-container",
    "truncation",
    "undefined-table-reference",
    "lossless-frame",
    "hierarchical-frame",
    "arithmetic-frame",
    "non-t81-frame",
    "non-8-bit-precision",
    "unsupported-component-count",
    "dnl-marker",
    "resource-limits",
    "mpf-secondary-image",
  ] as const),
  removes: Object.freeze(["EXIF", "XMP", "ICC", "C2PA", "JPEG"] as const),
  detection: "magic" as const,
});

export const jpegHandler: FormatHandler<JpegAdmission, JpegOutputPlan> =
  Object.freeze({
    capability,
    stagingFileName: "output.jpg",
    matches(magic: Buffer): boolean {
      return isJpegSignature(magic);
    },
    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<JpegAdmission> {
      const parsed = await parseJpeg(handle, size, signal);
      const trailerStart = Math.max(
        parsed.primaryEoiEnd,
        size - TRAILER_TAIL_BYTES,
      );
      const trailerLength = size - trailerStart;
      const trailerTail =
        trailerLength > 0
          ? await readTail(handle, trailerLength, trailerStart)
          : Buffer.alloc(0);
      return { parsed, ...collectMetadata(parsed, trailerTail) };
    },
    inspect(admission: JpegAdmission): Inspection {
      return {
        format: "jpeg",
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },
    buildOutputPlan,
    checkOutputPlan(plan: JpegOutputPlan): string | undefined {
      if (plan.declineReason !== undefined) return plan.declineReason;
      return plan.expectedMarkers.includes(SOS)
        ? undefined
        : "Sanitized JPEG plan is empty.";
    },
    classifyAdmissionFailure,
    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: JpegOutputPlan,
      signal?: AbortSignal,
    ): Promise<void> {
      let position = await writeAll(destination, JPEG_SOI_BYTES, 0);
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
      await writeAll(destination, JPEG_EOI_BYTES, position);
    },
    verifyOutput,
  });
