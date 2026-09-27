import type {
  MetadataEntry,
  MetadataValue,
  MetadataWarning,
} from "../types.js";

const MAX_IFD_ENTRIES = 4_096;
const MAX_IFD_DEPTH = 4;

const TAG_NAMES: Readonly<Record<number, string>> = {
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

const TYPE_WIDTHS: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

export interface ParsedExif {
  readonly entries: readonly MetadataEntry[];
  readonly warnings: readonly MetadataWarning[];
  readonly orientation:
    | { readonly status: "absent" }
    | { readonly status: "valid"; readonly value: number }
    | { readonly status: "malformed"; readonly detail: string }
    | { readonly status: "unsupported"; readonly detail: string };
}

interface TiffReader {
  readonly buffer: Buffer;
  readonly littleEndian: boolean;
  u16(offset: number): number;
  u32(offset: number): number;
  i32(offset: number): number;
}

function inBounds(buffer: Buffer, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= buffer.length - length
  );
}

function makeReader(buffer: Buffer, littleEndian: boolean): TiffReader {
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

function readNumber(reader: TiffReader, type: number, offset: number): number {
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

function simplify(values: readonly MetadataValue[]): MetadataValue {
  return values.length === 1 ? (values[0] ?? null) : values;
}

function readValue(
  reader: TiffReader,
  entryOffset: number,
  type: number,
  count: number,
): MetadataValue | undefined {
  const width = TYPE_WIDTHS[type];
  if (width === undefined || count > 1_000_000) return undefined;
  const byteLength = width * count;
  if (!Number.isSafeInteger(byteLength)) return undefined;
  const valueOffset =
    byteLength <= 4 ? entryOffset + 8 : reader.u32(entryOffset + 8);
  if (!inBounds(reader.buffer, valueOffset, byteLength)) {
    throw new RangeError("TIFF value points outside EXIF data");
  }

  if (type === 2) {
    const bytes = reader.buffer.subarray(valueOffset, valueOffset + byteLength);
    const nul = bytes.indexOf(0);
    return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString("utf8");
  }
  if (type === 5 || type === 10) {
    const values: MetadataValue[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = valueOffset + index * 8;
      const numerator = type === 5 ? reader.u32(offset) : reader.i32(offset);
      const denominator =
        type === 5 ? reader.u32(offset + 4) : reader.i32(offset + 4);
      values.push(
        denominator === 0
          ? { numerator, denominator }
          : numerator / denominator,
      );
    }
    return simplify(values);
  }
  if (type === 7) {
    const bytes = reader.buffer.subarray(valueOffset, valueOffset + byteLength);
    const printable = bytes.every(
      (byte) =>
        byte === 0 || byte === 9 || byte === 10 || byte === 13 || byte >= 32,
    );
    if (printable) return bytes.toString("utf8").replace(/\0+$/u, "");
    return [...bytes];
  }

  const values: MetadataValue[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(readNumber(reader, type, valueOffset + index * width));
  }
  return simplify(values);
}

export function parseExif(payload: Buffer): ParsedExif {
  const warnings: MetadataWarning[] = [];
  const entries: MetadataEntry[] = [];
  let orientation: ParsedExif["orientation"] = { status: "absent" };
  const tiff = payload.subarray(0, 6).equals(Buffer.from("Exif\0\0", "binary"))
    ? payload.subarray(6)
    : payload;

  try {
    if (tiff.length < 8) throw new RangeError("EXIF TIFF header is truncated");
    const byteOrder = tiff.toString("ascii", 0, 2);
    if (byteOrder !== "II" && byteOrder !== "MM") {
      throw new RangeError("EXIF byte order is invalid");
    }
    const reader = makeReader(tiff, byteOrder === "II");
    if (reader.u16(2) !== 42)
      throw new RangeError("EXIF TIFF marker is invalid");

    const visited = new Set<number>();
    const visitIfd = (offset: number, prefix: string, depth: number): void => {
      if (depth > MAX_IFD_DEPTH || visited.has(offset)) return;
      visited.add(offset);
      if (!inBounds(tiff, offset, 2))
        throw new RangeError("EXIF IFD is out of bounds");
      const count = reader.u16(offset);
      if (
        count > MAX_IFD_ENTRIES ||
        !inBounds(tiff, offset + 2, count * 12 + 4)
      ) {
        throw new RangeError("EXIF IFD is oversized or truncated");
      }
      for (let index = 0; index < count; index += 1) {
        const entryOffset = offset + 2 + index * 12;
        const tag = reader.u16(entryOffset);
        const type = reader.u16(entryOffset + 2);
        const valueCount = reader.u32(entryOffset + 4);
        if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) {
          const childPrefix =
            tag === 0x8825 ? "GPS." : tag === 0x8769 ? "Exif." : "Interop.";
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
            const detail =
              "EXIF Orientation must use TIFF SHORT with exactly one value.";
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
        const baseName =
          TAG_NAMES[tag] ?? `Tag0x${tag.toString(16).padStart(4, "0")}`;
        const name = `${prefix}${baseName}`;
        entries.push({ namespace: "EXIF", name, value });
        if (prefix === "" && tag === 0x0112 && typeof value === "number") {
          if (Number.isInteger(value) && value >= 1 && value <= 8) {
            orientation = { status: "valid", value };
          } else {
            const detail =
              "EXIF Orientation must be an integer from 1 through 8.";
            orientation = { status: "unsupported", detail };
            warnings.push({ code: "metadata-unsupported", detail });
          }
        }
      }
    };
    visitIfd(reader.u32(4), "", 0);
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message : "EXIF data is invalid.";
    warnings.push({
      code: "metadata-invalid",
      detail,
    });
    orientation = { status: "malformed", detail };
  }

  return { entries, warnings, orientation };
}

/** A single IFD0 X or Y resolution rational, stored exactly as the source held it. */
export interface MinimalExifResolutionValue {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * D-03: the resolution tags `createMinimalExif` may write. `unit` (IFD0 0x0128
 * ResolutionUnit) is optional; when omitted no ResolutionUnit tag is written.
 */
export interface MinimalExifResolution {
  readonly x: MinimalExifResolutionValue;
  readonly y: MinimalExifResolutionValue;
  readonly unit?: number;
}

/** D-03: the only tags `createMinimalExif` may ever write. */
export interface MinimalExifTags {
  readonly orientation?: number;
  readonly resolution?: MinimalExifResolution;
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(
      `${field} must be an integer from 0 through 4294967295`,
    );
  }
}

function assertResolutionValue(
  value: MinimalExifResolutionValue,
  field: string,
): void {
  assertUint32(value.numerator, `${field} numerator`);
  assertUint32(value.denominator, `${field} denominator`);
}

/**
 * D-03: builds a minimal little-endian TIFF/EXIF payload containing only the
 * requested IFD0 tags, in ascending tag order (0x0112 Orientation SHORT,
 * 0x011A XResolution RATIONAL, 0x011B YResolution RATIONAL, 0x0128
 * ResolutionUnit SHORT), with RATIONAL values stored after the IFD block and
 * referenced by offset. No YCbCrPositioning, no ExifIFD pointer, no IFD1, no
 * Software, no DateTime, no other tag. Resolution values are written exactly
 * as given — never derived, reduced or reconciled with JFIF/SPIFF/Photoshop
 * values (D-04).
 *
 * Throws `RangeError` when no tag is requested, or any field is out of range.
 */
export function createMinimalExif(tags: MinimalExifTags): Buffer {
  const { orientation, resolution } = tags;

  if (orientation === undefined && resolution === undefined) {
    throw new RangeError(
      "createMinimalExif requires at least one of orientation or resolution",
    );
  }

  if (orientation !== undefined) {
    if (
      !Number.isInteger(orientation) ||
      orientation < 1 ||
      orientation > 8
    ) {
      throw new RangeError(
        "EXIF Orientation must be an integer from 1 through 8",
      );
    }
  }

  if (resolution !== undefined) {
    assertResolutionValue(resolution.x, "XResolution");
    assertResolutionValue(resolution.y, "YResolution");
    if (resolution.unit !== undefined) {
      if (
        !Number.isInteger(resolution.unit) ||
        resolution.unit < 0 ||
        resolution.unit > 0xffff
      ) {
        throw new RangeError(
          "ResolutionUnit must be an integer from 0 through 65535",
        );
      }
    }
  }

  interface Entry {
    readonly tag: number;
    readonly type: 3 | 5;
    readonly inlineValue?: number;
    readonly rational?: MinimalExifResolutionValue;
  }

  const entries: Entry[] = [];
  if (orientation !== undefined) {
    entries.push({ tag: 0x0112, type: 3, inlineValue: orientation });
  }
  if (resolution !== undefined) {
    entries.push({ tag: 0x011a, type: 5, rational: resolution.x });
    entries.push({ tag: 0x011b, type: 5, rational: resolution.y });
    if (resolution.unit !== undefined) {
      entries.push({ tag: 0x0128, type: 3, inlineValue: resolution.unit });
    }
  }
  entries.sort((a, b) => a.tag - b.tag);

  const entryCount = entries.length;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const rationalCount = entries.filter((entry) => entry.rational).length;
  const totalBytes = 8 + ifdBytes + rationalCount * 8;

  const result = Buffer.alloc(totalBytes);
  result.write("II", 0, "ascii");
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(8, 4);
  result.writeUInt16LE(entryCount, 8);

  let rationalOffset = 8 + ifdBytes;
  entries.forEach((entry, index) => {
    const entryOffset = 10 + index * 12;
    result.writeUInt16LE(entry.tag, entryOffset);
    result.writeUInt16LE(entry.type, entryOffset + 2);
    result.writeUInt32LE(1, entryOffset + 4);
    if (entry.type === 3) {
      result.writeUInt16LE(entry.inlineValue ?? 0, entryOffset + 8);
    } else {
      result.writeUInt32LE(rationalOffset, entryOffset + 8);
      const rational = entry.rational!;
      result.writeUInt32LE(rational.numerator, rationalOffset);
      result.writeUInt32LE(rational.denominator, rationalOffset + 4);
      rationalOffset += 8;
    }
  });
  result.writeUInt32LE(0, 8 + ifdBytes - 4);

  return result;
}

export function createOrientationExif(orientation: number): Buffer {
  return createMinimalExif({ orientation });
}

/**
 * D-03: reads the raw (unreduced) IFD0 X/YResolution and ResolutionUnit from a
 * TIFF/EXIF payload, without going through `parseExif`'s reduced-rational
 * decode. Returns `undefined` when either X or Y is absent, of the wrong TIFF
 * type/count, or the TIFF is malformed — never throws.
 */
export function readIfd0Resolution(
  tiff: Buffer,
): MinimalExifResolution | undefined {
  try {
    if (tiff.length < 8) return undefined;
    const byteOrder = tiff.toString("ascii", 0, 2);
    if (byteOrder !== "II" && byteOrder !== "MM") return undefined;
    const reader = makeReader(tiff, byteOrder === "II");
    if (reader.u16(2) !== 42) return undefined;

    const ifd0Offset = reader.u32(4);
    if (!inBounds(tiff, ifd0Offset, 2)) return undefined;
    const count = reader.u16(ifd0Offset);
    if (count > MAX_IFD_ENTRIES || !inBounds(tiff, ifd0Offset + 2, count * 12))
      return undefined;

    let x: MinimalExifResolutionValue | undefined;
    let y: MinimalExifResolutionValue | undefined;
    let unit: number | undefined;

    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifd0Offset + 2 + index * 12;
      const tag = reader.u16(entryOffset);
      if (tag !== 0x011a && tag !== 0x011b && tag !== 0x0128) continue;
      const type = reader.u16(entryOffset + 2);
      const valueCount = reader.u32(entryOffset + 4);
      if (tag === 0x0128) {
        if (type !== 3 || valueCount !== 1) continue;
        unit = reader.u16(entryOffset + 8);
        continue;
      }
      if (type !== 5 || valueCount !== 1) continue;
      const valueOffset = reader.u32(entryOffset + 8);
      if (!inBounds(tiff, valueOffset, 8)) continue;
      const value: MinimalExifResolutionValue = {
        numerator: reader.u32(valueOffset),
        denominator: reader.u32(valueOffset + 4),
      };
      if (tag === 0x011a) x = value;
      else y = value;
    }

    if (x === undefined || y === undefined) return undefined;
    return unit === undefined ? { x, y } : { x, y, unit };
  } catch {
    return undefined;
  }
}
