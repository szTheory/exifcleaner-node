import type { FileHandle } from "node:fs/promises";
import {
  APP0,
  APP15,
  classifyMarker,
  JPEG_REFUSAL_DETAILS,
  JPEG_REFUSAL_KIND,
  RST0,
  RST7,
  SOF2,
  SOI,
  type JpegRefusal,
} from "./markers.js";

// JPEG marker-stream codec: length-driven single forward pass (ITU-T T.81 Annex B).
// Mirrors src/png/chunks.ts's parsePng loop shape (header, bounds-check, classify,
// buffer-or-skip, advance) with JPEG's marker grammar instead of PNG's chunk grammar.
// Must not import anything from src/png or src/webp (57-03 prohibition).

const READ_WINDOW_BYTES = 64 * 1024;

export class JpegStructureError extends Error {
  readonly kind: "malformed-file" | "unsafe-structure";
  readonly refusal: JpegRefusal;
  readonly limit?: { segment: string; size: number; limit: number };

  constructor(
    refusal: JpegRefusal,
    message: string,
    limit?: { segment: string; size: number; limit: number },
  ) {
    super(message);
    this.name = "JpegStructureError";
    this.refusal = refusal;
    this.kind = JPEG_REFUSAL_KIND[refusal];
    if (limit !== undefined) this.limit = limit;
  }
}

export interface JpegSegment {
  readonly marker: number;
  readonly offset: number;
  readonly totalLength: number;
  readonly payloadOffset: number;
  readonly payloadLength: number;
  readonly identifier: string | undefined;
  readonly entropyEnd?: number;
}

export interface JpegFrameComponent {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly tq: number;
}

export interface JpegFrame {
  readonly marker: number;
  readonly precision: number;
  readonly height: number;
  readonly width: number;
  readonly components: readonly JpegFrameComponent[];
}

export interface ParsedJpeg {
  readonly segments: readonly JpegSegment[];
  readonly frame: JpegFrame;
  readonly primaryEoiEnd: number;
  readonly trailerBytes: number;
  readonly buffered: ReadonlyMap<number, Buffer>;
}

export function isJpegSignature(magic: Buffer): boolean {
  return (
    magic.length >= 3 &&
    magic[0] === 0xff &&
    magic[1] === SOI &&
    magic[2] === 0xff
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const next = await handle.read(
      result,
      read,
      length - read,
      position + read,
    );
    if (next.bytesRead === 0) {
      throw new JpegStructureError("truncation", "Unexpected end of file.");
    }
    read += next.bytesRead;
  }
  return result;
}

// Bounded read-ahead window, mirrors src/png/chunks.ts's ChunkReadWindow (same
// bytes-served-with-no-I/O-when-inside-window shape, no shared code since this
// module must not import from src/png).
interface ReadWindow {
  buffer: Buffer;
  start: number;
  end: number;
}

function createReadWindow(): ReadWindow {
  return { buffer: Buffer.alloc(0), start: 0, end: 0 };
}

async function readWindowed(
  handle: FileHandle,
  window: ReadWindow,
  length: number,
  position: number,
  size: number,
): Promise<Buffer> {
  if (length > READ_WINDOW_BYTES) {
    return readExactly(handle, length, position);
  }
  if (position < window.start || position + length > window.end) {
    const windowLength = Math.min(READ_WINDOW_BYTES, size - position);
    window.buffer = await readExactly(handle, windowLength, position);
    window.start = position;
    window.end = position + windowLength;
  }
  const relative = position - window.start;
  return window.buffer.subarray(relative, relative + length);
}

async function readByte(
  handle: FileHandle,
  window: ReadWindow,
  position: number,
  size: number,
): Promise<number> {
  if (position >= size) {
    throw new JpegStructureError("truncation", "Unexpected end of file.");
  }
  const byte = (
    await readWindowed(handle, window, 1, position, size)
  ).readUInt8(0);
  return byte;
}

function readIdentifier(payload: Buffer): string | undefined {
  const window = payload.subarray(0, Math.min(32, payload.length));
  const nul = window.indexOf(0);
  if (nul < 0) return undefined;
  return window.subarray(0, nul).toString("ascii");
}

function refuse(refusal: JpegRefusal, detail?: string): never {
  const prefix = JPEG_REFUSAL_DETAILS[refusal];
  throw new JpegStructureError(
    refusal,
    detail === undefined ? prefix : `${prefix} ${detail}`,
  );
}

/** DQT payload: repeated [PqTq(1)][64 or 128 bytes of table values]. Populates
 * `dqtSlots` with every Tq id defined (Task 2/D-10 table-slot tracking). */
