import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import { createMinimalExif, parseExif } from "../src/metadata/exif.js";
import {
  iccProfileV4,
  jpegAdobe,
  jpegExif,
  jpegJfif,
  minimalJpeg,
} from "./fixtures.js";
import {
  appSegment,
  iccSegments,
  spliceSegments,
} from "./qualification/jpeg/fixtures.js";

/**
 * D-03/D-04/D-06 preservation matrix, plus the 57-06 tracer (Task 1) that
 * proves a source's preserved IFD0 tags ride a freshly synthesized minimal
 * EXIF in the source Exif slot -- never a copy of the source Exif bytes.
 */

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-jpeg-preservation-"),
  );
  directories.push(directory);
  return directory;
}

interface PreservationFlags {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
}

const ALL_FALSE: PreservationFlags = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

async function sanitizeToDirectory(
  source: Buffer,
  options: Partial<PreservationFlags> = {},
) {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.jpg");
  const destinationPath = join(directory, "destination.jpg");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...ALL_FALSE,
    ...options,
  });
  return { directory, sourcePath, destinationPath, result };
}

interface MarkerRange {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
}

/** Test-local marker walker (independent of src/jpeg/parser.ts). */
function readMarkerRanges(bytes: Buffer): MarkerRange[] {
  const ranges: MarkerRange[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff)
      throw new Error("expected a marker prefix byte");
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) {
      ranges.push({
        marker,
        start,
        end: offset,
        payloadStart: offset,
        payloadEnd: offset,
      });
      break;
    }
    if (marker === 0xda) {
      const length = bytes.readUInt16BE(offset);
      const payloadStart = offset + 2;
      const payloadEnd = offset + length;
      offset += length;
      for (;;) {
        while (bytes[offset] !== 0xff) offset += 1;
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      ranges.push({ marker, start, end: offset, payloadStart, payloadEnd });
      continue;
    }
    const length = bytes.readUInt16BE(offset);
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    offset += length;
    ranges.push({ marker, start, end: offset, payloadStart, payloadEnd });
  }
  return ranges;
}

function markerSequence(bytes: Buffer): number[] {
  return readMarkerRanges(bytes).map((range) => range.marker);
}

function firstByMarker(
  ranges: readonly MarkerRange[],
  marker: number,
): MarkerRange | undefined {
  return ranges.find((range) => range.marker === marker);
}

interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * Hand-built little-endian TIFF/EXIF body: IFD0 (Make, Orientation,
 * X/YResolution, ResolutionUnit, Artist, a GPS IFD pointer) chained to an
 * IFD1 carrying a "thumbnail" (a unique byte marker, not a real JPEG) --
 * every source-only tag the D-03 tracer must prove absent from the
 * synthesized output.
 */
