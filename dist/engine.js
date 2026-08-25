import { constants as fsConstants } from "node:fs";
import { lstat, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { aborted, isNodeErrorCode, jsonSafeCause } from "./errors.js";
import { parseExif, createOrientationExif } from "./metadata/exif.js";
import { parseIcc } from "./metadata/icc.js";
import { ICC_PRESERVATION_POLICY_ID, validateIccForPreservation, } from "./metadata/icc_admission.js";
import { parseXmp } from "./metadata/xmp.js";
import { err, ok } from "./result.js";
import { COPY_BLOCK_BYTES, MAX_BUFFERED_METADATA_BYTES, MAX_CHUNK_COUNT, MAX_RIFF_BYTES, encodeChunkHeader, encodeRiffHeader, parseWebp, readExactly, WebpStructureError, } from "./webp/riff.js";
const CAPABILITIES = Object.freeze({
    formats: Object.freeze([
        Object.freeze({
            format: "webp",
            mimeTypes: Object.freeze(["image/webp"]),
            extensions: Object.freeze([".webp"]),
            inspect: true,
            sanitize: true,
            preserves: Object.freeze({
                orientation: true,
                colorProfile: true,
                timestamps: true,
                imagePayload: true,
                animationPayload: true,
            }),
            animation: Object.freeze({
                supported: true,
                payloadPreservation: "byte-for-byte",
                boundary: "aggregate-chunk-count",
            }),
            validation: Object.freeze({
                container: "full",
                codecBitstream: "header-only",
            }),
            colorProfile: Object.freeze({
                policy: ICC_PRESERVATION_POLICY_ID,
                preservation: "preserve-if-present",
                versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"]),
                classes: Object.freeze(["scnr", "mntr"]),
                spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "]),
                maxProfileBytes: MAX_BUFFERED_METADATA_BYTES,
                maxTagCount: 4_096,
            }),
            limits: Object.freeze({
                maxMetadataBytesPerChunk: MAX_BUFFERED_METADATA_BYTES,
                maxChunkCount: MAX_CHUNK_COUNT,
                maxRiffBytes: MAX_RIFF_BYTES,
            }),
            refuses: Object.freeze([
                "unknown-chunks",
                "malformed-container",
                "unsupported-features",
                "resource-limits",
                "trailing-data",
            ]),
            removes: Object.freeze(["EXIF", "XMP", "ICC"]),
            detection: "magic",
        }),
    ]),
});
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function snapshot(source) {
    return {
        dev: source.dev,
        ino: source.ino,
        size: source.size,
        mtimeMs: source.mtimeMs,
        ctimeMs: source.ctimeMs,
    };
}
function identity(stats) {
    return { dev: stats.dev, ino: stats.ino };
}
function identityMatches(expected, actual) {
    return expected.dev === actual.dev && expected.ino === actual.ino;
}
function snapshotsEqual(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
function invalidOptions(detail, path) {
    return err(path === undefined
        ? { code: "invalid-options", detail }
        : { code: "invalid-options", detail, path });
}
function structureError(path, cause) {
    return { code: cause.kind, detail: cause.message, path };
}
function readError(path, cause) {
    if (isNodeErrorCode(cause, "ENOENT")) {
        return {
            code: "not-found",
            detail: "Source file does not exist.",
            path,
            cause: jsonSafeCause(cause),
        };
    }
    return {
        code: "read-failed",
        detail: "Could not read the source file.",
        path,
        cause: jsonSafeCause(cause),
    };
}
function collectMetadata(parsed) {
    const entries = [];
    const warnings = [];
    let orientation = { status: "absent" };
    for (const chunk of parsed.chunks) {
        if (chunk.fourCc === "EXIF" && chunk.metadata !== undefined) {
            const found = parseExif(chunk.metadata);
            entries.push(...found.entries);
            warnings.push(...found.warnings);
            orientation = found.orientation;
        }
        else if (chunk.fourCc === "XMP " && chunk.metadata !== undefined) {
            const found = parseXmp(chunk.metadata);
            entries.push(...found.entries);
            warnings.push(...found.warnings);
        }
        else if (chunk.fourCc === "ICCP" && chunk.metadata !== undefined) {
            const found = parseIcc(chunk.metadata);
            entries.push(...found.entries);
            warnings.push(...found.warnings);
        }
    }
    return { entries, warnings, orientation };
}
function validateRegularFile(stats, path) {
    if (!stats.isFile()) {
        return err({
            code: "read-failed",
            detail: "Source path is not a regular file.",
            path,
        });
    }
    return ok(undefined);
}
export function getCapabilities() {
    return CAPABILITIES;
}
export async function inspectFile(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        return invalidOptions("filePath must be a non-empty string.");
    }
    if (typeof options !== "object" || options === null) {
        return invalidOptions("inspectFile options must be an object.");
    }
    const { signal } = options;
    if (isAborted(signal))
        return err(aborted(filePath));
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY);
        const stats = await handle.stat();
        const regular = validateRegularFile(stats, filePath);
        if (!regular.ok)
            return regular;
        const parsed = await parseWebp(handle, stats.size, signal);
        const metadata = collectMetadata(parsed);
        return ok({
            format: "webp",
            entries: metadata.entries,
            warnings: metadata.warnings,
        });
    }
    catch (cause) {
        if (isAborted(signal))
            return err(aborted(filePath));
        if (cause instanceof WebpStructureError)
            return err(structureError(filePath, cause));
        return err(readError(filePath, cause));
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function buildOutputPlan(parsed, preserveOrientation, preserveColorProfile, orientation) {
    const keepOrientation = preserveOrientation && orientation !== undefined;
    const plan = [];
    for (const chunk of parsed.chunks) {
        if (chunk.fourCc === "XMP ")
            continue;
        if (chunk.fourCc === "ICCP" && !preserveColorProfile)
            continue;
        if (chunk.fourCc === "EXIF") {
            if (keepOrientation) {
                const data = createOrientationExif(orientation);
                plan.push({ fourCc: "EXIF", size: data.length, data });
            }
            continue;
        }
        if (chunk.fourCc === "VP8X") {
            const data = Buffer.from(parsed.vp8x?.data ?? Buffer.alloc(0));
            let flags = (data[0] ?? 0) & ~0x2c;
            if (preserveColorProfile &&
                parsed.chunks.some((candidate) => candidate.fourCc === "ICCP"))
                flags |= 0x20;
            if (keepOrientation)
                flags |= 0x08;
            data[0] = flags;
            plan.push({ fourCc: "VP8X", size: data.length, data });
            continue;
        }
        plan.push({ fourCc: chunk.fourCc, size: chunk.size, source: chunk });
    }
    return plan;
}
function outputSize(plan) {
    return plan.reduce((total, chunk) => total + 8 + chunk.size + (chunk.size & 1), 12);
}
async function writeAll(handle, data, position) {
    let written = 0;
    while (written < data.length) {
        const next = await handle.write(data, written, data.length - written, position + written);
        if (next.bytesWritten === 0)
            throw new Error("A file write made no progress.");
        written += next.bytesWritten;
    }
    return position + written;
}
async function copyChunkData(source, destination, chunk, destinationPosition, signal) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BLOCK_BYTES, Math.max(chunk.size, 1)));
    let copied = 0;
    while (copied < chunk.size) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(buffer.length, chunk.size - copied);
        const readResult = await source.read(buffer, 0, length, chunk.dataOffset + copied);
        if (readResult.bytesRead !== length)
            throw new Error("Source changed or became truncated while copying.");
        let blockWritten = 0;
        while (blockWritten < length) {
            const writeResult = await destination.write(buffer, blockWritten, length - blockWritten, destinationPosition + copied + blockWritten);
            if (writeResult.bytesWritten === 0)
                throw new Error("A file write made no progress.");
            blockWritten += writeResult.bytesWritten;
        }
        copied += length;
    }
    return destinationPosition + copied;
}
async function writeOutput(source, destination, plan, signal) {
    const size = outputSize(plan);
    let position = await writeAll(destination, encodeRiffHeader(size), 0);
    for (const chunk of plan) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        position = await writeAll(destination, encodeChunkHeader(chunk.fourCc, chunk.size), position);
        if (chunk.data !== undefined)
            position = await writeAll(destination, chunk.data, position);
        else if (chunk.source !== undefined) {
            position = await copyChunkData(source, destination, chunk.source, position, signal);
        }
        else {
            throw new Error("Output plan contains a chunk with no data source.");
        }
        if ((chunk.size & 1) === 1)
            position = await writeAll(destination, Buffer.alloc(1), position);
    }
    if (position !== size)
        throw new Error("Output size did not match its RIFF declaration.");
    await destination.sync();
}
const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);
async function chunksEqual(sourceHandle, source, destinationHandle, destination, signal) {
    if (source.size !== destination.size)
        return false;
    let offset = 0;
    while (offset < source.size) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(COPY_BLOCK_BYTES, source.size - offset);
        const [left, right] = await Promise.all([
            readExactly(sourceHandle, length, source.dataOffset + offset),
            readExactly(destinationHandle, length, destination.dataOffset + offset),
        ]);
        if (!left.equals(right))
            return false;
        offset += length;
    }
    return true;
}
async function verifyOutput(sourceHandle, source, destinationPath, ownedDestination, preserveOrientation, preserveColorProfile, expectedOrientation, signal) {
    let destinationHandle;
    try {
        const destinationPathStats = await lstat(destinationPath);
        if (!identityMatches(ownedDestination, destinationPathStats)) {
            return err({
                code: "destination-changed",
                detail: "Destination path no longer names the file created by this operation.",
                path: destinationPath,
            });
        }
        destinationHandle = await open(destinationPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
        const destinationStats = await destinationHandle.stat();
        if (!identityMatches(ownedDestination, destinationStats) ||
            !identityMatches(ownedDestination, await lstat(destinationPath))) {
            return err({
                code: "destination-changed",
                detail: "Destination path no longer names the file created by this operation.",
                path: destinationPath,
            });
        }
        const destination = await parseWebp(destinationHandle, destinationStats.size, signal);
        if (destination.chunks.some((chunk) => chunk.fourCc === "XMP ")) {
            return err({
                code: "verification-failed",
                detail: "XMP remained after sanitization.",
                path: destinationPath,
            });
        }
        const sourceIcc = source.chunks.find((chunk) => chunk.fourCc === "ICCP");
        const destinationIcc = destination.chunks.find((chunk) => chunk.fourCc === "ICCP");
        if (preserveColorProfile && sourceIcc !== undefined) {
            if (destinationIcc === undefined ||
                !(await chunksEqual(sourceHandle, sourceIcc, destinationHandle, destinationIcc, signal))) {
                return err({
                    code: "verification-failed",
                    detail: "ICC color profile was not preserved byte-for-byte.",
                    path: destinationPath,
                });
            }
        }
        else if (destinationIcc !== undefined) {
            return err({
                code: "verification-failed",
                detail: "ICC metadata remained after sanitization.",
                path: destinationPath,
            });
        }
        const destinationExif = destination.chunks.find((chunk) => chunk.fourCc === "EXIF");
        if (preserveOrientation && expectedOrientation !== undefined) {
            if (destinationExif?.metadata === undefined) {
                return err({
                    code: "verification-failed",
                    detail: "EXIF Orientation was not preserved.",
                    path: destinationPath,
                });
            }
            const parsedExif = parseExif(destinationExif.metadata);
            if (parsedExif.orientation.status !== "valid" ||
                parsedExif.orientation.value !== expectedOrientation ||
                parsedExif.entries.length !== 1) {
                return err({
                    code: "verification-failed",
                    detail: "Destination EXIF contains more than the preserved Orientation.",
                    path: destinationPath,
                });
            }
        }
        else if (destinationExif !== undefined) {
            return err({
                code: "verification-failed",
                detail: "EXIF metadata remained after sanitization.",
                path: destinationPath,
            });
        }
        const sourcePayload = source.chunks.filter((chunk) => PAYLOAD_CHUNKS.has(chunk.fourCc));
        const destinationPayload = destination.chunks.filter((chunk) => PAYLOAD_CHUNKS.has(chunk.fourCc));
        if (sourcePayload.length !== destinationPayload.length) {
            return err({
                code: "verification-failed",
                detail: "Image or animation chunk count changed.",
                path: destinationPath,
            });
        }
        for (let index = 0; index < sourcePayload.length; index += 1) {
            const left = sourcePayload[index];
            const right = destinationPayload[index];
            if (left === undefined ||
                right === undefined ||
                left.fourCc !== right.fourCc ||
                !(await chunksEqual(sourceHandle, left, destinationHandle, right, signal))) {
                return err({
                    code: "verification-failed",
                    detail: "Image or animation payload bytes changed.",
                    path: destinationPath,
                });
            }
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(aborted(destinationPath));
        return err({
            code: "verification-failed",
            detail: cause instanceof WebpStructureError
                ? cause.message
                : "Could not reopen and verify the destination.",
            path: destinationPath,
            cause: jsonSafeCause(cause),
        });
    }
    finally {
        await destinationHandle?.close().catch(() => undefined);
    }
}
async function cleanupDestination(path, ownedDestination) {
    try {
        const pathStats = await lstat(path);
        if (!identityMatches(ownedDestination, pathStats)) {
            return err({
                code: "destination-changed",
                detail: "Destination path was replaced; the replacement was left untouched.",
                path,
            });
        }
        await rm(path, { force: true });
        return ok(undefined);
    }
    catch (cause) {
        if (isNodeErrorCode(cause, "ENOENT"))
            return ok(undefined);
        return err({
            code: "cleanup-failed",
            detail: "Sanitization failed and the incomplete destination could not be removed.",
            path,
            cause: jsonSafeCause(cause),
        });
    }
}
export async function sanitizeFile(options) {
    if (typeof options !== "object" || options === null) {
        return invalidOptions("sanitizeFile options are required.");
    }
    const { sourcePath, destinationPath, signal } = options;
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
        return invalidOptions("sourcePath must be a non-empty string.");
    }
    if (typeof destinationPath !== "string" || destinationPath.length === 0) {
        return invalidOptions("destinationPath must be a non-empty string.");
    }
    if (typeof options.preserveOrientation !== "boolean" ||
        typeof options.preserveColorProfile !== "boolean" ||
        typeof options.preserveTimestamps !== "boolean") {
        return invalidOptions("All preservation options must be explicit booleans.");
    }
    if (resolve(sourcePath) === resolve(destinationPath)) {
        return invalidOptions("Source and destination paths must be different.", destinationPath);
    }
    if (isAborted(signal))
        return err(aborted(sourcePath));
    let sourceHandle;
    let destinationHandle;
    let destinationCreated = false;
    let ownedDestination;
    let failure;
    try {
        sourceHandle = await open(sourcePath, fsConstants.O_RDONLY);
        const sourceStats = await sourceHandle.stat();
        const regular = validateRegularFile(sourceStats, sourcePath);
        if (!regular.ok)
            return regular;
        const original = snapshot(sourceStats);
        const parsed = await parseWebp(sourceHandle, sourceStats.size, signal);
        const metadata = collectMetadata(parsed);
        const colorProfile = parsed.chunks.find((chunk) => chunk.fourCc === "ICCP" && chunk.metadata !== undefined);
        if (options.preserveColorProfile && colorProfile?.metadata !== undefined) {
            const admission = validateIccForPreservation(colorProfile.metadata);
            if (!admission.ok) {
                return err({
                    code: "unsupported-feature",
                    detail: admission.detail,
                    path: sourcePath,
                    feature: "color-profile-preservation",
                    reason: admission.reason,
                });
            }
        }
        if (options.preserveOrientation &&
            (metadata.orientation.status === "malformed" ||
                metadata.orientation.status === "unsupported")) {
            return err({
                code: "unsupported-feature",
                detail: metadata.orientation.detail,
                path: sourcePath,
                feature: "orientation-preservation",
            });
        }
        const orientation = metadata.orientation.status === "valid"
            ? metadata.orientation.value
            : undefined;
        const plan = buildOutputPlan(parsed, options.preserveOrientation, options.preserveColorProfile, orientation);
        if (outputSize(plan) > MAX_RIFF_BYTES) {
            return err({
                code: "unsafe-structure",
                detail: "Sanitized output exceeds RIFF limits.",
                path: sourcePath,
            });
        }
        try {
            destinationHandle = await open(destinationPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, sourceStats.mode & 0o777);
            destinationCreated = true;
        }
        catch (cause) {
            if (isNodeErrorCode(cause, "EEXIST")) {
                return err({
                    code: "destination-exists",
                    detail: "Destination already exists.",
                    path: destinationPath,
                    cause: jsonSafeCause(cause),
                });
            }
            return err({
                code: "write-failed",
                detail: "Could not create the destination exclusively.",
                path: destinationPath,
                cause: jsonSafeCause(cause),
            });
        }
        ownedDestination = identity(await destinationHandle.stat());
        await writeOutput(sourceHandle, destinationHandle, plan, signal);
        const verified = await verifyOutput(sourceHandle, parsed, destinationPath, ownedDestination, options.preserveOrientation, options.preserveColorProfile, orientation, signal);
        if (!verified.ok) {
            failure = verified.error;
            throw new Error("Destination verification failed.");
        }
        const currentSource = await stat(sourcePath);
        if (!snapshotsEqual(original, currentSource)) {
            failure = {
                code: "source-changed",
                detail: "Source changed during sanitization; output was discarded.",
                path: sourcePath,
            };
            throw new Error("Source changed during sanitization.");
        }
        if (options.preserveTimestamps) {
            await destinationHandle.utimes(sourceStats.atime, sourceStats.mtime);
        }
        const finalDestination = await lstat(destinationPath);
        if (!identityMatches(ownedDestination, finalDestination)) {
            failure = {
                code: "destination-changed",
                detail: "Destination path was replaced before sanitization completed.",
                path: destinationPath,
            };
            throw new Error("Destination changed during sanitization.");
        }
        const sourceNamespaces = new Set(parsed.chunks.flatMap((chunk) => chunk.fourCc === "EXIF"
            ? ["EXIF"]
            : chunk.fourCc === "XMP "
                ? ["XMP"]
                : chunk.fourCc === "ICCP"
                    ? ["ICC"]
                    : []));
        const removedNamespaces = [];
        if (sourceNamespaces.has("EXIF") &&
            !(options.preserveOrientation && orientation !== undefined))
            removedNamespaces.push("EXIF");
        if (sourceNamespaces.has("XMP"))
            removedNamespaces.push("XMP");
        if (sourceNamespaces.has("ICC") && !options.preserveColorProfile)
            removedNamespaces.push("ICC");
        destinationCreated = false;
        return ok({
            format: "webp",
            destinationPath,
            removedNamespaces,
            preserved: {
                orientation: options.preserveOrientation && orientation !== undefined,
                colorProfile: options.preserveColorProfile && sourceNamespaces.has("ICC"),
                timestamps: options.preserveTimestamps,
            },
            warnings: metadata.warnings,
        });
    }
    catch (cause) {
        if (failure === undefined) {
            if (isAborted(signal))
                failure = aborted(sourcePath);
            else if (cause instanceof WebpStructureError)
                failure = structureError(sourcePath, cause);
            else if (sourceHandle === undefined)
                failure = readError(sourcePath, cause);
            else
                failure = {
                    code: destinationCreated ? "write-failed" : "read-failed",
                    detail: destinationCreated
                        ? "Could not write the sanitized destination."
                        : "Could not read the source file.",
                    path: destinationCreated ? destinationPath : sourcePath,
                    cause: jsonSafeCause(cause),
                };
        }
    }
    finally {
        await destinationHandle?.close().catch(() => undefined);
        await sourceHandle?.close().catch(() => undefined);
    }
    if (destinationCreated && ownedDestination !== undefined) {
        const cleaned = await cleanupDestination(destinationPath, ownedDestination);
        if (!cleaned.ok)
            return cleaned;
    }
    return err(failure ?? {
        code: "write-failed",
        detail: "Sanitization failed.",
        path: destinationPath,
    });
}
//# sourceMappingURL=engine.js.map