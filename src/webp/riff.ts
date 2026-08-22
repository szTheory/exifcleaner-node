import type { FileHandle } from "node:fs/promises";

export const RIFF_HEADER_SIZE = 12;
export const MAX_BUFFERED_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_CHUNK_COUNT = 10_000;
export const MAX_RIFF_BYTES = 0xffff_fffe;
export const COPY_BLOCK_BYTES = 64 * 1024;

const KNOWN_CHUNKS = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
  "EXIF",
  "XMP ",
]);
const SINGLETON_CHUNKS = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ICCP",
  "EXIF",
  "XMP ",
]);

export class WebpStructureError extends Error {
  readonly kind: "unsupported-format" | "malformed-file" | "unsafe-structure";

  constructor(
    kind: "unsupported-format" | "malformed-file" | "unsafe-structure",
    message: string,
  ) {
    super(message);
    this.name = "WebpStructureError";
    this.kind = kind;
  }
}

export interface WebpChunk {
  readonly fourCc: string;
  readonly headerOffset: number;
  readonly dataOffset: number;
  readonly size: number;
  readonly paddedSize: number;
  readonly metadata?: Buffer;
}

export interface ParsedWebp {
  readonly fileSize: number;
  readonly chunks: readonly WebpChunk[];
  readonly vp8x?: {
    readonly chunk: WebpChunk;
    readonly data: Buffer;
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export async function readExactly(
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
    if (next.bytesRead === 0)
      throw new WebpStructureError("malformed-file", "Unexpected end of file.");
    read += next.bytesRead;
  }
  return result;
}

function metadataFlag(fourCc: string): number {
  if (fourCc === "ICCP") return 0x20;
  if (fourCc === "EXIF") return 0x08;
  if (fourCc === "XMP ") return 0x04;
  return 0;
}

function chunkRank(fourCc: string): number {
  if (fourCc === "VP8X") return 0;
  if (fourCc === "ICCP") return 1;
  if (fourCc === "ANIM") return 2;
  if (
    fourCc === "ALPH" ||
    fourCc === "VP8 " ||
    fourCc === "VP8L" ||
    fourCc === "ANMF"
  )
    return 3;
  return -1;
}

interface ImageInfo {
  readonly fourCc: "VP8 " | "VP8L";
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

function readUInt24LE(data: Buffer, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16)
  );
}

async function validateImagePayload(
  handle: FileHandle,
  chunk: WebpChunk,
): Promise<ImageInfo> {
  if (chunk.fourCc === "VP8 ") {
    if (chunk.size < 10) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8 image payload is shorter than its key-frame header.",
      );
    }
    const header = await readExactly(handle, 10, chunk.dataOffset);
    if (((header[0] ?? 0) & 0x01) !== 0) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8 WebP payload must begin with a key frame.",
      );
    }
    if (header[3] !== 0x9d || header[4] !== 0x01 || header[5] !== 0x2a) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8 key-frame signature is invalid.",
      );
    }
    const width = header.readUInt16LE(6) & 0x3fff;
    const height = header.readUInt16LE(8) & 0x3fff;
    if (width === 0 || height === 0) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8 image dimensions must be non-zero.",
      );
    }
    return { fourCc: "VP8 ", width, height, hasAlpha: false };
  }

  if (chunk.size < 5) {
    throw new WebpStructureError(
      "malformed-file",
      "VP8L image payload is shorter than its header.",
    );
  }
  const header = await readExactly(handle, 5, chunk.dataOffset);
  if (header[0] !== 0x2f) {
    throw new WebpStructureError(
      "malformed-file",
      "VP8L signature is invalid.",
    );
  }
  const bits = header.readUInt32LE(1);
  if (bits >>> 29 !== 0) {
    throw new WebpStructureError(
      "malformed-file",
      "VP8L version bits are unsupported.",
    );
  }
  return {
    fourCc: "VP8L",
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    hasAlpha: ((bits >>> 28) & 1) === 1,
  };
}

