// 68-10: an invalid numeric character reference inside an XMP CDATA section used to escape
// parseXmp as an untyped RangeError. validateEntities strips CDATA before checking entities,
// while the element branch unwraps CDATA and decodeXml then throws for a surrogate code point.
// Every format admission calls parseXmp, so the escaped throw surfaced as read-failed with
// phase transaction/source-open (do-not-fallback) and the file could never be cleaned.
// After the fix the packet is refused typed (metadata-invalid, entries empty), exactly like the
// plain-text case, and the engine reads and sanitizes the file.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFile, sanitizeFile } from "../src/index.js";
import { parseXmp } from "../src/metadata/xmp.js";
import { vp8, vp8x, webp } from "./fixtures.js";

const INVALID_ENTITY = "XMP contains an invalid numeric entity.";
const ROOT_OPEN =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">';
const ROOT_CLOSE = "</rdf:Description></rdf:RDF></x:xmpmeta>";

function packet(inner: string): Buffer {
  return Buffer.from(`${ROOT_OPEN}${inner}${ROOT_CLOSE}`, "utf8");
}

function cdataTitle(body: string): Buffer {
  return packet(`<dc:title><![CDATA[${body}]]></dc:title>`);
}

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-node-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseXmp CDATA numeric entities", () => {
  it("refuses a hexadecimal surrogate reference inside CDATA with the typed warning", () => {
    expect(parseXmp(cdataTitle("&#xD800;"))).toEqual({
      entries: [],
      warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
    });
  });

  it("refuses a decimal surrogate reference inside CDATA with the typed warning", () => {
    expect(parseXmp(cdataTitle("&#55296;"))).toEqual({
      entries: [],
      warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
    });
  });

  it("matches the plain-text case exactly", () => {
    const plain = packet("<dc:title>&#xD800;</dc:title>");
    expect(parseXmp(cdataTitle("&#xD800;"))).toEqual(parseXmp(plain));
  });

  it("refuses an invalid reference when the CDATA body also holds a bracket and a greater-than sign", () => {
    expect(parseXmp(cdataTitle("] > &#xDFFF; ]"))).toEqual({
      entries: [],
      warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
    });
  });

  it("refuses an invalid reference in the second of two CDATA sections", () => {
    const xmp = packet(
      "<dc:title><![CDATA[clean]]></dc:title><dc:creator><![CDATA[&#xD800;]]></dc:creator>",
    );
    expect(parseXmp(xmp)).toEqual({
      entries: [],
      warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
    });
  });

  it("decodes valid CDATA entities exactly as before", () => {
    expect(parseXmp(cdataTitle("a &amp; b")).entries).toEqual([
      { namespace: "XMP", name: "dc:title", value: "a & b" },
    ]);
    expect(parseXmp(cdataTitle("&#x41;")).entries).toEqual([
      { namespace: "XMP", name: "dc:title", value: "A" },
    ]);
    expect(parseXmp(cdataTitle("&#65;")).entries).toEqual([
      { namespace: "XMP", name: "dc:title", value: "A" },
    ]);
    expect(parseXmp(cdataTitle("a & b")).warnings).toEqual([]);
    expect(parseXmp(cdataTitle("a & b")).entries).toEqual([
      { namespace: "XMP", name: "dc:title", value: "a & b" },
    ]);
  });

  it("does not span a comment between two clean CDATA sections", () => {
    const xmp = packet(
      "<dc:title><![CDATA[one]]></dc:title><!-- &#xD800; --><dc:creator><![CDATA[two]]></dc:creator>",
    );
    expect(parseXmp(xmp)).toEqual({
      entries: [
        { namespace: "XMP", name: "dc:title", value: "one" },
        { namespace: "XMP", name: "dc:creator", value: "two" },
      ],
      warnings: [],
    });
  });

  it("does not span a processing instruction between two clean CDATA sections", () => {
    const xmp = packet(
      "<dc:title><![CDATA[one]]></dc:title><?pi &#xD800; ?><dc:creator><![CDATA[two]]></dc:creator>",
    );
    expect(parseXmp(xmp)).toEqual({
      entries: [
        { namespace: "XMP", name: "dc:title", value: "one" },
        { namespace: "XMP", name: "dc:creator", value: "two" },
      ],
      warnings: [],
    });
  });

  it("does not treat CDATA-looking text inside a comment as a CDATA section", () => {
    const xmp = packet(
      "<dc:title>kept</dc:title><!-- <![CDATA[&#xD800;]]> -->",
    );
    expect(parseXmp(xmp)).toEqual({
      entries: [{ namespace: "XMP", name: "dc:title", value: "kept" }],
      warnings: [],
    });
  });

  it("does not treat CDATA-looking text inside a processing instruction as a CDATA section", () => {
    const xmp = packet("<dc:title>kept</dc:title><?pi <![CDATA[&#xD800;]]> ?>");
    expect(parseXmp(xmp)).toEqual({
      entries: [{ namespace: "XMP", name: "dc:title", value: "kept" }],
      warnings: [],
    });
  });

  it("does not treat a comment-looking sequence inside CDATA as a comment", () => {
    const xmp = packet(
      "<dc:title><![CDATA[<!-- ]]></dc:title><dc:creator><![CDATA[&#xD800;]]></dc:creator><!-- end -->",
    );
    expect(parseXmp(xmp)).toEqual({
      entries: [],
      warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
    });
  });
});

describe("engine handling of a CDATA numeric entity in WebP XMP", () => {
  const hostileWebp = webp([
    { fourCc: "VP8X", data: vp8x(0x04) },
    { fourCc: "VP8 ", data: vp8() },
    { fourCc: "XMP ", data: cdataTitle("&#xD800;") },
  ]);

  it("inspectFile reads the file and reports the typed warning instead of read-failed", async () => {
    const directory = await workspace();
    const path = join(directory, "hostile.webp");
    await writeFile(path, hostileWebp);

    const result = await inspectFile(path);

    expect(result).toMatchObject({
      ok: true,
      value: {
        format: "webp",
        entries: [],
        warnings: [{ code: "metadata-invalid", detail: INVALID_ENTITY }],
      },
    });
  });

  it("sanitizeFile writes the destination without XMP and leaves the source and directory as expected", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "hostile.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, hostileWebp);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });

    expect(result).toMatchObject({ ok: true });
    expect((await readdir(directory)).sort()).toEqual([
      "clean.webp",
      "hostile.webp",
    ]);
    expect(await readFile(sourcePath)).toEqual(hostileWebp);
    const output = await readFile(destinationPath);
    expect(output.includes(Buffer.from("XMP "))).toBe(false);
    expect(output.includes(Buffer.from("CDATA"))).toBe(false);
    const inspection = await inspectFile(destinationPath);
    expect(inspection).toMatchObject({
      ok: true,
      value: { entries: [], warnings: [] },
    });
  });
});
