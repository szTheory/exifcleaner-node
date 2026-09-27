import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyFallback,
  getCapabilities,
  inspectFile,
  sanitizeFile,
} from "../../../dist/index.js";
import {
  JPEG_MAX_ICC_SEGMENTS,
  JPEG_REFUSAL_KIND,
  type JpegRefusal,
} from "../../../src/jpeg/markers.js";
import type { JpegCapabilities } from "../../../src/types.js";
import { metadataJpeg, minimalJpeg } from "../../fixtures.js";
import { buildCipaMpfTwoImages, iccSegments, spliceSegments } from "./fixtures.js";
import { jpegMarkerSequence } from "./oracles.js";

/**
 * The JPEG qualification tracer (Plan 57-07 Task 1): proves a real JPEG
 * round-trips through the built-package `sanitizeFile`/`inspectFile` pair
 * cleanly, and that every `JpegRefusal` literal `JpegCapabilities` advertises
 * is refused pre-write with the temp directory left holding exactly the
 * unchanged source file. No upstream JPEG corpus exists yet (57-09's scope),
 * so unlike the PNG/WebP tracers this file builds its own fixtures with
 * `minimalJpeg`/`metadataJpeg` and `./fixtures.js` rather than reading a
 * `tests/corpus/manifest.json` record.
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
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-jpeg-qual-"));
  directories.push(directory);
  return directory;
}

const APP1 = 0xe1;
const APP13 = 0xed;
const COM = 0xfe;

// ---------------------------------------------------------------------------
// Task 1 refusal-fixture byte-level helpers (local, minimal). Independent of
// tests/jpeg_parser.test.ts's own private helpers -- this file never imports
// test-file-scoped machinery from another test file.
// ---------------------------------------------------------------------------

function markerOffset(bytes: Buffer, marker: number, from = 2): number {
  let offset = from;
  while (offset < bytes.length - 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === marker) return offset;
    offset += 1;
  }
  throw new Error(`marker 0x${marker.toString(16)} not found in fixture`);
}

function patchMarkerByte(bytes: Buffer, markerOff: number, newMarker: number): Buffer {
  const result = Buffer.from(bytes);
  result[markerOff + 1] = newMarker;
  return result;
}

function patchByte(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result[offset] = value;
  return result;
}

/** Drops the last component entry (3 bytes) from the SOF segment,
 * decrementing both Nf and the segment length field. Mirrors
 * tests/jpeg_parser.test.ts's own local helper. */
function dropLastSofComponent(bytes: Buffer): Buffer {
  const offset = markerOffset(bytes, 0xc0);
  const length = bytes.readUInt16BE(offset + 2);
  const nfOffset = offset + 4 + 5; // header(4) + precision/height/width(5)
  const nf = bytes[nfOffset]!;
  const result = Buffer.from(bytes);
  result[nfOffset] = nf - 1;
  result.writeUInt16BE(length - 3, offset + 2);
  const componentTableEnd = offset + 4 + 6 + nf * 3;
  return Buffer.concat([
    result.subarray(0, componentTableEnd - 3),
    result.subarray(componentTableEnd),
  ]);
}

/**
 * One fixture builder per `JpegRefusal` literal (D-08/D-09/D-10/D-13). Keyed
 * by the exact `JpegRefusal` string so a case iterated from
 * `JpegCapabilities.refuses` without a matching key here throws instead of
 * silently skipping (must_haves: "a refusal literal added later without a
 * fixture fails the tracer").
 */
