import { executionError, isNodeErrorCode, jsonSafeCause } from "../errors.js";
import { err, ok } from "../result.js";
import { DIRECT_FINAL_FLAGS, REOPEN_FLAGS } from "./file-ops.js";
import { destinationPathMatchesIdentity, identitiesDistinct, identityOf, sourcePathMatchesSnapshot, timestampsMatchAtMillisecondPrecision, } from "./identity.js";
function aborted(signal) { return signal?.aborted ?? false; }
export async function runSafeTransaction(input) {
    const { sourceHandle, sourceSnapshot, sourceMode, handler, admission, plan, orientation, options, fileOps } = input;
    const { sourcePath, destinationPath, signal } = options;
    let destination;
    let owned;
    let started = false;
    let failure;
    try {
        if (aborted(signal))
            throw new DOMException("Aborted", "AbortError");
        try {
            destination = await fileOps.open(destinationPath, DIRECT_FINAL_FLAGS, sourceMode & 0o666);
        }
        catch (cause) {
            return err(executionError({ code: isNodeErrorCode(cause, "EEXIST") ? "destination-exists" : "write-failed", detail: isNodeErrorCode(cause, "EEXIST") ? "Destination already exists." : "Could not create the destination exclusively.", path: destinationPath, cause: jsonSafeCause(cause) }, "not-started"));
        }
        started = true;
        owned = identityOf(await fileOps.statHandle(destination));
        if (owned === undefined || !identitiesDistinct({ dev: sourceSnapshot.dev, ino: sourceSnapshot.ino }, await fileOps.statHandle(destination))) {
            failure = executionError({ code: "write-failed", detail: "Could not prove that the destination is a distinct filesystem object.", path: destinationPath }, "started");
            throw new Error("Destination identity unavailable or aliases source.");
        }
        await handler.writeOutput(sourceHandle, destination, plan, signal);
        await fileOps.sync(destination);
        await fileOps.close(destination);
        destination = undefined;
        if (!destinationPathMatchesIdentity(owned, await fileOps.lstatPath(destinationPath))) {
            failure = executionError({ code: "destination-changed", detail: "Destination path no longer names the file created by this operation.", path: destinationPath }, "started");
            throw new Error("Destination changed.");
        }
        destination = await fileOps.open(destinationPath, REOPEN_FLAGS);
        const destinationStats = await fileOps.statHandle(destination);
        if (!destinationPathMatchesIdentity(owned, destinationStats) || !destinationPathMatchesIdentity(owned, await fileOps.lstatPath(destinationPath))) {
            failure = executionError({ code: "destination-changed", detail: "Destination path no longer names the file created by this operation.", path: destinationPath }, "started");
            throw new Error("Destination changed.");
        }
        const verified = await handler.verifyOutput(sourceHandle, admission.parsed, destination, destinationStats.size, destinationPath, options.preserveOrientation, options.preserveColorProfile, orientation, signal);
        if (!verified.ok) {
            failure = verified.error;
            throw new Error("Destination verification failed.");
        }
        if (!sourcePathMatchesSnapshot(sourceSnapshot, await fileOps.statPath(sourcePath))) {
            failure = executionError({ code: "source-changed", detail: "Source changed during sanitization; output was discarded.", path: sourcePath }, "started");
            throw new Error("Source changed.");
        }
        if (options.preserveTimestamps) {
            await fileOps.utimes(destination, sourceSnapshot.atime, sourceSnapshot.mtime);
            if (!timestampsMatchAtMillisecondPrecision(sourceSnapshot, await fileOps.statHandle(destination))) {
                failure = executionError({ code: "write-failed", detail: "Could not verify requested destination timestamps.", path: destinationPath }, "started");
                throw new Error("Destination timestamp proof failed.");
            }
        }
        if (!destinationPathMatchesIdentity(owned, await fileOps.lstatPath(destinationPath))) {
            failure = executionError({ code: "destination-changed", detail: "Destination path was replaced before sanitization completed.", path: destinationPath }, "started");
            throw new Error("Destination changed.");
        }
        await fileOps.close(destination);
        destination = undefined;
        await fileOps.close(sourceHandle);
        const namespaces = new Set(admission.parsed.chunks.flatMap((chunk) => chunk.fourCc === "EXIF" ? ["EXIF"] : chunk.fourCc === "XMP " ? ["XMP"] : chunk.fourCc === "ICCP" ? ["ICC"] : []));
        return ok({ format: handler.capability.format, destinationPath, removedNamespaces: [...(namespaces.has("EXIF") && !(options.preserveOrientation && orientation !== undefined) ? ["EXIF"] : []), ...(namespaces.has("XMP") ? ["XMP"] : []), ...(namespaces.has("ICC") && !options.preserveColorProfile ? ["ICC"] : [])], preserved: { orientation: options.preserveOrientation && orientation !== undefined, colorProfile: options.preserveColorProfile && namespaces.has("ICC"), timestamps: options.preserveTimestamps }, warnings: admission.warnings });
    }
    catch (cause) {
        failure ??= executionError({ code: aborted(signal) ? "aborted" : "write-failed", detail: aborted(signal) ? "The operation was aborted." : "Could not complete the sanitized destination.", path: destinationPath, cause: jsonSafeCause(cause) }, started ? "started" : "not-started");
    }
    finally {
        if (destination !== undefined)
            await fileOps.close(destination).catch(() => undefined);
        await fileOps.close(sourceHandle).catch(() => undefined);
    }
    if (started && owned !== undefined) {
        try {
            if (destinationPathMatchesIdentity(owned, await fileOps.lstatPath(destinationPath)))
                await fileOps.remove(destinationPath);
        }
        catch { /* Root failure remains authoritative; cleanup is bounded. */ }
    }
    return err(failure);
}
//# sourceMappingURL=safe-transaction.js.map