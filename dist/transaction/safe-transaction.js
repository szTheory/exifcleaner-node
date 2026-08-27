import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { executionError, jsonSafeCause, withDestinationFinalization, } from "../errors.js";
import { err, ok } from "../result.js";
import { DIRECT_FINAL_FLAGS, DESTINATION_DIRECTORY_FLAGS, REOPEN_FLAGS, STAGE_DIRECTORY_FLAGS, WINDOWS_REOPEN_FLAGS, } from "./file-ops.js";
import { identitiesDistinct, identityMatches, identityOf, sourcePathMatchesSnapshot, timestampsMatchAtMillisecondPrecision, } from "./identity.js";
import { createPrivateStageDirectory, disposePrivateStageDirectory, removePrivateStageFile, publishNoReplace, } from "./native-publication.js";
function aborted(signal) {
    return signal?.aborted ?? false;
}
function stageResidue(cause) {
    return {
        state: "private-empty-stage-directory-remains",
        cause,
    };
}
function isVerifiedPosixStageDirectory(stats) {
    const euid = process.geteuid?.();
    return (stats.isDirectory() &&
        euid !== undefined &&
        stats.uid === euid &&
        (stats.mode & 0o077) === 0);
}
async function closePostPublicationResources({ fileOps, stageDirectory, destinationDirectory, stageFile, sourceHandle, directoryCapability, stagePath, platform, }) {
    let stageDirectoryCloseCause;
    const close = async (handle, stage = false) => {
        if (handle === undefined)
            return;
        await fileOps.close(handle).catch((cause) => {
            if (stage)
                stageDirectoryCloseCause = jsonSafeCause(cause);
        });
    };
    await close(stageDirectory, true);
    await close(destinationDirectory);
    await close(stageFile);
    await close(sourceHandle);
    if (platform === "win32" && directoryCapability !== undefined) {
        const stageFileResult = removePrivateStageFile(directoryCapability, stagePath);
        if (stageFileResult.state !== "disposed")
            return stageResidue({
                code: stageFileResult.state,
                message: "Private staged-file disposal did not complete.",
            });
        const stageDirectoryResult = disposePrivateStageDirectory(directoryCapability);
        return stageDirectoryResult.state === "disposed"
            ? { state: "none" }
            : stageResidue({
                code: stageDirectoryResult.state,
                message: "Private stage-directory disposal did not complete.",
            });
    }
    return stageDirectory === undefined
        ? { state: "none" }
        : stageResidue(stageDirectoryCloseCause ?? {
            code: "ENOTSUP",
            message: "Private empty stage-directory cleanup is unavailable.",
        });
}
export async function runSafeTransaction(input) {
    const { sourceHandle, sourceSnapshot, sourceMode, handler, admission, plan, orientation, options, fileOps, beforePublish, beforeStageFinalization, platform = process.platform, } = input;
    const { sourcePath, destinationPath, signal } = options;
    const stageDirectoryPath = join(dirname(destinationPath), `.exifcleaner-stage-${randomUUID()}`);
    const stagePath = join(stageDirectoryPath, "output.webp");
    let stageDirectory;
    let destinationDirectory;
    let stageFile;
    let directoryCreated = false;
    let directoryCapability;
    let fileCreated = false;
    let fileIdentity;
    let stageDirectoryIdentity;
    let failure;
    let sourceHandleOpen = true;
    try {
        if (aborted(signal))
            throw new DOMException("Aborted", "AbortError");
        if (platform === "win32") {
            const capability = createPrivateStageDirectory(stageDirectoryPath);
            if (capability !== undefined) {
                directoryCapability = capability;
            }
            directoryCreated = directoryCapability !== undefined;
            if (!directoryCreated) {
                failure = executionError({
                    code: "write-failed",
                    detail: "Could not create and verify a private owner-controlled staging directory.",
                    path: destinationPath,
                }, "not-started");
                throw new Error("Private Windows stage creation failed.");
            }
        }
        else {
            await fileOps.createDirectory(stageDirectoryPath, 0o700);
            directoryCreated = true;
            stageDirectory = await fileOps.open(stageDirectoryPath, STAGE_DIRECTORY_FLAGS);
            const directoryStats = await fileOps.statHandle(stageDirectory);
            stageDirectoryIdentity = identityOf(directoryStats);
            if (stageDirectoryIdentity === undefined ||
                !isVerifiedPosixStageDirectory(directoryStats)) {
                failure = executionError({
                    code: "write-failed",
                    detail: "Could not verify a private owner-controlled staging directory.",
                    path: destinationPath,
                }, "not-started");
                throw new Error("Private stage verification failed.");
            }
        }
        stageFile = await fileOps.open(stagePath, DIRECT_FINAL_FLAGS, sourceMode & 0o666);
        fileCreated = true;
        fileIdentity = identityOf(await fileOps.statHandle(stageFile));
        if (fileIdentity === undefined ||
            !identitiesDistinct({ dev: sourceSnapshot.dev, ino: sourceSnapshot.ino }, await fileOps.statHandle(stageFile))) {
            failure = executionError({
                code: "write-failed",
                detail: "Could not prove that the staged output is distinct from source.",
                path: destinationPath,
            }, "started");
            throw new Error("Stage file identity unavailable or aliases source.");
        }
        await handler.writeOutput(sourceHandle, stageFile, plan, signal);
        await fileOps.sync(stageFile);
        await fileOps.close(stageFile);
        stageFile = await fileOps.open(stagePath, platform === "win32" ? WINDOWS_REOPEN_FLAGS : REOPEN_FLAGS);
        const stageStats = await fileOps.statHandle(stageFile);
        if (fileIdentity === undefined ||
            identityOf(stageStats)?.dev !== fileIdentity.dev ||
            identityOf(stageStats)?.ino !== fileIdentity.ino) {
            failure = executionError({
                code: "write-failed",
                detail: "Could not reopen the staged output by its owned identity.",
                path: destinationPath,
            }, "started");
            throw new Error("Staged output identity unavailable.");
        }
        const verified = await handler.verifyOutput(sourceHandle, admission.parsed, stageFile, stageStats.size, destinationPath, options.preserveOrientation, options.preserveColorProfile, orientation, signal);
        if (!verified.ok) {
            failure = verified.error;
            throw new Error("Staged output verification failed.");
        }
        if (aborted(signal))
            throw new DOMException("Aborted", "AbortError");
        if (!sourcePathMatchesSnapshot(sourceSnapshot, await fileOps.statPath(sourcePath))) {
            failure = executionError({
                code: "source-changed",
                detail: "Source changed during sanitization; staged output was retained.",
                path: sourcePath,
            }, "started");
            throw new Error("Source changed.");
        }
        if (options.preserveTimestamps) {
            await fileOps.utimes(stageFile, sourceSnapshot.atime, sourceSnapshot.mtime);
            if (!timestampsMatchAtMillisecondPrecision(sourceSnapshot, await fileOps.statHandle(stageFile))) {
                failure = executionError({
                    code: "write-failed",
                    detail: "Could not verify requested staged-output timestamps.",
                    path: destinationPath,
                }, "started");
                throw new Error("Staged timestamp proof failed.");
            }
        }
        await fileOps.sync(stageFile);
        if (platform !== "win32") {
            destinationDirectory = await fileOps.open(dirname(destinationPath), DESTINATION_DIRECTORY_FLAGS);
        }
        await beforePublish?.({ stageDirectoryPath, stagePath });
        if (aborted(signal))
            throw new DOMException("Aborted", "AbortError");
        if (platform !== "win32" &&
            (stageDirectoryIdentity === undefined ||
                !identityMatches(stageDirectoryIdentity, await fileOps.statPath(stageDirectoryPath)))) {
            failure = executionError({
                code: "write-failed",
                detail: "The private staging directory changed before capability publication.",
                path: destinationPath,
            }, "started");
            throw new Error("Private stage directory changed.");
        }
        if (!sourcePathMatchesSnapshot(sourceSnapshot, await fileOps.statPath(sourcePath))) {
            failure = executionError({
                code: "source-changed",
                detail: "Source changed before publication; staged output was retained.",
                path: sourcePath,
            }, "started");
            throw new Error("Source changed before publication.");
        }
        const publication = publishNoReplace(stageFile.fd, stageDirectory?.fd, destinationDirectory?.fd, "output.webp", destinationPath, stagePath, directoryCapability, basename(destinationPath), platform);
        if (publication.state !== "published") {
            failure = executionError({
                code: publication.state === "destination-exists"
                    ? "destination-exists"
                    : "write-failed",
                detail: publication.state === "destination-exists"
                    ? "Destination already exists."
                    : "Native no-replace publication could not complete.",
                path: destinationPath,
                ...(publication.state === "publication-failed" &&
                    publication.diagnostic !== undefined
                    ? {
                        cause: {
                            code: "native-publication",
                            message: publication.diagnostic,
                        },
                    }
                    : {}),
            }, "started");
            throw new Error("Native publication did not succeed.");
        }
        const committedResources = {
            fileOps,
            stageDirectory,
            destinationDirectory,
            stageFile,
            sourceHandle,
            directoryCapability,
            stagePath,
            platform,
        };
        stageDirectory = undefined;
        destinationDirectory = undefined;
        stageFile = undefined;
        sourceHandleOpen = false;
        const postCommitResidue = await closePostPublicationResources(committedResources);
        const namespaces = new Set(admission.parsed.chunks.flatMap((chunk) => chunk.fourCc === "EXIF"
            ? ["EXIF"]
            : chunk.fourCc === "XMP "
                ? ["XMP"]
                : chunk.fourCc === "ICCP"
                    ? ["ICC"]
                    : []));
        return ok({
            format: handler.capability.format,
            destinationPath,
            removedNamespaces: [
                ...(namespaces.has("EXIF") &&
                    !(options.preserveOrientation && orientation !== undefined)
                    ? ["EXIF"]
                    : []),
                ...(namespaces.has("XMP") ? ["XMP"] : []),
                ...(namespaces.has("ICC") && !options.preserveColorProfile
                    ? ["ICC"]
                    : []),
            ],
            preserved: {
                orientation: options.preserveOrientation && orientation !== undefined,
                colorProfile: options.preserveColorProfile && namespaces.has("ICC"),
                timestamps: options.preserveTimestamps,
            },
            warnings: admission.warnings,
            postCommitResidue,
        });
    }
    catch (cause) {
        failure ??= executionError({
            code: aborted(signal) ? "aborted" : "write-failed",
            detail: aborted(signal)
                ? "The operation was aborted."
                : "Could not complete the private staged destination.",
            path: destinationPath,
            cause: jsonSafeCause(cause),
        }, fileCreated ? "started" : "not-started");
    }
    finally {
        if (stageFile !== undefined)
            await fileOps.close(stageFile).catch(() => undefined);
        if (stageDirectory !== undefined)
            await fileOps.close(stageDirectory).catch(() => undefined);
        if (destinationDirectory !== undefined)
            await fileOps.close(destinationDirectory).catch(() => undefined);
        if (sourceHandleOpen)
            await fileOps.close(sourceHandle).catch(() => undefined);
    }
    await Promise.resolve(beforeStageFinalization?.({ stageDirectoryPath, stagePath })).catch(() => undefined);
    if (directoryCreated &&
        !fileCreated &&
        platform === "win32" &&
        directoryCapability !== undefined &&
        disposePrivateStageDirectory(directoryCapability).state === "disposed") {
        return err(withDestinationFinalization(failure, { state: "owned-partial-removed" }));
    }
    const residueCause = fileCreated
        ? {
            message: "Private staged file remains after terminal publication failure.",
        }
        : directoryCreated
            ? {
                message: "Private staging directory remains after terminal setup failure.",
            }
            : { message: "Private staging setup did not complete." };
    return err(withDestinationFinalization(failure, {
        state: "owned-partial-remains",
        cause: residueCause,
    }));
}
//# sourceMappingURL=safe-transaction.js.map