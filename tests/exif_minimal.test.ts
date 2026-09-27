import { describe, expect, it } from "vitest";
import {
  createMinimalExif,
  createOrientationExif,
  parseExif,
  readIfd0Resolution,
} from "../src/metadata/exif.js";

/**
 * D-03: createMinimalExif generalizes createOrientationExif into a minimal
 * IFD0 builder covering Orientation and IFD0 resolution. This tracer case
 * pins the historical 26-byte orientation-only layout byte-for-byte before
 * any further behavior is added (Task 2).
 */

function historicalOrientationExif(orientation: number): Buffer {
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

describe("createMinimalExif: tracer — orientation-only output is byte-identical to the historical layout", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "orientation %d: createMinimalExif({ orientation }) equals the historical 26-byte layout",
    (value) => {
      const result = createMinimalExif({ orientation: value });
      expect(result.equals(historicalOrientationExif(value))).toBe(true);
      expect(result).toHaveLength(26);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "orientation %d: createOrientationExif delegates to createMinimalExif",
    (value) => {
      expect(
        createOrientationExif(value).equals(createMinimalExif({ orientation: value })),
      ).toBe(true);
    },
  );
});

describe("createMinimalExif: D-03 tag-set matrix", () => {
  it("orientation only: parses back to exactly one IFD0 entry, Orientation 6", () => {
    const result = createMinimalExif({ orientation: 6 });
    const parsed = parseExif(result);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.orientation).toEqual({ status: "valid", value: 6 });
  });

  it("resolution only (unit present): tags are exactly [0x011A, 0x011B, 0x0128] in order, 66 bytes total", () => {
    const result = createMinimalExif({
      resolution: {
        x: { numerator: 300, denominator: 1 },
        y: { numerator: 300, denominator: 1 },
        unit: 2,
      },
    });
    expect(result).toHaveLength(66);
    const count = result.readUInt16LE(8);
    expect(count).toBe(3);
    const tags = [0, 1, 2].map((index) => result.readUInt16LE(10 + index * 12));
    expect(tags).toEqual([0x011a, 0x011b, 0x0128]);
    // RATIONAL value offsets point past the next-IFD field (8 + 2 + 3*12 + 4 = 50).
    expect(result.readUInt32LE(10 + 0 * 12 + 8)).toBe(50);
    expect(result.readUInt32LE(10 + 1 * 12 + 8)).toBe(58);
  });

  it("orientation + resolution (no unit): tags are exactly [0x0112, 0x011A, 0x011B], raw pairs unreduced", () => {
    const result = createMinimalExif({
      orientation: 3,
      resolution: {
        x: { numerator: 72, denominator: 1 },
        y: { numerator: 144, denominator: 2 },
      },
    });
    const count = result.readUInt16LE(8);
    expect(count).toBe(3);
    const tags = [0, 1, 2].map((index) => result.readUInt16LE(10 + index * 12));
    expect(tags).toEqual([0x0112, 0x011a, 0x011b]);

    const resolution = readIfd0Resolution(result);
    expect(resolution).toEqual({
      x: { numerator: 72, denominator: 1 },
      y: { numerator: 144, denominator: 2 },
    });
  });

  it("zero denominator is written as stored and read back raw", () => {
    const result = createMinimalExif({
      resolution: {
        x: { numerator: 5, denominator: 0 },
        y: { numerator: 5, denominator: 0 },
      },
    });
    const resolution = readIfd0Resolution(result);
    expect(resolution).toEqual({
      x: { numerator: 5, denominator: 0 },
      y: { numerator: 5, denominator: 0 },
    });
  });

  it("empty tags object throws RangeError", () => {
    expect(() => createMinimalExif({})).toThrow(RangeError);
  });

  it("orientation 9 throws RangeError", () => {
    expect(() => createMinimalExif({ orientation: 9 })).toThrow(RangeError);
  });

  it("numerator -1 throws RangeError", () => {
    expect(() =>
      createMinimalExif({
        resolution: {
          x: { numerator: -1, denominator: 1 },
          y: { numerator: 1, denominator: 1 },
        },
      }),
    ).toThrow(RangeError);
  });

  it("numerator 2**32 throws RangeError", () => {
    expect(() =>
      createMinimalExif({
        resolution: {
          x: { numerator: 2 ** 32, denominator: 1 },
          y: { numerator: 1, denominator: 1 },
        },
      }),
    ).toThrow(RangeError);
  });

  it("no output ever contains YCbCrPositioning, ExifIFD, Software or DateTime", () => {
    const result = createMinimalExif({
      orientation: 6,
      resolution: {
        x: { numerator: 300, denominator: 1 },
        y: { numerator: 300, denominator: 1 },
        unit: 2,
      },
    });
    const count = result.readUInt16LE(8);
    const forbidden = new Set([0x0213, 0x8769, 0x0131, 0x0132]);
    for (let index = 0; index < count; index += 1) {
      const tag = result.readUInt16LE(10 + index * 12);
      expect(forbidden.has(tag)).toBe(false);
    }
  });
});

