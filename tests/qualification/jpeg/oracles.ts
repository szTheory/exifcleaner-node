import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { DifferentialProfile } from "../kit/oracles.js";
import type { PayloadDigest } from "../kit/corpus.js";

// JPEG's differential-oracle profile (57-05 tracer slice). Deliberately does
// not import anything from src/jpeg (the oracle and the handler must
// independently agree a profile is clean, never share one implementation --
// mirrors png/oracles.ts's own T-56-50 rationale). `permittedKinds` stays
// empty until 57-09 measures JPEG's own preservation grants.

export const JPEG_EXTENSION = ".jpg";

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Walks a JPEG marker stream (its own small length-driven parse, independent
 * of `src/jpeg/parser.ts`) and returns the sha256 of the reassembled APP2
 * `ICC_PROFILE` payload (concatenated in declared-sequence order), or
 * undefined when no such segment is present or the profile is inconsistent.
 * Only ever reads length-prefixed segment headers -- an entropy-coded scan's
 * internal bytes are never interpreted as a marker, so this walker stops
 * bounds-checking at the first SOS and returns whatever it has reassembled by
 * then (ICC_PROFILE segments always precede the frame's scan data in every
 * fixture and real-world encoder this oracle is measured against).
 */
export function jpegRawColorProfileSha256(input: Buffer): string | undefined {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    return undefined;
  }
  const identifier = Buffer.from("ICC_PROFILE\0", "ascii");
  const bySequence = new Map<number, Buffer>();
  let declaredCount: number | undefined;
  let offset = 2;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return undefined;
    const marker = input[offset + 1]!;
    if (marker === 0xd9 /* EOI */) break;
    if (marker === 0xda /* SOS */) break;
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = input.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > input.length) return undefined;
    const payloadOffset = offset + 4;
    const payloadLength = length - 2;
    if (
      marker === 0xe2 /* APP2 */ &&
      payloadLength >= identifier.length + 2 &&
      input
        .subarray(payloadOffset, payloadOffset + identifier.length)
        .equals(identifier)
    ) {
      const sequence = input.readUInt8(payloadOffset + identifier.length);
      const count = input.readUInt8(payloadOffset + identifier.length + 1);
      if (sequence === 0 || count === 0 || sequence > count) return undefined;
      if (declaredCount === undefined) declaredCount = count;
      else if (declaredCount !== count) return undefined;
      if (bySequence.has(sequence)) return undefined;
      bySequence.set(
        sequence,
        input.subarray(
          payloadOffset + identifier.length + 2,
          payloadOffset + payloadLength,
        ),
      );
    }
    offset = payloadOffset + payloadLength;
  }

  if (declaredCount === undefined) return undefined;
  const chunks: Buffer[] = [];
  for (let sequence = 1; sequence <= declaredCount; sequence += 1) {
    const chunk = bySequence.get(sequence);
    if (chunk === undefined) return undefined;
    chunks.push(chunk);
  }
  return digest(Buffer.concat(chunks));
}

export const jpegDifferentialProfile: DifferentialProfile = {
  format: "jpeg",
  extension: JPEG_EXTENSION,
  rawColorProfileSha256: jpegRawColorProfileSha256,
  // 57-09 fills this once JPEG's own preservation grants (orientation,
  // color profile, resolution) are measured against ExifTool.
  permittedKinds: [],
};

export interface JpegMarkerWalk {
  /** Ordered one-byte marker codes seen between SOI and the first EOI
   * (SOI/EOI/RSTn excluded; SOS is included once per scan, its
   * entropy-coded data skipped rather than interpreted). */
  readonly markers: readonly number[];
  /** Bytes after the first EOI (`57-07` tracer: 0 proves the primary-EOI
   * truncation cleanly removed any trailer/MPF/motion-photo payload). */
  readonly trailerBytes: number;
}

/**
 * Independent JPEG marker walker (57-07 tracer companion). Deliberately does
 * not import anything from `src/jpeg/parser.ts` -- the oracle and the
 * handler must independently agree on a sanitized output's shape, never
 * share one implementation (mirrors `jpegRawColorProfileSha256` above and
 * png/oracles.ts's own T-56-50 rationale). Walks the length-prefixed marker
 * segments from just after SOI, skips each SOS's entropy-coded scan data by
 * scanning for the next non-stuffed, non-restart marker byte, and stops at
 * the first EOI.
 */
export function jpegMarkerSequence(bytes: Buffer): JpegMarkerWalk {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("jpegMarkerSequence: not a JPEG (missing SOI).");
  }
  const markers: number[] = [];
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      throw new Error(
        `jpegMarkerSequence: expected a marker prefix byte at offset ${offset}.`,
      );
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 /* EOI */) {
      return { markers, trailerBytes: bytes.length - (offset + 2) };
    }
    if (
      marker >= 0xd0 &&
      marker <= 0xd7 /* stray RSTn, never expected here */
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xda /* SOS */) {
      markers.push(marker);
      const length = bytes.readUInt16BE(offset + 2);
      offset += 2 + length;
      for (;;) {
        while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
        if (offset >= bytes.length - 1) {
          throw new Error(
            "jpegMarkerSequence: truncated entropy-coded data (no EOI found).",
          );
        }
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      continue;
    }
    markers.push(marker);
    const length = bytes.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error("jpegMarkerSequence: no EOI found.");
}

