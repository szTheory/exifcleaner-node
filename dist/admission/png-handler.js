import { COPY_BLOCK_BYTES, copyRange } from "../io/copy-range.js";
import { createOrientationExif, parseExif } from "../metadata/exif.js";
import { parseIcc } from "../metadata/icc.js";
import { parseXmp, xmpOrientation } from "../metadata/xmp.js";
import { err, ok } from "../result.js";
import { executionError } from "../errors.js";
import { encodePngChunk, inflateBounded, InflateBudget, isPngSignature, parsePng, PNG_CRITICAL_CHUNK_TYPES, PNG_MAX_ANCILLARY_CHUNKS, PNG_MAX_BUFFERED_METADATA_BYTES_TOTAL, PNG_MAX_IDAT_CHUNKS, PNG_MAX_INFLATED_BYTES_TOTAL, PNG_MAX_INFLATED_ICC_BYTES, PNG_MAX_INFLATED_TEXT_BYTES, PNG_MAX_METADATA_BYTES_PER_CHUNK, PNG_REGISTERED_CHUNK_TYPES, PNG_SIGNATURE, PngStructureError, readExactly, } from "../png/chunks.js";
import { ICC_PRESERVATION_POLICY_ID, MAX_PROFILE_BYTES, } from "../metadata/icc_admission.js";
import { RAW_PROFILE_EXIF_KEYWORDS, rawProfileExifOrientation, } from "../png/orientation-sources.js";
// D-05 closed lists. Measured ExifTool 13.59 behaviour (56-CONTEXT.md,
// 56-RESEARCH.md): `-all=` keeps every type in PNG_PRESERVED_CHUNK_TYPES and
// removes every type in PNG_REMOVED_CHUNK_TYPES; `iCCP`/`pHYs` are removed
// unless the corresponding preservation flag is set (PNG_CONDITIONAL_CHUNK_TYPES).
// Casing note (56-08 D-05 amendment, maintainer-approved 2026-09-26): the
// carried-over 56-02 ambiguity between `mDCV`/`cLLI` (PNG Third Edition) and
// `mDCv`/`cLLi` (a lower-last-letter spelling that never appears in the
// actual registry) was measured directly against ExifTool 13.59 in this
// plan: freshly constructed fixtures show `-all=` and `-all=
// -TagsFromFile @ -ICC_Profile` preserve `mDCV`/`cLLI` byte-identical,
// exactly as they previously preserved `mDCv`/`cLLi`. The preserve-list now
// uses the standard spelling; `mDCv`/`cLLi` moves to registered-but-
// unmeasured (src/png/chunks.ts still admits it structurally), so it
// declines typed pre-write (unsafe-structure, safe-to-fallback) instead of
// being silently preserved under a spelling no real encoder emits.
export const PNG_PRESERVED_CHUNK_TYPES = new Set([
    "tRNS",
    "cHRM",
    "bKGD",
    "sBIT",
    "sPLT",
    "hIST",
    "cICP",
    "mDCV",
    "cLLI",
    "sCAL",
    "oFFs",
    "pCAL",
    "sTER",
    "iDOT",
    "vpAg",
]);
export const PNG_REMOVED_CHUNK_TYPES = new Set([
    "tEXt",
    "zTXt",
    "iTXt",
    "eXIf",
    "tIME",
    "caBX",
    "gAMA",
    "sRGB",
]);
export const PNG_CONDITIONAL_CHUNK_TYPES = new Map([
    ["iCCP", "colorProfile"],
    ["pHYs", "resolution"],
]);
const CHUNK_FIXED_OVERHEAD_BYTES = 12; // 4-byte length + 4-byte type + 4-byte CRC
function isAborted(signal) {
    return signal?.aborted ?? false;
}
/**
 * Extracted to a real function boundary so TypeScript widens `orientation`'s
 * type from its narrowed initializer literal (`{status:"absent"}`) instead of
 * carrying that narrowing past collectMetadata's `parsed.chunks.forEach`
 * closure, where every reassignment happens.
 */
