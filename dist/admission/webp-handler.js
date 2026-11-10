import { createMinimalExif, parseExif, readIfd0Resolution, } from "../metadata/exif.js";
import { parseIcc } from "../metadata/icc.js";
import { parseXmp } from "../metadata/xmp.js";
import { err, ok } from "../result.js";
import { executionError } from "../errors.js";
import { COPY_BLOCK_BYTES, MAX_BUFFERED_METADATA_BYTES, MAX_CHUNK_COUNT, MAX_RIFF_BYTES, encodeChunkHeader, encodeRiffHeader, parseWebp, WebpStructureError, } from "../webp/riff.js";
import { ICC_PRESERVATION_POLICY_ID } from "../metadata/icc_admission.js";
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function collectMetadata(parsed) {
    const entries = [];
    const warnings = [];
    let orientation = { status: "absent" };
    let colorProfile;
    let sourceResolution;
    const namespaces = new Set();
    for (const chunk of parsed.chunks) {
        if (chunk.fourCc === "EXIF") {
            namespaces.add("EXIF");
            if (chunk.metadata !== undefined) {
                const found = parseExif(chunk.metadata);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
                orientation = found.orientation;
                sourceResolution = readIfd0Resolution(exifTiffBody(chunk.metadata));
            }
        }
        else if (chunk.fourCc === "XMP ") {
            namespaces.add("XMP");
            if (chunk.metadata !== undefined) {
                const found = parseXmp(chunk.metadata);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
            }
        }
        else if (chunk.fourCc === "ICCP") {
            namespaces.add("ICC");
            if (chunk.metadata !== undefined) {
                colorProfile = chunk.metadata;
                const found = parseIcc(chunk.metadata);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
            }
        }
    }
    return {
        entries,
        warnings,
        orientation,
        colorProfile,
        namespaces: [...namespaces],
        // The resolution record lives in the EXIF IFD0 triple; it exists only when
        // both X and Y were read (a one-sided pair is no resolution).
        resolutionNamespace: sourceResolution === undefined ? undefined : "EXIF",
        sourceResolution,
    };
}
// The minimal IFD0 tags the output EXIF chunk may carry: the valid source
// orientation when requested, the source resolution triple when requested;
// undefined when neither applies (the EXIF chunk is then dropped).
function webpExifTags(admission, preserveOrientation, preserveResolution, orientation) {
    const keepOrientation = preserveOrientation && orientation !== undefined;
    const resolution = preserveResolution
        ? admission.sourceResolution
        : undefined;
    if (keepOrientation && resolution !== undefined)
        return { orientation, resolution };
    if (keepOrientation)
        return { orientation };
    if (resolution !== undefined)
        return { resolution };
    return undefined;
}
function buildOutputPlan(admission, preserveOrientation, preserveColorProfile, preserveResolution, orientation) {
    const parsed = admission.parsed;
    const exifTags = webpExifTags(admission, preserveOrientation, preserveResolution, orientation);
    const plan = [];
    for (const chunk of parsed.chunks) {
        if (chunk.fourCc === "XMP ")
            continue;
        if (chunk.fourCc === "ICCP" && !preserveColorProfile)
            continue;
        if (chunk.fourCc === "EXIF") {
            if (exifTags !== undefined) {
                const data = createMinimalExif(exifTags);
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
            if (exifTags !== undefined)
                flags |= 0x08;
            data[0] = flags;
            plan.push({ fourCc: "VP8X", size: data.length, data });
            continue;
        }
        plan.push({ fourCc: chunk.fourCc, size: chunk.size, source: chunk });
    }
    // KIT-08 (D-14 amendment): when every extended feature has been stripped
    // (the planned VP8X flags byte is 0) the only chunk left beside VP8X is the
    // single VP8 or VP8L bitstream (`parseWebp` admits ALPH, ANIM and ANMF only
    // together with the VP8X flags that keep the flags byte non-zero), so drop
    // VP8X and write simple-format WebP -- matching what ExifTool's own `-all=`
    // sanitize produces. Only a planned VP8X chunk can lead a plan that holds
    // inline data (`parseWebp` requires VP8X first and admits EXIF only behind
    // it), so the first data byte of the plan is that flags byte. `parseWebp`
    // already requires the VP8X canvas dimensions to match the VP8/VP8L
    // bitstream header exactly (src/webp/riff.ts), so dropping the canvas size
    // here is safe: the simple-format bitstream header alone still encodes the
    // true dimensions. `verifyOutput` re-parses the result, which refuses a
    // simple-format container that holds any other chunk.
    if (plan[0]?.data?.[0] === 0)
        return plan.slice(1);
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
    const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(source.size, 1));
    const sourceBuffer = Buffer.allocUnsafe(bufferSize);
    const destinationBuffer = Buffer.allocUnsafe(bufferSize);
    for (let offset = 0; offset < source.size;) {
        if (isAborted(signal))
            // Stryker disable next-line LogicalOperator, StringLiteral: unobservable-message — verifyOutput is the only caller and its catch discards the cause whenever the signal is aborted, reporting the typed aborted error; neither the abort reason nor the fallback exception's name or message reaches any result.
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(COPY_BLOCK_BYTES, source.size - offset);
        // Keep the two bounded reads serialized.  Concurrent MiB reads make the
        // verification pass contend for libuv's file-I/O scheduling window and
        // can create large tail-latency spikes on fresh benchmark children.
        const left = await sourceHandle.read(sourceBuffer, 0, length, source.dataOffset + offset);
        const right = await destinationHandle.read(destinationBuffer, 0, length, destination.dataOffset + offset);
        if (left.bytesRead !== length || right.bytesRead !== length)
            throw new Error("Source or output changed or became truncated during verification.");
        if (!sourceBuffer
            .subarray(0, length)
            .equals(destinationBuffer.subarray(0, length)))
            return false;
        offset += length;
    }
    return true;
}
const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);
const EXIF_IDENTIFIER = Buffer.from("Exif\0\0", "binary");
// The TIFF body of an EXIF chunk payload. Producers may or may not put the
// six-byte `Exif\0\0` identifier in front of it, and readIfd0Resolution expects
// the bare TIFF header, so an unstripped prefix would silently lose the resolution.
function exifTiffBody(payload) {
    return payload.subarray(0, EXIF_IDENTIFIER.length).equals(EXIF_IDENTIFIER)
        ? payload.subarray(EXIF_IDENTIFIER.length)
        : payload;
}
// True when the destination resolution differs from the source resolution in
// presence, any raw rational part, or the unit.
function resolutionsDiffer(actual, expected) {
    if (actual === undefined || expected === undefined)
        return actual !== expected;
    return (actual.x.numerator !== expected.x.numerator ||
        actual.x.denominator !== expected.x.denominator ||
        actual.y.numerator !== expected.y.numerator ||
        actual.y.denominator !== expected.y.denominator ||
        actual.unit !== expected.unit);
}
function verificationError(detail, path) {
    return executionError({ code: "verification-failed", detail, path }, "started");
}
function verificationAborted(path) {
    return executionError({ code: "aborted", detail: "Operation was aborted.", path }, "started");
}
async function verifyOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, preserveResolution, expectedOrientation, signal) {
    const source = admission.parsed;
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
        // The expected tag set is recomputed here from the request flags and the
        // source admission, never read back from the output plan.
        const wantsOrientation = preserveOrientation && expectedOrientation !== undefined;
        const expectedResolution = preserveResolution
            ? admission.sourceResolution
            : undefined;
        if (wantsOrientation || expectedResolution !== undefined) {
            const exifData = destinationExif?.metadata;
            if (exifData === undefined ||
                !exifData.equals(createMinimalExif({
                    ...(wantsOrientation ? { orientation: expectedOrientation } : {}),
                    ...(expectedResolution !== undefined
                        ? { resolution: expectedResolution }
                        : {}),
                })))
                return err(verificationError("EXIF chunk did not match the requested minimal tags.", destinationPath));
            // Parse the destination back: an encoder shared by planner and verifier
            // cannot vouch for itself, so the values are read as a consumer would
            // and compared with the request and the raw source resolution.
            const orientationBack = parseExif(exifData).orientation;
            if ((orientationBack.status === "valid"
                ? orientationBack.value
                : undefined) !== (wantsOrientation ? expectedOrientation : undefined))
                return err(verificationError("EXIF Orientation was not preserved.", destinationPath));
            if (resolutionsDiffer(readIfd0Resolution(exifData), expectedResolution))
                return err(verificationError("EXIF resolution did not parse back to the source resolution.", destinationPath));
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
        resolution: true,
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
    stagingFileName: "output.webp",
    matches(magic) {
        // A magic shorter than 12 bytes yields a form-type slice shorter than four characters, which
        // can never equal the signature, so no separate length test is needed.
        return (magic.subarray(0, 4).toString("ascii") === "RIFF" &&
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
    checkOutputPlan(plan) {
        return plan.length === 0 || webpOutputSize(plan) > MAX_RIFF_BYTES
            ? "Sanitized output exceeds RIFF limits."
            : undefined;
    },
    classifyAdmissionFailure(cause, preserveColorProfile) {
        if (!(cause instanceof WebpStructureError))
            return undefined;
        if (preserveColorProfile && cause.metadataLimit?.fourCc === "ICCP")
            return {
                code: "unsupported-feature",
                detail: `ICC profile size ${cause.metadataLimit.size} exceeds the ${cause.metadataLimit.limit}-byte policy limit.`,
                feature: "color-profile-preservation",
                reason: "policy-limit",
            };
        return { code: cause.kind, detail: cause.message };
    },
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