async function validateAlphaPayload(
  handle: FileHandle,
  chunk: WebpChunk,
  width: number,
  height: number,
): Promise<void> {
  if (chunk.size < 2) {
    throw new WebpStructureError(
      "malformed-file",
      "ALPH payload is shorter than its header and image data.",
    );
  }
  const header = (await readExactly(handle, 1, chunk.dataOffset))[0] ?? 0;
  const compression = header & 0x03;
  const preprocessing = (header >>> 4) & 0x03;
  if ((header & 0xc0) !== 0 || compression > 1 || preprocessing > 1) {
    throw new WebpStructureError(
      "malformed-file",
      "ALPH header contains reserved or unsupported values.",
    );
  }
  if (compression === 0 && chunk.size !== 1 + width * height) {
    throw new WebpStructureError(
      "malformed-file",
      "Uncompressed ALPH data does not match the image dimensions.",
    );
  }
}

async function validateAnimationFrame(
  handle: FileHandle,
  frame: WebpChunk,
  canvasWidth: number,
  canvasHeight: number,
  incrementChunkCount: () => void,
): Promise<boolean> {
  if (frame.size < 16) {
    throw new WebpStructureError(
      "malformed-file",
      "ANMF payload is shorter than its 16-byte frame header.",
    );
  }
  const header = await readExactly(handle, 16, frame.dataOffset);
  if (((header[15] ?? 0) & 0xfc) !== 0) {
    throw new WebpStructureError(
      "malformed-file",
      "ANMF frame header contains non-zero reserved bits.",
    );
  }
  const x = readUInt24LE(header, 0) * 2;
  const y = readUInt24LE(header, 3) * 2;
  const width = readUInt24LE(header, 6) + 1;
  const height = readUInt24LE(header, 9) + 1;
  if (x + width > canvasWidth || y + height > canvasHeight) {
    throw new WebpStructureError(
      "malformed-file",
      "ANMF frame dimensions exceed the VP8X canvas.",
    );
  }

  const nested: WebpChunk[] = [];
  const seen = new Set<string>();
  const frameEnd = frame.dataOffset + frame.size;
  let offset = frame.dataOffset + 16;
  while (offset < frameEnd) {
    if (frameEnd - offset < 8) {
      throw new WebpStructureError(
        "malformed-file",
        "ANMF contains trailing bytes instead of a nested chunk header.",
      );
    }
    incrementChunkCount();
    const chunkHeader = await readExactly(handle, 8, offset);
    const fourCc = chunkHeader.toString("ascii", 0, 4);
    if (fourCc !== "ALPH" && fourCc !== "VP8 " && fourCc !== "VP8L") {
      throw new WebpStructureError(
        "unsafe-structure",
        `Unknown nested ANMF chunk ${JSON.stringify(fourCc)} cannot be sanitized safely.`,
      );
    }
    if (seen.has(fourCc)) {
      throw new WebpStructureError(
        "unsafe-structure",
        `Duplicate nested ${fourCc.trim()} chunk is ambiguous.`,
      );
    }
    seen.add(fourCc);
    const size = chunkHeader.readUInt32LE(4);
    const paddedSize = size + (size & 1);
    const dataOffset = offset + 8;
    if (dataOffset > frameEnd - paddedSize) {
      throw new WebpStructureError(
        "malformed-file",
        `${fourCc.trim()} chunk exceeds ANMF bounds.`,
      );
    }
    if ((size & 1) === 1) {
      const padding = await readExactly(handle, 1, dataOffset + size);
      if (padding[0] !== 0) {
        throw new WebpStructureError(
          "malformed-file",
          `${fourCc.trim()} chunk in ANMF has non-zero padding.`,
        );
      }
    }
    nested.push({
      fourCc,
      headerOffset: offset,
      dataOffset,
      size,
      paddedSize,
    });
    offset = dataOffset + paddedSize;
  }

  const images = nested.filter(
    (chunk) => chunk.fourCc === "VP8 " || chunk.fourCc === "VP8L",
  );
  if (images.length !== 1) {
    throw new WebpStructureError(
      "malformed-file",
      "ANMF must contain exactly one VP8 or VP8L image chunk.",
    );
  }
  const image = await validateImagePayload(handle, images[0]!);
  if (image.width !== width || image.height !== height) {
    throw new WebpStructureError(
      "malformed-file",
      "ANMF frame dimensions do not match its image payload.",
    );
  }
  const alpha = nested.find((chunk) => chunk.fourCc === "ALPH");
  if (alpha !== undefined) {
    if (nested.length !== 2 || nested[0] !== alpha || image.fourCc !== "VP8 ") {
      throw new WebpStructureError(
        "unsafe-structure",
        "Nested ALPH must immediately precede one VP8 image chunk.",
      );
    }
    await validateAlphaPayload(handle, alpha, width, height);
  } else if (nested[0] !== images[0]) {
    throw new WebpStructureError(
      "unsafe-structure",
      "ANMF nested image chunks occur in an ambiguous order.",
    );
  }
  return alpha !== undefined || image.hasAlpha;
}

