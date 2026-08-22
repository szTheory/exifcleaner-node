import type { JsonSafeCause, MetadataError } from "./types.js";

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
  return path === undefined
    ? { code: "aborted", detail: "The operation was aborted." }
    : { code: "aborted", detail: "The operation was aborted.", path };
}
