export { getCapabilities, inspectFile, sanitizeFile } from "./engine.js";
export { classifyFallback } from "./fallback.js";
export { err, ok } from "./result.js";
export type {
  Capabilities,
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
  Result,
  SanitizeOptions,
  SanitizeResult,
  WebpCapabilities,
} from "./types.js";
