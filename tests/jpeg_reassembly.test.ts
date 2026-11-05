import { type FileHandle, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { iccProfileV4, minimalJpeg } from "./fixtures.js";
import {
  appendTrailer,
  iccSegments,
  spliceSegments,
} from "./qualification/jpeg/fixtures.js";
import { jpegHandler } from "../src/admission/jpeg-handler.js";
import {
  type ParsedJpeg,
  JpegStructureError,
  parseJpeg,
} from "../src/jpeg/parser.js";
import {
  ICC_SEGMENT_IDENTIFIER,
  reassembleIccSegments,
} from "../src/jpeg/icc.js";
import { MAX_PROFILE_BYTES } from "../src/metadata/icc_admission.js";
import { JPEG_MAX_EXTENDED_XMP_BYTES, SOS } from "../src/jpeg/markers.js";
import { xmpOrientation } from "../src/metadata/xmp.js";
import {
  EXTENDED_XMP_IDENTIFIER,
  reassembleExtendedXmp,
  STANDARD_XMP_IDENTIFIER,
} from "../src/jpeg/xmp.js";

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

  it("reassembles a profile spliced out of file order (sequence 2 before 1)", async () => {
    const profile = syntheticProfile(70_000);
    const segments = iccSegments(profile, 40_000);
    expect(segments.length).toBe(2);

    const jpeg = spliceSegments(minimalJpeg(), [...segments].reverse());
    const parsed = await parseFile(jpeg);
    const payloads = collectApp2Payloads(parsed);
    expect(payloads.length).toBe(2);

    const reassembled = reassembleIccSegments(payloads);
    expect(reassembled.equals(profile)).toBe(true);
  });
});

/** Raw ICC_PROFILE APPn payload, matching what `parseJpeg` buffers: the
 * identifier prefix, a 1-byte sequence number, a 1-byte total count, then
 * chunk bytes. Built directly (not through iccSegments/appSegment/parseJpeg)
 * for the ICC unit tests below, since they exercise reassembleIccSegments's
 * own consistency rules rather than the parser. */
function iccPayload(sequence: number, count: number, chunk: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from("ICC_PROFILE\0", "ascii"),
    Buffer.from([sequence, count]),
    chunk,
  ]);
}

describe("reassembleIccSegments: consistency rules (D-01, Task 2)", () => {
  it("reassembles a single-segment profile (1 of 1)", () => {
    const chunk = Buffer.from([1, 2, 3, 4]);
    const result = reassembleIccSegments([iccPayload(1, 1, chunk)]);
    expect(result.equals(chunk)).toBe(true);
  });

  it("throws malformed-container on a duplicate sequence number (never silently overwrites)", () => {
    // count=1 with two payloads both claiming sequence 1: without an explicit
    // duplicate check, the second would silently overwrite the first in a
    // sequence-keyed map and reassembly would succeed on the wrong bytes --
    // no other check (missing-sequence, mismatched-count) would catch this
    // shape, so this is the one test that isolates the duplicate check.
    const payloads = [
      iccPayload(1, 1, Buffer.from([0x01])),
      iccPayload(1, 1, Buffer.from([0x02])),
    ];
    expect(() => reassembleIccSegments(payloads)).toThrow(JpegStructureError);
    try {
      reassembleIccSegments(payloads);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JpegStructureError);
      expect((error as JpegStructureError).refusal).toBe("malformed-container");
    }
  });

  it("throws malformed-container on a missing sequence", () => {
    const payloads = [iccPayload(1, 3, Buffer.from([0x01]))];
    expect(() => reassembleIccSegments(payloads)).toThrow(JpegStructureError);
  });

  it("throws malformed-container on mismatched count bytes", () => {
    const payloads = [
      iccPayload(1, 2, Buffer.from([0x01])),
      iccPayload(2, 3, Buffer.from([0x02])),
    ];
    expect(() => reassembleIccSegments(payloads)).toThrow(JpegStructureError);
  });

  it("throws malformed-container on sequence 0", () => {
    expect(() =>
      reassembleIccSegments([iccPayload(0, 1, Buffer.from([0x01]))]),
    ).toThrow(JpegStructureError);
  });

  it("throws malformed-container on count 0", () => {
    expect(() =>
      reassembleIccSegments([iccPayload(1, 0, Buffer.from([0x01]))]),
    ).toThrow(JpegStructureError);
  });

  it("throws resource-limits when the reassembled size is MAX_PROFILE_BYTES + 1", () => {
    const chunkBytes = MAX_PROFILE_BYTES / 2 + 1;
    const payloads = [
      iccPayload(1, 2, Buffer.alloc(chunkBytes)),
      iccPayload(2, 2, Buffer.alloc(chunkBytes)),
    ];
    try {
      reassembleIccSegments(payloads);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JpegStructureError);
      const structureError = error as JpegStructureError;
      expect(structureError.refusal).toBe("resource-limits");
      expect(structureError.limit?.segment).toBe("ICC_PROFILE");
    }
  });
});