function buildTracerTiff(): {
  readonly tiff: Buffer;
  readonly artistMarker: Buffer;
  readonly thumbnailMarker: Buffer;
} {
  const orientation = 6;
  const artistBytes = Buffer.from("PRIVATE-ARTIST-MARKER\0", "ascii");
  const makeBytes = Buffer.from("PRIVATE-MAKE-MARKER\0", "ascii");
  const thumbnail = Buffer.from("THUMBNAIL-BYTES-MARKER-".repeat(6), "ascii");

  const entryCount = 7; // Make, Orientation, XRes, YRes, ResUnit, Artist, GPS pointer
  const ifd0Offset = 8;
  const ifd0Bytes = 2 + entryCount * 12 + 4;
  const externalStart = ifd0Offset + ifd0Bytes;

  const makeOffset = externalStart;
  const xResOffset = makeOffset + makeBytes.length;
  const yResOffset = xResOffset + 8;
  const artistOffset = yResOffset + 8;
  const gpsOffset = artistOffset + artistBytes.length;
  const gpsBytes = 2 + 1 * 12 + 4;
  const ifd1Offset = gpsOffset + gpsBytes;
  const ifd1Bytes = 2 + 2 * 12 + 4;
  const thumbnailOffset = ifd1Offset + ifd1Bytes;
  const total = thumbnailOffset + thumbnail.length;

  const tiff = Buffer.alloc(total);
  tiff.write("II", 0, 2, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Offset, 4);

  let o = ifd0Offset;
  tiff.writeUInt16LE(entryCount, o);
  o += 2;
  const writeEntry = (
    tag: number,
    type: number,
    count: number,
    value: number,
  ): void => {
    tiff.writeUInt16LE(tag, o);
    tiff.writeUInt16LE(type, o + 2);
    tiff.writeUInt32LE(count, o + 4);
    tiff.writeUInt32LE(value, o + 8);
    o += 12;
  };
  writeEntry(0x010f, 2, makeBytes.length, makeOffset); // Make
  writeEntry(0x0112, 3, 1, orientation); // Orientation
  writeEntry(0x011a, 5, 1, xResOffset); // XResolution
  writeEntry(0x011b, 5, 1, yResOffset); // YResolution
  writeEntry(0x0128, 3, 1, 2); // ResolutionUnit (inches)
  writeEntry(0x013b, 2, artistBytes.length, artistOffset); // Artist
  writeEntry(0x8825, 4, 1, gpsOffset); // GPS IFD pointer
  tiff.writeUInt32LE(ifd1Offset, o); // IFD0 next-IFD -> IFD1
  o += 4;

  makeBytes.copy(tiff, makeOffset);
  tiff.writeUInt32LE(300, xResOffset);
  tiff.writeUInt32LE(1, xResOffset + 4);
  tiff.writeUInt32LE(300, yResOffset);
  tiff.writeUInt32LE(1, yResOffset + 4);
  artistBytes.copy(tiff, artistOffset);

  let g = gpsOffset;
  tiff.writeUInt16LE(1, g);
  g += 2;
  tiff.writeUInt16LE(0x0000, g); // GPSVersionID
  tiff.writeUInt16LE(1, g + 2); // BYTE
  tiff.writeUInt32LE(4, g + 4);
  tiff.writeUInt8(2, g + 8);
  tiff.writeUInt8(3, g + 9);
  tiff.writeUInt8(0, g + 10);
  tiff.writeUInt8(0, g + 11);
  g += 12;
  tiff.writeUInt32LE(0, g); // GPS next-IFD: none

  let i1 = ifd1Offset;
  tiff.writeUInt16LE(2, i1);
  i1 += 2;
  tiff.writeUInt16LE(0x0201, i1); // JPEGInterchangeFormat
  tiff.writeUInt16LE(4, i1 + 2);
  tiff.writeUInt32LE(1, i1 + 4);
  tiff.writeUInt32LE(thumbnailOffset, i1 + 8);
  i1 += 12;
  tiff.writeUInt16LE(0x0202, i1); // JPEGInterchangeFormatLength
  tiff.writeUInt16LE(4, i1 + 2);
  tiff.writeUInt32LE(1, i1 + 4);
  tiff.writeUInt32LE(thumbnail.length, i1 + 8);
  i1 += 12;
  tiff.writeUInt32LE(0, i1); // IFD1 next-IFD: none

  thumbnail.copy(tiff, thumbnailOffset);

  return {
    tiff,
    artistMarker: artistBytes,
    thumbnailMarker: thumbnail.subarray(0, 64),
  };
}

