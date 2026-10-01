import { COPY_BLOCK_BYTES, copyRange } from "../io/copy-range.js";
import { createMinimalExif, parseExif, readIfd0Resolution, } from "../metadata/exif.js";
import { parseXmp, xmpOrientation } from "../metadata/xmp.js";
import { parseIcc } from "../metadata/icc.js";
import { err, ok } from "../result.js";
import { executionError } from "../errors.js";
import { APP0, APP1, APP2, APP14, classifyAppPayload, COM, DHT, DQT, DRI, EOI, JPEG_MAX_EXTENDED_XMP_BYTES, JPEG_MAX_FILE_BYTES, JPEG_MAX_ICC_SEGMENTS, JPEG_MAX_SCAN_COUNT, JPEG_MAX_SEGMENT_COUNT, JPEG_MAX_TABLE_SEGMENT_COUNT, JPEG_ADMITTED_SOF_MARKERS, JPEG_REFUSAL_DETAILS, SOI, SOS, isAppMarker, } from "../jpeg/markers.js";
import { JpegStructureError, isJpegSignature, parseJpeg, } from "../jpeg/parser.js";
import { ICC_SEGMENT_IDENTIFIER, reassembleIccSegments } from "../jpeg/icc.js";
import { STANDARD_XMP_IDENTIFIER, reassembleExtendedXmp } from "../jpeg/xmp.js";
import { classifyTrailerClasses, trailerRefusal, } from "../jpeg/trailer.js";
import { ICC_PRESERVATION_POLICY_ID, MAX_PROFILE_BYTES, } from "../metadata/icc_admission.js";
const TRAILER_TAIL_BYTES = 64;
const JPEG_SOI_BYTES = Buffer.from([0xff, SOI]);
const JPEG_EOI_BYTES = Buffer.from([0xff, EOI]);
// Only the prefixes still needed outside classification (payload
// stripping/rebuilding) are kept here; APPn classification itself now lives
// in classifyAppPayload (src/jpeg/markers.ts, WR-01).
const EXIF_PREFIX = Buffer.from("Exif\0\0", "ascii");
const XMP_STANDARD_PREFIX = Buffer.from(STANDARD_XMP_IDENTIFIER, "ascii");
// APP11 (JUMBF/C2PA) and APP13 (Photoshop) have no admitted constants in
// src/jpeg/markers.ts -- both are treated generically there (every APPn is
// admitted structurally); their D-01/D-02 meaning is format-handler-only.
const APP11 = 0xeb;
function isAborted(signal) {
    return signal?.aborted ?? false;
}
function startsWith(payload, prefix) {
    return (payload.length >= prefix.length &&
        payload.subarray(0, prefix.length).equals(prefix));
}
// WR-01: APPn-prefix classification ("what's removed vs. kept", D-01) lives
// once in src/jpeg/markers.ts (classifyAppPayload / AppSegmentKind) and is
// imported here, rather than re-implemented -- src/jpeg/parser.ts's
// classification of "what's buffered" imports the same function, so the two
// can never desynchronize. `payload` is `undefined` for every segment
// `parseJpeg` did not buffer (COM, APP13, APP11, unknown APPn, and any
// duplicate jfif/exif/xmp/mpf beyond the first); classifyAppPayload correctly
// falls through to "other" for those.
function isStructuralMarker(marker) {
    return (marker === SOS ||
        marker === DQT ||
        marker === DHT ||
        marker === DRI ||
        JPEG_ADMITTED_SOF_MARKERS.has(marker));
}
/**
 * D-01's closed classification rule, the single source of truth for what
 * survives sanitization -- used both by `collectMetadata` (to decide what to
 * report and to build the output plan from) and independently re-run by
 * `verifyOutput` against the reparsed destination, so a bug in
 * `buildOutputPlan`/`writeOutput` can never leak a removed identifier past
 * verification undetected.
 */
