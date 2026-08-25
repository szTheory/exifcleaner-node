import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_BUFFERED_METADATA_BYTES,
  MAX_CHUNK_COUNT,
  WebpStructureError,
  parseWebp,
} from "../src/webp/riff.js";
import {
  alpha,
  anim,
  animationFrame,
  chunk,
  exifWithOrientation,
  vp8,
  vp8l,
  vp8x,
  webp,
  xmpPacket,
} from "./fixtures.js";

async function parseFixture(fixture: Buffer): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-riff-"));
  const path = join(directory, "input.webp");
  try {
    await writeFile(path, fixture);
    const handle = await open(path, "r");
    try {
      await parseWebp(handle, fixture.length);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectStructureError(
  fixture: Buffer,
  kind: WebpStructureError["kind"],
): Promise<void> {
  await expect(parseFixture(fixture)).rejects.toMatchObject({ kind });
}

async function parseOversizedIccp(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-riff-"));
  const path = join(directory, "input.webp");
  const metadataSize = MAX_BUFFERED_METADATA_BYTES + 1;
  const fileSize = 12 + 18 + 8 + metadataSize + (metadataSize & 1) + 18;
  const header = Buffer.alloc(38);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WEBP", 8, 4, "ascii");
  header.write("VP8X", 12, 4, "ascii");
  header.writeUInt32LE(10, 16);
  header[20] = 0x20;
  header.write("ICCP", 30, 4, "ascii");
  header.writeUInt32LE(metadataSize, 34);
  try {
    const handle = await open(path, "w+");
    try {
      await handle.write(header);
      await handle.truncate(fileSize);
      await parseWebp(handle, fileSize);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("parseWebp structural validation", () => {
  it("reports typed metadata-limit context for an oversized ICCP without buffering it", async () => {
    await expect(parseOversizedIccp()).rejects.toMatchObject({
      kind: "unsafe-structure",
      metadataLimit: {
        fourCc: "ICCP",
        size: MAX_BUFFERED_METADATA_BYTES + 1,
        limit: MAX_BUFFERED_METADATA_BYTES,
      },
    });
  });

  it("accepts valid VP8 and VP8L headers with matching VP8X canvases", async () => {
    await parseFixture(
      webp([
        { fourCc: "VP8X", data: vp8x(0, 3, 2) },
        { fourCc: "VP8 ", data: vp8(3, 2) },
      ]),
    );
    await parseFixture(
      webp([
        { fourCc: "VP8X", data: vp8x(0x10, 2, 3) },
        { fourCc: "VP8L", data: vp8l(2, 3, true) },
      ]),
    );
  });

  it("accepts EXIF and XMP outside reconstruction order", async () => {
    await parseFixture(
      webp([
        { fourCc: "VP8X", data: vp8x(0x0c) },
        { fourCc: "XMP ", data: xmpPacket() },
        { fourCc: "EXIF", data: exifWithOrientation(1) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    );
  });

  it.each([
    ["short VP8", Buffer.alloc(9)],
    ["inter frame VP8", Buffer.from([0x11, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0])],
    ["bad VP8 signature", Buffer.from([0x10, 0, 0, 0, 1, 0x2a, 1, 0, 1, 0])],
    ["zero-width VP8", Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 1, 0])],
    ["short VP8L", Buffer.alloc(4)],
    ["bad VP8L signature", Buffer.alloc(5)],
    ["unsupported VP8L version", Buffer.from([0x2f, 0, 0, 0, 0x20])],
  ])("rejects an invalid %s bitstream header", async (_name, data) => {
    const fourCc = _name.includes("VP8L") ? "VP8L" : "VP8 ";
    await expectStructureError(webp([{ fourCc, data }]), "malformed-file");
  });

  it("rejects an image whose dimensions disagree with the VP8X canvas", async () => {
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0, 2, 2) },
        { fourCc: "VP8 ", data: vp8(1, 2) },
      ]),
      "malformed-file",
    );
  });

  it("rejects a VP8X canvas whose area exceeds the format limit", async () => {
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0, 65_536, 65_536) },
        { fourCc: "VP8 ", data: vp8(1, 1) },
      ]),
      "malformed-file",
    );
  });

  it("requires ANIM to contain exactly its six-byte header", async () => {
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x02) },
        { fourCc: "ANIM", data: Buffer.alloc(5) },
        { fourCc: "ANMF", data: animationFrame() },
      ]),
      "malformed-file",
    );
  });

  it("accepts padded nested ALPH followed by exactly one VP8 image", async () => {
    await parseFixture(
      webp([
        { fourCc: "VP8X", data: vp8x(0x12, 2, 1) },
        { fourCc: "ANIM", data: anim() },
        {
          fourCc: "ANMF",
          data: animationFrame({
            width: 2,
            chunks: [
              { fourCc: "ALPH", data: alpha(2, 1, 0x80) },
              { fourCc: "VP8 ", data: vp8(2, 1) },
            ],
          }),
        },
      ]),
    );
  });

  it.each([
    ["short header", Buffer.alloc(15), "malformed-file"],
    [
      "reserved frame bits",
      (() => {
        const data = animationFrame();
        data[15] = 0x04;
        return data;
      })(),
      "malformed-file",
    ],
    [
      "frame outside canvas",
      animationFrame({ x: 2, width: 1 }),
      "malformed-file",
    ],
    [
      "duplicate images",
      animationFrame({
        chunks: [
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "VP8L", data: vp8l() },
        ],
      }),
      "malformed-file",
    ],
    [
      "ALPH after image",
      animationFrame({
        chunks: [
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "ALPH", data: alpha() },
        ],
      }),
      "unsafe-structure",
    ],
    [
      "trailing nested byte",
      Buffer.concat([animationFrame(), Buffer.from([1])]),
      "malformed-file",
    ],
  ] as const)("rejects ANMF with %s", async (_name, frame, kind) => {
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x02) },
        { fourCc: "ANIM", data: anim() },
        { fourCc: "ANMF", data: frame },
      ]),
      kind,
    );
  });

  it("refuses an opaque nested PRIV chunk that would otherwise preserve GPS data", async () => {
    const privateGps = Buffer.from("GPSLatitude=40.7128;GPSLongitude=-74.0060");
    const fixture = webp([
      { fourCc: "VP8X", data: vp8x(0x02) },
      { fourCc: "ANIM", data: anim() },
      {
        fourCc: "ANMF",
        data: animationFrame({
          chunks: [
            { fourCc: "PRIV", data: privateGps },
            { fourCc: "VP8 ", data: vp8() },
          ],
        }),
      },
    ]);

    expect(fixture.includes(privateGps)).toBe(true);
    await expectStructureError(fixture, "unsafe-structure");
  });

  it("enforces alpha semantics for still and animated image payloads", async () => {
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x10) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "malformed-file",
    );
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x02) },
        { fourCc: "ANIM", data: anim() },
        {
          fourCc: "ANMF",
          data: animationFrame({
            chunks: [{ fourCc: "VP8L", data: vp8l(1, 1, true) }],
          }),
        },
      ]),
      "malformed-file",
    );
  });

  it("exports a finite aggregate chunk limit", () => {
    expect(Number.isSafeInteger(MAX_CHUNK_COUNT)).toBe(true);
    expect(MAX_CHUNK_COUNT).toBeGreaterThan(0);
  });

  it("enforces the aggregate chunk limit before frame processing", async () => {
    const frame = animationFrame();
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x02) },
        { fourCc: "ANIM", data: anim() },
        ...Array.from({ length: MAX_CHUNK_COUNT - 1 }, () => ({
          fourCc: "ANMF",
          data: frame,
        })),
      ]),
      "unsafe-structure",
    );
  });

  it("rejects a nested chunk with non-zero odd-byte padding", async () => {
    const frameHeader = animationFrame({ chunks: [] });
    const frame = Buffer.concat([
      frameHeader,
      chunk("VP8 ", vp8(1, 1, Buffer.from([1])), 7),
    ]);
    await expectStructureError(
      webp([
        { fourCc: "VP8X", data: vp8x(0x02) },
        { fourCc: "ANIM", data: anim() },
        { fourCc: "ANMF", data: frame },
      ]),
      "malformed-file",
    );
  });
});