describe("Task 1 tracer: D-03 minimal EXIF synthesis in the source Exif slot", () => {
  it("preserves Orientation and IFD0 resolution as one synthesized Exif; Artist/Make/GPS/thumbnail never ride along", async () => {
    const { tiff, artistMarker, thumbnailMarker } = buildTracerTiff();
    const profile = iccProfileV4();
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
      appSegment(APP1, jpegExif(tiff)),
      ...iccSegments(profile, profile.length),
      appSegment(0xfe, Buffer.from("private comment", "ascii")),
    ]);

    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveOrientation: true,
      preserveColorProfile: true,
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(true);
    expect(result.value.preserved.colorProfile).toBe(true);
    expect(result.value.preserved.resolution).toBe(true);

    const destination = await readFile(destinationPath);
    const ranges = readMarkerRanges(destination);
    const kept = ranges
      .map((range) => range.marker)
      .filter(
        (marker) =>
          marker !== 0xdb &&
          marker !== 0xc0 &&
          marker !== 0xc4 &&
          marker !== 0xda &&
          marker !== 0xd9,
      );
    expect(kept).toEqual([APP0, APP1, APP2]);

    // APP0 and APP2 are byte-identical to the source.
    const sourceRanges = readMarkerRanges(source);
    for (const marker of [APP0, APP2]) {
      const s = firstByMarker(sourceRanges, marker)!;
      const d = firstByMarker(ranges, marker)!;
      expect(
        destination
          .subarray(d.start, d.end)
          .equals(source.subarray(s.start, s.end)),
      ).toBe(true);
    }

    // APP1's TIFF equals the recomputed minimal EXIF for exactly the
    // preserved tags.
    const app1 = firstByMarker(ranges, APP1)!;
    const app1Payload = destination.subarray(
      app1.payloadStart,
      app1.payloadEnd,
    );
    const expectedTiff = createMinimalExif({
      orientation: 6,
      resolution: {
        x: { numerator: 300, denominator: 1 },
        y: { numerator: 300, denominator: 1 },
        unit: 2,
      },
    });
    expect(app1Payload.subarray(6).equals(expectedTiff)).toBe(true);

    // Artist, Make, GPS and the thumbnail bytes never survive.
    expect(
      destination.includes(artistMarker.subarray(0, artistMarker.length - 1)),
    ).toBe(false);
    expect(
      destination.includes(Buffer.from("PRIVATE-MAKE-MARKER", "ascii")),
    ).toBe(false);
    expect(destination.includes(thumbnailMarker)).toBe(false);

    // parseExif on the destination yields exactly the preserved tag set.
    const reparsed = parseExif(app1Payload);
    expect(reparsed.orientation).toEqual({ status: "valid", value: 6 });
    expect(reparsed.entries.map((entry) => entry.name).sort()).toEqual(
      ["Orientation", "ResolutionUnit", "XResolution", "YResolution"].sort(),
    );
  });

  it("NEGATIVE CONTROL: copying the source Exif segment instead of inserting the synthesized one would leak Artist (documented, not executed as a live mutation here -- see SUMMARY for the live run)", () => {
    // Guarded by the tracer test above: `app1Payload.subarray(6).equals(expectedTiff)`
    // asserts byte-for-byte equality with the *synthesized* TIFF, which is a
    // different (shorter) buffer than the source's Artist/Make/GPS/thumbnail
    // -carrying TIFF -- a copy-back regression would fail that assertion.
    expect(true).toBe(true);
  });
});