function classifySegments(parsed) {
    const adobePresent = parsed.segments.some((segment, index) => classifyAppPayload(segment.marker, parsed.buffered.get(index)) ===
        "adobe");
    return parsed.segments.map((segment, index) => {
        const { marker } = segment;
        if (isStructuralMarker(marker))
            return "structural";
        if (marker === COM || !isAppMarker(marker))
            return "remove";
        const kind = classifyAppPayload(marker, parsed.buffered.get(index));
        if (kind === "adobe")
            return "keep";
        if (kind === "jfif")
            return adobePresent ? "remove" : "conditional-resolution";
        if (kind === "icc")
            return "conditional-color";
        // exif, xmp, mpf and "other" (APP0 JFXX, APP11, APP13, non-Adobe APP14,
        // APP15, unknown identifiers, duplicates beyond the first) are all
        // removed unconditionally (D-01).
        return "remove";
    });
}
/**
 * Extracted to a real function boundary so TypeScript widens `orientation`'s
 * type from its narrowed initializer literal (`{status:"absent"}`) instead of
 * carrying that narrowing past `collectMetadata`'s `parsed.segments.forEach`
 * closure, where every reassignment happens (mirrors png-handler.ts's
 * `validOrientationValue` precedent for the same TS control-flow limitation).
 */
function isValidOrientation(state) {
    return state.status === "valid";
}
/** Same function-boundary widening as `isValidOrientation` (both exist for the
 * same TS control-flow limitation): returns the EXIF Orientation value when
 * `state` is valid, else `undefined`. */
function validOrientationValue(state) {
    return state.status === "valid" ? state.value : undefined;
}
const JFIF_HEADER_BYTES = 14; // identifier(5) + version(2) + units(1) + density(4) + thumbnail dims(2)
/** JFIF payload layout (D-04): units at byte 7, X/Ydensity at 8/10 (BE u16),
 * Xthumbnail/Ythumbnail at 12/13 -- the raw buffered payload, identifier
 * prefix included. Returns `undefined` when the payload is too short to hold
 * the fixed header (malformed; never guessed at). */
function readJfifDensity(payload) {
    if (payload.length < JFIF_HEADER_BYTES)
        return undefined;
    return {
        unit: payload.readUInt8(7),
        x: payload.readUInt16BE(8),
        y: payload.readUInt16BE(10),
    };
}
function jfifHasEmbeddedThumbnail(payload) {
    if (payload.length < JFIF_HEADER_BYTES)
        return false;
    return payload.readUInt8(12) !== 0 || payload.readUInt8(13) !== 0;
}
/** D-15 analog: `<MARKER>` for a COM segment, `APP<n>` for an APPn segment,
 * `APP<n>:<identifier>` when the segment carries an identifiable prefix. */