function validOrientationValue(state) {
    return state.status === "valid" ? state.value : undefined;
}
function chunkSpan(chunk) {
    return CHUNK_FIXED_OVERHEAD_BYTES + chunk.length;
}
const ICCP_MIN_KEYWORD_BYTES = 1;
const ICCP_MAX_KEYWORD_BYTES = 79;
function parseIccpChunk(data, budget) {
    const nul = data.indexOf(0);
    if (nul < ICCP_MIN_KEYWORD_BYTES || nul > ICCP_MAX_KEYWORD_BYTES) {
        throw new PngStructureError("malformed-file", "iCCP chunk profile name is missing or exceeds the 79-byte limit.");
    }
    // A terminator that is the last byte leaves no method byte: `method` is then
    // undefined and the check below refuses the chunk with the same typed kind.
    const method = data[nul + 1];
    if (method !== 0) {
        throw new PngStructureError("malformed-file", "iCCP chunk compression method must be zero.");
    }
    const compressed = data.subarray(nul + 2);
    return inflateBounded(compressed, "iCCP", PNG_MAX_INFLATED_ICC_BYTES, budget);
}
function parseZtxtChunk(data, budget) {
    const nul = data.indexOf(0);
    if (nul < 0) {
        throw new PngStructureError("malformed-file", "zTXt chunk is missing its keyword terminator.");
    }
    // A terminator in the last two bytes leaves no compressed data: inflateBounded
    // refuses the empty stream with the same typed kind.
    const compressed = data.subarray(nul + 2);
    return inflateBounded(compressed, 
    // Stryker disable next-line StringLiteral: unobservable-message — this chunk label reaches only the diagnostic text and the typed limit's chunkType, which classifyAdmissionFailure compares with the iCCP label alone, so a zTXt label never selects a different outcome.
    "zTXt", PNG_MAX_INFLATED_TEXT_BYTES, budget);
}
function parseItxtChunk(data, budget) {
    const keywordNul = data.indexOf(0);
    // No keyword terminator means the data holds no zero byte at all, so the
    // language-tag search below finds none either and refuses with the same kind.
    const keyword = data.toString("latin1", 0, keywordNul);
    const compressionFlag = data[keywordNul + 1];
    let offset = keywordNul + 3; // past keyword\0, compression flag, compression method
    const languageNul = data.indexOf(0, offset);
    if (languageNul === -1) {
        throw new PngStructureError("malformed-file", "iTXt chunk is missing its language-tag terminator.");
    }
    offset = languageNul + 1;
    const translatedNul = data.indexOf(0, offset);
    if (translatedNul === -1) {
        throw new PngStructureError("malformed-file", "iTXt chunk is missing its translated-keyword terminator.");
    }
    const payload = data.subarray(translatedNul + 1);
    const text = compressionFlag === 1
        ? inflateBounded(payload, 
        // Stryker disable next-line StringLiteral: unobservable-message — this chunk label reaches only the diagnostic text and the typed limit's chunkType, which classifyAdmissionFailure compares with the iCCP label alone, so an iTXt label never selects a different outcome.
        "iTXt", PNG_MAX_INFLATED_TEXT_BYTES, budget)
        : payload;
    return { keyword, text };
}
const XMP_ITXT_KEYWORD = "XML:com.adobe.xmp";
/** PNG `tEXt` chunk payload: Latin-1 keyword, NUL, Latin-1 text (D-15). */
function parseTextChunkData(data) {
    const nul = data.indexOf(0);
    return nul < 0
        ? { keyword: data.toString("latin1"), text: "" }
        : {
            keyword: data.toString("latin1", 0, nul),
            text: data.toString("latin1", nul + 1),
        };
}
/**
 * WR-01: routes a decoded text-chunk keyword to its metadata/orientation
 * source, shared by the tEXt, zTXt and iTXt branches below (the sole place
 * that checks RAW_PROFILE_EXIF_KEYWORDS membership). Before this fix, XMP
 * (`XML:com.adobe.xmp`) was only recognised in iTXt and the raw EXIF/APP1
 * profile keywords were only recognised in tEXt/zTXt, so a PNG carrying
 * either source in the "wrong" chunk type silently lost its orientation
 * decline -- confirmed against ExifTool 13.59 (56-REVIEW.md), which honours
 * both keywords in every text chunk type. `textBuffer` is the chunk's
 * decoded text bytes (already decompressed for zTXt/compressed iTXt).
 * Returns `true` when the keyword was the XMP packet, so the caller skips
 * pushing a duplicate `PNG` text entry -- the XMP namespace/entries already
 * cover it. Never returns the source bytes themselves (D-12).
 */