function parseDqtSlots(payload: Buffer, dqtSlots: Set<number>): void {
  let cursor = 0;
  while (cursor < payload.length) {
    if (cursor + 1 > payload.length) {
      refuse("malformed-container", "DQT table header is truncated.");
    }
    const pqTq = payload.readUInt8(cursor);
    const pq = (pqTq >> 4) & 0x0f;
    const tq = pqTq & 0x0f;
    const tableBytes = pq === 0 ? 64 : 128;
    if (cursor + 1 + tableBytes > payload.length) {
      refuse("malformed-container", "DQT table is truncated.");
    }
    dqtSlots.add(tq);
    cursor += 1 + tableBytes;
  }
}

/** DHT payload: repeated [TcTh(1)][BITS(16)][VALUES(sum(BITS))]. Populates
 * `dcSlots`/`acSlots` with every Th id defined for the matching Tc class. */
function parseDhtSlots(
  payload: Buffer,
  dcSlots: Set<number>,
  acSlots: Set<number>,
): void {
  let cursor = 0;
  while (cursor < payload.length) {
    if (cursor + 1 + 16 > payload.length) {
      refuse("malformed-container", "DHT table header is truncated.");
    }
    const tcTh = payload.readUInt8(cursor);
    const tc = (tcTh >> 4) & 0x0f;
    const th = tcTh & 0x0f;
    const bits = payload.subarray(cursor + 1, cursor + 1 + 16);
    let valueCount = 0;
    for (const count of bits) valueCount += count;
    if (cursor + 1 + 16 + valueCount > payload.length) {
      refuse("malformed-container", "DHT table is truncated.");
    }
    (tc === 0 ? dcSlots : acSlots).add(th);
    cursor += 1 + 16 + valueCount;
  }
}

interface JpegSosComponent {
  readonly cs: number;
  readonly td: number;
  readonly ta: number;
}

interface JpegSosHeader {
  readonly components: readonly JpegSosComponent[];
  readonly ss: number;
  readonly se: number;
  readonly ah: number;
  readonly al: number;
}

function parseSosHeader(payload: Buffer): JpegSosHeader {
  if (payload.length < 1) {
    refuse("malformed-container", "SOS header is too short.");
  }
  const ns = payload.readUInt8(0);
  if (payload.length < 1 + ns * 2 + 3) {
    refuse("malformed-container", "SOS header is truncated.");
  }
  const components: JpegSosComponent[] = [];
  for (let index = 0; index < ns; index += 1) {
    const base = 1 + index * 2;
    const cs = payload.readUInt8(base);
    const tdTa = payload.readUInt8(base + 1);
    components.push({ cs, td: (tdTa >> 4) & 0x0f, ta: tdTa & 0x0f });
  }
  const tailBase = 1 + ns * 2;
  const ss = payload.readUInt8(tailBase);
  const se = payload.readUInt8(tailBase + 1);
  const ahAl = payload.readUInt8(tailBase + 2);
  return { components, ss, se, ah: (ahAl >> 4) & 0x0f, al: ahAl & 0x0f };
}

/**
 * D-10 / RESEARCH Pitfall 2: validates that every scan component's frame
 * quantization table, and (per scan type) DC and/or AC Huffman table, was
 * defined by a preceding DQT/DHT before this SOS. A sequential frame
 * (SOF0/SOF1) always needs both DC and AC for every component. A progressive
 * frame (SOF2) needs only DC for a DC-first scan (Ss=0, Ah=0), nothing for a
 * DC-refinement scan (Ss=0, Ah>0), and only AC for an AC scan (Ss>0).
 */
function validateScanTables(
  frame: JpegFrame,
  sos: JpegSosHeader,
  dqtSlots: ReadonlySet<number>,
  dcSlots: ReadonlySet<number>,
  acSlots: ReadonlySet<number>,
): void {
  let needsDc = true;
  let needsAc = true;
  if (frame.marker === SOF2) {
    if (sos.ss === 0 && sos.ah === 0) {
      needsDc = true;
      needsAc = false;
    } else if (sos.ss === 0 && sos.ah > 0) {
      needsDc = false;
      needsAc = false;
    } else {
      needsDc = false;
      needsAc = true;
    }
  }
  for (const component of sos.components) {
    const frameComponent = frame.components.find((c) => c.id === component.cs);
    if (frameComponent === undefined) {
      refuse(
        "malformed-container",
        `SOS references undefined component id ${component.cs}.`,
      );
    }
    if (!dqtSlots.has(frameComponent.tq)) {
      refuse(
        "undefined-table-reference",
        `Component ${component.cs} references quantization table ${frameComponent.tq}, which was never defined.`,
      );
    }
    if (needsDc && !dcSlots.has(component.td)) {
      refuse(
        "undefined-table-reference",
        `Component ${component.cs} references DC Huffman table ${component.td}, which was never defined.`,
      );
    }
    if (needsAc && !acSlots.has(component.ta)) {
      refuse(
        "undefined-table-reference",
        `Component ${component.cs} references AC Huffman table ${component.ta}, which was never defined.`,
      );
    }
  }
}