function markerLabel(marker, identifier) {
    const name = marker === COM
        ? "COM"
        : isAppMarker(marker)
            ? `APP${marker - APP0}`
            : `0x${marker.toString(16).padStart(2, "0")}`;
    return identifier === undefined || identifier.length === 0
        ? name
        : `${name}:${identifier}`;
}
function isKept(cls, preserveColorProfile, preserveResolution) {
    if (cls === "structural" || cls === "keep")
        return true;
    if (cls === "conditional-color")
        return preserveColorProfile;
    if (cls === "conditional-resolution")
        return preserveResolution;
    return false;
}
function collectMetadata(parsed, trailerTail) {
    const entries = [];
    const warnings = [];
    let orientation = { status: "absent" };
    const iccPayloads = [];
    let colorProfile;
    const namespaces = new Set();
    let resolutionNamespace;
    let exifSlot;
    let jfifDroppedForAdobe = false;
    let jfifConditionallyKept = false;
    let jfifHasThumbnail = false;
    let sourceResolution;
    let mpfPayload;
    const xmpEntries = [];
    let standardXmpPayload;
    const extendedXmpPayloads = [];
    const classes = classifySegments(parsed);
    parsed.segments.forEach((segment, index) => {
        const cls = classes[index];
        const { marker } = segment;
        if (cls === "structural" || cls === "keep")
            return;
        if (cls === "conditional-color") {
            namespaces.add("ICC");
            const payload = parsed.buffered.get(index);
            if (payload !== undefined)
                iccPayloads.push(payload);
            return;
        }
        if (cls === "conditional-resolution") {
            // The only way a JFIF segment classifies "conditional-resolution" is
            // when no Adobe APP14 is present anywhere in the file (classifySegments).
            jfifConditionallyKept = true;
            const payload = parsed.buffered.get(index);
            if (payload !== undefined) {
                // Never `namespaces.add("JPEG")` here: this JFIF is a *candidate*
                // for the resolution namespace mechanism (`resolutionNamespace`
                // below), which safe-transaction.ts only reports removed when
                // `preserveResolution` is false (D-06). Adding it to the general
                // `namespaces` set would double-report it as removed even when
                // preserved -- the entries below still carry namespace "JPEG" for
                // inspect(), which is a separate, unconditional concern.
                const density = readJfifDensity(payload);
                if (density !== undefined) {
                    entries.push({
                        namespace: "JPEG",
                        name: "JFIF:ResolutionUnit",
                        value: density.unit,
                    }, { namespace: "JPEG", name: "JFIF:XResolution", value: density.x }, { namespace: "JPEG", name: "JFIF:YResolution", value: density.y });
                }
                if (jfifHasEmbeddedThumbnail(payload))
                    jfifHasThumbnail = true;
            }
            return;
        }
        // cls === "remove"
        if (marker === COM) {
            namespaces.add("JPEG");
            entries.push({
                namespace: "JPEG",
                name: markerLabel(marker, undefined),
                value: segment.payloadLength,
            });
            return;
        }
        const payload = parsed.buffered.get(index);
        const kind = classifyAppPayload(marker, payload);
        if (kind === "jfif") {
            // The only way a JFIF segment classifies "remove" is D-06's Adobe drop.
            namespaces.add("JPEG");
            jfifDroppedForAdobe = true;
            if (payload !== undefined) {
                const density = readJfifDensity(payload);
                if (density !== undefined) {
                    entries.push({
                        namespace: "JPEG",
                        name: "JFIF:ResolutionUnit",
                        value: density.unit,
                    }, { namespace: "JPEG", name: "JFIF:XResolution", value: density.x }, { namespace: "JPEG", name: "JFIF:YResolution", value: density.y });
                }
            }
            return;
        }
        if (kind === "exif") {
            namespaces.add("EXIF");
            exifSlot = index;
            if (payload !== undefined) {
                const found = parseExif(payload);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
                orientation = found.orientation;
                const tiff = startsWith(payload, EXIF_PREFIX)
                    ? payload.subarray(EXIF_PREFIX.length)
                    : payload;
                sourceResolution = readIfd0Resolution(tiff);
            }
            return;
        }
        if (kind === "xmp") {
            namespaces.add("XMP");
            if (payload !== undefined) {
                const standard = payload.subarray(XMP_STANDARD_PREFIX.length);
                standardXmpPayload ??= standard;
                const found = parseXmp(standard);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
                xmpEntries.push(...found.entries);
            }
            return;
        }
        if (kind === "extended-xmp") {
            // Read-only, for D-05 orientation reconciliation only -- never feeds
            // output bytes or `entries` (JPG-01 removes all XMP outright).
            namespaces.add("XMP");
            if (payload !== undefined)
                extendedXmpPayloads.push(payload);
            return;
        }
        if (kind === "mpf") {
            namespaces.add("JPEG");
            if (payload !== undefined)
                mpfPayload = payload;
            entries.push({
                namespace: "JPEG",
                name: markerLabel(marker, segment.identifier),
                value: segment.payloadLength,
            });
            return;
        }
        if (marker === APP11) {
            namespaces.add("C2PA");
            entries.push({
                namespace: "C2PA",
                name: "JUMBF",
                value: segment.payloadLength,
            });
            return;
        }
        // APP0 JFXX, APP13 Photoshop, non-Adobe APP14, APP15, unknown
        // identifiers, and duplicate jfif/exif/xmp/mpf beyond the first.
        namespaces.add("JPEG");
        entries.push({
            namespace: "JPEG",
            name: markerLabel(marker, segment.identifier),
            value: segment.payloadLength,
        });
    });
    // D-05: the written Orientation comes only from EXIF IFD0 0x0112. A
    // standard XMP or complete ExtendedXMP tiff:Orientation that is present
    // while EXIF Orientation is missing or different declines pre-write
    // (mirrors PNG D-11's reconciliation shape: png-handler.ts:522-538).
    //
    // Measured (57-EVIDENCE.md "D-05 discrepancy"): unlike 57-CONTEXT.md's
    // prose, ExifTool does NOT pick EXIF over XMP "regardless of segment
    // order" -- whichever of EXIF/XMP appears first in the file wins. The
    // decline below is kept anyway, and is still correct regardless of that
    // order dependency: declining routes the whole file through the real
    // ExifTool fallback, which reproduces whatever ExifTool would have written
    // for the actual segment order for free. No order-awareness is needed here.
    if (standardXmpPayload !== undefined) {
        const candidates = [];
        const primary = xmpOrientation(standardXmpPayload);
        if (primary !== undefined)
            candidates.push(primary);
        const extended = reassembleExtendedXmp(standardXmpPayload, extendedXmpPayloads);
        if (extended.status === "complete") {
            const extendedValue = xmpOrientation(extended.xmp);
            if (extendedValue !== undefined)
                candidates.push(extendedValue);
        }
        else if (extended.status === "incomplete") {
            candidates.push("invalid");
            warnings.push({ code: "metadata-invalid", detail: extended.detail });
        }
        if (candidates.length > 0) {
            const sourceValue = validOrientationValue(orientation);
            const disagrees = candidates.some((candidate) => candidate === "invalid" || candidate !== sourceValue);
            if (disagrees) {
                orientation = {
                    status: "unsupported",
                    detail: "A non-EXIF Orientation is missing from EXIF IFD0 or disagrees with it.",
                };
            }
        }
    }
    if (iccPayloads.length > 0) {
        colorProfile = reassembleIccSegments(iccPayloads);
        const found = parseIcc(colorProfile);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
    }
    const fileSize = parsed.primaryEoiEnd + parsed.trailerBytes;
    const trailerClasses = classifyTrailerClasses({
        mpfPayload,
        xmpEntries,
        trailerTail,
        trailerBytes: parsed.trailerBytes,
        fileSize,
    });
    const refusal = trailerRefusal(trailerClasses);
    if (refusal !== undefined) {
        throw new JpegStructureError(refusal, JPEG_REFUSAL_DETAILS[refusal]);
    }
    // D-06: EXIF wins when the source carries its own IFD0 resolution; else
    // JFIF is the resolution source only when it was not dropped for Adobe;
    // else the source has no resolution to preserve.
    if (sourceResolution !== undefined)
        resolutionNamespace = "EXIF";
    else if (jfifConditionallyKept)
        resolutionNamespace = "JPEG";
    if (parsed.trailerBytes > 0) {
        namespaces.add("JPEG");
        entries.push({
            namespace: "JPEG",
            name: "Trailer",
            value: parsed.trailerBytes,
        });
    }
    return {
        entries,
        warnings,
        orientation,
        colorProfile,
        namespaces: [...namespaces],
        resolutionNamespace,
        classes,
        exifSlot,
        jfifDroppedForAdobe,
        jfifHasThumbnail,
        sourceResolution,
        trailerClasses,
    };
}
/**
 * D-03: the minimal IFD0 tag set `buildOutputPlan`/`verifyOutput` synthesize
 * -- orientation only when `preserveOrientation` requested a valid one,
 * resolution only from the source's own EXIF IFD0 (never JFIF/SPIFF/
 * Photoshop, D-04) when `preserveResolution` requested it. `undefined` when
 * neither tag applies (nothing to insert).
 */