function routeTextKeyword(keyword, textBuffer, namespaces, entries, warnings, otherOrientations) {
    if (keyword === XMP_ITXT_KEYWORD) {
        namespaces.add("XMP");
        const found = parseXmp(textBuffer);
        entries.push(...found.entries);
        warnings.push(...found.warnings);
        const foundOrientation = xmpOrientation(textBuffer);
        if (foundOrientation !== undefined)
            otherOrientations.push(foundOrientation);
        return true;
    }
    if (RAW_PROFILE_EXIF_KEYWORDS.has(keyword)) {
        const foundOrientation = rawProfileExifOrientation(textBuffer.toString("latin1"), PNG_MAX_INFLATED_TEXT_BYTES);
        if (foundOrientation !== undefined)
            otherOrientations.push(foundOrientation);
    }
    return false;
}
/**
 * PNG `tIME` chunk payload (7 bytes: 2-byte year, then month/day/hour/
 * minute/second) formatted to match ExifTool's measured `PNG:ModifyDate`
 * output shape (D-15).
 */
function formatPngTime(data) {
    const pad = (value, width = 2) => value.toString().padStart(width, "0");
    const year = data.readUInt16BE(0);
    const month = data[2] ?? 0;
    const day = data[3] ?? 0;
    const hour = data[4] ?? 0;
    const minute = data[5] ?? 0;
    const second = data[6] ?? 0;
    return `${pad(year, 4)}:${pad(month)}:${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
function collectMetadata(parsed) {
    const entries = [];
    const warnings = [];
    let orientation = { status: "absent" };
    let colorProfile;
    const namespaces = new Set();
    let resolutionNamespace;
    const classes = [];
    const unregisteredStripped = [];
    const budget = new InflateBudget(PNG_MAX_INFLATED_BYTES_TOTAL);
    // D-11/D-12: Orientation values read from every non-eXIf source (XMP iTXt,
    // ImageMagick raw-EXIF-profile tEXt/zTXt), collected during the same
    // traversal and reconciled against the eXIf's own Orientation once the
    // whole file has been scanned (chunk order is "anywhere" for all of
    // these). Never carries bytes -- only routing values.
    const otherOrientations = [];
    parsed.chunks.forEach((chunk, index) => {
        const { type } = chunk;
        if (PNG_CRITICAL_CHUNK_TYPES.has(type)) {
            classes.push("keep");
            return;
        }
        // iDOT (Apple's private adjacency-constrained chunk, D-06) is a measured
        // "keep, measured-kept by ExifTool" entry like any other
        // PNG_PRESERVED_CHUNK_TYPES member -- unconditionally kept here. The
        // iDOT-to-first-IDAT adjacency invariant is enforced at the plan level
        // (buildOutputPlan), not during admission, because it depends on the
        // request's preservation flags.
        if (PNG_PRESERVED_CHUNK_TYPES.has(type)) {
            classes.push("keep");
            return;
        }
        const conditional = PNG_CONDITIONAL_CHUNK_TYPES.get(type);
        if (conditional === "resolution") {
            classes.push("conditional-resolution");
            resolutionNamespace = "PNG";
            return;
        }
        if (conditional === "colorProfile") {
            classes.push("conditional-color");
            namespaces.add("ICC");
            const data = parsed.buffered.get(index);
            if (data !== undefined) {
                colorProfile = parseIccpChunk(data, budget);
                const found = parseIcc(colorProfile);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
            }
            return;
        }
        if (!PNG_REMOVED_CHUNK_TYPES.has(type)) {
            if (PNG_REGISTERED_CHUNK_TYPES.has(type)) {
                // D-05: registered but unmeasured. The handler never guesses keep or
                // strip -- it becomes eligible once a measurement adds it to a list.
                throw new PngStructureError("unsafe-structure", `PNG chunk ${type} is registered but its ExifTool behaviour is not measured; declining.`);
            }
            // D-05: unregistered private ancillary chunk. src/png/chunks.ts's
            // structural pass already refused an uppercase-first (critical) unknown
            // as an unknown-critical chunk, so anything reaching here is a
            // lowercase-first ancillary type. Strip it and record its type so the
            // differential can grant it (Plans 07/09); its presence widens
            // removedNamespaces via PNG.
            classes.push("remove");
            if (!unregisteredStripped.includes(type))
                unregisteredStripped.push(type);
            namespaces.add("PNG");
            return;
        }
        classes.push("remove");
        const data = parsed.buffered.get(index);
        if (type === "eXIf") {
            namespaces.add("EXIF");
            if (data !== undefined) {
                // D-11: PNG's eXIf is a singleton chunk type (SINGLETON_CHUNK_TYPES in
                // src/png/chunks.ts), so there is exactly one to read from. Task 2
                // layers the non-eXIf-source decline (D-11/D-12) on top of this.
                const found = parseExif(data);
                entries.push(...found.entries);
                warnings.push(...found.warnings);
                orientation = found.orientation;
            }
            return;
        }
        if (type === "caBX") {
            namespaces.add("C2PA");
            if (data !== undefined) {
                entries.push({ namespace: "C2PA", name: "JUMBF", value: data.length });
            }
            return;
        }
        if (type === "tIME") {
            namespaces.add("PNG");
            if (data !== undefined && data.length >= 7) {
                entries.push({
                    namespace: "PNG",
                    name: "ModifyDate",
                    value: formatPngTime(data),
                });
            }
            return;
        }
        if (type === "gAMA" || type === "sRGB") {
            // D-15: gAMA/sRGB widen removedNamespaces but never produce an entry --
            // there is nothing here a user would recognize as "their" metadata.
            namespaces.add("PNG");
            return;
        }
        if (type === "tEXt") {
            // Prettier would move the comment before the else onto the closing brace above it, where Stryker never reads it, so this statement is left as written.
            // prettier-ignore
            if (data !== undefined) {
                const { keyword, text } = parseTextChunkData(data);
                const wasXmp = routeTextKeyword(keyword, Buffer.from(text, "latin1"), namespaces, entries, warnings, otherOrientations);
                if (!wasXmp) {
                    namespaces.add("PNG");
                    entries.push({ namespace: "PNG", name: keyword, value: text });
                }
            }
            else 
            // Stryker disable next-line BlockStatement: defensive-unreachable-by-construction — parsePng stores the data of every chunk except IDAT in the buffered map, so a tEXt chunk always has data and this fallback is never reached.
            {
                namespaces.add("PNG");
            }
            return;
        }
        if (type === "zTXt") {
            // Prettier would move the comment before the else onto the closing brace above it, where Stryker never reads it, so this statement is left as written.
            // prettier-ignore
            if (data !== undefined) {
                const keywordNul = data.indexOf(0);
                const text = parseZtxtChunk(data, budget);
                const keyword = data.toString("latin1", 0, keywordNul);
                const wasXmp = routeTextKeyword(keyword, text, namespaces, entries, warnings, otherOrientations);
                if (!wasXmp) {
                    namespaces.add("PNG");
                    entries.push({
                        namespace: "PNG",
                        name: keyword,
                        value: text.toString("latin1"),
                    });
                }
            }
            else 
            // Stryker disable next-line BlockStatement: defensive-unreachable-by-construction — parsePng stores the data of every chunk except IDAT in the buffered map, so a zTXt chunk always has data and this fallback is never reached.
            {
                namespaces.add("PNG");
            }
            return;
        }
        // Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — every other removed chunk type returned above and every other type returned or threw earlier, so only an iTXt chunk reaches this test and it is always true; the always-false sibling is a TypeScript compile error and is suppressed only as collateral.
        if (type === "iTXt") {
            if (data === undefined) {
                namespaces.add("PNG");
                return;
            }
            const { keyword, text } = parseItxtChunk(data, budget);
            const wasXmp = routeTextKeyword(keyword, text, namespaces, entries, warnings, otherOrientations);
            if (!wasXmp) {
                namespaces.add("PNG");
                try {
                    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(text);
                    entries.push({ namespace: "PNG", name: keyword, value: decoded });
                }
                catch {
                    warnings.push({
                        code: "metadata-invalid",
                        detail: `iTXt chunk ${keyword} text is not valid UTF-8.`,
                    });
                }
            }
        }
    });
    // D-11: decline (route to ExifTool) only when a non-eXIf Orientation is
    // missing from eXIf or disagrees with it. An agreeing non-eXIf Orientation,
    // or a non-eXIf block carrying no Orientation, does not decline.
    const sourceValue = validOrientationValue(orientation);
    if (otherOrientations.some((other) => other !== sourceValue)) {
        orientation = {
            status: "unsupported",
            detail: "A non-eXIf Orientation is missing from eXIf or disagrees with it.",
        };
    }
    return {
        entries,
        warnings,
        orientation,
        colorProfile,
        namespaces: [...namespaces],
        resolutionNamespace,
        classes,
        unregisteredStripped,
    };
}
function isKept(cls, preserveColorProfile, preserveResolution) {
    if (cls === "keep")
        return true;
    if (cls === "conditional-color")
        return preserveColorProfile;
    if (cls === "conditional-resolution")
        return preserveResolution;
    return false;
}
/**
 * D-06: iDOT's offsets are relative to the iDOT chunk's own start, so nothing
 * may be inserted between iDOT and the first IDAT, and nothing between them
 * may be removed. Returns a decline message when a chunk in that span would
 * be removed under the current flags; undefined when the file has no iDOT,
 * has no IDAT after it, or every in-between chunk is kept.
 */
function findIdotAdjacencyDecline(admission, preserveColorProfile, preserveResolution) {
    const { chunks } = admission.parsed;
    const idotIndex = chunks.findIndex((item) => item.type === "iDOT");
    if (idotIndex < 0)
        return undefined;
    const firstIdatIndex = chunks.findIndex((item) => item.type === "IDAT");
    for (let index = idotIndex + 1; index < firstIdatIndex; index += 1) {
        const chunk = chunks[index];
        const cls = admission.classes[index] ?? "remove";
        if (!isKept(cls, preserveColorProfile, preserveResolution)) {
            return `PNG chunk ${chunk.type} sits between iDOT and the first IDAT and cannot be removed safely.`;
        }
    }
    return undefined;
}
function buildOutputPlan(admission, preserveOrientation, preserveColorProfile, preserveResolution, orientation) {
    // Every kept chunk is copied byte-for-byte from its original source range;
    // adjacent kept chunks are coalesced into one copy range. When orientation
    // preservation applies (D-11), a minimal eXIf (createOrientationExif) is
    // inserted immediately after IHDR -- chunk index 0, always kept (critical)
    // -- before any iDOT or IDAT (D-13). Inserting there always splits IHDR's
    // copy range from whatever follows it, since the insert is never adjacent
    // to a source byte range.
    const insertOrientation = preserveOrientation && orientation !== undefined;
    const parts = [];
    const expectedTypes = [];
    const copiedChunks = [];
    let pendingStart;
    let pendingEnd;
    const flush = () => {
        if (pendingStart === undefined || pendingEnd === undefined)
            return;
        parts.push({
            kind: "copy",
            sourceOffset: pendingStart,
            length: pendingEnd - pendingStart,
        });
        pendingStart = undefined;
        pendingEnd = undefined;
    };
    admission.parsed.chunks.forEach((chunk, index) => {
        const cls = admission.classes[index] ?? "remove";
        if (!isKept(cls, preserveColorProfile, preserveResolution)) {
            // Stryker disable next-line CallExpression: redundant-guard-after-typed-check — a removed chunk always has a positive span, so the next kept chunk never starts where the pending range ends and the non-adjacent branch below flushes that range first; the final flush covers a removed chunk at the end.
            flush();
            return;
        }
        const chunkStart = chunk.offset;
        const chunkEnd = chunk.offset + chunkSpan(chunk);
        if (pendingEnd === chunkStart) {
            pendingEnd = chunkEnd;
        }
        else {
            // Stryker disable next-line CallExpression: redundant-guard-after-typed-check — a pending range is only open here when the previous chunk was kept and adjacent in the file, and the removed-chunk branch above already flushed it otherwise, so this flush never has a range to write.
            flush();
            pendingStart = chunkStart;
            pendingEnd = chunkEnd;
        }
        expectedTypes.push(chunk.type);
        copiedChunks.push(chunk);
        if (index === 0 && insertOrientation) {
            flush();
            parts.push({
                kind: "insert",
                data: encodePngChunk("eXIf", createOrientationExif(orientation)),
            });
            expectedTypes.push("eXIf");
        }
    });
    flush();
    const declineReason = findIdotAdjacencyDecline(admission, preserveColorProfile, preserveResolution);
    return declineReason === undefined
        ? { parts, expectedTypes, copiedChunks }
        : { parts, expectedTypes, copiedChunks, declineReason };
}
function recomputeExpectedTypes(admission, preserveColorProfile, preserveResolution, insertOrientation) {
    const types = [];
    admission.parsed.chunks.forEach((chunk, index) => {
        const cls = admission.classes[index] ?? "remove";
        if (isKept(cls, preserveColorProfile, preserveResolution)) {
            types.push(chunk.type);
            if (index === 0 && insertOrientation)
                types.push("eXIf");
        }
    });
    return types;
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
async function chunksEqual(sourceHandle, source, destinationHandle, destination, signal) {
    const sourceSpan = chunkSpan(source);
    const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(sourceSpan, 1));
    const sourceBuffer = Buffer.allocUnsafe(bufferSize);
    const destinationBuffer = Buffer.allocUnsafe(bufferSize);
    for (let offset = 0; offset < sourceSpan;) {
        if (isAborted(signal))
            // Stryker disable next-line LogicalOperator, StringLiteral: unobservable-message — verifyOutput is the only caller and its catch discards the cause whenever the signal is aborted, reporting the typed aborted error; neither the abort reason nor the fallback exception's name or message reaches any result.
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const length = Math.min(COPY_BLOCK_BYTES, sourceSpan - offset);
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
    const insertOrientation = preserveOrientation && expectedOrientation !== undefined;
    try {
        const destination = await parsePng(destinationHandle, destinationSize, signal);
        const expectedTypes = recomputeExpectedTypes(admission, preserveColorProfile, preserveResolution, insertOrientation);
        const destinationTypes = destination.chunks.map((chunk) => chunk.type);
        if (destinationTypes.length !== expectedTypes.length ||
            destinationTypes.some((type, index) => type !== expectedTypes[index]))
            return err(verificationError("Destination chunk sequence did not match the sanitized plan.", destinationPath));
        for (const [index, type] of destinationTypes.entries()) {
            // The eXIf at index 1 is the deliberately-inserted minimal orientation
            // payload (D-11/D-13), not a leaked source chunk -- it is byte- and
            // content-verified separately below.
            if (insertOrientation && index === 1 && type === "eXIf")
                continue;
            if (PNG_REMOVED_CHUNK_TYPES.has(type))
                return err(verificationError(`${type} remained after sanitization.`, destinationPath));
        }
        if (insertOrientation) {
            const exifChunk = destination.chunks[1];
            if (exifChunk === undefined || exifChunk.type !== "eXIf")
                return err(verificationError("Expected eXIf chunk is missing after IHDR.", destinationPath));
            const exifData = await readExactly(destinationHandle, exifChunk.length, exifChunk.dataOffset);
            const expectedData = createOrientationExif(expectedOrientation);
            const reparsed = parseExif(exifData);
            if (!exifData.equals(expectedData) ||
                reparsed.orientation.status !== "valid" ||
                // Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — an eXIf payload equal to the freshly built minimal orientation payload reads back as that same valid orientation, so this operand is false whenever the first operand is false, and the first operand alone refuses every other payload.
                reparsed.orientation.value !== expectedOrientation ||
                // Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — an eXIf payload equal to the freshly built minimal orientation payload reads back as exactly one entry, so this operand is false whenever the first operand is false, and the first operand alone refuses every other payload.
                reparsed.entries.length !== 1)
                return err(verificationError("Inserted eXIf did not equal the minimal orientation payload.", destinationPath));
        }
        const sourceKept = admission.parsed.chunks.filter((_chunk, index) => isKept(admission.classes[index] ?? "remove", preserveColorProfile, preserveResolution));
        const destinationForComparison = insertOrientation
            ? destination.chunks.filter((_chunk, index) => index !== 1)
            : destination.chunks;
        // Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — the destination ends at its single IEND chunk and the loop below pairs every kept source chunk with the destination chunk at the same position, so a count difference already fails there: a missing destination chunk is an undefined operand, and a longer destination pairs the last kept source chunk, IEND, with a chunk of another type.
        if (sourceKept.length !== destinationForComparison.length)
            return err(verificationError("Destination chunk count did not match the sanitized plan.", destinationPath));
        for (let index = 0; index < sourceKept.length; index += 1) {
            const left = sourceKept[index];
            const right = destinationForComparison[index];
            if (left === undefined ||
                right === undefined ||
                // Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — the four type bytes of a chunk lie inside the span that chunksEqual compares, so a destination chunk of another type fails that comparison with the same refusal; a comparison that cannot complete throws and the catch returns the same typed code.
                left.type !== right.type ||
                !(await chunksEqual(sourceHandle, left, destinationHandle, right, signal)))
                return err(verificationError("Kept PNG chunk bytes changed.", destinationPath));
        }
        return ok(undefined);
    }
    catch (cause) {
        if (isAborted(signal))
            return err(verificationAborted(destinationPath));
        return err(verificationError(cause instanceof PngStructureError
            ? cause.message
            : "Could not reopen and verify the destination.", destinationPath));
    }
}
function classifyAdmissionFailure(cause, preserveColorProfile) {
    if (!(cause instanceof PngStructureError))
        return undefined;
    if (preserveColorProfile && cause.limit?.chunkType === "iCCP")
        return {
            code: "unsupported-feature",
            detail: `ICC profile size ${cause.limit.size} exceeds the ${cause.limit.limit}-byte policy limit.`,
            feature: "color-profile-preservation",
            reason: "policy-limit",
        };
    return { code: cause.kind, detail: cause.message };
}
const capability = Object.freeze({
    format: "png",
    mimeTypes: Object.freeze(["image/png"]),
    extensions: Object.freeze([".png"]),
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
        maxMetadataBytesPerChunk: PNG_MAX_METADATA_BYTES_PER_CHUNK,
        maxAncillaryChunkCount: PNG_MAX_ANCILLARY_CHUNKS,
        maxIdatChunkCount: PNG_MAX_IDAT_CHUNKS,
        maxInflatedIccBytes: PNG_MAX_INFLATED_ICC_BYTES,
        maxInflatedTextBytes: PNG_MAX_INFLATED_TEXT_BYTES,
        maxInflatedBytesTotal: PNG_MAX_INFLATED_BYTES_TOTAL,
        maxBufferedMetadataBytesTotal: PNG_MAX_BUFFERED_METADATA_BYTES_TOTAL,
    }),
    refuses: Object.freeze([
        "unknown-critical-chunks",
        "malformed-container",
        "crc-mismatch",
        "chunk-order",
        "truncation",
        "trailing-data",
        "animation",
        "resource-limits",
        "unmeasured-registered-chunks",
        "unsafe-chunk-adjacency",
    ]),
    removes: Object.freeze(["EXIF", "XMP", "ICC", "PNG", "C2PA"]),
    detection: "magic",
});
export const pngHandler = Object.freeze({
    capability,
    stagingFileName: "output.png",
    matches(magic) {
        return isPngSignature(magic);
    },
    async admit(handle, size, signal) {
        const parsed = await parsePng(handle, size, signal);
        return { parsed, ...collectMetadata(parsed) };
    },
    inspect(admission) {
        return {
            format: "png",
            entries: admission.entries,
            warnings: admission.warnings,
        };
    },
    buildOutputPlan,
    checkOutputPlan(plan) {
        if (plan.declineReason !== undefined)
            return plan.declineReason;
        return plan.expectedTypes.includes("IDAT")
            ? undefined
            : "Sanitized PNG plan is empty.";
    },
    classifyAdmissionFailure,
    async writeOutput(source, destination, plan, signal) {
        let position = await writeAll(destination, PNG_SIGNATURE, 0);
        for (const part of plan.parts) {
            if (isAborted(signal))
                throw signal?.reason ?? new DOMException("Aborted", "AbortError");
            position =
                part.kind === "insert"
                    ? await writeAll(destination, part.data, position)
                    : await copyRange(source, destination, part.sourceOffset, part.length, position, signal);
        }
    },
    verifyOutput,
});
//# sourceMappingURL=png-handler.js.map