import type { FallbackDisposition, MetadataError } from "./types.js";

export function classifyFallback(error: MetadataError): FallbackDisposition {
  return error.phase === "admission" && error.nativeWrite === "not-started"
    ? "safe-to-fallback"
    : "do-not-fallback";
}