/**
 * The entropy-coded scan data has no length field (D-10). It ends at the next marker
 * that is not `0xFF00` (byte-stuffed data) or `0xFFD0`..`0xFFD7` (RSTn, restart
 * markers that do not end a scan); a run of `0xFF` fill bytes before that marker code
 * is skipped. One forward linear pass, no backtracking. Returns the offset of the
 * `0xFF` byte that starts the terminating marker.
 */
async function scanEntropyData(
  handle: FileHandle,
  window: ReadWindow,
  startOffset: number,
  size: number,
): Promise<number> {
  let offset = startOffset;
  for (;;) {
    const byte = await readByte(handle, window, offset, size);
    offset += 1;
    if (byte !== 0xff) continue;
    let next = await readByte(handle, window, offset, size);
    if (next === 0x00) {
      // Byte-stuffed literal 0xFF in the entropy data.
      offset += 1;
      continue;
    }
    while (next === 0xff) {
      offset += 1;
      next = await readByte(handle, window, offset, size);
    }
    if (next >= RST0 && next <= RST7) {
      // RSTn does not end the scan.
      offset += 1;
      continue;
    }
    // Any other marker ends the scan. offset - 1 is the position of the 0xFF that
    // starts it, so the caller's main loop can re-read it through the normal path.
    return offset - 1;
  }
}

function readU16BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16BE(offset);
}

/**
 * Parses a JPEG marker stream from an open file handle: SOI, a length-driven single
 * forward pass over marker segments (bounds-checking each declared length as its
 * header is read), the admitted-SOF frame header, one or more SOS scans (each
 * followed by a forward-only entropy-data scan), and the primary EOI. Anything after
 * the primary EOI is the trailer.
 */