const GUID_A = "0123456789ABCDEF0123456789ABCDEF";
const GUID_B = "FEDCBA9876543210FEDCBA9876543210";

/** A minimal standard-XMP APP1 payload (identifier + RDF), optionally naming
 * an ExtendedXMP GUID via `xmpNote:HasExtendedXMP`. */
function standardXmpPayload(
  options: {
    readonly hasExtendedXmpGuid?: string;
    readonly orientation?: number;
  } = {},
): Buffer {
  const attributes = [
    options.hasExtendedXmpGuid !== undefined
      ? `xmlns:xmpNote="http://ns.adobe.com/xmp/1.0/mm/" xmpNote:HasExtendedXMP="${options.hasExtendedXmpGuid}"`
      : "",
    options.orientation !== undefined
      ? `xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${options.orientation}"`
      : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" ${attributes}/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.concat([
    Buffer.from(STANDARD_XMP_IDENTIFIER, "ascii"),
    Buffer.from([0x00]),
    Buffer.from(xml, "utf8"),
  ]);
}

/** A minimal RDF/XMP packet carrying only `tiff:Orientation`, used as an
 * ExtendedXMP chunk's data. */
function orientationXmp(orientation: number): Buffer {
  return Buffer.from(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${orientation}"/>` +
      `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    "utf8",
  );
}

/** A raw ExtendedXMP APP1 payload: identifier + 32-byte GUID + 4-byte full
 * length + 4-byte offset + chunk data (Adobe XMP Part 3). */
function extendedXmpChunkPayload(
  guid: string,
  fullLength: number,
  offset: number,
  data: Buffer,
): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(fullLength, 0);
  head.writeUInt32BE(offset, 4);
  return Buffer.concat([
    Buffer.from(EXTENDED_XMP_IDENTIFIER, "ascii"),
    Buffer.from([0x00]),
    Buffer.from(guid, "ascii"),
    head,
    data,
  ]);
}

describe("reassembleExtendedXmp: GUID-scoped, bounded reassembly (D-05, Task 2)", () => {
  it("exports the standard and extended XMP identifier constants", () => {
    expect(STANDARD_XMP_IDENTIFIER).toBe("http://ns.adobe.com/xap/1.0/");
    expect(EXTENDED_XMP_IDENTIFIER).toBe("http://ns.adobe.com/xmp/extension/");
  });

  it("reassembles two chunks of the named GUID covering 0..N into the full packet", () => {
    const full = orientationXmp(8);
    const half = Math.ceil(full.length / 2);
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [
      extendedXmpChunkPayload(GUID_A, full.length, 0, full.subarray(0, half)),
      extendedXmpChunkPayload(GUID_A, full.length, half, full.subarray(half)),
    ];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.xmp.equals(full)).toBe(true);
    }
  });

  it("ignores chunks of a different GUID", () => {
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [extendedXmpChunkPayload(GUID_B, 10, 0, Buffer.alloc(10))];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("absent");
  });

  it("returns incomplete with a detail for a gap in coverage", () => {
    const full = orientationXmp(8);
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [
      extendedXmpChunkPayload(GUID_A, full.length, 0, full.subarray(0, 4)),
      extendedXmpChunkPayload(GUID_A, full.length, 8, full.subarray(8)),
    ];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it("returns incomplete with a detail for overlapping chunks", () => {
    const full = orientationXmp(8);
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [
      extendedXmpChunkPayload(GUID_A, full.length, 0, full.subarray(0, 20)),
      extendedXmpChunkPayload(GUID_A, full.length, 10, full.subarray(10)),
    ];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("incomplete");
  });

  it("returns incomplete for inconsistent declared full lengths", () => {
    const full = orientationXmp(8);
    const half = Math.ceil(full.length / 2);
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [
      extendedXmpChunkPayload(GUID_A, full.length, 0, full.subarray(0, half)),
      extendedXmpChunkPayload(
        GUID_A,
        full.length + 1,
        half,
        full.subarray(half),
      ),
    ];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("incomplete");
  });

  it("returns incomplete when the declared full length exceeds JPEG_MAX_EXTENDED_XMP_BYTES", () => {
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const oversized = JPEG_MAX_EXTENDED_XMP_BYTES + 1;
    const chunks = [
      extendedXmpChunkPayload(GUID_A, oversized, 0, Buffer.alloc(16)),
    ];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("incomplete");
  });

  it("returns absent when there is no HasExtendedXMP, even with extension chunks present", () => {
    const standard = standardXmpPayload();
    const chunks = [extendedXmpChunkPayload(GUID_A, 10, 0, Buffer.alloc(10))];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("absent");
  });

  it("feeds a complete ExtendedXMP with tiff:Orientation=8 into xmpOrientation and gets 8 back", () => {
    const full = orientationXmp(8);
    const standard = standardXmpPayload({ hasExtendedXmpGuid: GUID_A });
    const chunks = [extendedXmpChunkPayload(GUID_A, full.length, 0, full)];
    const result = reassembleExtendedXmp(standard, chunks);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(xmpOrientation(result.xmp)).toBe(8);
    }
  });
});

describe("reassembleIccSegments consistency clusters (67-25, jpeg-3)", () => {
  function expectMalformed(payloads: readonly Buffer[]): void {
    try {
      reassembleIccSegments(payloads);
    } catch (error) {
      expect(error).toBeInstanceOf(JpegStructureError);
      expect((error as JpegStructureError).refusal).toBe("malformed-container");
      return;
    }
    expect.unreachable();
  }

  it("reassembleIccSegments: an empty payload list is refused with the typed malformed-container error", () => {
    expectMalformed([]);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: a payload shorter than the 14-byte header is refused with the typed error, not a range error", () => {
    for (const length of [0, 1, 10, 11, 12, 13]) {
      expectMalformed([Buffer.alloc(length, 0x41)]);
    }
  });

  it("reassembleIccSegments EqualityOperator: a header-only payload of exactly 14 bytes is a valid empty profile", () => {
    const result = reassembleIccSegments([iccPayload(1, 1, Buffer.alloc(0))]);
    expect(result.length).toBe(0);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: sequence zero is refused even beside a complete 1-of-1 set", () => {
    const zero = iccPayload(0, 1, Buffer.from([0x0a]));
    const one = iccPayload(1, 1, Buffer.from([0x0b]));
    expectMalformed([zero, one]);
    expectMalformed([one, zero]);
  });

  it("reassembleIccSegments ConditionalExpression and BlockStatement: a sequence number above its declared count is refused even beside a complete set", () => {
    const first = iccPayload(1, 1, Buffer.from([0x0a]));
    const beyond = iccPayload(2, 1, Buffer.from([0x0b]));
    expectMalformed([first, beyond]);
    expectMalformed([beyond, first]);
  });

  it("reassembleIccSegments ConditionalExpression: segments that declare different counts are refused even when the last count yields a complete set", () => {
    const declaresThree = iccPayload(1, 3, Buffer.from([0x0a]));
    const declaresTwo = iccPayload(2, 2, Buffer.from([0x0b]));
    expectMalformed([declaresThree, declaresTwo]);
  });

  it("reassembleIccSegments EqualityOperator: a profile of exactly MAX_PROFILE_BYTES is accepted and returned in sequence order", () => {
    const half = MAX_PROFILE_BYTES / 2;
    const result = reassembleIccSegments([
      iccPayload(2, 2, Buffer.alloc(half, 0x22)),
      iccPayload(1, 2, Buffer.alloc(half, 0x11)),
    ]);
    expect(result.length).toBe(MAX_PROFILE_BYTES);
    expect(result[0]).toBe(0x11);
    expect(result[half - 1]).toBe(0x11);
    expect(result[half]).toBe(0x22);
    expect(result[MAX_PROFILE_BYTES - 1]).toBe(0x22);
  });
});

/** The decline fields this file asserts, read from the closed decline union. */
interface JrDeclineFields {
  readonly code: string;
  readonly detail: string;
  readonly feature?: string;
  readonly reason?: string;
}

/** One recorded FileHandle.read call: the exact arguments the code passed. */
interface JrReadCall {
  readonly offset: number;
  readonly length: number;
  readonly position: number;
}

/** Wraps a real FileHandle so every read is recorded; reads still hit the file. */
function jrRecordingHandle(handle: FileHandle): {
  readonly handle: FileHandle;
  readonly reads: JrReadCall[];
} {
  const reads: JrReadCall[] = [];
  const read = async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    reads.push({ offset, length, position });
    return handle.read(buffer, offset, length, position);
  };
  const proxy = new Proxy(handle, {
    get(target, property) {
      if (property === "read") return read;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { handle: proxy, reads };
}

/** Runs `body` with a recording read handle on a temp file holding `bytes`. */
async function jrWithJpegFile<T>(
  bytes: Buffer,
  body: (handle: FileHandle, reads: JrReadCall[], path: string) => Promise<T>,
): Promise<T> {
  const path = await writeTempFile(bytes);
  const raw = await open(path, "r");
  try {
    const recording = jrRecordingHandle(raw);
    return await body(recording.handle, recording.reads, path);
  } finally {
    await raw.close();
    await rm(path, { force: true });
  }
}

/** The reads parseJpeg alone performs on `bytes` (the prefix of admit's reads). */
async function jrParseReadCount(bytes: Buffer): Promise<number> {
  return jrWithJpegFile(bytes, async (handle, reads) => {
    await parseJpeg(handle, bytes.length);
    return reads.length;
  });
}

/** The reads admit performs after parseJpeg's, plus the admission entries. */
async function jrAdmitTailReads(bytes: Buffer): Promise<{
  readonly tailReads: readonly JrReadCall[];
  readonly trailerEntry: number | undefined;
}> {
  const parseReads = await jrParseReadCount(bytes);
  return jrWithJpegFile(bytes, async (handle, reads) => {
    const admission = await jpegHandler.admit(handle, bytes.length);
    const entry = admission.entries.find(
      (candidate) =>
        candidate.namespace === "JPEG" && candidate.name === "Trailer",
    );
    const value = entry?.value;
    return {
      tailReads: reads.slice(parseReads),
      trailerEntry: typeof value === "number" ? value : undefined,
    };
  });
}

describe("jpeg-handler.ts admit, output-plan and write clusters (67-25, jpeg-3)", () => {
  it("admit MethodExpression, ArithmeticOperator, ConditionalExpression and EqualityOperator: a trailer longer than the 64-byte window reads exactly the last 64 bytes", async () => {
    const bytes = appendTrailer(minimalJpeg(), Buffer.alloc(200, 0x5a));
    const result = await jrAdmitTailReads(bytes);
    expect(result.tailReads).toEqual([
      { offset: 0, length: 64, position: bytes.length - 64 },
    ]);
    expect(result.trailerEntry).toBe(200);
  });

  it("admit MethodExpression, ArithmeticOperator, ConditionalExpression and EqualityOperator: a short trailer reads exactly its own bytes from the primary EOI", async () => {
    const bytes = appendTrailer(minimalJpeg(), Buffer.alloc(20, 0x5a));
    const result = await jrAdmitTailReads(bytes);
    expect(result.tailReads).toEqual([
      { offset: 0, length: 20, position: bytes.length - 20 },
    ]);
    expect(result.trailerEntry).toBe(20);
  });

  it("admit MethodExpression and ArithmeticOperator: a file without a trailer reads nothing beyond the parse", async () => {
    const bytes = minimalJpeg();
    const result = await jrAdmitTailReads(bytes);
    expect(result.tailReads).toEqual([]);
    expect(result.trailerEntry).toBeUndefined();
  });

  it("checkOutputPlan ConditionalExpression: a plan without a scan declines with a string, and a declined plan returns its own reason", async () => {
    const bytes = minimalJpeg();
    const plan = await jrWithJpegFile(bytes, async (handle) => {
      const admission = await jpegHandler.admit(handle, bytes.length);
      return jpegHandler.buildOutputPlan(
        admission,
        false,
        false,
        false,
        undefined,
      );
    });
    expect(jpegHandler.checkOutputPlan(plan)).toBeUndefined();
    expect(plan.expectedMarkers).toContain(SOS);

    const noScan = {
      ...plan,
      expectedMarkers: plan.expectedMarkers.filter((marker) => marker !== SOS),
    };
    expect(typeof jpegHandler.checkOutputPlan(noScan)).toBe("string");

    const declined = { ...plan, declineReason: "scripted decline reason" };
    expect(jpegHandler.checkOutputPlan(declined)).toBe(
      "scripted decline reason",
    );
  });

  it("writeOutput ConditionalExpression and LogicalOperator: an aborted signal stops the write loop and rejects with the signal's own reason", async () => {
    const bytes = minimalJpeg();
    const reason = new Error("scripted abort reason");
    const controller = new AbortController();
    controller.abort(reason);
    const outcome = await jrWriteWithSignal(bytes, controller.signal);
    expect(outcome.error).toBe(reason);
    expect(outcome.destinationBytes.length).toBeLessThanOrEqual(2);
  });

  it("writeOutput StringLiteral and LogicalOperator: an aborted signal without a reason rejects with a DOMException named AbortError", async () => {
    const bytes = minimalJpeg();
    const signalWithoutReason = { aborted: true } as unknown as AbortSignal;
    const outcome = await jrWriteWithSignal(bytes, signalWithoutReason);
    expect(outcome.error).toBeInstanceOf(DOMException);
    expect((outcome.error as DOMException).name).toBe("AbortError");
  });

  it("classifyAdmissionFailure StringLiteral: an over-limit ICC profile declines color-profile preservation with the typed policy-limit reason, and other structure errors keep their kind", () => {
    const oversize = new JpegStructureError(
      "resource-limits",
      "scripted oversize ICC profile",
      { segment: ICC_SEGMENT_IDENTIFIER, size: 99, limit: 16 },
    );
    const preserved = jpegHandler.classifyAdmissionFailure(oversize, true) as
      JrDeclineFields | undefined;
    expect(preserved?.code).toBe("unsupported-feature");
    expect(preserved?.feature).toBe("color-profile-preservation");
    expect(preserved?.reason).toBe("policy-limit");
    expect(typeof preserved?.detail).toBe("string");

    const notPreserved = jpegHandler.classifyAdmissionFailure(
      oversize,
      false,
    ) as JrDeclineFields | undefined;
    expect(notPreserved?.code).toBe(oversize.kind);
    expect(notPreserved?.feature).toBeUndefined();

    expect(
      jpegHandler.classifyAdmissionFailure(new Error("unrelated"), true),
    ).toBeUndefined();
  });
});

/**
 * Runs the shipped writeOutput with a hand-built plan whose only part is an
 * insert, so only the loop's own abort check (not copyRange's) can stop it.
 */
async function jrWriteWithSignal(
  bytes: Buffer,
  signal: AbortSignal,
): Promise<{ readonly error: unknown; readonly destinationBytes: Buffer }> {
  const sourcePath = await writeTempFile(bytes);
  const destinationPath = await writeTempFile(Buffer.alloc(0));
  const source = await open(sourcePath, "r");
  const destination = await open(destinationPath, "r+");
  try {
    const admission = await jpegHandler.admit(source, bytes.length);
    const built = jpegHandler.buildOutputPlan(
      admission,
      false,
      false,
      false,
      undefined,
    );
    const plan = {
      ...built,
      parts: [{ kind: "insert" as const, data: Buffer.from([0x01, 0x02]) }],
    };
    let error: unknown;
    try {
      await jpegHandler.writeOutput(source, destination, plan, signal);
    } catch (caught) {
      error = caught;
    }
    const written = await destination.readFile();
    return { error, destinationBytes: written };
  } finally {
    await source.close();
    await destination.close();
    await rm(sourcePath, { force: true });
    await rm(destinationPath, { force: true });
  }
}
