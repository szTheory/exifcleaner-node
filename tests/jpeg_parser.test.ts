import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalJpeg } from "./fixtures.js";
import { isJpegSignature, parseJpeg } from "../src/jpeg/parser.js";

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