function computeMinimalExifTags(admission, preserveOrientation, preserveResolution, orientation) {
    const tags = {
        ...(preserveOrientation && orientation !== undefined
            ? { orientation }
            : {}),
        ...(preserveResolution && admission.sourceResolution !== undefined
            ? { resolution: admission.sourceResolution }
            : {}),
    };
    return tags.orientation === undefined && tags.resolution === undefined
        ? undefined
        : tags;
}
/** Wraps a synthesized TIFF body in a complete APP1 Exif segment
 * (`0xFF 0xE1`, big-endian length, `Exif\0\0`, the TIFF bytes). */
function buildExifInsertSegment(tiff) {
    const length = 2 + EXIF_PREFIX.length + tiff.length;
    if (length > 0xffff) {
        throw new RangeError("Synthesized EXIF segment exceeds the 16-bit segment length field.");
    }
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = APP1;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, EXIF_PREFIX, tiff]);
}
function buildOutputPlan(admission, preserveOrientation, preserveColorProfile, preserveResolution, orientation) {
    const parts = [];
    const expectedMarkers = [];
    const copiedRanges = [];
    let pendingStart;
    let pendingEnd;
    const tags = computeMinimalExifTags(admission, preserveOrientation, preserveResolution, orientation);
    const flush = () => {
        if (pendingStart === undefined || pendingEnd === undefined)
            return;
        const length = pendingEnd - pendingStart;
        parts.push({ kind: "copy", sourceOffset: pendingStart, length });
        copiedRanges.push({ sourceOffset: pendingStart, length });
        pendingStart = undefined;
        pendingEnd = undefined;
    };
    admission.parsed.segments.forEach((segment, index) => {
        // D-03: the synthesized Exif always lands in the source Exif segment's
        // own slot, replacing it -- the source Exif segment itself is never
        // copied, whatever it classified as.
        if (tags !== undefined && index === admission.exifSlot) {
            flush();
            const tiff = createMinimalExif(tags);
            parts.push({ kind: "insert", data: buildExifInsertSegment(tiff) });
            expectedMarkers.push(APP1);
            return;
        }
        const cls = admission.classes[index] ?? "remove";
        if (!isKept(cls, preserveColorProfile, preserveResolution)) {
            flush();
            return;
        }
        const segmentStart = segment.offset;
        const segmentEnd = segment.offset + segment.totalLength;
        if (pendingEnd === segmentStart) {
            pendingEnd = segmentEnd;
        }
        else {
            flush();
            pendingStart = segmentStart;
            pendingEnd = segmentEnd;
        }
        expectedMarkers.push(segment.marker);
    });
    flush();
    // D-01/JPG-01 (JFIF thumbnail): a kept-candidate JFIF carrying a non-zero
    // thumbnail is never kept byte-identical (D-01 forbids editing a kept
    // JFIF), so the only safe native outcomes are remove or decline; declining
    // resolution preservation pre-write falls back to ExifTool, which recreates
    // JFIF from density alone (57-EVIDENCE.md D-01 jfif-thumbnail measurement).
    const declineReason = preserveResolution && admission.jfifHasThumbnail
        ? "JPEG JFIF segment carries an embedded thumbnail; resolution preservation falls back."
        : undefined;
    return {
        parts,
        expectedMarkers,
        copiedRanges,
        preserveResolution,
        ...(declineReason === undefined ? {} : { declineReason }),
    };
}
function recomputeExpectedMarkers(admission, preserveColorProfile, preserveResolution, hasInsert) {
    const markers = [];
    admission.parsed.segments.forEach((segment, index) => {
        if (hasInsert && index === admission.exifSlot) {
            markers.push(APP1);
            return;
        }
        const cls = admission.classes[index] ?? "remove";
        if (isKept(cls, preserveColorProfile, preserveResolution))
            markers.push(segment.marker);
    });
    return markers;
}
/** The destination segment index the synthesized Exif insert lands at --
 * the count of source segments kept before `admission.exifSlot`, since the
 * insert always replaces that slot 1:1 (never adjacent-coalesced with a kept
 * neighbor in the expected-marker sequence). */
