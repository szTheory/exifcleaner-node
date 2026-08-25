import { constants as fsConstants } from "node:fs";
import { lstat, open, rm, stat, utimes } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import {
  selectHandler,
  getRegisteredCapabilities,
} from "./admission/registry.js";
import { aborted, isNodeErrorCode, jsonSafeCause } from "./errors.js";
import { validateIccForPreservation } from "./metadata/icc_admission.js";
import { err, ok } from "./result.js";
import type {
  Capabilities,
  Inspection,
  InspectOptions,
  MetadataError,
  Result,
  SanitizeOptions,
  SanitizeResult,
} from "./types.js";
import { MAX_RIFF_BYTES, WebpStructureError } from "./webp/riff.js";

interface SourceSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
function snapshot(source: Stats): SourceSnapshot {
  return {
    dev: source.dev,
    ino: source.ino,
    size: source.size,
    mtimeMs: source.mtimeMs,
    ctimeMs: source.ctimeMs,
  };
}
function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}
function identityMatches(expected: FileIdentity, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}
function snapshotsEqual(left: SourceSnapshot, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function invalidOptions(detail: string, path?: string): Result<never> {
  return err(
    path === undefined
      ? { code: "invalid-options", detail }
      : { code: "invalid-options", detail, path },
  );
}
function structureError(
  path: string,
  cause: WebpStructureError,
): MetadataError {
  return { code: cause.kind, detail: cause.message, path };
}
function readError(path: string, cause: unknown): MetadataError {
  return isNodeErrorCode(cause, "ENOENT")
    ? {
        code: "not-found",
        detail: "Source file does not exist.",
        path,
        cause: jsonSafeCause(cause),
      }
    : {
        code: "read-failed",
        detail: "Could not read the source file.",
        path,
        cause: jsonSafeCause(cause),
      };
}
function validateRegularFile(stats: Stats, path: string): Result<void> {
  return stats.isFile()
    ? ok(undefined)
    : err({
        code: "read-failed",
        detail: "Source path is not a regular file.",
        path,
      });
}

export function getCapabilities(): Capabilities {
  return getRegisteredCapabilities();
}

export async function inspectFile(
  filePath: string,
  options: InspectOptions = {},
): Promise<Result<Inspection>> {
  if (typeof filePath !== "string" || filePath.length === 0)
    return invalidOptions("filePath must be a non-empty string.");
  if (typeof options !== "object" || options === null)
    return invalidOptions("inspectFile options must be an object.");
  if (isAborted(options.signal)) return err(aborted(filePath));
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY);
    const sourceStats = await handle.stat();
    const regular = validateRegularFile(sourceStats, filePath);
    if (!regular.ok) return regular;
    const handler = await selectHandler(handle);
    if (handler === undefined)
      return err({
        code: "unsupported-format",
        detail: "Source file is not a supported native format.",
        path: filePath,
      });
    return ok(
      handler.inspect(
        await handler.admit(handle, sourceStats.size, options.signal),
      ),
    );
  } catch (cause) {
    if (isAborted(options.signal)) return err(aborted(filePath));
    return cause instanceof WebpStructureError
      ? err(structureError(filePath, cause))
      : err(readError(filePath, cause));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanupDestination(
  path: string,
  ownedDestination: FileIdentity,
): Promise<Result<void>> {
  try {
    if (!identityMatches(ownedDestination, await lstat(path)))
      return err({
        code: "destination-changed",
        detail:
          "Destination path was replaced; the replacement was left untouched.",
        path,
      });
    await rm(path, { force: true });
    return ok(undefined);
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return ok(undefined);
    return err({
      code: "cleanup-failed",
      detail:
        "Sanitization failed and the incomplete destination could not be removed.",
      path,
      cause: jsonSafeCause(cause),
    });
  }
}

export async function sanitizeFile(
  options: SanitizeOptions,
): Promise<Result<SanitizeResult>> {
  if (typeof options !== "object" || options === null)
    return invalidOptions("sanitizeFile options are required.");
  const { sourcePath, destinationPath, signal } = options;
  if (typeof sourcePath !== "string" || sourcePath.length === 0)
    return invalidOptions("sourcePath must be a non-empty string.");
  if (typeof destinationPath !== "string" || destinationPath.length === 0)
    return invalidOptions("destinationPath must be a non-empty string.");
  if (
    typeof options.preserveOrientation !== "boolean" ||
    typeof options.preserveColorProfile !== "boolean" ||
    typeof options.preserveTimestamps !== "boolean"
  )
    return invalidOptions(
      "All preservation options must be explicit booleans.",
    );
  if (resolve(sourcePath) === resolve(destinationPath))
    return invalidOptions(
      "Source and destination paths must be different.",
      destinationPath,
    );
  if (isAborted(signal)) return err(aborted(sourcePath));

  let sourceHandle: FileHandle | undefined;
  let destinationHandle: FileHandle | undefined;
  let destinationCreated = false;
  let ownedDestination: FileIdentity | undefined;
  let failure: MetadataError | undefined;
  try {
    sourceHandle = await open(sourcePath, fsConstants.O_RDONLY);
    const sourceStats = await sourceHandle.stat();
    const regular = validateRegularFile(sourceStats, sourcePath);
    if (!regular.ok) return regular;
    const original = snapshot(sourceStats);
    const handler = await selectHandler(sourceHandle);
    if (handler === undefined)
      return err({
        code: "unsupported-format",
        detail: "Source file is not a supported native format.",
        path: sourcePath,
      });
    const admission = await handler.admit(
      sourceHandle,
      sourceStats.size,
      signal,
    );
    const colorProfile = admission.parsed.chunks.find(
      (chunk) => chunk.fourCc === "ICCP" && chunk.metadata !== undefined,
    );
    if (options.preserveColorProfile && colorProfile?.metadata !== undefined) {
      const checked = validateIccForPreservation(colorProfile.metadata);
      if (!checked.ok)
        return err({
          code: "unsupported-feature",
          detail: checked.detail,
          path: sourcePath,
          feature: "color-profile-preservation",
          reason: checked.reason,
        });
    }
    if (
      options.preserveOrientation &&
      (admission.orientation.status === "malformed" ||
        admission.orientation.status === "unsupported")
    )
      return err({
        code: "unsupported-feature",
        detail: admission.orientation.detail,
        path: sourcePath,
        feature: "orientation-preservation",
      });
    const orientation =
      admission.orientation.status === "valid"
        ? admission.orientation.value
        : undefined;
    const plan = handler.buildOutputPlan(
      admission.parsed,
      options.preserveOrientation,
      options.preserveColorProfile,
      orientation,
    );
    if (
      handler === undefined ||
      plan.length === 0 ||
      handler.capability.format !== "webp" ||
      plan.reduce((sum, chunk) => sum + 8 + chunk.size + (chunk.size & 1), 12) >
        MAX_RIFF_BYTES
    )
      return err({
        code: "unsafe-structure",
        detail: "Sanitized output exceeds RIFF limits.",
        path: sourcePath,
      });
    try {
      destinationHandle = await open(
        destinationPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
        sourceStats.mode & 0o777,
      );
      destinationCreated = true;
    } catch (cause) {
      return isNodeErrorCode(cause, "EEXIST")
        ? err({
            code: "destination-exists",
            detail: "Destination already exists.",
            path: destinationPath,
            cause: jsonSafeCause(cause),
          })
        : err({
            code: "write-failed",
            detail: "Could not create the destination exclusively.",
            path: destinationPath,
            cause: jsonSafeCause(cause),
          });
    }
    ownedDestination = identity(await destinationHandle.stat());
    await handler.writeOutput(sourceHandle, destinationHandle, plan, signal);
    await destinationHandle.close();
    destinationHandle = undefined;
    if (!identityMatches(ownedDestination, await lstat(destinationPath))) {
      failure = {
        code: "destination-changed",
        detail:
          "Destination path no longer names the file created by this operation.",
        path: destinationPath,
      };
      throw new Error("Destination changed.");
    }
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const destinationStats = await destinationHandle.stat();
    if (
      !identityMatches(ownedDestination, destinationStats) ||
      !identityMatches(ownedDestination, await lstat(destinationPath))
    ) {
      failure = {
        code: "destination-changed",
        detail:
          "Destination path no longer names the file created by this operation.",
        path: destinationPath,
      };
      throw new Error("Destination changed.");
    }
    const verified = await handler.verifyOutput(
      sourceHandle,
      admission.parsed,
      destinationHandle,
      destinationStats.size,
      destinationPath,
      options.preserveOrientation,
      options.preserveColorProfile,
      orientation,
      signal,
    );
    if (!verified.ok) {
      failure = verified.error;
      throw new Error("Destination verification failed.");
    }
    await destinationHandle.close();
    destinationHandle = undefined;
    if (!snapshotsEqual(original, await stat(sourcePath))) {
      failure = {
        code: "source-changed",
        detail: "Source changed during sanitization; output was discarded.",
        path: sourcePath,
      };
      throw new Error("Source changed.");
    }
    if (options.preserveTimestamps)
      await utimes(destinationPath, sourceStats.atime, sourceStats.mtime);
    if (!identityMatches(ownedDestination, await lstat(destinationPath))) {
      failure = {
        code: "destination-changed",
        detail: "Destination path was replaced before sanitization completed.",
        path: destinationPath,
      };
      throw new Error("Destination changed.");
    }
    const namespaces = new Set(
      admission.parsed.chunks.flatMap((chunk) =>
        chunk.fourCc === "EXIF"
          ? ["EXIF" as const]
          : chunk.fourCc === "XMP "
            ? ["XMP" as const]
            : chunk.fourCc === "ICCP"
              ? ["ICC" as const]
              : [],
      ),
    );
    const removedNamespaces: ("EXIF" | "XMP" | "ICC")[] = [];
    if (
      namespaces.has("EXIF") &&
      !(options.preserveOrientation && orientation !== undefined)
    )
      removedNamespaces.push("EXIF");
    if (namespaces.has("XMP")) removedNamespaces.push("XMP");
    if (namespaces.has("ICC") && !options.preserveColorProfile)
      removedNamespaces.push("ICC");
    destinationCreated = false;
    return ok({
      format: handler.capability.format,
      destinationPath,
      removedNamespaces,
      preserved: {
        orientation: options.preserveOrientation && orientation !== undefined,
        colorProfile: options.preserveColorProfile && namespaces.has("ICC"),
        timestamps: options.preserveTimestamps,
      },
      warnings: admission.warnings,
    });
  } catch (cause) {
    if (failure === undefined)
      failure = isAborted(signal)
        ? aborted(sourcePath)
        : cause instanceof WebpStructureError &&
            options.preserveColorProfile &&
            !destinationCreated &&
            cause.metadataLimit?.fourCc === "ICCP"
          ? {
              code: "unsupported-feature",
              detail: `ICC profile size ${cause.metadataLimit.size} exceeds the ${cause.metadataLimit.limit}-byte policy limit.`,
              path: sourcePath,
              feature: "color-profile-preservation",
              reason: "policy-limit",
            }
          : cause instanceof WebpStructureError
            ? structureError(sourcePath, cause)
            : sourceHandle === undefined
              ? readError(sourcePath, cause)
              : {
                  code: destinationCreated ? "write-failed" : "read-failed",
                  detail: destinationCreated
                    ? "Could not write the sanitized destination."
                    : "Could not read the source file.",
                  path: destinationCreated ? destinationPath : sourcePath,
                  cause: jsonSafeCause(cause),
                };
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
  if (destinationCreated && ownedDestination !== undefined) {
    const cleaned = await cleanupDestination(destinationPath, ownedDestination);
    if (!cleaned.ok) return cleaned;
  }
  return err(
    failure ?? {
      code: "write-failed",
      detail: "Sanitization failed.",
      path: destinationPath,
    },
  );
}
