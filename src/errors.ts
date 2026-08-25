import type {
  JsonSafeCause,
  MetadataError,
  MetadataErrorDetails,
  NativeWriteState,
  FallbackProof,
} from "./types.js";

interface NodeErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

export function jsonSafeCause(cause: unknown): JsonSafeCause {
  if (typeof cause === "object" && cause !== null) {
    const candidate: NodeErrorLike = cause;
    const message =
      typeof candidate.message === "string" ? candidate.message : String(cause);
    if (typeof candidate.code === "string") {
      return { code: candidate.code, message };
    }
    return { message };
  }
  return { message: String(cause) };
}

export function isNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as NodeErrorLike).code === code
  );
}

export function aborted(path?: string): MetadataError {
  const error: MetadataErrorDetails =
    path === undefined
      ? { code: "aborted", detail: "The operation was aborted." }
      : { code: "aborted", detail: "The operation was aborted.", path };
  return requestError(error);
}

function withProof<T extends MetadataErrorDetails>(
  error: T,
  phase: MetadataError["phase"],
  nativeWrite: NativeWriteState,
): T & FallbackProof {
  return { ...error, phase, nativeWrite };
}

export function requestError<T extends MetadataErrorDetails>(
  error: T,
): T & FallbackProof {
  return withProof(error, "request", "not-started");
}

export function sourceOpenError<T extends MetadataErrorDetails>(
  error: T,
): T & FallbackProof {
  return withProof(error, "source-open", "not-started");
}

export function admissionDecline<T extends MetadataErrorDetails>(
  error: T,
): T & FallbackProof {
  return withProof(error, "admission", "not-started");
}

export function executionError<T extends MetadataErrorDetails>(
  error: T,
  nativeWrite: NativeWriteState,
): T & FallbackProof {
  return withProof(error, "transaction", nativeWrite);
}