export async function parseWebp(
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
): Promise<ParsedWebp> {
  if (isAborted(signal))
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  if (!Number.isSafeInteger(fileSize) || fileSize < RIFF_HEADER_SIZE) {
    throw new WebpStructureError(
      "unsupported-format",
      "File is too small to be a WebP RIFF container.",
    );
  }
  if (fileSize > MAX_RIFF_BYTES) {
    throw new WebpStructureError(
      "unsafe-structure",
      "WebP RIFF size exceeds the 32-bit container limit.",
    );
  }
  const header = await readExactly(handle, RIFF_HEADER_SIZE, 0);
  if (
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new WebpStructureError(
      "unsupported-format",
      "File magic is not RIFF/WEBP.",
    );
  }
  const declaredFileSize = header.readUInt32LE(4) + 8;
  if (declaredFileSize !== fileSize) {
    const reason =
      declaredFileSize < fileSize ? "trailing data" : "truncated data";
    throw new WebpStructureError(
      "malformed-file",
      `RIFF size does not match the file size (${reason}).`,
    );
  }

  const chunks: WebpChunk[] = [];
  const seen = new Set<string>();
  let chunkCount = 0;
  const incrementChunkCount = (): void => {
    chunkCount += 1;
    if (chunkCount > MAX_CHUNK_COUNT) {
      throw new WebpStructureError(
        "unsafe-structure",
        `WebP contains more than ${MAX_CHUNK_COUNT} chunks.`,
      );
    }
  };
  let offset = RIFF_HEADER_SIZE;
  while (offset < fileSize) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    if (fileSize - offset < 8) {
      throw new WebpStructureError(
        "malformed-file",
        "RIFF chunk header is truncated.",
      );
    }
    incrementChunkCount();
    const chunkHeader = await readExactly(handle, 8, offset);
    const fourCc = chunkHeader.toString("ascii", 0, 4);
    const size = chunkHeader.readUInt32LE(4);
    if (!KNOWN_CHUNKS.has(fourCc)) {
      throw new WebpStructureError(
        "unsafe-structure",
        `Unknown WebP chunk ${JSON.stringify(fourCc)} cannot be sanitized safely.`,
      );
    }
    if (SINGLETON_CHUNKS.has(fourCc) && seen.has(fourCc)) {
      throw new WebpStructureError(
        "unsafe-structure",
        `Duplicate ${fourCc.trim()} chunk is ambiguous.`,
      );
    }
    if (metadataFlag(fourCc) !== 0 && size > MAX_BUFFERED_METADATA_BYTES) {
      throw new WebpStructureError(
        "unsafe-structure",
        `${fourCc.trim()} metadata exceeds the ${MAX_BUFFERED_METADATA_BYTES}-byte inspection limit.`,
      );
    }
    seen.add(fourCc);
    const paddedSize = size + (size & 1);
    const dataOffset = offset + 8;
    if (dataOffset > fileSize - paddedSize) {
      throw new WebpStructureError(
        "malformed-file",
        `${fourCc.trim()} chunk exceeds RIFF bounds.`,
      );
    }
    if ((size & 1) === 1) {
      const padding = await readExactly(handle, 1, dataOffset + size);
      if (padding[0] !== 0) {
        throw new WebpStructureError(
          "malformed-file",
          `${fourCc.trim()} chunk has non-zero padding.`,
        );
      }
    }
    let metadata: Buffer | undefined;
    if (metadataFlag(fourCc) !== 0) {
      metadata = await readExactly(handle, size, dataOffset);
    }
    chunks.push(
      metadata === undefined
        ? { fourCc, headerOffset: offset, dataOffset, size, paddedSize }
        : {
            fourCc,
            headerOffset: offset,
            dataOffset,
            size,
            paddedSize,
            metadata,
          },
    );
    offset = dataOffset + paddedSize;
  }
  if (offset !== fileSize) {
    throw new WebpStructureError(
      "malformed-file",
      "RIFF chunks do not end at the declared boundary.",
    );
  }

  const vp8xChunk = chunks.find((chunk) => chunk.fourCc === "VP8X");
  let vp8x: ParsedWebp["vp8x"];
  if (vp8xChunk !== undefined) {
    if (chunks[0] !== vp8xChunk || vp8xChunk.size !== 10) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8X must be the first chunk and contain 10 bytes.",
      );
    }
    const data = await readExactly(handle, 10, vp8xChunk.dataOffset);
    if (
      ((data[0] ?? 0) & 0xc1) !== 0 ||
      (data[1] ?? 0) !== 0 ||
      (data[2] ?? 0) !== 0 ||
      (data[3] ?? 0) !== 0
    ) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8X reserved bits or bytes are non-zero.",
      );
    }
    vp8x = { chunk: vp8xChunk, data };
  }

  let canvasWidth: number | undefined;
  let canvasHeight: number | undefined;
  if (vp8x !== undefined) {
    canvasWidth = readUInt24LE(vp8x.data, 4) + 1;
    canvasHeight = readUInt24LE(vp8x.data, 7) + 1;
    if (canvasWidth * canvasHeight > 0xffff_ffff) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8X canvas area exceeds the 32-bit WebP limit.",
      );
    }
  }

  const hasStillImage = seen.has("VP8 ") || seen.has("VP8L");
  const hasAnimationFrames = chunks.some((chunk) => chunk.fourCc === "ANMF");
  if (seen.has("VP8 ") && seen.has("VP8L")) {
    throw new WebpStructureError(
      "unsafe-structure",
      "Container has both VP8 and VP8L image payloads.",
    );
  }
  if (!hasStillImage && !hasAnimationFrames) {
    throw new WebpStructureError(
      "malformed-file",
      "WebP container has no image or animation frame payload.",
    );
  }
  if (hasAnimationFrames !== seen.has("ANIM")) {
    throw new WebpStructureError(
      "malformed-file",
      "ANIM and ANMF chunks must occur together.",
    );
  }
  if ((seen.has("ANIM") || seen.has("ANMF")) && vp8x === undefined) {
    throw new WebpStructureError(
      "malformed-file",
      "Animated WebP requires a VP8X chunk.",
    );
  }
  if (hasStillImage && hasAnimationFrames) {
    throw new WebpStructureError(
      "unsafe-structure",
      "Container mixes top-level still-image and animation payloads.",
    );
  }
  const anim = chunks.find((chunk) => chunk.fourCc === "ANIM");
  if (anim !== undefined && anim.size !== 6) {
    throw new WebpStructureError(
      "malformed-file",
      "ANIM chunk must contain exactly 6 bytes.",
    );
  }
  const alphaIndex = chunks.findIndex((chunk) => chunk.fourCc === "ALPH");
  if (
    alphaIndex >= 0 &&
    (chunks[alphaIndex + 1]?.fourCc !== "VP8 " || vp8x === undefined)
  ) {
    throw new WebpStructureError(
      "malformed-file",
      "ALPH must immediately precede VP8 in an extended WebP container.",
    );
  }
  let previousRank = -1;
  for (const chunk of chunks) {
    const rank = chunkRank(chunk.fourCc);
    if (rank < 0) continue;
    if (rank < previousRank) {
      throw new WebpStructureError(
        "unsafe-structure",
        `WebP chunk ${chunk.fourCc.trim()} occurs in an ambiguous order.`,
      );
    }
    previousRank = rank;
  }

  let actualAlpha = false;
  if (hasStillImage) {
    const imageChunk = chunks.find(
      (chunk) => chunk.fourCc === "VP8 " || chunk.fourCc === "VP8L",
    );
    const image = await validateImagePayload(handle, imageChunk!);
    if (
      canvasWidth !== undefined &&
      canvasHeight !== undefined &&
      (image.width !== canvasWidth || image.height !== canvasHeight)
    ) {
      throw new WebpStructureError(
        "malformed-file",
        "Image dimensions do not match the VP8X canvas.",
      );
    }
    if (alphaIndex >= 0) {
      await validateAlphaPayload(
        handle,
        chunks[alphaIndex]!,
        image.width,
        image.height,
      );
      actualAlpha = true;
    } else {
      actualAlpha = image.hasAlpha;
    }
  } else if (hasAnimationFrames) {
    for (const frame of chunks.filter((chunk) => chunk.fourCc === "ANMF")) {
      actualAlpha =
        (await validateAnimationFrame(
          handle,
          frame,
          canvasWidth!,
          canvasHeight!,
          incrementChunkCount,
        )) || actualAlpha;
    }
  }

  const hasMetadata = seen.has("ICCP") || seen.has("EXIF") || seen.has("XMP ");
  if (hasMetadata && vp8x === undefined) {
    throw new WebpStructureError(
      "malformed-file",
      "WebP metadata chunks require a VP8X chunk.",
    );
  }
  if (vp8x !== undefined) {
    const flags = vp8x.data[0] ?? 0;
    for (const fourCc of ["ICCP", "EXIF", "XMP "] as const) {
      const flagPresent = (flags & metadataFlag(fourCc)) !== 0;
      if (flagPresent !== seen.has(fourCc)) {
        throw new WebpStructureError(
          "malformed-file",
          `VP8X ${fourCc.trim()} flag does not match the chunk table.`,
        );
      }
    }
    const animationFlag = (flags & 0x02) !== 0;
    if (animationFlag !== hasAnimationFrames) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8X animation flag does not match animation chunks.",
      );
    }
    if (((flags & 0x10) !== 0) !== actualAlpha) {
      throw new WebpStructureError(
        "malformed-file",
        "VP8X alpha flag does not match the image payloads.",
      );
    }
  }

  return vp8x === undefined ? { fileSize, chunks } : { fileSize, chunks, vp8x };
}

export function encodeChunkHeader(fourCc: string, size: number): Buffer {
  const header = Buffer.allocUnsafe(8);
  header.write(fourCc, 0, 4, "ascii");
  header.writeUInt32LE(size, 4);
  return header;
}

export function encodeRiffHeader(fileSize: number): Buffer {
  if (fileSize < RIFF_HEADER_SIZE || fileSize > MAX_RIFF_BYTES) {
    throw new RangeError("Output cannot be represented as a RIFF container");
  }
  const header = Buffer.allocUnsafe(RIFF_HEADER_SIZE);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WEBP", 8, 4, "ascii");
  return header;
}