const REFUSAL_FIXTURE_BUILDERS: Readonly<Record<JpegRefusal, () => Buffer>> =
  Object.freeze({
    "malformed-container": () => {
      // Missing SOI would fail JPEG signature detection at the engine level
      // (unsupported-format, never reaching admission) -- a second SOI
      // before the primary EOI keeps the magic bytes intact while still
      // being malformed-container per src/jpeg/parser.ts.
      const bytes = minimalJpeg({ components: 3 });
      return Buffer.concat([
        bytes.subarray(0, 2),
        Buffer.from([0xff, 0xd8]),
        bytes.subarray(2),
      ]);
    },
    truncation: () => {
      const bytes = minimalJpeg({ components: 3 });
      return bytes.subarray(0, bytes.length - 2);
    },
    "undefined-table-reference": () => {
      const bytes = minimalJpeg({ components: 3 });
      const sosOffset = markerOffset(bytes, 0xda);
      // header(4) + Ns(1) + Cs(1) => TdTa of the first scan component.
      return patchByte(bytes, sosOffset + 4 + 1 + 1, 0x10);
    },
    "lossless-frame": () => {
      const bytes = minimalJpeg({ components: 3 });
      return patchMarkerByte(bytes, markerOffset(bytes, 0xc0), 0xc3);
    },
    "hierarchical-frame": () => {
      const bytes = minimalJpeg({ components: 3 });
      return patchMarkerByte(bytes, markerOffset(bytes, 0xc0), 0xc5);
    },
    "arithmetic-frame": () => {
      const bytes = minimalJpeg({ components: 3 });
      return patchMarkerByte(bytes, markerOffset(bytes, 0xc0), 0xc9);
    },
    "non-t81-frame": () => {
      const bytes = minimalJpeg({ components: 3 });
      return patchMarkerByte(bytes, markerOffset(bytes, 0xc0), 0xc8);
    },
    "non-8-bit-precision": () => minimalJpeg({ components: 3, precision: 12 }),
    "unsupported-component-count": () =>
      dropLastSofComponent(minimalJpeg({ components: 3 })),
    "dnl-marker": () => minimalJpeg({ components: 3, height: 0 }),
    "resource-limits": () =>
      spliceSegments(
        minimalJpeg({ components: 3 }),
        iccSegments(Buffer.alloc(JPEG_MAX_ICC_SEGMENTS + 1), 1),
      ),
    "mpf-secondary-image": () =>
      buildCipaMpfTwoImages(minimalJpeg({ components: 3 })),
  });

function jpegCapability(): JpegCapabilities {
  const capability = getCapabilities().formats.find(
    (entry) => entry.format === "jpeg",
  ) as JpegCapabilities | undefined;
  if (capability === undefined) throw new Error("jpeg capability missing");
  return capability;
}

const refusalCases: readonly {
  readonly refusal: JpegRefusal;
  readonly build: () => Buffer;
}[] = jpegCapability().refuses.map((refusal) => {
  const build = REFUSAL_FIXTURE_BUILDERS[refusal];
  if (build === undefined) {
    throw new Error(
      `JPEG qualification tracer: no fixture builder registered for JpegRefusal literal "${refusal}" -- add one to REFUSAL_FIXTURE_BUILDERS.`,
    );
  }
  return { refusal, build };
});

describe("JPEG qualification tracer", () => {
  it("proves a metadata-bearing JPEG through built-package sanitize, reopen, and payload checks", async () => {
    const source = metadataJpeg();
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.jpg");
    const destinationPath = join(directory, "destination.jpg");
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);

    const destination = await readFile(destinationPath);
    const walk = jpegMarkerSequence(destination);
    expect(walk.trailerBytes).toBe(0);
    expect(walk.markers).not.toContain(APP1);
    expect(walk.markers).not.toContain(APP13);
    expect(walk.markers).not.toContain(COM);

    const inspected = await inspectFile(destinationPath);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error("unreachable");
    expect(inspected.value.format).toBe("jpeg");
    expect(
      inspected.value.entries.some((entry) => entry.namespace === "EXIF"),
    ).toBe(false);
    expect(
      inspected.value.entries.some((entry) => entry.namespace === "XMP"),
    ).toBe(false);
    expect(
      inspected.value.entries.some(
        (entry) => entry.namespace === "JPEG" && entry.name === "COM",
      ),
    ).toBe(false);
  });

  it.each(refusalCases)(
    "refuses $refusal pre-write with a clean, unchanged temp directory",
    async ({ refusal, build }) => {
      const source = build();
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.jpg");
      const destinationPath = join(directory, "destination.jpg");
      await writeFile(sourcePath, source);

      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.phase).toBe("admission");
      expect(result.error.nativeWrite).toBe("not-started");
      expect(result.error.code).toBe(JPEG_REFUSAL_KIND[refusal]);
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");

      const entries = await readdir(directory);
      expect(entries).toEqual(["source.jpg"]);
      expect((await readFile(sourcePath)).equals(source)).toBe(true);
    },
  );

  it("runs one refusal case per JpegCapabilities.refuses literal", () => {
    expect(refusalCases.length).toBe(jpegCapability().refuses.length);
    expect(refusalCases.length).toBeGreaterThan(0);
  });
});
