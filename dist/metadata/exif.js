const MAX_IFD_ENTRIES = 4_096;
const MAX_IFD_DEPTH = 4;
const TAG_NAMES = {
    0x010e: "ImageDescription",
    0x010f: "Make",
    0x0110: "Model",
    0x0112: "Orientation",
    0x0131: "Software",
    0x0132: "DateTime",
    0x013b: "Artist",
    0x8298: "Copyright",
    0x829a: "ExposureTime",
    0x829d: "FNumber",
    0x8827: "ISOSpeedRatings",
    0x9000: "ExifVersion",
    0x9003: "DateTimeOriginal",
    0x9004: "DateTimeDigitized",
    0x9201: "ShutterSpeedValue",
    0x9202: "ApertureValue",
    0x9204: "ExposureBiasValue",
    0x9209: "Flash",
    0x920a: "FocalLength",
    0x927c: "MakerNote",
    0x9286: "UserComment",
    0xa001: "ColorSpace",
    0xa002: "PixelXDimension",
    0xa003: "PixelYDimension",
    0xa405: "FocalLengthIn35mmFilm",
    0x0000: "GPSVersionID",
    0x0001: "GPSLatitudeRef",
    0x0002: "GPSLatitude",
    0x0003: "GPSLongitudeRef",
    0x0004: "GPSLongitude",
    0x0005: "GPSAltitudeRef",
    0x0006: "GPSAltitude",
    0x001d: "GPSDateStamp",
};
const TYPE_WIDTHS = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    7: 1,
    9: 4,
    10: 8,
};
function inBounds(buffer, offset, length) {
    return (Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        offset <= buffer.length - length);
}
function makeReader(buffer, littleEndian) {
    return {
        buffer,
        littleEndian,
        u16(offset) {
            if (!inBounds(buffer, offset, 2))
                throw new RangeError("TIFF u16 out of bounds");
            return littleEndian
                ? buffer.readUInt16LE(offset)
                : buffer.readUInt16BE(offset);
        },
        u32(offset) {
            if (!inBounds(buffer, offset, 4))
                throw new RangeError("TIFF u32 out of bounds");
            return littleEndian
                ? buffer.readUInt32LE(offset)
                : buffer.readUInt32BE(offset);
        },
        i32(offset) {
            if (!inBounds(buffer, offset, 4))
                throw new RangeError("TIFF i32 out of bounds");
            return littleEndian
                ? buffer.readInt32LE(offset)
                : buffer.readInt32BE(offset);
        },
    };
}
function readNumber(reader, type, offset) {
    switch (type) {
        case 1:
        case 7:
            if (!inBounds(reader.buffer, offset, 1))
                throw new RangeError("TIFF byte out of bounds");
            return reader.buffer[offset] ?? 0;
        case 3:
            return reader.u16(offset);
        case 4:
            return reader.u32(offset);
        case 9:
            return reader.i32(offset);
        default:
            throw new RangeError("Unsupported numeric TIFF type");
    }
}
function simplify(values) {
    return values.length === 1 ? (values[0] ?? null) : values;
}
function readValue(reader, entryOffset, type, count) {
    const width = TYPE_WIDTHS[type];
    if (width === undefined || count > 1_000_000)
        return undefined;
    const byteLength = width * count;
    if (!Number.isSafeInteger(byteLength))
        return undefined;
    const valueOffset = byteLength <= 4 ? entryOffset + 8 : reader.u32(entryOffset + 8);
    if (!inBounds(reader.buffer, valueOffset, byteLength)) {
        throw new RangeError("TIFF value points outside EXIF data");
    }
    if (type === 2) {
        const bytes = reader.buffer.subarray(valueOffset, valueOffset + byteLength);
        const nul = bytes.indexOf(0);
        return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString("utf8");
    }
    if (type === 5 || type === 10) {
        const values = [];
        for (let index = 0; index < count; index += 1) {
            const offset = valueOffset + index * 8;
            const numerator = type === 5 ? reader.u32(offset) : reader.i32(offset);
            const denominator = type === 5 ? reader.u32(offset + 4) : reader.i32(offset + 4);
            values.push(denominator === 0
                ? { numerator, denominator }
                : numerator / denominator);
        }
        return simplify(values);
    }
    if (type === 7) {
        const bytes = reader.buffer.subarray(valueOffset, valueOffset + byteLength);
        const printable = bytes.every((byte) => byte === 0 || byte === 9 || byte === 10 || byte === 13 || byte >= 32);
        if (printable)
            return bytes.toString("utf8").replace(/\0+$/u, "");
        return [...bytes];
    }
    const values = [];
    for (let index = 0; index < count; index += 1) {
        values.push(readNumber(reader, type, valueOffset + index * width));
    }
    return simplify(values);
}
export function parseExif(payload) {
    const warnings = [];
    const entries = [];
    let orientation = { status: "absent" };
    const tiff = payload.subarray(0, 6).equals(Buffer.from("Exif\0\0", "binary"))
        ? payload.subarray(6)
        : payload;
    try {
        if (tiff.length < 8)
            throw new RangeError("EXIF TIFF header is truncated");
        const byteOrder = tiff.toString("ascii", 0, 2);
        if (byteOrder !== "II" && byteOrder !== "MM") {
            throw new RangeError("EXIF byte order is invalid");
        }
        const reader = makeReader(tiff, byteOrder === "II");
        if (reader.u16(2) !== 42)
            throw new RangeError("EXIF TIFF marker is invalid");
        const visited = new Set();
        const visitIfd = (offset, prefix, depth) => {
            if (depth > MAX_IFD_DEPTH || visited.has(offset))
                return;
            visited.add(offset);
            if (!inBounds(tiff, offset, 2))
                throw new RangeError("EXIF IFD is out of bounds");
            const count = reader.u16(offset);
            if (count > MAX_IFD_ENTRIES ||
                !inBounds(tiff, offset + 2, count * 12 + 4)) {
                throw new RangeError("EXIF IFD is oversized or truncated");
            }
            for (let index = 0; index < count; index += 1) {
                const entryOffset = offset + 2 + index * 12;
                const tag = reader.u16(entryOffset);
                const type = reader.u16(entryOffset + 2);
                const valueCount = reader.u32(entryOffset + 4);
                if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) {
                    const childPrefix = tag === 0x8825 ? "GPS." : tag === 0x8769 ? "Exif." : "Interop.";
                    visitIfd(reader.u32(entryOffset + 8), childPrefix, depth + 1);
                    continue;
                }
                if (prefix === "" && tag === 0x0112) {
                    if (orientation.status !== "absent") {
                        const detail = "EXIF contains more than one Orientation tag.";
                        orientation = {
                            status: "unsupported",
                            detail,
                        };
                        warnings.push({ code: "metadata-unsupported", detail });
                        continue;
                    }
                    if (type !== 3 || valueCount !== 1) {
                        const detail = "EXIF Orientation must use TIFF SHORT with exactly one value.";
                        orientation = {
                            status: "unsupported",
                            detail,
                        };
                        warnings.push({ code: "metadata-unsupported", detail });
                        continue;
                    }
                }
                const value = readValue(reader, entryOffset, type, valueCount);
                if (value === undefined) {
                    warnings.push({
                        code: "metadata-unsupported",
                        detail: `EXIF tag 0x${tag.toString(16).padStart(4, "0")} uses unsupported TIFF type ${type}.`,
                    });
                    continue;
                }
                const baseName = TAG_NAMES[tag] ?? `Tag0x${tag.toString(16).padStart(4, "0")}`;
                const name = `${prefix}${baseName}`;
                entries.push({ namespace: "EXIF", name, value });
                if (prefix === "" && tag === 0x0112 && typeof value === "number") {
                    if (Number.isInteger(value) && value >= 1 && value <= 8) {
                        orientation = { status: "valid", value };
                    }
                    else {
                        const detail = "EXIF Orientation must be an integer from 1 through 8.";
                        orientation = { status: "unsupported", detail };
                        warnings.push({ code: "metadata-unsupported", detail });
                    }
                }
            }
        };
        visitIfd(reader.u32(4), "", 0);
    }
    catch (cause) {
        const detail = cause instanceof Error ? cause.message : "EXIF data is invalid.";
        warnings.push({
            code: "metadata-invalid",
            detail,
        });
        orientation = { status: "malformed", detail };
    }
    return { entries, warnings, orientation };
}
export function createOrientationExif(orientation) {
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
        throw new RangeError("EXIF Orientation must be an integer from 1 through 8");
    }
    const result = Buffer.alloc(26);
    result.write("II", 0, "ascii");
    result.writeUInt16LE(42, 2);
    result.writeUInt32LE(8, 4);
    result.writeUInt16LE(1, 8);
    result.writeUInt16LE(0x0112, 10);
    result.writeUInt16LE(3, 12);
    result.writeUInt32LE(1, 14);
    result.writeUInt16LE(orientation, 18);
    result.writeUInt32LE(0, 22);
    return result;
}
//# sourceMappingURL=exif.js.map