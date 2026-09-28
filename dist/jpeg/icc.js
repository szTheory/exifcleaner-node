// JPEG multi-segment ICC profile reassembly (ICC.1 Annex B.4, D-01 "one logical
// unit"). Every APP2 ICC_PROFILE payload the caller passes in must carry the same
// declared count byte, every sequence number 1..count must appear exactly once, and
// the reassembled profile is bounded by MAX_PROFILE_BYTES (the same limit
// src/metadata/icc_admission.ts enforces for PNG/WebP, imported not redefined). Any
// inconsistency throws JpegStructureError malformed-container; there is no partial
// result -- reassembleIccSegments either returns the whole profile or throws.
import { MAX_PROFILE_BYTES } from "../metadata/icc_admission.js";
import { JpegStructureError } from "./parser.js";
export const ICC_SEGMENT_IDENTIFIER = "ICC_PROFILE";
// "ICC_PROFILE\0" (11 characters + NUL), then a 1-byte sequence number and a
// 1-byte total count, then profile bytes (ICC.1 Annex B.4).
const ICC_IDENTIFIER_BYTES = 12;
function refuseMalformed(message) {
    throw new JpegStructureError("malformed-container", message);
}
/**
 * Reassembles a multi-segment JPEG APP2 ICC_PROFILE profile from its raw APPn
 * payloads (identifier prefix included, as buffered by `parseJpeg`). Segments may
 * arrive in any order; they are concatenated in sequence order, not payload-array
 * order (D-01 edge: out-of-order segments still reassemble correctly).
 */
export function reassembleIccSegments(payloads) {
    if (payloads.length === 0) {
        refuseMalformed("No ICC_PROFILE segments were provided to reassemble.");
    }
    let declaredCount;
    const bySequence = new Map();
    for (const payload of payloads) {
        if (payload.length < ICC_IDENTIFIER_BYTES + 2) {
            refuseMalformed("ICC_PROFILE segment payload is too short.");
        }
        const sequence = payload.readUInt8(ICC_IDENTIFIER_BYTES);
        const count = payload.readUInt8(ICC_IDENTIFIER_BYTES + 1);
        if (sequence === 0) {
            refuseMalformed("ICC_PROFILE segment sequence number is zero.");
        }
        if (count === 0) {
            refuseMalformed("ICC_PROFILE segment declared count is zero.");
        }
        if (sequence > count) {
            refuseMalformed(`ICC_PROFILE segment sequence number ${sequence} exceeds its declared count ${count}.`);
        }
        if (declaredCount === undefined) {
            declaredCount = count;
        }
        else if (declaredCount !== count) {
            refuseMalformed("ICC_PROFILE segments declare inconsistent total counts.");
        }
        if (bySequence.has(sequence)) {
            refuseMalformed(`ICC_PROFILE segment sequence number ${sequence} appears more than once.`);
        }
        bySequence.set(sequence, payload.subarray(ICC_IDENTIFIER_BYTES + 2));
    }
    if (declaredCount === undefined) {
        refuseMalformed("No ICC_PROFILE segments were provided to reassemble.");
    }
    const chunks = [];
    let totalLength = 0;
    for (let sequence = 1; sequence <= declaredCount; sequence += 1) {
        const chunk = bySequence.get(sequence);
        if (chunk === undefined) {
            refuseMalformed(`ICC_PROFILE segment sequence number ${sequence} is missing.`);
        }
        chunks.push(chunk);
        totalLength += chunk.length;
    }
    if (totalLength > MAX_PROFILE_BYTES) {
        throw new JpegStructureError("resource-limits", `Reassembled ICC profile is ${totalLength} bytes, exceeding the ${MAX_PROFILE_BYTES}-byte limit.`, {
            segment: ICC_SEGMENT_IDENTIFIER,
            size: totalLength,
            limit: MAX_PROFILE_BYTES,
        });
    }
    return Buffer.concat(chunks, totalLength);
}
//# sourceMappingURL=icc.js.map