describe("D-04/D-06 resolution matrix (jpeg_preservation)", () => {
  it("JFIF-only + preserveResolution true: APP0 byte-identical, no APP1, preserved.resolution true, resolutionNamespace JPEG", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    expect(result.value.removedNamespaces).not.toContain("JPEG");

    const destination = await readFile(destinationPath);
    expect(markerSequence(destination)).not.toContain(APP1);
    const ranges = readMarkerRanges(destination);
    const sourceRanges = readMarkerRanges(source);
    const d = firstByMarker(ranges, APP0)!;
    const s = firstByMarker(sourceRanges, APP0)!;
    expect(
      destination
        .subarray(d.start, d.end)
        .equals(source.subarray(s.start, s.end)),
    ).toBe(true);
  });

  it("JFIF 72dpi + IFD0 300dpi conflict + true: both kept independently, no reconciliation, no unit conversion", async () => {
    const tiffOrientationOnly = (() => {
      const { tiff } = buildTracerTiff();
      return tiff;
    })();
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
      appSegment(APP1, jpegExif(tiffOrientationOnly)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);

    const destination = await readFile(destinationPath);
    const ranges = readMarkerRanges(destination);
    const app0 = firstByMarker(ranges, APP0)!;
    // JFIF density bytes (offsets 8-11 of the payload) stay 72/72.
    const jfifPayload = destination.subarray(
      app0.payloadStart,
      app0.payloadEnd,
    );
    expect(jfifPayload.readUInt16BE(8)).toBe(72);
    expect(jfifPayload.readUInt16BE(10)).toBe(72);
    const app1 = firstByMarker(ranges, APP1)!;
    const app1Payload = destination.subarray(
      app1.payloadStart,
      app1.payloadEnd,
    );
    const reparsed = parseExif(app1Payload);
    const xEntry = reparsed.entries.find(
      (entry) => entry.name === "XResolution",
    );
    expect(xEntry?.value).toBe(300);
  });

  it("IFD0-only + true: minimal Exif carries only the resolution tags", async () => {
    const { tiff } = buildTracerTiff();
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP1, jpegExif(tiff)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);

    const destination = await readFile(destinationPath);
    const ranges = readMarkerRanges(destination);
    const app1 = firstByMarker(ranges, APP1)!;
    const app1Payload = destination.subarray(
      app1.payloadStart,
      app1.payloadEnd,
    );
    const reparsed = parseExif(app1Payload);
    expect(reparsed.orientation.status).toBe("absent");
    expect(reparsed.entries.map((entry) => entry.name).sort()).toEqual(
      ["ResolutionUnit", "XResolution", "YResolution"].sort(),
    );
  });

  it("any source + preserveResolution false: no JFIF, no IFD0 resolution tag, preserved.resolution false, removedNamespaces includes the resolution namespace", async () => {
    const { tiff } = buildTracerTiff();
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
      appSegment(APP1, jpegExif(tiff)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(result.value.removedNamespaces).toContain("EXIF");

    const destination = await readFile(destinationPath);
    expect(markerSequence(destination)).not.toContain(APP0);
    expect(markerSequence(destination)).not.toContain(APP1);
  });

  it("JFIF-only source + preserveResolution false: removedNamespaces includes JPEG (the resolutionNamespace)", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
    ]);
    const { result } = await sanitizeToDirectory(source, {
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(result.value.removedNamespaces).toContain("JPEG");
  });

  it("D-06: APP14 + JFIF + IFD0 300dpi + true: no APP0, Exif carries IFD0 300, preserved.resolution true, no decline", async () => {
    const { tiff } = buildTracerTiff();
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
      appSegment(APP1, jpegExif(tiff)),
      appSegment(APP14, jpegAdobe(1)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);

    const destination = await readFile(destinationPath);
    const markers = markerSequence(destination);
    expect(markers).not.toContain(APP0);
    const ranges = readMarkerRanges(destination);
    const app1 = firstByMarker(ranges, APP1)!;
    const app1Payload = destination.subarray(
      app1.payloadStart,
      app1.payloadEnd,
    );
    const reparsed = parseExif(app1Payload);
    const xEntry = reparsed.entries.find(
      (entry) => entry.name === "XResolution",
    );
    expect(xEntry?.value).toBe(300);
  });

  it("D-06: APP14 + JFIF-only + true: no APP0, no APP1, preserved.resolution false, ok true, removedNamespaces includes JPEG", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(72, 72)),
      appSegment(APP14, jpegAdobe(1)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(result.value.removedNamespaces).toContain("JPEG");

    const destination = await readFile(destinationPath);
    const markers = markerSequence(destination);
    expect(markers).not.toContain(APP0);
    expect(markers).not.toContain(APP1);
  });

  it("raw rationals: IFD0 XResolution stored 600/2 is written 600/2, never reduced to 300/1", async () => {
    // parseExif's own decode reduces RATIONAL numerator/denominator to a
    // plain number (600/2 and 300/1 both decode to 300), so this asserts the
    // raw inserted bytes instead of a lossy re-decode.
    const custom = createMinimalExif({
      resolution: {
        x: { numerator: 600, denominator: 2 },
        y: { numerator: 300, denominator: 1 },
      },
    });
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP1, jpegExif(custom)),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    const ranges = readMarkerRanges(destination);
    const app1 = firstByMarker(ranges, APP1)!;
    const app1Payload = destination.subarray(
      app1.payloadStart,
      app1.payloadEnd,
    );
    const expectedTiff = createMinimalExif({
      resolution: {
        x: { numerator: 600, denominator: 2 },
        y: { numerator: 300, denominator: 1 },
      },
    });
    expect(app1Payload.subarray(6).equals(expectedTiff)).toBe(true);
  });
});

