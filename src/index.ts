export { getCapabilities, inspectFile, sanitizeFile } from "./engine.js";
export { classifyFallback } from "./fallback.js";
export { err, ok } from "./result.js";
export type {
  Capabilities,
  CommonFormatCapabilities,
  FallbackDisposition,
  FormatCapabilities,
  Inspection,
  InspectOptions,
  JsonSafeCause,
  MetadataEntry,
  MetadataError,
  MetadataValue,
  MetadataWarning,
  NativeFormat,
  PostCommitResidue,
  Result,
  SanitizeOptions,
  SanitizeResult,
  WebpCapabilities,
} from "./types.js";
