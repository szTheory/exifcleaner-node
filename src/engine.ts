import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getRegisteredCapabilities,
  selectHandler,
} from "./admission/registry.js";
import type { RegisteredHandler } from "./admission/registry.js";
import type { AdmissionDeclineDetail } from "./admission/handler.js";
import {
  aborted,
  admissionDecline,
  executionError,
  isNodeErrorCode,
  jsonSafeCause,
  requestError,
  sourceOpenError,
} from "./errors.js";
import { validateIccForPreservation } from "./metadata/icc_admission.js";
import { err, ok } from "./result.js";
import { NODE_FILE_OPS } from "./transaction/file-ops.js";
import { snapshotSource } from "./transaction/identity.js";
import { runSafeTransaction } from "./transaction/safe-transaction.js";
import type {
  Capabilities,
  Inspection,
  InspectOptions,
  MetadataError,
  MetadataErrorDetails,
  Result,
  SanitizeOptions,
  SanitizeResult,
} from "./types.js";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
function invalidOptions(detail: string, path?: string): Result<never> {
  return err(
    requestError(
      path === undefined
        ? { code: "invalid-options", detail }
        : { code: "invalid-options", detail, path },
    ),
  );
}
function declinedError(
  declined: AdmissionDeclineDetail,
  path: string,
): MetadataErrorDetails {
  const { code, detail, ...rest } = declined;
  return { code, detail, path, ...rest } as MetadataErrorDetails;
}
function readError(path: string, cause: unknown): MetadataError {
  return sourceOpenError(
    isNodeErrorCode(cause, "ENOENT")
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
        },
  );
}
function validateRegularFile(stats: Stats, path: string): Result<void> {
  return stats.isFile()
    ? ok(undefined)
    : err(
        sourceOpenError({
          code: "read-failed",
          detail: "Source path is not a regular file.",
          path,
        }),
      );
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
  let handler: RegisteredHandler | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY);
    const sourceStats = await handle.stat();
    const regular = validateRegularFile(sourceStats, filePath);
    if (!regular.ok) return regular;
    handler = await selectHandler(handle);
    if (handler === undefined)
      return err(
        admissionDecline({
          code: "unsupported-format",
          detail: "Source file is not a supported native format.",
          path: filePath,
        }),
      );
    return ok(
      handler.inspect(
        await handler.admit(handle, sourceStats.size, options.signal),
      ),
    );
  } catch (cause) {
    if (isAborted(options.signal))
      return err(
        executionError(
          {
            code: "aborted",
            detail: "The operation was aborted.",
            path: filePath,
          },
          "not-started",
        ),
      );
    const declined = handler?.classifyAdmissionFailure(cause, false);
    return declined !== undefined
      ? err(admissionDecline(declinedError(declined, filePath)))
      : err(readError(filePath, cause));
  } finally {
    await handle?.close().catch(() => undefined);
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
    typeof options.preserveTimestamps !== "boolean" ||
    typeof options.preserveResolution !== "boolean"
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
  let handler: RegisteredHandler | undefined;
  try {
    sourceHandle = await open(sourcePath, fsConstants.O_RDONLY);
    const sourceStats = await sourceHandle.stat();
    const regular = validateRegularFile(sourceStats, sourcePath);
    if (!regular.ok) return regular;
    handler = await selectHandler(sourceHandle);
    if (handler === undefined)
      return err(
        admissionDecline({
          code: "unsupported-format",
          detail: "Source file is not a supported native format.",
          path: sourcePath,
        }),
      );
    const admission = await handler.admit(
      sourceHandle,
      sourceStats.size,
      signal,
    );
    const colorProfile = admission.colorProfile;
    if (options.preserveColorProfile && colorProfile !== undefined) {
      const checked = validateIccForPreservation(colorProfile);
      if (!checked.ok)
        return err(
          admissionDecline({
            code: "unsupported-feature",
            detail: checked.detail,
            path: sourcePath,
            feature: "color-profile-preservation",
            reason: checked.reason,
          }),
        );
    }
    if (
      options.preserveOrientation &&
      (admission.orientation.status === "malformed" ||
        admission.orientation.status === "unsupported")
    )
      return err(
        admissionDecline({
          code: "unsupported-feature",
          detail: admission.orientation.detail,
          path: sourcePath,
          feature: "orientation-preservation",
        }),
      );
    if (
      options.preserveResolution &&
      !handler.capability.preserves.resolution
    )
      return err(
        admissionDecline({
          code: "unsupported-feature",
          detail: "This format cannot preserve resolution natively.",
          path: sourcePath,
          feature: "resolution-preservation",
        }),
      );
    const orientation =
      admission.orientation.status === "valid"
        ? admission.orientation.value
        : undefined;
    const plan = handler.buildOutputPlan(
      admission,
      options.preserveOrientation,
      options.preserveColorProfile,
      options.preserveResolution,
      orientation,
    );
    const overflow = handler.checkOutputPlan(plan);
    if (overflow !== undefined)
      return err(
        admissionDecline({
          code: "unsafe-structure",
          detail: overflow,
          path: sourcePath,
        }),
      );
    const transaction = await runSafeTransaction({
      sourceHandle,
      sourceSnapshot: snapshotSource(sourceStats),
      sourceMode: sourceStats.mode,
      handler,
      admission,
      plan,
      orientation,
      options,
      fileOps: NODE_FILE_OPS,
    });
    sourceHandle = undefined;
    return transaction;
  } catch (cause) {
    if (isAborted(signal))
      return err(
        executionError(
          {
            code: "aborted",
            detail: "The operation was aborted.",
            path: sourcePath,
          },
          "not-started",
        ),
      );
    const declined = handler?.classifyAdmissionFailure(
      cause,
      options.preserveColorProfile,
    );
    if (declined !== undefined)
      return err(admissionDecline(declinedError(declined, sourcePath)));
    return err(
      sourceHandle === undefined
        ? readError(sourcePath, cause)
        : executionError(
            {
              code: "read-failed",
              detail: "Could not admit the source file.",
              path: sourcePath,
              cause: jsonSafeCause(cause),
            },
            "not-started",
          ),
    );
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}