/**
 * Walks a JPEG marker stream (a test-local parse, independent of
 * `src/jpeg/parser.ts` and of `jpegMarkerSequence` above -- the payload
 * identity check must not share a bug with either the handler or the
 * tracer's own walker) and returns the concatenation, in scan order, of
 * every SOS's entropy-coded scan data -- the raw byte range libjpeg-turbo's
 * own decoder consumes, restart markers and stuffed 0x00 bytes included
 * exactly as encoded. Correctly treats a run of 0xFF fill bytes (D-08's own
 * `fill-bytes.jpg` variant) as padding per T.81 B.1.1.5: any number of 0xFF
 * bytes may precede a marker code, so the real marker is the first non-0xFF
 * byte following a run of 0xFF, both when scanning for a segment marker and
 * when scanning for the marker that ends a scan's entropy data.
 */
export function jpegEntropyCodedBytes(bytes: Buffer): Buffer {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("jpegEntropyCodedBytes: not a JPEG (missing SOI).");
  }
  const parts: Buffer[] = [];
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      throw new Error(
        `jpegEntropyCodedBytes: expected a marker prefix byte at offset ${offset}.`,
      );
    }
    while (bytes[offset + 1] === 0xff) offset += 1;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 /* EOI */) break;
    if (marker >= 0xd0 && marker <= 0xd7 /* stray RSTn outside a scan */) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 /* TEM, standalone */) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xda /* SOS */) {
      const scanStart = offset + 2 + length;
      let scanEnd = scanStart;
      for (;;) {
        while (scanEnd < bytes.length && bytes[scanEnd] !== 0xff) scanEnd += 1;
        if (scanEnd >= bytes.length - 1) {
          throw new Error(
            "jpegEntropyCodedBytes: truncated entropy-coded data (no terminating marker found).",
          );
        }
        let peek = scanEnd;
        while (bytes[peek + 1] === 0xff) peek += 1;
        const next = bytes[peek + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          scanEnd = peek + 2;
          continue;
        }
        scanEnd = peek;
        break;
      }
      parts.push(bytes.subarray(scanStart, scanEnd));
      offset = scanEnd;
      continue;
    }
    offset += 2 + length;
  }
  return Buffer.concat(parts);
}

/**
 * The JPEG suite's own `payloadDigests` callback for `runQualificationCase`
 * (mirrors `pngPayloadDigests`/`webpPayloadDigests`): the sha256 of every
 * scan's concatenated entropy-coded bytes, reported as one payload part
 * (`"ENTROPY"`) when the stream carries at least one SOS.
 */
export function jpegPayloadDigests(data: Buffer): readonly PayloadDigest[] {
  const entropy = jpegEntropyCodedBytes(data);
  return entropy.length === 0
    ? []
    : [{ part: "ENTROPY", sha256: digest(entropy) }];
}

// libjpeg-turbo runners (57-08, D-08). These build on
// `scripts/qualification/build-oracles.cjs`'s pinned, feature-asserted
// libjpeg-turbo 3.2.0 authority -- never on the handler's own
// `src/jpeg/parser.ts` -- so the payload-identity tests 57-09 adds compare
// against a genuinely independent decoder.

const SHA256 = /^[a-f0-9]{64}$/;

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;

interface ExecutableAuthority {
  readonly path: string;
  readonly sha256: string;
}

interface PreparedJpegOracleTools {
  readonly jpegDecode: ExecutableAuthority;
  readonly djpeg: ExecutableAuthority;
  readonly jpegtran: ExecutableAuthority;
  readonly rdjpgcom: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly prepareOracleTools: () => PreparedJpegOracleTools;
}

let preparedTools: PreparedJpegOracleTools | undefined;

function tools(): PreparedJpegOracleTools {
  preparedTools ??= authorityBuilder.prepareOracleTools();
  return preparedTools;
}

process.once("exit", () => preparedTools?.dispose());

/**
 * A binary-safe process runner (mirrors `png/oracles.ts`'s own
 * `executeBinary`): JPEG pixel and PNM bytes are arbitrary and would be
 * corrupted by the kit's UTF-8-decoding `execute`.
 */
