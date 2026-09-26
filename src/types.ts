export type Result<T, E = MetadataError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type NativeFormat = "webp" | "png";

/**
 * The closed set of metadata namespaces this package can report inspecting,
 * removing, or preserving (D-15, 56-CONTEXT.md). Deliberately not exported:
 * every exported member of this module that needs it (`MetadataEntry`,
 * `SanitizeResult`) references it directly, and other modules restate the
 * same literal union rather than importing it (see `admission/handler.ts`).
 */
type MetadataNamespace = "EXIF" | "XMP" | "ICC" | "PNG" | "C2PA";

export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly MetadataValue[]
  | { readonly [key: string]: MetadataValue };

export interface MetadataEntry {
  readonly namespace: MetadataNamespace;
  readonly name: string;
  readonly value: MetadataValue;
}

export interface MetadataWarning {
  readonly code:
    "metadata-truncated" | "metadata-invalid" | "metadata-unsupported";
  readonly detail: string;
}

export interface Inspection {
  readonly format: NativeFormat;
  readonly entries: readonly MetadataEntry[];
  readonly warnings: readonly MetadataWarning[];
}

export interface InspectOptions {
  readonly signal?: AbortSignal;
}

export interface SanitizeOptions {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
  readonly preserveResolution: boolean;
  readonly signal?: AbortSignal;
}

export interface SanitizeResult {
  readonly format: NativeFormat;
  readonly destinationPath: string;
  readonly removedNamespaces: readonly MetadataNamespace[];
  readonly preserved: {
    readonly orientation: boolean;
    readonly colorProfile: boolean;
    readonly timestamps: boolean;
    readonly resolution: boolean;
  };
  readonly warnings: readonly MetadataWarning[];
  readonly postCommitResidue: PostCommitResidue;
}

export type PostCommitResidue =
  | { readonly state: "none" }
  | {
      readonly state: "private-empty-stage-directory-remains";
      readonly cause: JsonSafeCause;
    };

export interface CommonFormatCapabilities {
  readonly format: string;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
  readonly inspect: boolean;
  readonly sanitize: boolean;
  readonly preserves: {
    readonly orientation: boolean;
    readonly colorProfile: boolean;
    readonly timestamps: boolean;
    readonly resolution: boolean;
  };
  readonly detection: "magic";
}

export interface WebpCapabilities extends CommonFormatCapabilities {
  readonly format: "webp";
  readonly mimeTypes: readonly ["image/webp"];
  readonly extensions: readonly [".webp"];
  readonly inspect: true;
  readonly sanitize: true;
  readonly preserves: {
    readonly orientation: true;
    readonly colorProfile: true;
    readonly timestamps: true;
    readonly resolution: false;
    readonly imagePayload: true;
    readonly animationPayload: true;
  };
  readonly animation: {
    readonly supported: true;
    readonly payloadPreservation: "byte-for-byte";
    readonly boundary: "aggregate-chunk-count";
  };
  readonly validation: {
    readonly container: "full";
    readonly codecBitstream: "header-only";
  };
  readonly colorProfile: {
    readonly policy: "icc-structural-v0.2";
    readonly preservation: "preserve-if-present";
    readonly versions: readonly ["v2.0-v2.4", "v4.0-v4.4"];
    readonly classes: readonly ["scnr", "mntr"];
    readonly spaces: readonly ["RGB /XYZ ", "RGB /Lab "];
    readonly maxProfileBytes: number;
    readonly maxTagCount: number;
  };
  readonly limits: {
    readonly maxMetadataBytesPerChunk: number;
    readonly maxChunkCount: number;
    readonly maxRiffBytes: 4_294_967_294;
  };
  readonly refuses: readonly [
    "unknown-chunks",
    "malformed-container",
    "unsupported-features",
    "resource-limits",
    "trailing-data",
  ];
  readonly removes: readonly ["EXIF", "XMP", "ICC"];
  readonly detection: "magic";
}

