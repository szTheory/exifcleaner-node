import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalJpeg } from "./fixtures.js";
import {
  isJpegSignature,
  JpegStructureError,
  parseJpeg,
} from "../src/jpeg/parser.js";
import { JPEG_REFUSAL_KIND, type JpegRefusal } from "../src/jpeg/markers.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function writeTempFile(bytes: Buffer): Promise<string> {
  const path = join(
    tmpdir(),
    `jpeg-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  );
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
  return path;
}

async function parseFile(bytes: Buffer) {
  const path = await writeTempFile(bytes);
  const handle = await open(path, "r");
  try {
    return await parseJpeg(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

describe("parseJpeg tracer", () => {
  it("parses a minimal baseline JPEG: exact marker sequence, no trailer", async () => {
    const bytes = minimalJpeg();
    const parsed = await parseFile(bytes);
    const markers = parsed.segments.map((segment) =>
      segment.marker.toString(16),
    );
    expect(markers).toEqual(["db", "c0", "c4", "da"]);
    expect(parsed.primaryEoiEnd).toBe(bytes.length);
    expect(parsed.trailerBytes).toBe(0);
  });

  it("locates the trailer boundary when 17 bytes are appended after EOI", async () => {
    const bytes = Buffer.concat([minimalJpeg(), Buffer.alloc(17, 0xab)]);
    const parsed = await parseFile(bytes);
    expect(parsed.trailerBytes).toBe(17);
    expect(parsed.primaryEoiEnd).toBe(bytes.length - 17);
  });

  it("decodes 1, 3 and 4 component fixtures identically in shape", async () => {
    for (const components of [1, 3, 4] as const) {
      const bytes = minimalJpeg({ components });
      const parsed = await parseFile(bytes);
      expect(parsed.frame.components).toHaveLength(components);
      expect(parsed.trailerBytes).toBe(0);
    }
  });
});

describe("isJpegSignature", () => {
  it("is true for FF D8 FF E0", () => {
    expect(isJpegSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it("is false for a PNG signature", () => {
    expect(isJpegSignature(PNG_SIGNATURE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2/3 fixture-patching helpers: byte-level surgery on minimalJpeg()'s
// output (marker substitution, length edits, truncation, segment splicing).
// ---------------------------------------------------------------------------

/** The offset of the 0xFF byte that starts the first occurrence of `marker` at
 * or after `from`. Safe here because every header byte minimalJpeg() emits
 * (dimensions, table ids, sampling factors) is below 0xFF, so no marker code
 * can appear by coincidence inside a segment payload before SOS. */
function markerOffset(bytes: Buffer, marker: number, from = 2): number {
  let offset = from;
  while (offset < bytes.length - 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === marker) return offset;
    offset += 1;
  }
  throw new Error(`marker 0x${marker.toString(16)} not found in fixture`);
}

function segmentLength(bytes: Buffer, markerOff: number): number {
  return bytes.readUInt16BE(markerOff + 2);
}

function patchMarkerByte(
  bytes: Buffer,
  markerOff: number,
  newMarker: number,
): Buffer {
  const result = Buffer.from(bytes);
  result[markerOff + 1] = newMarker;
  return result;
}

function patchByte(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result[offset] = value;
  return result;
}

function patchU16(bytes: Buffer, offset: number, value: number): Buffer {
  const result = Buffer.from(bytes);
  result.writeUInt16BE(value, offset);
  return result;
}

function buildSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** Inserts `segment` bytes immediately before the first `beforeMarker`
 * occurrence at or after `from`. */
function insertSegmentBefore(
  bytes: Buffer,
  beforeMarker: number,
  segment: Buffer,
  from = 2,
): Buffer {
  const offset = markerOffset(bytes, beforeMarker, from);
  return Buffer.concat([
    bytes.subarray(0, offset),
    segment,
    bytes.subarray(offset),
  ]);
}

/** Removes the whole length-prefixed segment starting at `marker`'s first
 * occurrence at or after `from`. */
function removeSegment(bytes: Buffer, marker: number, from = 2): Buffer {
  const offset = markerOffset(bytes, marker, from);
  const length = segmentLength(bytes, offset);
  return Buffer.concat([
    bytes.subarray(0, offset),
    bytes.subarray(offset + 2 + length),
  ]);
}

/** Drops the last component entry (3 bytes) from the SOF segment, decrementing
 * both Nf and the segment length field -- builds an "unsupported component
 * count" fixture without widening minimalJpeg()'s own `1 | 3 | 4` type. */
function dropLastSofComponent(bytes: Buffer, sofMarker = 0xc0): Buffer {
  const offset = markerOffset(bytes, sofMarker);
  const length = segmentLength(bytes, offset);
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

/** Truncates the DHT segment's payload to drop its AC table (the second
 * single-code table minimalJpeg() always writes), decrementing the length
 * field to match. */
function dropAcHuffmanTable(bytes: Buffer): Buffer {
  const offset = markerOffset(bytes, 0xc4);
  const length = segmentLength(bytes, offset);
  const dcTableBytes = 1 + 16 + 1; // TcTh + BITS + one VALUES byte
  const result = Buffer.from(bytes);
  result.writeUInt16BE(2 + dcTableBytes, offset + 2);
  return Buffer.concat([
    result.subarray(0, offset + 4 + dcTableBytes),
    result.subarray(offset + 2 + length),
  ]);
}

async function expectRefusal(
  bytes: Buffer,
  refusal: JpegRefusal,
): Promise<void> {
  const path = await writeTempFile(bytes);
  const handle = await open(path, "r");
  try {
    await expect(parseJpeg(handle, bytes.length)).rejects.toMatchObject({
      refusal,
      kind: JPEG_REFUSAL_KIND[refusal],
    });
  } finally {
    await handle.close();
  }
}

async function expectAdmitted(bytes: Buffer): Promise<void> {
  const path = await writeTempFile(bytes);
  const handle = await open(path, "r");
  try {
    await expect(parseJpeg(handle, bytes.length)).resolves.toBeDefined();
  } finally {
    await handle.close();
  }
}

describe("parseJpeg: admitted frame/structure classes (D-08/D-09)", () => {
  it("admits SOF0 with marker 0xC1 (extended sequential Huffman)", async () => {
    await expectAdmitted(minimalJpeg({ sofMarker: 0xc1 }));
  });

  it("admits a progressive frame at the marker level (SOF2)", async () => {
    await expectAdmitted(minimalJpeg({ sofMarker: 0xc2 }));
  });

  it("admits DRI with RSTn every MCU", async () => {
    await expectAdmitted(
      minimalJpeg({ width: 16, height: 8, restartInterval: 1 }),
    );
  });

  it("admits a 0xFF fill-byte run before a marker", async () => {
    const bytes = minimalJpeg();
    const dhtOffset = markerOffset(bytes, 0xc4);
    const withFill = Buffer.concat([
      bytes.subarray(0, dhtOffset),
      Buffer.from([0xff, 0xff, 0xff]),
      bytes.subarray(dhtOffset),
    ]);
    await expectAdmitted(withFill);
  });

  it("admits two per-component SOS for a baseline 3-component frame", async () => {
    await expectAdmitted(
      minimalJpeg({ components: 3, scans: "per-component" }),
    );
  });

  it("admits DQT placed between two per-component scans", async () => {
    const bytes = minimalJpeg({ components: 3, scans: "per-component" });
    const secondSosOffset = markerOffset(
      bytes,
      0xda,
      markerOffset(bytes, 0xda) + 1,
    );
    const dqtOffset = markerOffset(bytes, 0xdb);
    const dqtLength = segmentLength(bytes, dqtOffset);
    const dqtSegment = bytes.subarray(dqtOffset, dqtOffset + 2 + dqtLength);
    const withExtraDqt = Buffer.concat([
      bytes.subarray(0, secondSosOffset),
      dqtSegment,
      bytes.subarray(secondSosOffset),
    ]);
    await expectAdmitted(withExtraDqt);
  });

  it("admits an APP1 whose payload contains FF D8/FF D9 (thumbnail-shaped); the primary EOI is the image's EOI", async () => {
    const bytes = minimalJpeg();
    const thumbnailPayload = Buffer.concat([
      Buffer.from("Exif\0\0", "ascii"),
      Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0xff, 0xd9]),
    ]);
    const withThumbnail = insertSegmentBefore(
      bytes,
      0xdb,
      buildSegment(0xe1, thumbnailPayload),
    );
    const path = await writeTempFile(withThumbnail);
    const handle = await open(path, "r");
    try {
      const parsed = await parseJpeg(handle, withThumbnail.length);
      expect(parsed.primaryEoiEnd).toBe(withThumbnail.length);
      expect(parsed.trailerBytes).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("admits a progressive DC refinement scan (Ss=0, Ah>0) with no tables required", async () => {
    const bytes = minimalJpeg({ sofMarker: 0xc2 });
    const sosOffset = markerOffset(bytes, 0xda);
    // SOS payload: Ns(1) Cs/TdTa*Ns(2*Ns) Ss(1) Se(1) AhAl(1); byte before the
    // last is AhAl -- set Ah=1 (nibble 0x10).
    const ahAlOffset = sosOffset + 2 + segmentLength(bytes, sosOffset) - 1;
    const patched = patchByte(bytes, ahAlOffset, 0x10);
    await expectAdmitted(patched);
  });
});

describe("parseJpeg: refused frame classes (D-09)", () => {
  it("refuses SOF3 (lossless) as lossless-frame", async () => {
    const bytes = minimalJpeg();
    const sofOffset = markerOffset(bytes, 0xc0);
    await expectRefusal(
      patchMarkerByte(bytes, sofOffset, 0xc3),
      "lossless-frame",
    );
  });

  it.each([0xc5, 0xc6, 0xc7])(
    "refuses SOF%s (hierarchical) as hierarchical-frame",
    async (marker) => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      await expectRefusal(
        patchMarkerByte(bytes, sofOffset, marker),
        "hierarchical-frame",
      );
    },
  );

  it("refuses a DHP segment as hierarchical-frame", async () => {
    const bytes = minimalJpeg();
    const withDhp = insertSegmentBefore(
      bytes,
      0xc0,
      buildSegment(0xde, Buffer.alloc(2)),
    );
    await expectRefusal(withDhp, "hierarchical-frame");
  });

  it("refuses an EXP segment as hierarchical-frame", async () => {
    const bytes = minimalJpeg();
    const withExp = insertSegmentBefore(
      bytes,
      0xc0,
      buildSegment(0xdf, Buffer.alloc(2)),
    );
    await expectRefusal(withExp, "hierarchical-frame");
  });

  it.each([0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])(
    "refuses SOF%s (arithmetic) as arithmetic-frame",
    async (marker) => {
      const bytes = minimalJpeg();
      const sofOffset = markerOffset(bytes, 0xc0);
      await expectRefusal(
        patchMarkerByte(bytes, sofOffset, marker),
        "arithmetic-frame",
      );
    },
  );

  it("refuses a DAC segment as arithmetic-frame", async () => {
    const bytes = minimalJpeg();
    const withDac = insertSegmentBefore(
      bytes,
      0xc0,
      buildSegment(0xcc, Buffer.alloc(2)),
    );
    await expectRefusal(withDac, "arithmetic-frame");
  });

  it("refuses JPG (0xC8, reserved) as non-t81-frame", async () => {
    const bytes = minimalJpeg();
    const sofOffset = markerOffset(bytes, 0xc0);
    await expectRefusal(
      patchMarkerByte(bytes, sofOffset, 0xc8),
      "non-t81-frame",
    );
  });

  it("refuses JPEG-LS (0xF7, within JPGn) as non-t81-frame", async () => {
    const bytes = minimalJpeg();
    const sofOffset = markerOffset(bytes, 0xc0);
    await expectRefusal(
      patchMarkerByte(bytes, sofOffset, 0xf7),
      "non-t81-frame",
    );
  });

  it("refuses 12-bit precision as non-8-bit-precision", async () => {
    await expectRefusal(minimalJpeg({ precision: 12 }), "non-8-bit-precision");
  });

  it("refuses a frame height of 0 as dnl-marker", async () => {
    await expectRefusal(minimalJpeg({ height: 0 }), "dnl-marker");
  });

  it("refuses a DNL segment as dnl-marker", async () => {
    const bytes = minimalJpeg();
    const withDnl = insertSegmentBefore(
      bytes,
      0xc0,
      buildSegment(0xdc, Buffer.alloc(4)),
    );
    await expectRefusal(withDnl, "dnl-marker");
  });

  it("refuses a component count outside 1, 3, 4 as unsupported-component-count", async () => {
    const bytes = minimalJpeg({ components: 3 });
    await expectRefusal(
      dropLastSofComponent(bytes),
      "unsupported-component-count",
    );
  });
});

describe("parseJpeg: structural refusals (D-10)", () => {
  it("refuses a file missing SOI as malformed-container", async () => {
    const bytes = minimalJpeg().subarray(2);
    await expectRefusal(bytes, "malformed-container");
  });

  it("refuses a second SOI before the primary EOI as malformed-container", async () => {
    const bytes = minimalJpeg();
    const withSecondSoi = Buffer.concat([
      bytes.subarray(0, 2),
      Buffer.from([0xff, 0xd8]),
      bytes.subarray(2),
    ]);
    await expectRefusal(withSecondSoi, "malformed-container");
  });

  it("refuses a segment length below 2 as malformed-container", async () => {
    const bytes = minimalJpeg();
    const dqtOffset = markerOffset(bytes, 0xdb);
    await expectRefusal(
      patchU16(bytes, dqtOffset + 2, 1),
      "malformed-container",
    );
  });

  it("refuses a segment length past end of file as truncation", async () => {
    const bytes = minimalJpeg();
    const dqtOffset = markerOffset(bytes, 0xdb);
    await expectRefusal(patchU16(bytes, dqtOffset + 2, 0x7fff), "truncation");
  });

  it("refuses truncation inside a segment as truncation", async () => {
    const bytes = minimalJpeg();
    const dqtOffset = markerOffset(bytes, 0xdb);
    await expectRefusal(bytes.subarray(0, dqtOffset + 10), "truncation");
  });

  it("refuses truncation inside entropy data (no EOI) as truncation", async () => {
    const bytes = minimalJpeg();
    await expectRefusal(bytes.subarray(0, bytes.length - 3), "truncation");
  });

  it("refuses a file with no EOI as truncation", async () => {
    const bytes = minimalJpeg();
    await expectRefusal(bytes.subarray(0, bytes.length - 2), "truncation");
  });

  it("refuses a scan referencing an undefined DC table as undefined-table-reference", async () => {
    const bytes = minimalJpeg();
    const sosOffset = markerOffset(bytes, 0xda);
    const tdTaOffset = sosOffset + 4 + 1 + 1; // header(4) + Ns(1) + Cs(1) => TdTa
    await expectRefusal(
      patchByte(bytes, tdTaOffset, 0x10),
      "undefined-table-reference",
    );
  });

  it("refuses a scan component whose frame Tq slot was never defined as undefined-table-reference", async () => {
    const bytes = removeSegment(minimalJpeg(), 0xdb);
    await expectRefusal(bytes, "undefined-table-reference");
  });

  it("refuses a progressive AC scan with no AC table as undefined-table-reference", async () => {
    // AC scans are non-interleaved (Ns=1) per T.81; components:1 keeps the SOS
    // payload shape [Ns(1) Cs(1) TdTa(1) Ss(1) Se(1) AhAl(1)].
    const bytes = dropAcHuffmanTable(
      minimalJpeg({ sofMarker: 0xc2, components: 1 }),
    );
    const sosOffset = markerOffset(bytes, 0xda);
    // Ss: header(4) + Ns(1) + Cs(1) + TdTa(1).
    const ssOffset = sosOffset + 4 + 1 + 1 + 1;
    const patched = patchByte(bytes, ssOffset, 1);
    await expectRefusal(patched, "undefined-table-reference");
  });

  it("refuses SOS before SOF as malformed-container", async () => {
    const bytes = removeSegment(minimalJpeg(), 0xc0);
    await expectRefusal(bytes, "malformed-container");
  });

  it("refuses more than one SOF as malformed-container", async () => {
    const bytes = minimalJpeg();
    const sofOffset = markerOffset(bytes, 0xc0);
    const sofLength = segmentLength(bytes, sofOffset);
    const sofSegment = bytes.subarray(sofOffset, sofOffset + 2 + sofLength);
    const withDuplicateSof = Buffer.concat([
      bytes.subarray(0, sofOffset),
      sofSegment,
      bytes.subarray(sofOffset),
    ]);
    await expectRefusal(withDuplicateSof, "malformed-container");
  });

  it("refuses an unknown non-APPn marker (0x02, reserved) as malformed-container", async () => {
    const bytes = minimalJpeg();
    const dqtOffset = markerOffset(bytes, 0xdb);
    await expectRefusal(
      patchMarkerByte(bytes, dqtOffset, 0x02),
      "malformed-container",
    );
  });

  it("refuses a stray RSTn outside entropy data as malformed-container", async () => {
    const bytes = minimalJpeg();
    const withStrayRst = insertSegmentBefore(
      bytes,
      0xdb,
      Buffer.from([0xff, 0xd0]),
    );
    await expectRefusal(withStrayRst, "malformed-container");
  });
});
