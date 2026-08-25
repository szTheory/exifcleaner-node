import { createHash } from "node:crypto";
export const ICC_PRESERVATION_POLICY_ID = "icc-structural-v0.2";
const ICC_HEADER_BYTES = 128;
const ICC_TAG_COUNT_BYTES = 4;
const ICC_TAG_RECORD_BYTES = 12;
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;
const MAX_TAG_COUNT = 4_096;
const D50 = [0x0000_f6d6, 0x0001_0000, 0x0000_d32d];
function rejected(reason, detail) {
    return { ok: false, reason, detail };
}
function validDate(payload) {
    const year = payload.readUInt16BE(24);
    const month = payload.readUInt16BE(26);
    const day = payload.readUInt16BE(28);
    const hour = payload.readUInt16BE(30);
    const minute = payload.readUInt16BE(32);
    const second = payload.readUInt16BE(34);
    if (year === 0 ||
        month < 1 ||
        month > 12 ||
        hour > 23 ||
        minute > 59 ||
        second > 59)
        return false;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day >= 1 && day <= days;
}
function bcd(value) {
    const high = value >> 4;
    const low = value & 0x0f;
    return high <= 9 && low <= 9 ? high * 10 + low : undefined;
}
function allZero(payload, start, end) {
    for (let offset = start; offset < end; offset += 1)
        if (payload[offset] !== 0)
            return false;
    return true;
}
function profileIdMatches(payload) {
    if (allZero(payload, 84, 100))
        return true;
    const digestInput = Buffer.from(payload);
    digestInput.fill(0, 44, 48);
    digestInput.fill(0, 64, 68);
    digestInput.fill(0, 84, 100);
    return createHash("md5")
        .update(digestInput)
        .digest()
        .equals(payload.subarray(84, 100));
}
/**
 * Bounded structural admission only. It does not evaluate ICC semantics, CMM safety,
 * or color correctness, and never transforms or returns payload bytes.
 */
export function validateIccForPreservation(payload) {
    if (payload.length > MAX_PROFILE_BYTES)
        return rejected("policy-limit", "ICC profile exceeds the policy size limit.");
    if (payload.length < ICC_HEADER_BYTES + ICC_TAG_COUNT_BYTES)
        return rejected("invalid", "ICC profile header is truncated.");
    if (payload.length % 4 !== 0)
        return rejected("invalid", "ICC profile length is not four-byte aligned.");
    if (payload.readUInt32BE(0) !== payload.length)
        return rejected("invalid", "ICC profile declared size does not match its bytes.");
    if (payload.toString("ascii", 36, 40) !== "acsp")
        return rejected("invalid", "ICC profile signature is invalid.");
    const minor = bcd((payload[9] ?? 0) >> 4);
    const bugFix = bcd(payload[9] ?? 0);
    if (minor === undefined || bugFix === undefined)
        return rejected("invalid", "ICC profile version uses non-decimal BCD.");
    if (payload[8] !== 2 && payload[8] !== 4)
        return rejected("unsupported", "ICC profile major version is not admitted.");
    if (minor > 4)
        return rejected("unsupported", "ICC profile minor version is not admitted.");
    if (!allZero(payload, 10, 12))
        return rejected("invalid", "ICC profile version-reserved bytes are nonzero.");
    if (!validDate(payload))
        return rejected("invalid", "ICC profile creation date is invalid.");
    if (payload.readUInt32BE(64) > 3)
        return rejected("invalid", "ICC profile rendering intent is invalid.");
    const deviceClass = payload.toString("ascii", 12, 16);
    const colorSpace = payload.toString("ascii", 16, 20);
    const pcs = payload.toString("ascii", 20, 24);
    if (deviceClass !== "scnr" && deviceClass !== "mntr")
        return rejected("unsupported", "ICC profile device class is not admitted.");
    if (colorSpace !== "RGB " || (pcs !== "XYZ " && pcs !== "Lab "))
        return rejected("unsupported", "ICC profile color space is not admitted.");
    if (payload[8] === 2 && !allZero(payload, 84, 128))
        return rejected("invalid", "ICC v2 reserved bytes are nonzero.");
    if (payload[8] === 4 &&
        (payload.readUInt32BE(68) !== D50[0] ||
            payload.readUInt32BE(72) !== D50[1] ||
            payload.readUInt32BE(76) !== D50[2] ||
            !profileIdMatches(payload) ||
            !allZero(payload, 100, 128)))
        return rejected("invalid", "ICC v4 required header fields are invalid.");
    const tagCount = payload.readUInt32BE(128);
    if (tagCount === 0)
        return rejected("invalid", "ICC profile has no tag records.");
    if (tagCount > MAX_TAG_COUNT)
        return rejected("policy-limit", "ICC profile tag count exceeds the policy limit.");
    const tableEnd = ICC_HEADER_BYTES + ICC_TAG_COUNT_BYTES + tagCount * ICC_TAG_RECORD_BYTES;
    if (tableEnd > payload.length)
        return rejected("invalid", "ICC profile tag table is truncated.");
    // The tracer intentionally admits the one-record canonical layout; Plan 02 expands
    // this seam to the complete bounded tag-table policy.
    if (tagCount !== 1)
        return rejected("unsupported", "ICC profile tag table is not admitted by this policy path.");
    const signature = payload.readUInt32BE(132);
    const offset = payload.readUInt32BE(136);
    const size = payload.readUInt32BE(140);
    if (signature === 0 ||
        offset !== tableEnd ||
        offset % 4 !== 0 ||
        size < 8 ||
        offset + size !== payload.length)
        return rejected("invalid", "ICC profile tag range is invalid.");
    if (payload.readUInt32BE(offset + 4) !== 0)
        return rejected("invalid", "ICC profile tag type reserved bytes are nonzero.");
    return { ok: true };
}
//# sourceMappingURL=icc_admission.js.map