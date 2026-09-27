import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { iccProfileV4, minimalJpeg } from "./fixtures.js";
import { iccSegments, spliceSegments } from "./qualification/jpeg/fixtures.js";
import { type ParsedJpeg, parseJpeg } from "../src/jpeg/parser.js";
import { ICC_SEGMENT_IDENTIFIER, reassembleIccSegments } from "../src/jpeg/icc.js";

const APP2 = 0xe2;

async function writeTempFile(bytes: Buffer): Promise<string> {
  const path = join(
    tmpdir(),
    `jpeg-reassembly-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
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

/** Collects every buffered APP2 payload from a parsed JPEG, in file order. */
function collectApp2Payloads(parsed: ParsedJpeg): Buffer[] {
  const payloads: Buffer[] = [];
  parsed.segments.forEach((segment, index) => {
    if (segment.marker !== APP2) return;
    const payload = parsed.buffered.get(index);
    if (payload !== undefined) payloads.push(payload);
  });
  return payloads;
}

/** A 70,000-byte synthetic profile: a real (structurally valid-looking) ICC v4
 * header from the shared test helper, padded with deterministic filler bytes.
 * reassembleIccSegments never validates ICC semantics (that is
 * icc_admission.ts's job elsewhere) -- it only needs to see the exact bytes
 * come back out, in order. */
function syntheticProfile(totalBytes: number): Buffer {
  const header = iccProfileV4();
  const filler = Buffer.alloc(totalBytes - header.length);
  for (let index = 0; index < filler.length; index += 1) {
    filler[index] = (index * 31) % 256;
  }
  return Buffer.concat([header, filler]);
}

describe("reassembleIccSegments tracer: a two-segment ICC profile parsed from a real JPEG", () => {
  it("splices a 70,000-byte profile as two APP2 segments and reassembles it byte-for-byte", async () => {
    const profile = syntheticProfile(70_000);
    expect(profile.length).toBe(70_000);

    const segments = iccSegments(profile, 40_000);
    expect(segments.length).toBe(2);

    const jpeg = spliceSegments(minimalJpeg(), segments);
    const parsed = await parseFile(jpeg);

    const payloads = collectApp2Payloads(parsed);
    expect(payloads.length).toBe(2);

    const reassembled = reassembleIccSegments(payloads);
    expect(reassembled.equals(profile)).toBe(true);
  });

  it("exports the ICC_PROFILE identifier constant", () => {
    expect(ICC_SEGMENT_IDENTIFIER).toBe("ICC_PROFILE");
  });
});
