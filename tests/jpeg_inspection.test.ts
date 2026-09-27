import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFile } from "../dist/index.js";
import { parseExif } from "../src/metadata/exif.js";
import { parseIcc } from "../src/metadata/icc.js";
import { parseXmp } from "../src/metadata/xmp.js";
import {
  exifWithArtist,
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
