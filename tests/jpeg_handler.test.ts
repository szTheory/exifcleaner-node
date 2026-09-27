import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import { iccProfileV4, jpegAdobe, jpegExif, jpegJfif, jpegPhotoshop, minimalJpeg, exifWithArtist } from "./fixtures.js";
import { appSegment, iccSegments, spliceSegments, appendTrailer } from "./qualification/jpeg/fixtures.js";

/**
 * End-to-end proof that a JPEG travels the whole native path (57-05's
 * architectural tracer): magic selection, admission through the 57-03/57-04
 * codec, the D-01 closed rule, output plan, write, re-parse verification and
 * publication -- through the public API, against the built `dist/index.js`
 * (mirrors tests/png_handler.test.ts's dist-import convention).
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-jpeg-handler-"));
  directories.push(directory);
  return directory;
}

const NO_PRESERVATION = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

interface MarkerRange {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

/**
 * A small, test-local JPEG marker walker independent of `src/jpeg/parser.ts`
 * -- used only to assert on marker sequences and byte ranges, never as a
 * production parse.
 */
function readMarkerRanges(bytes: Buffer): MarkerRange[] {
  const ranges: MarkerRange[] = [];
  let offset = 2; // past SOI
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff) throw new Error("expected a marker prefix byte");
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) {
      ranges.push({ marker, start, end: offset });
      break;
    }
    if (marker === 0xda) {
      const length = bytes.readUInt16BE(offset);
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
      ranges.push({ marker, start, end: offset });
      continue;
    }
    const length = bytes.readUInt16BE(offset);
    offset += length;
    ranges.push({ marker, start, end: offset });
  }
  return ranges;
}

function markerSequence(bytes: Buffer): number[] {
  return readMarkerRanges(bytes).map((range) => range.marker);
}

function firstRangeByMarker(
  ranges: readonly MarkerRange[],
  marker: number,
): MarkerRange | undefined {
  return ranges.find((range) => range.marker === marker);
}