function findInsertPosition(admission, preserveColorProfile, preserveResolution) {
    let position = 0;
    const stopAt = admission.exifSlot ?? 0;
    for (let index = 0; index < stopAt; index += 1) {
        const cls = admission.classes[index] ?? "remove";
        if (isKept(cls, preserveColorProfile, preserveResolution))
            position += 1;
    }
    return position;
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
async function readTail(handle, length, position) {
    const result = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const next = await handle.read(result, read, length - read, position + read);
        if (next.bytesRead === 0)
            break;
        read += next.bytesRead;
    }
    return result;
}
async function segmentsEqual(sourceHandle, source, destinationHandle, destination, signal) {
    if (source.totalLength !== destination.totalLength)
        return false;
    const span = source.totalLength;
    const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(span, 1));
    const sourceBuffer = Buffer.allocUnsafe(bufferSize);
    const destinationBuffer = Buffer.allocUnsafe(bufferSize);
    for (let offset = 0; offset < span;) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(COPY_BLOCK_BYTES, span - offset);
        const left = await sourceHandle.read(sourceBuffer, 0, length, source.offset + offset);
        const right = await destinationHandle.read(destinationBuffer, 0, length, destination.offset + offset);
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
function verificationError(detail, path) {
    return executionError({ code: "verification-failed", detail, path }, "started");
}
function verificationAborted(path) {
    return executionError({ code: "aborted", detail: "Operation was aborted.", path }, "started");
}
async function verifyOutput(sourceHandle, admission, destinationHandle, destinationSize, destinationPath, preserveOrientation, preserveColorProfile, preserveResolution, expectedOrientation, signal) {
    const tags = computeMinimalExifTags(admission, preserveOrientation, preserveResolution, expectedOrientation);
    const hasInsert = tags !== undefined;
    try {
        const destination = await parseJpeg(destinationHandle, destinationSize, signal);
        if (destination.trailerBytes !== 0)
            return err(verificationError("Destination retains trailer bytes after the primary EOI.", destinationPath));
        const expectedMarkers = recomputeExpectedMarkers(admission, preserveColorProfile, preserveResolution, hasInsert);
        const destinationMarkers = destination.segments.map((segment) => segment.marker);
        if (destinationMarkers.length !== expectedMarkers.length ||
            destinationMarkers.some((marker, index) => marker !== expectedMarkers[index]))
            return err(verificationError("Destination marker sequence did not match the sanitized plan.", destinationPath));
        const insertPosition = hasInsert
            ? findInsertPosition(admission, preserveColorProfile, preserveResolution)
            : -1;
        // D-01: independently re-derive the destination's own classification --
        // never merely trust the marker-sequence check above -- so a removed
        // identifier that somehow survived is always caught here. The inserted
        // Exif at `insertPosition` is the deliberately synthesized D-03 payload,
        // not a leaked source segment -- it is byte- and content-verified
        // separately below.
        const destinationClasses = classifySegments(destination);
        for (const [index, cls] of destinationClasses.entries()) {
            if (hasInsert && index === insertPosition)
                continue;
            if (!isKept(cls, preserveColorProfile, preserveResolution)) {
                const marker = destination.segments[index]?.marker ?? 0;
                return err(verificationError(`Marker 0x${marker.toString(16)} remained after sanitization.`, destinationPath));
            }
        }
        if (hasInsert) {
            const exifSegment = destination.segments[insertPosition];
            if (exifSegment === undefined || exifSegment.marker !== APP1)
                return err(verificationError("Expected synthesized Exif segment is missing from its source slot.", destinationPath));
            const exifPayload = await readTail(destinationHandle, exifSegment.payloadLength, exifSegment.payloadOffset);
            const expectedTiff = createMinimalExif(tags);
            const expectedPayload = Buffer.concat([EXIF_PREFIX, expectedTiff]);
            const reparsed = parseExif(exifPayload);
            const expectedEntryCount = (tags.orientation === undefined ? 0 : 1) +
                (tags.resolution === undefined
                    ? 0
                    : tags.resolution.unit === undefined
                        ? 2
                        : 3);
            if (!exifPayload.equals(expectedPayload) ||
                reparsed.entries.length !== expectedEntryCount ||
                (tags.orientation !== undefined &&
                    (reparsed.orientation.status !== "valid" ||
                        reparsed.orientation.value !== tags.orientation)))
                return err(verificationError("Inserted Exif did not equal the recomputed minimal EXIF payload.", destinationPath));
        }
        const sourceKept = admission.parsed.segments.filter((_segment, index) => {
            if (hasInsert && index === admission.exifSlot)
                return false;
            return isKept(admission.classes[index] ?? "remove", preserveColorProfile, preserveResolution);
        });
        const destinationForComparison = hasInsert
            ? destination.segments.filter((_segment, index) => index !== insertPosition)
            : destination.segments;
        if (sourceKept.length !== destinationForComparison.length)
            return err(verificationError("Destination segment count did not match the sanitized plan.", destinationPath));
        for (let index = 0; index < sourceKept.length; index += 1) {
            const left = sourceKept[index];
            const right = destinationForComparison[index];
            if (left === undefined ||
                right === undefined ||
                left.marker !== right.marker ||
                !(await segmentsEqual(sourceHandle, left, destinationHandle, right, signal)))
                return err(verificationError("Kept JPEG segment bytes changed.", destinationPath));
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        return err(verificationError(cause instanceof JpegStructureError
            ? cause.message
            : "Could not reopen and verify the destination.", destinationPath));
    }
}
function classifyAdmissionFailure(cause, preserveColorProfile) {
    if (!(cause instanceof JpegStructureError))
        return undefined;
    if (preserveColorProfile && cause.limit?.segment === ICC_SEGMENT_IDENTIFIER)
        return {
            code: "unsupported-feature",
            detail: `ICC profile size ${cause.limit.size} exceeds the ${cause.limit.limit}-byte policy limit.`,
            feature: "color-profile-preservation",
            reason: "policy-limit",
        };
    return { code: cause.kind, detail: cause.message };
}
const capability = Object.freeze({
    format: "jpeg",
    mimeTypes: Object.freeze(["image/jpeg"]),
    extensions: Object.freeze([".jpg", ".jpeg"]),
    inspect: true,
    sanitize: true,
    preserves: Object.freeze({
        orientation: true,
        colorProfile: true,
        timestamps: true,
        resolution: true,
        imagePayload: true,
        animationPayload: false,
    }),
    validation: Object.freeze({
        container: "full",
        codecBitstream: "not-decoded",
    }),
    colorProfile: Object.freeze({
        policy: ICC_PRESERVATION_POLICY_ID,
        preservation: "preserve-if-present",
        versions: Object.freeze(["v2.0-v2.4", "v4.0-v4.4"]),
        classes: Object.freeze(["scnr", "mntr"]),
        spaces: Object.freeze(["RGB /XYZ ", "RGB /Lab "]),
        maxProfileBytes: MAX_PROFILE_BYTES,
        maxTagCount: 4_096,
    }),
    limits: Object.freeze({
        maxFileBytes: JPEG_MAX_FILE_BYTES,
        maxSegmentCount: JPEG_MAX_SEGMENT_COUNT,
        maxScanCount: JPEG_MAX_SCAN_COUNT,
        maxTableSegmentCount: JPEG_MAX_TABLE_SEGMENT_COUNT,
        maxIccSegments: JPEG_MAX_ICC_SEGMENTS,
        maxReassembledIccBytes: MAX_PROFILE_BYTES,
        maxExtendedXmpBytes: JPEG_MAX_EXTENDED_XMP_BYTES,
    }),
    refuses: Object.freeze([
        "malformed-container",
        "truncation",
        "undefined-table-reference",
        "lossless-frame",
        "hierarchical-frame",
        "arithmetic-frame",
        "non-t81-frame",
        "non-8-bit-precision",
        "unsupported-component-count",
        "dnl-marker",
        "resource-limits",
        "mpf-secondary-image",
    ]),
    removes: Object.freeze(["EXIF", "XMP", "ICC", "C2PA", "JPEG"]),
    detection: "magic",
});
export const jpegHandler = Object.freeze({
    capability,
    stagingFileName: "output.jpg",
    matches(magic) {
        return isJpegSignature(magic);
    },
    async admit(handle, size, signal) {
        const parsed = await parseJpeg(handle, size, signal);
        const trailerStart = Math.max(parsed.primaryEoiEnd, size - TRAILER_TAIL_BYTES);
        const trailerLength = size - trailerStart;
        const trailerTail = trailerLength > 0
            ? await readTail(handle, trailerLength, trailerStart)
            : Buffer.alloc(0);
        return { parsed, ...collectMetadata(parsed, trailerTail) };
    },
    inspect(admission) {
        return {
            format: "jpeg",
            entries: admission.entries,
            warnings: admission.warnings,
        };
    },
    buildOutputPlan,
    checkOutputPlan(plan) {
        if (plan.declineReason !== undefined)
            return plan.declineReason;
        return plan.expectedMarkers.includes(SOS)
            ? undefined
            : "Sanitized JPEG plan is empty.";
    },
    classifyAdmissionFailure,
    async writeOutput(source, destination, plan, signal) {
        let position = await writeAll(destination, JPEG_SOI_BYTES, 0);
        for (const part of plan.parts) {
            if (isAborted(signal))
                throw signal?.reason ?? new DOMException("Aborted", "AbortError");
            position =
                part.kind === "insert"
                    ? await writeAll(destination, part.data, position)
                    : await copyRange(source, destination, part.sourceOffset, part.length, position, signal);
        }
        await writeAll(destination, JPEG_EOI_BYTES, position);
    },
    verifyOutput,
});
//# sourceMappingURL=jpeg-handler.js.map