function executeBinary(
  authority: ExecutableAuthority,
  args: readonly string[],
): {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
} {
  if (!SHA256.test(authority.sha256)) throw new Error("Invalid tool authority");
  const result = spawnSync(authority.path, args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error !== undefined) throw new Error("Oracle process failed");
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/**
 * Decodes `path` through the pinned libjpeg-turbo `jpeg_decode_oracle`
 * (raw component output -- see `scripts/qualification/jpeg_decode_oracle.c`)
 * and returns its exact `DIM ...` header line plus the sha256 of the raw
 * decoded scanline bytes. Rejects on any non-zero exit, the oracle's own
 * stderr included in the message.
 */
export async function jpegDecodePixels(
  path: string,
): Promise<{ readonly header: string; readonly pixelsSha256: string }> {
  const result = executeBinary(tools().jpegDecode, [path]);
  if (result.status !== 0)
    throw new Error(
      `jpegDecodePixels: oracle rejected input (${result.stderr.trim()})`,
    );
  const newline = result.stdout.indexOf(0x0a);
  if (newline < 0)
    throw new Error("jpegDecodePixels: oracle emitted an unknown transcript");
  const header = result.stdout.subarray(0, newline).toString("utf8");
  if (!header.startsWith("DIM "))
    throw new Error("jpegDecodePixels: oracle emitted an unknown transcript");
  const pixels = result.stdout.subarray(newline + 1);
  if (pixels.length === 0)
    throw new Error("jpegDecodePixels: oracle produced no pixel bytes");
  return { header, pixelsSha256: digest(pixels) };
}

/**
 * Decodes `path` to PNM through the pinned libjpeg-turbo `djpeg` (no
 * `-outfile`, so the PNM bytes are written to stdout per IJG convention).
 * Rejects on any non-zero exit, the oracle's own stderr included in the
 * message.
 */
export async function djpegPnm(path: string): Promise<Buffer> {
  const result = executeBinary(tools().djpeg, [path]);
  if (result.status !== 0)
    throw new Error(
      `djpegPnm: oracle rejected input (${result.stderr.trim()})`,
    );
  if (result.stdout.length === 0)
    throw new Error("djpegPnm: oracle produced no output");
  return result.stdout;
}

/**
 * Reads `path`'s JPEG comment (COM) segments through the pinned
 * libjpeg-turbo `rdjpgcom`. Rejects on any non-zero exit, the oracle's own
 * stderr included in the message.
 */
export async function rdjpgcomText(path: string): Promise<string> {
  const result = executeBinary(tools().rdjpgcom, [path]);
  if (result.status !== 0)
    throw new Error(
      `rdjpgcomText: oracle rejected input (${result.stderr.trim()})`,
    );
  return result.stdout.toString("utf8");
}

/**
 * JPG-03 payload identity (57-09 D-08): the five independent checks
 * `must_haves` truth 2 requires, run against a source file and a sanitized
 * output file already materialized on disk. Throws a labelled error on the
 * first mismatch so a failing assertion always names which of the five
 * checks fired.
 *
 * 1. Entropy-coded ranges byte-identical (this file's own `jpegEntropyCodedBytes`
 *    walker, independent of both `src/jpeg/parser.ts` and the pinned decoder).
 * 2. `jpeg_decode_oracle` reports an identical `DIM` header and an identical
 *    raw-pixel sha256 for source and output.
 * 3. `djpeg -pnm` output is identical for 1- and 3-component fixtures (the
 *    component count is read from the pixel oracle's own `DIM` header;
 *    other component counts, e.g. the 4-component CMYK/YCCK fixture, skip
 *    this check -- `djpeg`'s PNM writer has no CMYK output mode).
 * 4. `rdjpgcom` prints nothing for the output (no surviving COM segment).
 * 5. `jpegtran` re-reads the output with exit 0 (structural validity).
 */
export async function assertPayloadIdentity(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  const sourceBytes = await readFile(sourcePath);
  const outputBytes = await readFile(outputPath);

  const sourceEntropy = jpegEntropyCodedBytes(sourceBytes);
  const outputEntropy = jpegEntropyCodedBytes(outputBytes);
  if (!sourceEntropy.equals(outputEntropy)) {
    throw new Error(
      "assertPayloadIdentity: entropy-coded ranges differ between source and output",
    );
  }

  const sourceDecoded = await jpegDecodePixels(sourcePath);
  const outputDecoded = await jpegDecodePixels(outputPath);
  if (sourceDecoded.header !== outputDecoded.header) {
    throw new Error(
      `assertPayloadIdentity: pixel oracle DIM header differs (source "${sourceDecoded.header}" vs output "${outputDecoded.header}")`,
    );
  }
  if (sourceDecoded.pixelsSha256 !== outputDecoded.pixelsSha256) {
    throw new Error(
      "assertPayloadIdentity: pixel oracle raw-pixel sha256 differs between source and output",
    );
  }

  const componentsField = Number(sourceDecoded.header.split(" ")[3]);
  if (componentsField === 1 || componentsField === 3) {
    const sourcePnm = await djpegPnm(sourcePath);
    const outputPnm = await djpegPnm(outputPath);
    if (!sourcePnm.equals(outputPnm)) {
      throw new Error(
        "assertPayloadIdentity: djpeg -pnm output differs between source and output",
      );
    }
  }

  const comText = await rdjpgcomText(outputPath);
  if (comText.length !== 0) {
    throw new Error(
      `assertPayloadIdentity: rdjpgcom printed surviving COM text for the output ("${comText.trim()}")`,
    );
  }

  const jpegtranResult = executeBinary(tools().jpegtran, [outputPath]);
  if (jpegtranResult.status !== 0) {
    throw new Error(
      `assertPayloadIdentity: jpegtran failed to re-read the output (${jpegtranResult.stderr.trim()})`,
    );
  }
}