function xmpAppPayload(text: string): Buffer {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"><dc:description>${text}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP11 = 0xeb;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;
const DQT = 0xdb;
const DHT = 0xc4;
const SOF0 = 0xc0;
const SOF9 = 0xc9;
const SOS = 0xda;
const EOI = 0xd9;

/** The must_haves truth-1 fixture: every removable segment kind plus a
 * 3,913-byte trailer, built with tests/qualification/jpeg/fixtures.ts's
 * splicing helpers. */
function fullMetadataFixture(): Buffer {
  const profile = iccProfileV4();
  const segments = [
    appSegment(APP0, jpegJfif()),
    appSegment(APP1, jpegExif(exifWithArtist("private workflow"))),
    appSegment(APP1, xmpAppPayload("private workflow")),
    ...iccSegments(profile, profile.length),
    appSegment(APP11, Buffer.from("JUMBF-C2PA-canary", "ascii")),
    appSegment(APP13, jpegPhotoshop()),
    appSegment(APP14, jpegAdobe(1)),
    appSegment(COM, Buffer.from("private comment", "ascii")),
  ];
  const spliced = spliceSegments(minimalJpeg({ components: 3 }), segments);
  return appendTrailer(spliced, Buffer.alloc(3_913, 0x41));
}

describe("JPEG handler end to end (57-05 tracer)", () => {
  it("(a) sanitizes a full-metadata JPEG: destination markers are SOI, APP14, structural segments, EOI; every kept range is byte-identical", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.jpg");
    const destinationPath = join(directory, "destination.jpg");
    const source = fullMetadataFixture();
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.format).toBe("jpeg");
    expect([...result.value.removedNamespaces].sort()).toEqual(
      ["C2PA", "EXIF", "ICC", "JPEG", "XMP"].sort(),
    );

    const destination = await readFile(destinationPath);
    const destRanges = readMarkerRanges(destination);
    expect(destRanges.map((r) => r.marker)).toEqual([
      APP14,
      DQT,
      SOF0,
      DHT,
      SOS,
      EOI,
    ]);
    // The destination ends exactly at EOI -- the 3,913-byte trailer is gone.
    expect(destRanges[destRanges.length - 1]!.end).toBe(destination.length);

    const sourceRanges = readMarkerRanges(source);
    for (const marker of [APP14, DQT, SOF0, DHT, SOS]) {
      const expected = firstRangeByMarker(sourceRanges, marker)!;
      const actual = firstRangeByMarker(destRanges, marker)!;
      expect(
        destination
          .subarray(actual.start, actual.end)
          .equals(source.subarray(expected.start, expected.end)),
      ).toBe(true);
    }
  });

  it("(b) sanitizes a minimal JPEG plus APP14 Adobe (no removable segment) to output bytes identical to the source", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.jpg");
    const destinationPath = join(directory, "destination.jpg");
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP14, jpegAdobe(1)),
    ]);
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    expect(destination.equals(source)).toBe(true);
  });

  it("(c) keeps every APP2 ICC_PROFILE segment byte-identical and in order when preserveColorProfile is true, and removes all of them when false", async () => {
    const directory = await freshDirectory();
    const profile = iccProfileV4();
    const segments = iccSegments(profile, Math.ceil(profile.length / 2));
    expect(segments.length).toBe(2);
    const source = spliceSegments(minimalJpeg({ components: 3 }), segments);

    for (const preserveColorProfile of [true, false]) {
      const sourcePath = join(
        directory,
        `source-${String(preserveColorProfile)}.jpg`,
      );
      const destinationPath = join(
        directory,
        `destination-${String(preserveColorProfile)}.jpg`,
      );
      await writeFile(sourcePath, source);

      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...NO_PRESERVATION,
        preserveColorProfile,
      });
      expect(result.ok).toBe(true);

      const destination = await readFile(destinationPath);
      const destRanges = readMarkerRanges(destination);
      const destIccRanges = destRanges.filter((r) => r.marker === APP2);
      if (preserveColorProfile) {
        expect(destIccRanges.length).toBe(2);
        const sourceRanges = readMarkerRanges(source).filter(
          (r) => r.marker === APP2,
        );
        for (let index = 0; index < 2; index += 1) {
          expect(
            destination
              .subarray(destIccRanges[index]!.start, destIccRanges[index]!.end)
              .equals(
                source.subarray(
                  sourceRanges[index]!.start,
                  sourceRanges[index]!.end,
                ),
              ),
          ).toBe(true);
        }
      } else {
        expect(destIccRanges.length).toBe(0);
      }
    }
  });

  it("(d) keeps APP0 JFIF byte-identical when preserveResolution is true on a JFIF-only source, and drops it when APP14 Adobe is also present (D-06)", async () => {
    const directory = await freshDirectory();
    const jfifOnly = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif()),
    ]);
    const jfifWithAdobe = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif()),
      appSegment(APP14, jpegAdobe(1)),
    ]);

    const jfifOnlyPath = join(directory, "jfif-only.jpg");
    const jfifOnlyDest = join(directory, "jfif-only-dest.jpg");
    await writeFile(jfifOnlyPath, jfifOnly);
    const jfifOnlyResult = await sanitizeFile({
      sourcePath: jfifOnlyPath,
      destinationPath: jfifOnlyDest,
      ...NO_PRESERVATION,
      preserveResolution: true,
    });
    expect(jfifOnlyResult.ok).toBe(true);
    if (!jfifOnlyResult.ok) throw new Error("unreachable");
    expect(jfifOnlyResult.value.preserved.resolution).toBe(true);
    const jfifOnlyDestination = await readFile(jfifOnlyDest);
    const jfifOnlyRanges = readMarkerRanges(jfifOnlyDestination);
    expect(jfifOnlyRanges.filter((r) => r.marker === APP0).length).toBe(1);
    expect(jfifOnlyRanges.filter((r) => r.marker === APP1).length).toBe(0);
    const sourceJfif = firstRangeByMarker(readMarkerRanges(jfifOnly), APP0)!;
    const destJfif = firstRangeByMarker(jfifOnlyRanges, APP0)!;
    expect(
      jfifOnlyDestination
        .subarray(destJfif.start, destJfif.end)
        .equals(jfifOnly.subarray(sourceJfif.start, sourceJfif.end)),
    ).toBe(true);

    const withAdobePath = join(directory, "jfif-adobe.jpg");
    const withAdobeDest = join(directory, "jfif-adobe-dest.jpg");
    await writeFile(withAdobePath, jfifWithAdobe);
    const withAdobeResult = await sanitizeFile({
      sourcePath: withAdobePath,
      destinationPath: withAdobeDest,
      ...NO_PRESERVATION,
      preserveResolution: true,
    });
    expect(withAdobeResult.ok).toBe(true);
    const withAdobeDestination = await readFile(withAdobeDest);
    const withAdobeRanges = readMarkerRanges(withAdobeDestination);
    expect(withAdobeRanges.filter((r) => r.marker === APP0).length).toBe(0);
    expect(withAdobeRanges.filter((r) => r.marker === APP14).length).toBe(1);
  });

  it("(e) declines a SOF9 (arithmetic-coded) fixture pre-write, safe-to-fallback, source untouched", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.jpg");
    const destinationPath = join(directory, "destination.jpg");
    const source = minimalJpeg({ components: 3, sofMarker: SOF9 });
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.jpg"]);
    const sourceAfter = await readFile(sourcePath);
    expect(sourceAfter.equals(source)).toBe(true);
  });

  it("(f) removes an APP11 JUMBF/C2PA segment and reports C2PA in removedNamespaces (D-02)", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.jpg");
    const destinationPath = join(directory, "destination.jpg");
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP11, Buffer.from("JUMBF-C2PA-canary", "ascii")),
    ]);
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...NO_PRESERVATION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).toContain("C2PA");

    const destination = await readFile(destinationPath);
    expect(markerSequence(destination)).not.toContain(APP11);
  });
});