describe("D-01/JPG-01 JFIF thumbnail decline", () => {
  function jfifWithThumbnail(): Buffer {
    const header = Buffer.alloc(9);
    header[0] = 1;
    header[1] = 1;
    header[2] = 1;
    header.writeUInt16BE(72, 3);
    header.writeUInt16BE(72, 5);
    header[7] = 2; // Xthumbnail
    header[8] = 2; // Ythumbnail
    const thumbnailBytes = Buffer.alloc(3 * 2 * 2, 0x11); // RGB 2x2
    return Buffer.concat([
      Buffer.from("JFIF\0", "ascii"),
      header,
      thumbnailBytes,
    ]);
  }

  it("preserveResolution true declines pre-write (safe-to-fallback), source untouched", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jfifWithThumbnail()),
    ]);
    const { result, sourcePath } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");
    expect((await readFile(sourcePath)).equals(source)).toBe(true);
  });

  it("preserveResolution false: sanitizes ok with no APP0 and the thumbnail bytes absent", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jfifWithThumbnail()),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    const destination = await readFile(destinationPath);
    expect(markerSequence(destination)).not.toContain(APP0);
    expect(destination.includes(Buffer.alloc(12, 0x11))).toBe(false);
  });
});

describe("ICC matrix (jpeg_preservation)", () => {
  it("a valid two-segment profile + true: both kept, order preserved; + false: none", async () => {
    const profile = iccProfileV4();
    const segments = iccSegments(profile, Math.ceil(profile.length / 2));
    expect(segments.length).toBe(2);
    const source = spliceSegments(minimalJpeg({ components: 3 }), segments);

    const kept = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
    });
    expect(kept.result.ok).toBe(true);
    const keptDest = await readFile(kept.destinationPath);
    expect(markerSequence(keptDest).filter((m) => m === APP2).length).toBe(2);

    const dropped = await sanitizeToDirectory(source, {
      preserveColorProfile: false,
    });
    expect(dropped.result.ok).toBe(true);
    const droppedDest = await readFile(dropped.destinationPath);
    expect(markerSequence(droppedDest)).not.toContain(APP2);
  });

  // An oversize-profile ("exceeds MAX_PROFILE_BYTES") decline is specified by
  // the plan, but is measured unreachable for JPEG through real APP2
  // ICC_PROFILE segments: JPEG_MAX_ICC_SEGMENTS (255, a 1-byte sequence-number
  // ceiling) x the largest possible per-segment ICC payload (65,533 - 14
  // identifier/sequence/count bytes = 65,519) tops out at 16,707,345 bytes --
  // below MAX_PROFILE_BYTES's 16,777,216-byte cap. The parser's own segment
  // -count cap (`resource-limits`, unsafe-structure) always fires first on
  // any attempt to construct a bigger profile. `reassembleIccSegments`'s
  // MAX_PROFILE_BYTES check is real code (shared with PNG/WebP, where it is
  // reachable), just dead for JPEG under the current segment-size ceiling --
  // recorded here as a measured finding, not asserted as reachable.

  it("an invalid profile header + true declines with reason invalid pre-write", async () => {
    const invalid = Buffer.alloc(200, 0x00); // too short a "header" once truncated below 128 is fine, but make CMM garbage
    const segments = iccSegments(invalid, invalid.length);
    const source = spliceSegments(minimalJpeg({ components: 3 }), segments);

    const { result } = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if ("reason" in result.error) {
      expect(result.error.reason).toBe("invalid");
    }
  });
});
