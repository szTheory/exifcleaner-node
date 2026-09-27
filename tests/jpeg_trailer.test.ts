import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalJpeg } from "./fixtures.js";
import {
  appendTrailer,
  buildCipaMpfTwoImages,
  buildGainmapMpfHdrgm,
  buildGoogleMotionPhotoShape,
  buildMpfIndexOutOfRange,
  buildMpfIndexTruncated,
  buildSamsungSefhSeftTrailer,
} from "./qualification/jpeg/fixtures.js";
import { type ParsedJpeg, parseJpeg } from "../src/jpeg/parser.js";
import { parseXmp } from "../src/metadata/xmp.js";
import type { MetadataEntry } from "../src/types.js";
import {
  classifyTrailerClasses,
  JPEG_REFUSED_TRAILER_CLASSES,
  trailerRefusal,
  type JpegTrailerClass,
} from "../src/jpeg/trailer.js";

const APP2 = 0xe2;
const STANDARD_XMP_IDENTIFIER = "http://ns.adobe.com/xap/1.0/";

async function writeTempFile(bytes: Buffer): Promise<string> {
  const path = join(
    tmpdir(),
    `jpeg-trailer-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  );
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
  return path;
}

async function parseFile(bytes: Buffer): Promise<ParsedJpeg> {
  const path = await writeTempFile(bytes);
  const handle = await open(path, "r");
  try {
    return await parseJpeg(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

/** Builds a `classifyTrailerClasses` input from a real parsed JPEG: the
 * buffered APP2 MPF payload (if any), the standard XMP's parsed entries (if
 * any), the trailer bytes themselves as `trailerTail`, the trailer byte
 * count, and the file size. */
async function classifyFile(
  bytes: Buffer,
): Promise<ReadonlySet<JpegTrailerClass>> {
  const parsed = await parseFile(bytes);
  let mpfPayload: Buffer | undefined;
  let xmpEntries: readonly MetadataEntry[] = [];
  parsed.segments.forEach((segment, index) => {
    if (segment.marker !== APP2 && segment.identifier === undefined) return;
    const payload = parsed.buffered.get(index);
    if (payload === undefined) return;
    if (segment.identifier === "MPF") {
      mpfPayload = payload;
    } else if (segment.identifier === STANDARD_XMP_IDENTIFIER) {
      xmpEntries = parseXmp(payload).entries;
    }
  });
  return classifyTrailerClasses({
    mpfPayload,
    xmpEntries,
    trailerTail: bytes.subarray(parsed.primaryEoiEnd),
    trailerBytes: parsed.trailerBytes,
    fileSize: bytes.length,
  });
}

describe("classifyTrailerClasses (D-12/D-13)", () => {
  it("returns an empty set for a JPEG with no trailer, MPF or motion-photo XMP", async () => {
    const classes = await classifyFile(minimalJpeg());
    expect(classes.size).toBe(0);
  });

  it("returns { plain-trailer } for 5 random trailer bytes", async () => {
    const bytes = appendTrailer(minimalJpeg(), Buffer.from([1, 2, 3, 4, 5]));
    const classes = await classifyFile(bytes);
    expect(classes).toEqual(new Set(["plain-trailer"]));
  });

  it("classifies the CIPA MPF two-images shape as { mpf, plain-trailer }", async () => {
    const classes = await classifyFile(buildCipaMpfTwoImages(minimalJpeg()));
    expect(classes).toEqual(new Set(["mpf", "plain-trailer"]));
  });

  it("classifies an MPF index truncated mid-entry as { mpf-index-invalid }", async () => {
    // The truncated segment's own length field is internally consistent (it
    // declares exactly the shorter payload present), so it parses as a
    // well-formed segment with no appended trailer bytes -- this is a
    // structural-content truncation inside the MP Index, not a file-trailer.
    const classes = await classifyFile(buildMpfIndexTruncated(minimalJpeg()));
    expect(classes).toEqual(new Set(["mpf-index-invalid"]));
  });

  it("classifies an MPF index offset out of range as { mpf-index-invalid }", async () => {
    const classes = await classifyFile(buildMpfIndexOutOfRange(minimalJpeg()));
    expect(classes).toEqual(new Set(["mpf-index-invalid"]));
  });

  it("classifies the Google Motion Photo shape as { google-motion-photo, plain-trailer }", async () => {
    const classes = await classifyFile(
      buildGoogleMotionPhotoShape(minimalJpeg()),
    );
    expect(classes).toEqual(new Set(["google-motion-photo", "plain-trailer"]));
  });

  it("classifies the Samsung SEFH/SEFT trailer shape as { samsung-trailer, plain-trailer }", async () => {
    const classes = await classifyFile(
      buildSamsungSefhSeftTrailer(minimalJpeg()),
    );
    expect(classes).toEqual(new Set(["samsung-trailer", "plain-trailer"]));
  });

  it("classifies the gain-map MPF+hdrgm shape as { mpf, gain-map, plain-trailer }", async () => {
    const classes = await classifyFile(buildGainmapMpfHdrgm(minimalJpeg()));
    expect(classes).toEqual(new Set(["mpf", "gain-map", "plain-trailer"]));
  });

  it("classifies a hostile MPF payload claiming 65,535 entries in a 40-byte payload as mpf-index-invalid, without reading past the payload", () => {
    const header = Buffer.alloc(40 - 4); // minus "MPF\0"
    header.write("MM", 0, 2, "latin1");
    header.writeUInt16BE(0x002a, 2);
    header.writeUInt32BE(8, 4); // IFD0 offset
    header.writeUInt16BE(65_535, 8); // hostile entry count
    const mpfPayload = Buffer.concat([Buffer.from("MPF\0", "latin1"), header]);
    expect(mpfPayload.length).toBe(40);

    const classes = classifyTrailerClasses({
      mpfPayload,
      xmpEntries: [],
      trailerTail: Buffer.alloc(0),
      trailerBytes: 0,
      fileSize: 1_000,
    });
    expect(classes).toEqual(new Set(["mpf-index-invalid"]));
  });
});

describe("trailerRefusal (D-13)", () => {
  const ALL_CLASSES: readonly JpegTrailerClass[] = [
    "mpf",
    "mpf-index-invalid",
    "google-motion-photo",
    "gain-map",
    "samsung-trailer",
    "plain-trailer",
  ];

  it.each(ALL_CLASSES)(
    "returns the refusal literal for %s exactly when it is in JPEG_REFUSED_TRAILER_CLASSES",
    (cls) => {
      const refusal = trailerRefusal(new Set([cls]));
      if (JPEG_REFUSED_TRAILER_CLASSES.has(cls)) {
        expect(refusal).toBe("mpf-secondary-image");
      } else {
        expect(refusal).toBeUndefined();
      }
    },
  );

  it("pins JPEG_REFUSED_TRAILER_CLASSES to the 57-EVIDENCE.md measured verdicts", () => {
    // 57-EVIDENCE.md "Full MPF/motion/trailer decision table" (measured
    // 2026-09-27) -- one row per JpegTrailerClass:
    const measuredVerdicts: ReadonlyArray<
      readonly [JpegTrailerClass, "promote" | "refuse"]
    > = [
      ["mpf", "refuse"], // cipa-mpf-two-images: measured confound, mechanical D-13 rule
      ["gain-map", "refuse"], // gainmap-mpf-hdrgm: same measured confound
      ["mpf-index-invalid", "promote"], // mpf-index-truncated/out-of-range: -all= wrote clean output, no warning
      ["google-motion-photo", "promote"], // real Google.jpg + google-motion-photo-shape.jpg
      ["samsung-trailer", "promote"], // samsung-sefh-seft-trailer
      ["plain-trailer", "promote"], // D-11: never refused
    ];
    const expectedRefused = new Set(
      measuredVerdicts
        .filter(([, verdict]) => verdict === "refuse")
        .map(([cls]) => cls),
    );
    expect(new Set(JPEG_REFUSED_TRAILER_CLASSES)).toEqual(expectedRefused);
  });
});
