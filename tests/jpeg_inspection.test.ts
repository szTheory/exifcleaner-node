import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jpegHandler } from "../src/admission/jpeg-handler.js";
import { classifyFallback, inspectFile, sanitizeFile } from "../src/index.js";
import { parseExif } from "../src/metadata/exif.js";
import { parseIcc } from "../src/metadata/icc.js";
import { parseXmp } from "../src/metadata/xmp.js";
import {
  exifWithArtist,
  exifWithOrientation,
  iccProfileV4,
  jpegAdobe,
  jpegExif,
  jpegJfif,
  jpegPhotoshop,
  minimalJpeg,
} from "./fixtures.js";
import {
  appSegment,
  appendTrailer,
  iccSegments,
  spliceSegments,
} from "./qualification/jpeg/fixtures.js";

/**
 * D-15 analog: JPEG inspection entries (EXIF, XMP, ICC, JFIF density, C2PA
 * JUMBF, and one entry per other removable segment named `<MARKER>:
 * <identifier>`), plus Trailer reporting and bounded reads on a hostile
 * COM-flood shape.
 */

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP11 = 0xeb;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

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
    join(tmpdir(), "exifcleaner-jpeg-inspection-"),
  );
  directories.push(directory);
  return directory;
}

function xmpAppPayload(text: string): Buffer {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"><dc:description>${text}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(xml, "utf8"),
  ]);
}

describe("JPEG inspection entries (D-15 analog)", () => {
  it("reports EXIF, XMP, ICC, JFIF density, C2PA JUMBF, and one JPEG entry per other removable segment", async () => {
    const profile = iccProfileV4();
    const exifTiff = exifWithArtist("private workflow");
    const xmp = xmpAppPayload("private-xmp-workflow");
    const jumbfPayload = Buffer.from("JUMBF-C2PA-canary", "ascii");
    const mpfPayload = Buffer.concat([
      Buffer.from("MPF\0", "ascii"),
      Buffer.alloc(20, 0x00),
    ]);
    const comText = "private comment";

    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP0, jpegJfif(180, 180)),
      appSegment(APP1, jpegExif(exifTiff)),
      appSegment(APP1, xmp),
      ...iccSegments(profile, profile.length),
      appSegment(APP11, jumbfPayload),
      appSegment(0xe2, mpfPayload),
      appSegment(APP13, jpegPhotoshop()),
      appSegment(APP14, jpegAdobe(1)),
      appSegment(COM, Buffer.from(comText, "ascii")),
    ]);
    const withTrailer = appendTrailer(source, Buffer.alloc(512, 0x41));

    const sourcePath = join(await freshDirectory(), "source.jpg");
    await writeFile(sourcePath, withTrailer);

    const result = await inspectFile(sourcePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const { entries } = result.value;
    const exifEntries = parseExif(exifTiff).entries;
    const xmpEntries = parseXmp(
      xmp.subarray("http://ns.adobe.com/xap/1.0/".length + 1),
    ).entries;
    const iccEntries = parseIcc(profile).entries;

    expect(entries).toEqual(
      expect.arrayContaining([...exifEntries, ...xmpEntries, ...iccEntries]),
    );

    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "JFIF:ResolutionUnit",
      value: 1,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "JFIF:XResolution",
      value: 180,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "JFIF:YResolution",
      value: 180,
    });
    expect(entries).toContainEqual({
      namespace: "C2PA",
      name: "JUMBF",
      value: jumbfPayload.length,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "APP2:MPF",
      value: mpfPayload.length,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "APP13:Photoshop 3.0",
      value: jpegPhotoshop().length,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "COM",
      value: comText.length,
    });
    expect(entries).toContainEqual({
      namespace: "JPEG",
      name: "Trailer",
      value: 512,
    });

    // APP14 Adobe is always kept (D-01), so it never produces an entry.
    expect(entries.some((entry) => entry.name.startsWith("APP14"))).toBe(false);
  });

  it("names a JUMBF entry and a Trailer entry", async () => {
    const source = appendTrailer(
      spliceSegments(minimalJpeg({ components: 3 }), [
        appSegment(APP11, Buffer.from("jumbf-payload", "ascii")),
      ]),
      Buffer.alloc(16, 0x00),
    );
    const sourcePath = join(await freshDirectory(), "source.jpg");
    await writeFile(sourcePath, source);

    const result = await inspectFile(sourcePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.entries).toContainEqual(
      expect.objectContaining({ namespace: "C2PA", name: "JUMBF" }),
    );
    expect(result.value.entries).toContainEqual(
      expect.objectContaining({ name: "Trailer" }),
    );
  });

  it("an incomplete ExtendedXMP adds a metadata-invalid warning", async () => {
    const guid = "ABCD1234ABCD1234ABCD1234ABCD1234";
    const xml = Buffer.from(
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="8"></rdf:Description></rdf:RDF></x:xmpmeta>`,
      "utf8",
    );
    const standard = Buffer.concat([
      Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
      Buffer.from(
        `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${guid}"></rdf:Description></rdf:RDF></x:xmpmeta>`,
        "utf8",
      ),
    ]);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(xml.length, 0);
    header.writeUInt32BE(0, 4);
    const onlyChunk = Buffer.concat([
      Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
      Buffer.from(guid, "ascii"),
      header,
      xml.subarray(0, 8), // deliberately short -- a coverage gap
    ]);
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      appSegment(APP1, standard),
      appSegment(APP1, onlyChunk),
    ]);
    const sourcePath = join(await freshDirectory(), "source.jpg");
    await writeFile(sourcePath, source);

    const result = await inspectFile(sourcePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.warnings).toContainEqual(
      expect.objectContaining({ code: "metadata-invalid" }),
    );
  });

  it("inspectFile on a 1,000-COM hostile shape returns within its bounded reads (no COM payload buffered)", async () => {
    const comSegments = Array.from({ length: 1_000 }, (_unused, index) =>
      appSegment(COM, Buffer.from(`comment-${index}`, "ascii")),
    );
    const source = spliceSegments(minimalJpeg({ components: 3 }), comSegments);
    const sourcePath = join(await freshDirectory(), "source.jpg");
    await writeFile(sourcePath, source);

    const start = Date.now();
    const result = await inspectFile(sourcePath);
    const elapsedMs = Date.now() - start;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const comEntries = result.value.entries.filter(
      (entry) => entry.name === "COM",
    );
    expect(comEntries.length).toBe(1_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });
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

function noPreservation(): {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
} {
  return {
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: false,
  };
}

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
    ...noPreservation(),
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