export async function parseJpeg(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<ParsedJpeg> {
  if (isAborted(signal)) {
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  }
  if (!Number.isSafeInteger(size) || size < 4) {
    throw new JpegStructureError(
      "malformed-container",
      "File is too small to be a JPEG.",
    );
  }
  const window = createReadWindow();
  const soi = await readWindowed(handle, window, 2, 0, size);
  if (soi[0] !== 0xff || soi[1] !== SOI) {
    throw new JpegStructureError(
      "malformed-container",
      "File does not begin with an SOI marker.",
    );
  }

  const segments: JpegSegment[] = [];
  const buffered = new Map<number, Buffer>();
  const dqtSlots = new Set<number>();
  const dcSlots = new Set<number>();
  const acSlots = new Set<number>();
  let offset = 2;
  let frame: JpegFrame | undefined;
  let primaryEoiEnd: number | undefined;

  while (offset < size) {
    if (isAborted(signal)) {
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    }
    const markerStart = offset;
    const prefix = await readByte(handle, window, offset, size);
    if (prefix !== 0xff) {
      throw new JpegStructureError(
        "malformed-container",
        "Expected a marker prefix byte (0xFF).",
      );
    }
    offset += 1;
    let marker = await readByte(handle, window, offset, size);
    offset += 1;
    while (marker === 0xff) {
      // Fill bytes (D-09): a run of 0xFF before the real marker code.
      marker = await readByte(handle, window, offset, size);
      offset += 1;
    }

    const classification = classifyMarker(marker);
    if (!classification.admitted) {
      refuse(classification.refusal);
    }

    if (classification.kind === "soi") {
      throw new JpegStructureError(
        "malformed-container",
        "A second SOI appeared before the primary EOI.",
      );
    }
    if (classification.kind === "eoi") {
      primaryEoiEnd = offset;
      break;
    }
    if (classification.kind === "restart") {
      throw new JpegStructureError(
        "malformed-container",
        "A restart marker appeared outside entropy-coded scan data.",
      );
    }

    if (classification.kind === "sos") {
      if (frame === undefined) {
        throw new JpegStructureError(
          "malformed-container",
          "SOS appeared before any SOF.",
        );
      }
      if (size - offset < 2) {
        throw new JpegStructureError(
          "truncation",
          "SOS segment header is truncated.",
        );
      }
      const header = await readWindowed(handle, window, 2, offset, size);
      const length = readU16BE(header, 0);
      if (length < 2) {
        throw new JpegStructureError(
          "malformed-container",
          "SOS segment length is below 2.",
        );
      }
      const payloadOffset = offset + 2;
      const payloadLength = length - 2;
      if (payloadOffset + payloadLength > size) {
        throw new JpegStructureError(
          "truncation",
          "SOS segment exceeds file bounds.",
        );
      }
      const sosPayload = await readWindowed(
        handle,
        window,
        payloadLength,
        payloadOffset,
        size,
      );
      const sosHeader = parseSosHeader(sosPayload);
      validateScanTables(frame, sosHeader, dqtSlots, dcSlots, acSlots);
      const headerEnd = payloadOffset + payloadLength;
      const entropyEnd = await scanEntropyData(handle, window, headerEnd, size);
      segments.push({
        marker,
        offset: markerStart,
        totalLength: entropyEnd - markerStart,
        payloadOffset,
        payloadLength,
        identifier: undefined,
        entropyEnd,
      });
      offset = entropyEnd;
      continue;
    }

    // Every other segment here (DQT/DHT/DRI/admitted-SOF/APPn/COM) is
    // length-prefixed: a 2-byte big-endian length (counting itself) followed by
    // that many bytes of payload.
    if (size - offset < 2) {
      throw new JpegStructureError(
        "truncation",
        "Segment length field is truncated.",
      );
    }
    const header = await readWindowed(handle, window, 2, offset, size);
    const length = readU16BE(header, 0);
    if (length < 2) {
      throw new JpegStructureError(
        "malformed-container",
        "Segment length is below 2.",
      );
    }
    const payloadOffset = offset + 2;
    const payloadLength = length - 2;
    if (payloadOffset + payloadLength > size) {
      throw new JpegStructureError(
        "truncation",
        "Segment exceeds file bounds.",
      );
    }
    const payload = await readWindowed(
      handle,
      window,
      payloadLength,
      payloadOffset,
      size,
    );

    if (classification.kind === "dqt") {
      parseDqtSlots(payload, dqtSlots);
    } else if (classification.kind === "dht") {
      parseDhtSlots(payload, dcSlots, acSlots);
    } else if (classification.kind === "sof-admitted") {
      if (frame !== undefined) {
        throw new JpegStructureError(
          "malformed-container",
          "More than one SOF appeared in the primary image.",
        );
      }
      if (payload.length < 6) {
        throw new JpegStructureError(
          "malformed-container",
          "SOF segment is too short.",
        );
      }
      const precision = payload.readUInt8(0);
      const height = payload.readUInt16BE(1);
      const width = payload.readUInt16BE(3);
      const componentCount = payload.readUInt8(5);
      if (payload.length < 6 + componentCount * 3) {
        throw new JpegStructureError(
          "malformed-container",
          "SOF component table is truncated.",
        );
      }
      if (precision !== 8) {
        refuse("non-8-bit-precision");
      }
      if (height === 0) {
        refuse("dnl-marker");
      }
      if (
        componentCount !== 1 &&
        componentCount !== 3 &&
        componentCount !== 4
      ) {
        refuse("unsupported-component-count");
      }
      const components: JpegFrameComponent[] = [];
      for (let index = 0; index < componentCount; index += 1) {
        const base = 6 + index * 3;
        const id = payload.readUInt8(base);
        const sampling = payload.readUInt8(base + 1);
        const tq = payload.readUInt8(base + 2);
        components.push({
          id,
          h: (sampling >> 4) & 0x0f,
          v: sampling & 0x0f,
          tq,
        });
      }
      frame = { marker, precision, height, width, components };
    }

    const identifier =
      marker >= APP0 && marker <= APP15 ? readIdentifier(payload) : undefined;

    segments.push({
      marker,
      offset: markerStart,
      totalLength: length + (offset - markerStart),
      payloadOffset,
      payloadLength,
      identifier,
    });
    offset = payloadOffset + payloadLength;
  }

  if (primaryEoiEnd === undefined) {
    throw new JpegStructureError(
      "truncation",
      "JPEG has no primary EOI marker.",
    );
  }
  if (frame === undefined) {
    throw new JpegStructureError(
      "malformed-container",
      "JPEG has no SOF (frame header).",
    );
  }

  return {
    segments,
    frame,
    primaryEoiEnd,
    trailerBytes: size - primaryEoiEnd,
    buffered,
  };
}
