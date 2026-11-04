import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jpegHandler } from "../src/admission/jpeg-handler.js";
import { classifyFallback, inspectFile, sanitizeFile } from "../src/index.js";
import {
  exifWithOrientation,
  iccProfileV4,
  jpegAdobe,
  jpegExif,
  jpegJfif,
  jpegPhotoshop,
  minimalJpeg,
  exifWithArtist,
} from "./fixtures.js";
import {
  appSegment,
  iccSegments,
  spliceSegments,
  appendTrailer,
} from "./qualification/jpeg/fixtures.js";

/**
 * End-to-end proof that a JPEG travels the whole native path (57-05's
 * architectural tracer): magic selection, admission through the 57-03/57-04
 * codec, the D-01 closed rule, output plan, write, re-parse verification and
 * publication -- through the public API, against `src/index.js`
 * (mirrors the src-import convention of tests/png_handler.test.ts).
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
    if (bytes[offset] !== 0xff)
      throw new Error("expected a marker prefix byte");
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

const APP15 = 0xef;
const DRI = 0xdd;
const XMP_GUID = "ABCD1234ABCD1234ABCD1234ABCD1234";

async function writeSource(source: Buffer): Promise<string> {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.jpg");
  await writeFile(sourcePath, source);
  return sourcePath;
}

async function inspectBytes(source: Buffer) {
  const result = await inspectFile(await writeSource(source));
  if (!result.ok)
    throw new Error(`inspectFile failed with ${result.error.code}`);
  return result.value;
}

interface PreservationFlags {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
}

async function sanitizeBytes(
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
    ...NO_PRESERVATION,
    ...options,
  });
  return { result, sourcePath, destinationPath };
}

async function admitBytes(source: Buffer) {
  const handle = await open(await writeSource(source), "r");
  try {
    return await jpegHandler.admit(handle, source.length);
  } finally {
    await handle.close();
  }
}

/** A JFIF APP0 payload with explicit unit, density and thumbnail dimensions;
 * `length` cuts it short of the 14-byte fixed header. */
function jfifBytes(fields: {
  readonly unit?: number;
  readonly x?: number;
  readonly y?: number;
  readonly thumbnailWidth?: number;
  readonly thumbnailHeight?: number;
  readonly length?: number;
}): Buffer {
  const data = Buffer.alloc(9);
  data[0] = 1;
  data[1] = 1;
  data[2] = fields.unit ?? 1;
  data.writeUInt16BE(fields.x ?? 72, 3);
  data.writeUInt16BE(fields.y ?? 72, 5);
  data[7] = fields.thumbnailWidth ?? 0;
  data[8] = fields.thumbnailHeight ?? 0;
  const full = Buffer.concat([Buffer.from("JFIF\0", "ascii"), data]);
  return full.subarray(0, fields.length ?? full.length);
}

function standardXmpOrientationPayload(
  orientation: number,
  guid?: string,
): Buffer {
  const note =
    guid === undefined
      ? ""
      : ` xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${guid}"`;
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description tiff:Orientation="${String(orientation)}" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"${note}></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

/** Only the first 32-byte chunk of an ExtendedXMP packet: a coverage gap, so
 * the reassembly is incomplete. */
function incompleteExtendedXmpPayload(guid: string): Buffer {
  const xml = Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="8"></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
  const header = Buffer.alloc(8);
  header.writeUInt32BE(xml.length, 0);
  header.writeUInt32BE(0, 4);
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
    Buffer.from(guid, "ascii"),
    header,
    xml.subarray(0, 32),
  ]);
}

