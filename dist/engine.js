import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { getRegisteredCapabilities, selectHandler, } from "./admission/registry.js";
import { aborted, admissionDecline, executionError, isNodeErrorCode, jsonSafeCause, requestError, sourceOpenError, } from "./errors.js";
import { validateIccForPreservation } from "./metadata/icc_admission.js";
import { err, ok } from "./result.js";
import { NODE_FILE_OPS } from "./transaction/file-ops.js";
import { snapshotSource } from "./transaction/identity.js";
import { runSafeTransaction } from "./transaction/safe-transaction.js";
import { MAX_RIFF_BYTES, WebpStructureError } from "./webp/riff.js";
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function invalidOptions(detail, path) {
    return err(requestError(path === undefined
        ? { code: "invalid-options", detail }
        : { code: "invalid-options", detail, path }));
}
function structureError(path, cause) {
    return admissionDecline({ code: cause.kind, detail: cause.message, path });
}
function readError(path, cause) {
    return sourceOpenError(isNodeErrorCode(cause, "ENOENT")
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
        });
}
function validateRegularFile(stats, path) {
    return stats.isFile()
        ? ok(undefined)
        : err(sourceOpenError({
            code: "read-failed",
            detail: "Source path is not a regular file.",
            path,
        }));
}
export function getCapabilities() {
    return getRegisteredCapabilities();
}
export async function inspectFile(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0)
        return invalidOptions("filePath must be a non-empty string.");
    if (typeof options !== "object" || options === null)
        return invalidOptions("inspectFile options must be an object.");
    if (isAborted(options.signal))
        return err(aborted(filePath));
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY);
        const sourceStats = await handle.stat();
        const regular = validateRegularFile(sourceStats, filePath);
        if (!regular.ok)
            return regular;
        const handler = await selectHandler(handle);
        if (handler === undefined)
            return err(admissionDecline({
                code: "unsupported-format",
                detail: "Source file is not a supported native format.",
                path: filePath,
            }));
        return ok(handler.inspect(await handler.admit(handle, sourceStats.size, options.signal)));
    }
    catch (cause) {
        if (isAborted(options.signal))
            return err(executionError({
                code: "aborted",
                detail: "The operation was aborted.",
                path: filePath,
            }, "not-started"));
        return cause instanceof WebpStructureError
            ? err(structureError(filePath, cause))
            : err(readError(filePath, cause));
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
export async function sanitizeFile(options) {
    if (typeof options !== "object" || options === null)
        return invalidOptions("sanitizeFile options are required.");
    const { sourcePath, destinationPath, signal } = options;
    if (typeof sourcePath !== "string" || sourcePath.length === 0)
        return invalidOptions("sourcePath must be a non-empty string.");
    if (typeof destinationPath !== "string" || destinationPath.length === 0)
        return invalidOptions("destinationPath must be a non-empty string.");
    if (typeof options.preserveOrientation !== "boolean" ||
        typeof options.preserveColorProfile !== "boolean" ||
        typeof options.preserveTimestamps !== "boolean")
        return invalidOptions("All preservation options must be explicit booleans.");
    if (resolve(sourcePath) === resolve(destinationPath))
        return invalidOptions("Source and destination paths must be different.", destinationPath);
    if (isAborted(signal))
        return err(aborted(sourcePath));
    let sourceHandle;
    try {
        sourceHandle = await open(sourcePath, fsConstants.O_RDONLY);
        const sourceStats = await sourceHandle.stat();
        const regular = validateRegularFile(sourceStats, sourcePath);
        if (!regular.ok)
            return regular;
        const handler = await selectHandler(sourceHandle);
        if (handler === undefined)
            return err(admissionDecline({
                code: "unsupported-format",
                detail: "Source file is not a supported native format.",
                path: sourcePath,
            }));
        const admission = await handler.admit(sourceHandle, sourceStats.size, signal);
        const colorProfile = admission.parsed.chunks.find((chunk) => chunk.fourCc === "ICCP" && chunk.metadata !== undefined);
        if (options.preserveColorProfile && colorProfile?.metadata !== undefined) {
            const checked = validateIccForPreservation(colorProfile.metadata);
            if (!checked.ok)
                return err(admissionDecline({
                    code: "unsupported-feature",
                    detail: checked.detail,
                    path: sourcePath,
                    feature: "color-profile-preservation",
                    reason: checked.reason,
                }));
        }
        if (options.preserveOrientation &&
            (admission.orientation.status === "malformed" ||
                admission.orientation.status === "unsupported"))
            return err(admissionDecline({
                code: "unsupported-feature",
                detail: admission.orientation.detail,
                path: sourcePath,
                feature: "orientation-preservation",
            }));
        const orientation = admission.orientation.status === "valid"
            ? admission.orientation.value
            : undefined;
        const plan = handler.buildOutputPlan(admission.parsed, options.preserveOrientation, options.preserveColorProfile, orientation);
        if (plan.length === 0 ||
            plan.reduce((sum, chunk) => sum + 8 + chunk.size + (chunk.size & 1), 12) >
                MAX_RIFF_BYTES)
            return err(admissionDecline({
                code: "unsafe-structure",
                detail: "Sanitized output exceeds RIFF limits.",
                path: sourcePath,
            }));
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
    }
    catch (cause) {
        if (isAborted(signal))
            return err(executionError({
                code: "aborted",
                detail: "The operation was aborted.",
                path: sourcePath,
            }, "not-started"));
        if (cause instanceof WebpStructureError &&
            options.preserveColorProfile &&
            cause.metadataLimit?.fourCc === "ICCP")
            return err(admissionDecline({
                code: "unsupported-feature",
                detail: `ICC profile size ${cause.metadataLimit.size} exceeds the ${cause.metadataLimit.limit}-byte policy limit.`,
                path: sourcePath,
                feature: "color-profile-preservation",
                reason: "policy-limit",
            }));
        return cause instanceof WebpStructureError
            ? err(structureError(sourcePath, cause))
            : err(sourceHandle === undefined
                ? readError(sourcePath, cause)
                : executionError({
                    code: "read-failed",
                    detail: "Could not admit the source file.",
                    path: sourcePath,
                    cause: jsonSafeCause(cause),
                }, "not-started"));
    }
    finally {
        await sourceHandle?.close().catch(() => undefined);
    }
}
//# sourceMappingURL=engine.js.map