export interface PngCapabilities extends CommonFormatCapabilities {
  readonly format: "png";
  readonly mimeTypes: readonly ["image/png"];
  readonly extensions: readonly [".png"];
  readonly inspect: true;
  readonly sanitize: true;
  readonly preserves: {
    readonly orientation: true;
    readonly colorProfile: true;
    readonly timestamps: true;
    readonly resolution: true;
    readonly imagePayload: true;
    readonly animationPayload: false;
  };
  readonly validation: {
    readonly container: "full";
    readonly codecBitstream: "not-decoded";
  };
  readonly colorProfile: {
    readonly policy: "icc-structural-v0.2";
    readonly preservation: "preserve-if-present";
    readonly versions: readonly ["v2.0-v2.4", "v4.0-v4.4"];
    readonly classes: readonly ["scnr", "mntr"];
    readonly spaces: readonly ["RGB /XYZ ", "RGB /Lab "];
    readonly maxProfileBytes: number;
    readonly maxTagCount: number;
  };
  readonly limits: {
    readonly maxMetadataBytesPerChunk: number;
    readonly maxAncillaryChunkCount: number;
    readonly maxInflatedIccBytes: number;
    readonly maxInflatedTextBytes: number;
    readonly maxInflatedBytesTotal: number;
  };
  readonly refuses: readonly [
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
  ];
  readonly removes: readonly ["EXIF", "XMP", "ICC", "PNG", "C2PA"];
  readonly detection: "magic";
}

export interface Capabilities {
  readonly formats: readonly [FormatCapabilities, ...FormatCapabilities[]];
}

/**
 * The union of every registered format's capabilities, discriminated on `format`.
 * Phase 56 adds the PNG member; Phase 57 adds JPEG without changing this
 * contract's shape.
 */
export type FormatCapabilities = WebpCapabilities | PngCapabilities;

export type ColorProfileAdmissionReason =
  "invalid" | "unsupported" | "policy-limit";

export type FallbackDisposition = "safe-to-fallback" | "do-not-fallback";

export type MetadataErrorPhase =
  "request" | "source-open" | "admission" | "transaction";

export type NativeWriteState = "not-started" | "started";

export interface FallbackProof {
  readonly phase: MetadataErrorPhase;
  readonly nativeWrite: NativeWriteState;
}

export type PreCreateMetadataErrorDetails =
  | {
      readonly code: "aborted";
      readonly detail: string;
      readonly path?: string;
    }
  | {
      readonly code: "invalid-options";
      readonly detail: string;
      readonly path?: string;
    }
  | {
      readonly code: "not-found";
      readonly detail: string;
      readonly path: string;
      readonly cause?: JsonSafeCause;
    }
  | {
      readonly code: "unsupported-format";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "malformed-file";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "unsafe-structure";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "unsupported-feature";
      readonly detail: string;
      readonly path: string;
      readonly feature: "orientation-preservation";
    }
  | {
      readonly code: "unsupported-feature";
      readonly detail: string;
      readonly path: string;
      readonly feature: "color-profile-preservation";
      readonly reason: ColorProfileAdmissionReason;
    }
  | {
      readonly code: "unsupported-feature";
      readonly detail: string;
      readonly path: string;
      readonly feature: "resolution-preservation";
    }
  | {
      readonly code: "source-changed";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "destination-exists";
      readonly detail: string;
      readonly path: string;
      readonly cause?: JsonSafeCause;
    };

export type PostCreateMetadataErrorDetails =
  | {
      readonly code: "destination-changed";
      readonly detail: string;
      readonly path: string;
    }
  | {
      readonly code: "read-failed" | "write-failed" | "verification-failed";
      readonly detail: string;
      readonly path: string;
      readonly cause?: JsonSafeCause;
    }
  | {
      readonly code: "cleanup-failed";
      readonly detail: string;
      readonly path: string;
      readonly cause?: JsonSafeCause;
    };

export type MetadataErrorDetails =
  PreCreateMetadataErrorDetails | PostCreateMetadataErrorDetails;

export type MetadataError =
  | (PreCreateMetadataErrorDetails & FallbackProof)
  | (PostCreateMetadataErrorDetails &
      FallbackProof & { readonly finalization?: DestinationFinalization });

export interface JsonSafeCause {
  readonly code?: string;
  readonly message: string;
}

export type DestinationFinalization =
  | { readonly state: "owned-partial-removed" }
  | { readonly state: "already-missing" }
  | { readonly state: "replaced-and-left-untouched" }
  | {
      readonly state: "owned-partial-remains";
      readonly cause: JsonSafeCause;
    };
