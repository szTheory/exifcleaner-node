import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import { parseExif } from "../src/metadata/exif.js";
import {
  exifWithOrientation,
  jpegExif,
  minimalJpeg,
  xmpWithOrientation,
} from "./fixtures.js";
import { appSegment, spliceSegments } from "./qualification/jpeg/fixtures.js";

/**
 * D-05 orientation matrix: the written Orientation comes only from EXIF IFD0
 * 0x0112. A standard XMP or complete ExtendedXMP `tiff:Orientation` present
 * while EXIF Orientation is missing or different declines pre-write.
 *
 * 57-EVIDENCE.md's "D-05 discrepancy" measurement found 57-CONTEXT.md's
 * "ExifTool picks EXIF over XMP regardless of segment order" premise FALSE
 * (whichever appears first in the file wins). The decline implemented here
 * does not depend on that premise: it declines on any EXIF/XMP disagreement
 * regardless of order, routing the whole file through the real ExifTool
 * fallback, which reproduces the correct (order-dependent) result for free.
 */

const APP0 = 0xe0;
const APP1 = 0xe1;

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
    join(tmpdir(), "exifcleaner-jpeg-orientation-"),
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

const STANDARD_XMP_IDENTIFIER = "http://ns.adobe.com/xap/1.0/";
const EXTENDED_XMP_IDENTIFIER = "http://ns.adobe.com/xmp/extension/";
const GUID = "ABCD1234ABCD1234ABCD1234ABCD1234"; // 32 chars

function standardXmpSegment(
  orientation: number | undefined,
  guid?: string,
): Buffer {
  const attrs =
    orientation === undefined
      ? ""
      : ` tiff:Orientation="${String(orientation)}" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"`;
  const noteAttr =
    guid === undefined
      ? ""
      : ` xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${guid}"`;
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description${attrs}${noteAttr}></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return appSegment(
    APP1,
    Buffer.concat([
      Buffer.from(`${STANDARD_XMP_IDENTIFIER}\0`, "ascii"),
      Buffer.from(xml, "utf8"),
    ]),
  );
}

function extendedXmpSegments(
  guid: string,
  xml: Buffer,
  chunkBytes: number,
): Buffer[] {
  const segments: Buffer[] = [];
  for (let offset = 0; offset < xml.length; offset += chunkBytes) {
    const chunk = xml.subarray(
      offset,
      Math.min(offset + chunkBytes, xml.length),
    );
    const header = Buffer.alloc(8);
    header.writeUInt32BE(xml.length, 0);
    header.writeUInt32BE(offset, 4);
    segments.push(
      appSegment(
        APP1,
        Buffer.concat([
          Buffer.from(`${EXTENDED_XMP_IDENTIFIER}\0`, "ascii"),
          Buffer.from(guid, "ascii"),
          header,
          chunk,
        ]),
      ),
    );
  }
  return segments;
}

function extendedXmpPacket(orientation: number): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${String(orientation)}"></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

function exifSegment(orientation: number): Buffer {
  return appSegment(APP1, jpegExif(exifWithOrientation(orientation)));
}

async function expectOrientationKept(
  source: Buffer,
  expected: number,
): Promise<void> {
  const { result, destinationPath } = await sanitizeToDirectory(source, {
    preserveOrientation: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.value.preserved.orientation).toBe(true);
  const destination = await readFile(destinationPath);
  let offset = 2;
  let app1: Buffer | undefined;
  while (offset < destination.length) {
    const marker = destination[offset + 1]!;
    if (marker === 0xd9) break;
    if (marker === 0xda) break;
    const length = destination.readUInt16BE(offset + 2);
    if (marker === APP1) {
      app1 = destination.subarray(offset + 4, offset + 2 + length);
      break;
    }
    offset += 2 + length;
  }
  expect(app1).toBeDefined();
  const reparsed = parseExif(app1!);
  expect(reparsed.orientation).toEqual({ status: "valid", value: expected });
}

async function expectOrientationDeclined(source: Buffer): Promise<void> {
  const { result } = await sanitizeToDirectory(source, {
    preserveOrientation: true,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("unsupported-feature");
  if ("feature" in result.error) {
    expect(result.error.feature).toBe("orientation-preservation");
  }
  expect(classifyFallback(result.error)).toBe("safe-to-fallback");
}

describe("D-05 orientation matrix (jpeg_orientation)", () => {
  it("EXIF 6 + XMP 6: keeps 6", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(6),
    ]);
    await expectOrientationKept(source, 6);
  });

  it("EXIF 6 + XMP 8: declines (disagreement)", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(8),
    ]);
    await expectOrientationDeclined(source);
  });

  it("XMP 8 only (no EXIF Orientation): declines", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      standardXmpSegment(8),
    ]);
    await expectOrientationDeclined(source);
  });

  it("EXIF 6 + ExtendedXMP complete with 8: declines", async () => {
    const xml = extendedXmpPacket(8);
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(undefined, GUID),
      ...extendedXmpSegments(GUID, xml, 32),
    ]);
    await expectOrientationDeclined(source);
  });

  it("EXIF 6 + ExtendedXMP incomplete (a chunk missing): declines", async () => {
    const xml = extendedXmpPacket(8);
    const chunks = extendedXmpSegments(GUID, xml, 32);
    expect(chunks.length).toBeGreaterThan(1);
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(undefined, GUID),
      chunks[0]!, // only the first chunk -- coverage gap
    ]);
    await expectOrientationDeclined(source);
  });

  it("XMP with no Orientation: keeps 6", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(undefined),
    ]);
    await expectOrientationKept(source, 6);
  });

  it("a declining source + preserveOrientation false: ok, no Orientation in output", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(8),
    ]);
    const { result, destinationPath } = await sanitizeToDirectory(source, {
      preserveOrientation: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.orientation).toBe(false);
    const destination = await readFile(destinationPath);
    expect(destination.includes(Buffer.from([0xff, APP1]))).toBe(false);
  });

  it("XMP before Exif and XMP after Exif give the same (decline) outcome", async () => {
    const before = spliceSegments(minimalJpeg({ components: 3 }), [
      standardXmpSegment(8),
      exifSegment(6),
    ]);
    const after = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      standardXmpSegment(8),
    ]);
    await expectOrientationDeclined(before);
    await expectOrientationDeclined(after);
  });

  it("duplicate Exif (two APP1 Exif, Orientation 6 then 8): the first segment's value (6) is what's read and preserved", async () => {
    const source = spliceSegments(minimalJpeg({ components: 3 }), [
      exifSegment(6),
      exifSegment(8),
    ]);
    await expectOrientationKept(source, 6);
  });
});