function gainMapXmpPayload(): Buffer {
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

describe("jpeg-handler.ts collectMetadata and helper clusters (67-23, jpeg-1)", () => {
  it("isStructuralMarker ConditionalExpression: a DRI restart-interval segment is structural and survives sanitization byte-identically", async () => {
    const source = minimalJpeg({ components: 3, restartInterval: 4 });
    expect(markerSequence(source)).toContain(DRI);

    const { result, destinationPath } = await sanitizeBytes(source);
    expect(result.ok).toBe(true);
    const destination = await readFile(destinationPath);
    expect(markerSequence(destination)).toContain(DRI);
    expect(destination.equals(source)).toBe(true);
  });

  it("readJfifDensity ConditionalExpression: a JFIF payload shorter than the 14-byte header reports no density", async () => {
    const whole = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP0, jfifBytes({})),
      ]),
    );
    expect(
      whole.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toHaveLength(3);

    const short = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP0, jfifBytes({ length: 13 })),
      ]),
    );
    expect(
      short.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toEqual([]);
  });

  it("collectMetadata BlockStatement and StringLiteral: a kept-candidate JFIF reports its unit and densities as named JPEG entries", async () => {
    const inspection = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP0, jfifBytes({ unit: 2, x: 300, y: 150 })),
      ]),
    );
    expect(
      inspection.entries.filter((entry) => entry.name.startsWith("JFIF:")),
    ).toEqual([
      { namespace: "JPEG", name: "JFIF:ResolutionUnit", value: 2 },
      { namespace: "JPEG", name: "JFIF:XResolution", value: 300 },
      { namespace: "JPEG", name: "JFIF:YResolution", value: 150 },
    ]);
  });

  it("jfifHasEmbeddedThumbnail LogicalOperator and ConditionalExpression: a width-only or height-only thumbnail declines resolution preservation", async () => {
    for (const thumbnail of [
      { thumbnailWidth: 1, thumbnailHeight: 0 },
      { thumbnailWidth: 0, thumbnailHeight: 1 },
    ]) {
      const source = spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP0, jfifBytes(thumbnail)),
      ]);
      const { result, sourcePath } = await sanitizeBytes(source, {
        preserveResolution: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("unsafe-structure");
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");
      expect((await readFile(sourcePath)).equals(source)).toBe(true);
    }

    const control = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jfifBytes({})),
    ]);
    const { result } = await sanitizeBytes(control, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
  });

  it("jfifHasEmbeddedThumbnail ConditionalExpression, EqualityOperator and BooleanLiteral: a JFIF payload shorter than the header is never treated as carrying a thumbnail", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jfifBytes({ thumbnailWidth: 1, length: 13 })),
    ]);
    const { result, destinationPath } = await sanitizeBytes(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    const destination = await readFile(destinationPath);
    const sourceJfif = firstRangeByMarker(readMarkerRanges(source), APP0)!;
    const destinationJfif = firstRangeByMarker(
      readMarkerRanges(destination),
      APP0,
    )!;
    expect(
      destination
        .subarray(destinationJfif.start, destinationJfif.end)
        .equals(source.subarray(sourceJfif.start, sourceJfif.end)),
    ).toBe(true);
  });

  it("markerLabel ConditionalExpression: an APPn segment whose identifier is empty is named APPn without a colon", async () => {
    const inspection = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP15, Buffer.from([0x00, 0x41, 0x42])),
        appSegment(APP15, Buffer.from("ZZ\0payload", "ascii")),
      ]),
    );
    const labelled = inspection.entries.filter((entry) =>
      entry.name.startsWith("APP15"),
    );
    expect(labelled).toEqual([
      { namespace: "JPEG", name: "APP15", value: 3 },
      { namespace: "JPEG", name: "APP15:ZZ", value: 10 },
    ]);
  });

  it("collectMetadata BooleanLiteral: jfifDroppedForAdobe is true only when an APP14 Adobe segment drops the JFIF segment", async () => {
    const base = minimalJpeg({ components: 3 });
    const jfif = appSegment(APP0, jfifBytes({}));
    const adobe = appSegment(APP14, jpegAdobe(1));

    expect(
      (await admitBytes(spliceSegments(base, [jfif, adobe])))
        .jfifDroppedForAdobe,
    ).toBe(true);
    expect(
      (await admitBytes(spliceSegments(base, [jfif]))).jfifDroppedForAdobe,
    ).toBe(false);
    expect(
      (await admitBytes(spliceSegments(base, [adobe]))).jfifDroppedForAdobe,
    ).toBe(false);
    expect((await admitBytes(base)).jfifDroppedForAdobe).toBe(false);
  });

  it("collectMetadata CallExpression: EXIF parse warnings reach the inspection", async () => {
    const broken = jpegExif(
      Buffer.concat([
        Buffer.from("II*\0", "latin1"),
        Buffer.from([0xff, 0xff, 0xff, 0x7f]),
      ]),
    );
    const warned = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP1, broken),
      ]),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP1, jpegExif(exifWithArtist("private workflow"))),
      ]),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata CallExpression: standard XMP parse warnings reach the inspection", async () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ]);
    const warned = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP1, invalidUtf8),
      ]),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await inspectBytes(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP1, xmpAppPayload("private workflow")),
      ]),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata CallExpression: the standard XMP entries feed the trailer classification, so a gain-map XMP with trailer bytes is refused", async () => {
    const withXmp = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP1, gainMapXmpPayload()),
    ]);
    const clean = await inspectFile(await writeSource(withXmp));
    expect(clean.ok).toBe(true);

    const refused = await inspectFile(
      await writeSource(appendTrailer(withXmp, Buffer.alloc(32, 0x41))),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("unsafe-structure");
  });

  it("collectMetadata CallExpression: ICC parse warnings reach the inspection", async () => {
    const profile = iccProfileV4();
    const broken = Buffer.from(profile);
    broken.write("nope", 36, 4, "ascii");
    const warned = await inspectBytes(
      spliceSegments(
        minimalJpeg({ components: 3 }),
        iccSegments(broken, broken.length),
      ),
    );
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );

    const clean = await inspectBytes(
      spliceSegments(
        minimalJpeg({ components: 3 }),
        iccSegments(profile, profile.length),
      ),
    );
    expect(clean.warnings).toEqual([]);
  });

  it("collectMetadata MethodExpression: an XMP orientation that agrees with EXIF does not mask an incomplete ExtendedXMP", async () => {
    const exif = appSegment(APP1, jpegExif(exifWithOrientation(6)));
    const agreeing = spliceSegments(minimalJpeg({ components: 3 }), [
      exif,
      appSegment(APP1, standardXmpOrientationPayload(6)),
    ]);
    const kept = await sanitizeBytes(agreeing, { preserveOrientation: true });
    expect(kept.result.ok).toBe(true);

    const incomplete = spliceSegments(minimalJpeg({ components: 3 }), [
      exif,
      appSegment(APP1, standardXmpOrientationPayload(6, XMP_GUID)),
      appSegment(APP1, incompleteExtendedXmpPayload(XMP_GUID)),
    ]);
    const { result } = await sanitizeBytes(incomplete, {
      preserveOrientation: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if ("feature" in result.error) {
      expect(result.error.feature).toBe("orientation-preservation");
    }
  });
});
