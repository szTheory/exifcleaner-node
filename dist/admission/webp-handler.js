import { parseExif, createOrientationExif } from "../metadata/exif.js";
import { parseIcc } from "../metadata/icc.js";
import { parseXmp } from "../metadata/xmp.js";
import { err, ok } from "../result.js";
import { executionError } from "../errors.js";
import { COPY_BLOCK_BYTES, MAX_BUFFERED_METADATA_BYTES, MAX_CHUNK_COUNT, MAX_RIFF_BYTES, encodeChunkHeader, encodeRiffHeader, parseWebp, readExactly, WebpStructureError, } from "../webp/riff.js";
import { ICC_PRESERVATION_POLICY_ID } from "../metadata/icc_admission.js";
function isAborted(signal) {
    return signal?.aborted ?? false;
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
                parsed.chunks.some((item) => item.fourCc === "ICCP"))
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
export function webpOutputSize(plan) {
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
async function copyChunkData(source, destination, chunk, position, signal) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BLOCK_BYTES, Math.max(chunk.size, 1)));
    let copied = 0;
    while (copied < chunk.size) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(buffer.length, chunk.size - copied);
        const read = await source.read(buffer, 0, length, chunk.dataOffset + copied);
        if (read.bytesRead !== length)
            throw new Error("Source changed or became truncated while copying.");
        let written = 0;
        while (written < length) {
            const result = await destination.write(buffer, written, length - written, position + copied + written);
            if (result.bytesWritten === 0)
                throw new Error("A file write made no progress.");
            written += result.bytesWritten;
        }
        copied += length;
    }
    return position + copied;
}
async function chunksEqual(sourceHandle, source, destinationHandle, destination, signal) {
    if (source.size !== destination.size)
        return false;
    for (let offset = 0; offset < source.size;) {
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
const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);
function verificationError(detail, path) {
    return executionError({ code: "verification-failed", detail, path }, "started");
}
function verificationAborted(path) {
    return executionError({ code: "aborted", detail: "Operation was aborted.", path }, "started");
}
async function verifyOutput(sourceHandle, source, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, expectedOrientation, signal) {
    try {
        const destination = await parseWebp(destinationHandle, destinationSize, signal);
        if (destination.chunks.some((chunk) => chunk.fourCc === "XMP "))
            return err(verificationError("XMP remained after sanitization.", destinationPath));
        const sourceIcc = source.chunks.find((chunk) => chunk.fourCc === "ICCP");
        const destinationIcc = destination.chunks.find((chunk) => chunk.fourCc === "ICCP");
        if (preserveColorProfile && sourceIcc !== undefined) {
            if (destinationIcc === undefined ||
                !(await chunksEqual(sourceHandle, sourceIcc, destinationHandle, destinationIcc, signal)))
                return err(verificationError("ICC color profile was not preserved byte-for-byte.", destinationPath));
        }
        else if (destinationIcc !== undefined)
            return err(verificationError("ICC metadata remained after sanitization.", destinationPath));
        const destinationExif = destination.chunks.find((chunk) => chunk.fourCc === "EXIF");
        if (preserveOrientation && expectedOrientation !== undefined) {
            const parsedExif = destinationExif?.metadata === undefined
                ? undefined
                : parseExif(destinationExif.metadata);
            if (parsedExif?.orientation.status !== "valid" ||
                parsedExif.orientation.value !== expectedOrientation ||
                parsedExif.entries.length !== 1)
                return err(verificationError("EXIF Orientation was not preserved.", destinationPath));
        }
        else if (destinationExif !== undefined)
            return err(verificationError("EXIF metadata remained after sanitization.", destinationPath));
        const sourcePayload = source.chunks.filter((chunk) => PAYLOAD_CHUNKS.has(chunk.fourCc));
        const destinationPayload = destination.chunks.filter((chunk) => PAYLOAD_CHUNKS.has(chunk.fourCc));
        if (sourcePayload.length !== destinationPayload.length)
            return err(verificationError("Image or animation chunk count changed.", destinationPath));
        for (let index = 0; index < sourcePayload.length; index += 1) {
            const left = sourcePayload[index];
            const right = destinationPayload[index];
            if (left === undefined ||
                right === undefined ||
                left.fourCc !== right.fourCc ||
                !(await chunksEqual(sourceHandle, left, destinationHandle, right, signal)))
                return err(verificationError("Image or animation payload bytes changed.", destinationPath));
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        return err(verificationError(cause instanceof WebpStructureError
            ? cause.message
            : "Could not reopen and verify the destination.", destinationPath));
    }
}
const capability = Object.freeze({
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
});
export const webpHandler = Object.freeze({
    capability,
    matches(magic) {
        return (magic.length >= 12 &&
            magic.subarray(0, 4).toString("ascii") === "RIFF" &&
            magic.subarray(8, 12).toString("ascii") === "WEBP");
    },
    async admit(handle, size, signal) {
        const parsed = await parseWebp(handle, size, signal);
        return { parsed, ...collectMetadata(parsed) };
    },
    inspect(admission) {
        return {
            format: "webp",
            entries: admission.entries,
            warnings: admission.warnings,
        };
    },
    buildOutputPlan,
    async writeOutput(source, destination, plan, signal) {
        const size = webpOutputSize(plan);
        let position = await writeAll(destination, encodeRiffHeader(size), 0);
        for (const chunk of plan) {
            if (isAborted(signal))
                throw signal?.reason ?? new DOMException("Aborted", "AbortError");
            position = await writeAll(destination, encodeChunkHeader(chunk.fourCc, chunk.size), position);
            position =
                chunk.data !== undefined
                    ? await writeAll(destination, chunk.data, position)
                    : chunk.source !== undefined
                        ? await copyChunkData(source, destination, chunk.source, position, signal)
                        : (() => {
                            throw new Error("Output plan contains a chunk with no data source.");
                        })();
            if (chunk.size & 1)
                position = await writeAll(destination, Buffer.alloc(1), position);
        }
        if (position !== size)
            throw new Error("Output size did not match its RIFF declaration.");
    },
    verifyOutput,
});
//# sourceMappingURL=webp-handler.js.map