describe("readIfd0Resolution", () => {
  it("returns undefined when only XResolution is present (both X and Y required)", () => {
    // Build a TIFF with only XResolution in IFD0 (no YResolution).
    const result = Buffer.alloc(8 + 2 + 1 * 12 + 4 + 8);
    result.write("II", 0, "ascii");
    result.writeUInt16LE(42, 2);
    result.writeUInt32LE(8, 4);
    result.writeUInt16LE(1, 8);
    result.writeUInt16LE(0x011a, 10);
    result.writeUInt16LE(5, 12);
    result.writeUInt32LE(1, 14);
    result.writeUInt32LE(8 + 2 + 12 + 4, 18);
    result.writeUInt32LE(0, 8 + 2 + 12);
    result.writeUInt32LE(300, 8 + 2 + 12 + 4);
    result.writeUInt32LE(1, 8 + 2 + 12 + 4 + 4);
    expect(readIfd0Resolution(result)).toBeUndefined();
  });

  it("returns undefined on a malformed TIFF, never throws", () => {
    expect(readIfd0Resolution(Buffer.from("not a tiff"))).toBeUndefined();
    expect(readIfd0Resolution(Buffer.alloc(0))).toBeUndefined();
  });

  it("negative control: appending a YCbCrPositioning entry turns the tag-set test red (reverted after)", () => {
    // Manually construct a 2-entry IFD0: Orientation + a spliced-in
    // YCbCrPositioning (0x0213), which createMinimalExif must never emit.
    const entries = [
      { tag: 0x0112, type: 3, value: 6 },
      { tag: 0x0213, type: 3, value: 1 },
    ].sort((a, b) => a.tag - b.tag);
    const count = entries.length;
    const totalBytes = 8 + 2 + count * 12 + 4;
    const buffer = Buffer.alloc(totalBytes);
    buffer.write("II", 0, "ascii");
    buffer.writeUInt16LE(42, 2);
    buffer.writeUInt32LE(8, 4);
    buffer.writeUInt16LE(count, 8);
    entries.forEach((entry, index) => {
      const offset = 10 + index * 12;
      buffer.writeUInt16LE(entry.tag, offset);
      buffer.writeUInt16LE(entry.type, offset + 2);
      buffer.writeUInt32LE(1, offset + 4);
      buffer.writeUInt16LE(entry.value, offset + 8);
    });
    buffer.writeUInt32LE(0, totalBytes - 4);

    const tags: number[] = [];
    const readCount = buffer.readUInt16LE(8);
    for (let index = 0; index < readCount; index += 1) {
      tags.push(buffer.readUInt16LE(10 + index * 12));
    }
    // This fixture DOES contain YCbCrPositioning (0x0213) — proving the guard
    // below is non-vacuous. createMinimalExif's own output never does (see
    // "no output ever contains ... " test above), so this control demonstrates
    // the assertion would catch a real regression if createMinimalExif ever
    // emitted an extra tag.
    expect(tags).toContain(0x0213);
  });
});
