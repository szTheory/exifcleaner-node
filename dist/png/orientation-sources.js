import { parseExif } from "../metadata/exif.js";
import { parseXmp } from "../metadata/xmp.js";
import { PngStructureError } from "./chunks.js";
// D-11/D-12: non-eXIf Orientation sources are read only for routing -- their
// bytes never reach the output. Both readers return a value, "invalid" (a
// present but unusable/disagreeable Orientation), or undefined (absent).
const XMP_ORIENTATION_NAME = "tiff:Orientation";
/** ImageMagick's legacy raw-EXIF-profile text-chunk keywords (D-11). */
export const RAW_PROFILE_EXIF_KEYWORDS = new Set([
    "Raw profile type exif",
    "Raw profile type APP1",
]);
function isOrientationValue(value) {
    return Number.isInteger(value) && value >= 1 && value <= 8;
}
/**
 * Reads a `tiff:Orientation` entry out of an XMP packet (D-11/D-12). Returns
 * the value when it parses as an integer 1-8, `"invalid"` when the entry is
 * present but unusable, or `undefined` when no such entry exists. Never
 * returns XMP bytes -- only a value for routing.
 */
export function xmpOrientation(xmp) {
    const { entries } = parseXmp(xmp);
    const entry = entries.find((item) => item.name === XMP_ORIENTATION_NAME);
    if (entry === undefined)
        return undefined;
    const raw = entry.value;
    const text = typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number"
            ? String(raw)
            : undefined;
    if (text === undefined || text.length === 0)
        return "invalid";
    const parsed = Number.parseInt(text, 10);
    return String(parsed) === text && isOrientationValue(parsed)
        ? parsed
        : "invalid";
}
/**
 * Parses an ImageMagick-style "Raw profile type exif"/"Raw profile type
 * APP1" text-chunk payload (a newline, the profile name, a newline, a
 * right-aligned decimal byte count, a newline, then hex digits in lines) and
 * reads its embedded EXIF Orientation (D-11/D-12). The declared byte count
 * is bounds-checked against `maxBytes` *before* any hex is decoded (D-14's
 * DoS mitigation for this reader); an over-bound declaration always refuses,
 * independent of any preservation flag. Malformed layout or hex is
 * `malformed-file`. Never returns the decoded bytes -- only a value or
 * absence, for routing.
 */
export function rawProfileExifOrientation(text, maxBytes) {
    const lines = text.split("\n");
    const countLine = lines[2];
    if (lines.length < 4 || countLine === undefined) {
        throw new PngStructureError("malformed-file", "Raw profile text is missing its header.");
    }
    const trimmedCount = countLine.trim();
    const declaredLength = Number.parseInt(trimmedCount, 10);
    if (trimmedCount.length === 0 ||
        String(declaredLength) !== trimmedCount ||
        declaredLength < 0) {
        throw new PngStructureError("malformed-file", "Raw profile declared length is invalid.");
    }
    if (declaredLength > maxBytes) {
        throw new PngStructureError("unsafe-structure", `Raw profile declared length ${declaredLength} exceeds the ${maxBytes}-byte bound.`, { chunkType: "raw-profile", size: declaredLength, limit: maxBytes });
    }
    const hexChars = lines.slice(3).join("").replace(/[ \t\r]+/gu, "");
    const hexSlice = hexChars.slice(0, declaredLength * 2);
    if (hexSlice.length !== declaredLength * 2 ||
        !/^[0-9a-fA-F]*$/u.test(hexSlice)) {
        throw new PngStructureError("malformed-file", "Raw profile hex data is missing or contains a non-hex digit.");
    }
    const data = Buffer.from(hexSlice, "hex");
    const found = parseExif(data);
    if (found.orientation.status === "valid")
        return found.orientation.value;
    if (found.orientation.status === "absent")
        return undefined;
    return "invalid";
}
//# sourceMappingURL=orientation-sources.js.map