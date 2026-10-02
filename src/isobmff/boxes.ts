import type { FileHandle } from "node:fs/promises";
import { IsobmffStructureError } from "./errors.js";
import type { IsobmffBudget } from "./caps.js";

// ISOBMFF box walker (BMF-01). Two parsing surfaces share one framing contract:
//   - `readTopLevelBoxes` reads box *headers only* directly from the file handle (8 or 16
//     bytes, plus 16 for a `uuid` usertype) -- it never buffers a box's payload, so an
//     arbitrarily large `mdat` costs one header read, not one allocation (RSS requirement,
//     61-04 Task 3).
//   - `parseBoxHeader`/`walkContainer` operate on an in-memory buffer (a container's payload
//     that the caller has already read once, e.g. `meta`'s payload after a `budget.checkMetaSize`
//     cap check) and recurse into the closed `CONTAINER_BOXES` set, depth-capped via `budget`.
// `size == 0` ("extends to end of file", ISO/IEC 14496-12 S4.2) is accepted only for the
// top-level `mdat` box, read via `readTopLevelBoxes` -- it is never legal inside any container,
// which both keeps the rule unambiguous (a container has no independent "end of file" to extend
// to) and makes `parseBoxHeader` reject it unconditionally.

const BASE_HEADER_BYTES = 8; // size(32) + type(32)
const LARGESIZE_BYTES = 8;
const USERTYPE_BYTES = 16;

function boxFramingError(message: string): IsobmffStructureError {
  return new IsobmffStructureError("box-framing", message);
}

export interface BoxHeader {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  /** Total box size (header + payload), in bytes. */
  readonly size: number;
  readonly payloadStart: number;
  readonly end: number;
  /** Only present when `type === "uuid"`; lower-case hex, 32 characters (16 bytes). */
  readonly usertype?: string;
}

/** The container box types this walker recurses into (61-CONTEXT.md). */
export const CONTAINER_BOXES: ReadonlySet<string> = new Set([
  "meta",
  "dinf",
  "iprp",
  "ipco",
  "grpl",
  "iinf",
  "iref",
]);

/**
 * How many bytes of a `CONTAINER_BOXES` member's payload precede its first child box. `meta` and
 * `iref` are a `FullBox` with children directly after the 4-byte version/flags field; `iinf` is a
 * `FullBox` with its own `entry_count` field (2 bytes for version 0, 4 bytes otherwise, per the
 * Grammar) between version/flags and its `infe` children; `dinf`/`iprp`/`ipco`/`grpl` are plain
 * boxes whose children start at byte 0 of the payload.
 */
function containerChildOffset(
  type: string,
  buffer: Buffer,
  payloadStart: number,
): number {
  if (type === "meta" || type === "iref") return 4;
  if (type === "iinf") {
    if (payloadStart >= buffer.length) {
      throw boxFramingError(
        `iinf payload is too short to carry its version byte at offset ${payloadStart}.`,
      );
    }
    const version = buffer.readUInt8(payloadStart);
    return version === 0 ? 4 + 2 : 4 + 4;
  }
  return 0;
}

export const TOP_LEVEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "ftyp",
  "meta",
  "mdat",
  "free",
  "skip",
]);

/** C2PA's registered `uuid` usertype (lower-case hex, no dashes), the one `uuid` box admitted at
 * the top level (D5) -- `d8fec3d6-1b0e-483c-9297-5828877ec481`. */
export const C2PA_UUID_USERTYPE = "d8fec3d61b0e483c92975828877ec481";

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
    if (next.bytesRead === 0) {
      throw boxFramingError(
        `Unexpected end of file at offset ${position + read}.`,
      );
    }
    read += next.bytesRead;
  }
  return result;
}

/**
 * Decode an ISOBMFF box header from an in-memory buffer at `offset`, bounded by `end` (the
 * enclosing container's end, exclusive of anything past it). `size == 0` is never legal here
 * (reserved for the top-level `mdat` box, via `readTopLevelBoxes`).
 */
export function parseBoxHeader(
  buffer: Buffer,
  offset: number,
  end: number,
): BoxHeader {
  if (offset + BASE_HEADER_BYTES > end) {
    throw boxFramingError(`Box header at offset ${offset} is truncated.`);
  }

  const declaredSize = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);

  let headerSize = BASE_HEADER_BYTES;
  let totalSize: number;

  if (declaredSize === 0) {
    throw boxFramingError(
      `Box "${type}" at offset ${offset} declares size 0, which is only permitted for the top-level mdat box.`,
    );
  } else if (declaredSize === 1) {
    if (offset + BASE_HEADER_BYTES + LARGESIZE_BYTES > end) {
      throw boxFramingError(
        `Box "${type}" at offset ${offset} is missing its largesize field.`,
      );
    }
    const largesize = buffer.readBigUInt64BE(offset + BASE_HEADER_BYTES);
    headerSize = BASE_HEADER_BYTES + LARGESIZE_BYTES;
    if (largesize < BigInt(headerSize)) {
      throw boxFramingError(
        `Box "${type}" at offset ${offset} has a largesize smaller than its own header.`,
      );
    }
    if (largesize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw boxFramingError(
        `Box "${type}" at offset ${offset} has a largesize beyond safe integer precision.`,
      );
    }
    totalSize = Number(largesize);
  } else if (declaredSize < BASE_HEADER_BYTES) {
    throw boxFramingError(
      `Box "${type}" at offset ${offset} declares size ${declaredSize}, smaller than the 8-byte box header.`,
    );
  } else {
    totalSize = declaredSize;
  }

  let usertype: string | undefined;
  let payloadStart = offset + headerSize;
  if (type === "uuid") {
    if (payloadStart + USERTYPE_BYTES > end) {
      throw boxFramingError(
        `uuid box at offset ${offset} is missing its usertype field.`,
      );
    }
    usertype = buffer.toString(
      "hex",
      payloadStart,
      payloadStart + USERTYPE_BYTES,
    );
    headerSize += USERTYPE_BYTES;
    payloadStart += USERTYPE_BYTES;
  }

  const boxEnd = offset + totalSize;
  if (boxEnd > end) {
    throw boxFramingError(
      `Box "${type}" at offset ${offset} extends past its parent's end.`,
    );
  }
  if (boxEnd < payloadStart) {
    throw boxFramingError(
      `Box "${type}" at offset ${offset} declares a size smaller than its own header.`,
    );
  }

  return {
    type,
    start: offset,
    headerSize,
    size: totalSize,
    payloadStart,
    end: boxEnd,
    ...(usertype !== undefined ? { usertype } : {}),
  };
}

async function readTopLevelBoxHeaderAt(
  handle: FileHandle,
  position: number,
  fileSize: number,
): Promise<BoxHeader> {
  if (position + BASE_HEADER_BYTES > fileSize) {
    throw boxFramingError(`Box header at offset ${position} is truncated.`);
  }

  const header = await readExactly(handle, BASE_HEADER_BYTES, position);
  const declaredSize = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);

  let headerSize = BASE_HEADER_BYTES;
  let totalSize: number;

  if (declaredSize === 0) {
    if (type !== "mdat") {
      throw boxFramingError(
        `Box "${type}" at offset ${position} declares size 0, which is only permitted for the top-level mdat box.`,
      );
    }
    totalSize = fileSize - position;
  } else if (declaredSize === 1) {
    if (position + BASE_HEADER_BYTES + LARGESIZE_BYTES > fileSize) {
      throw boxFramingError(
        `Box "${type}" at offset ${position} is missing its largesize field.`,
      );
    }
    const largesizeBuffer = await readExactly(
      handle,
      LARGESIZE_BYTES,
      position + BASE_HEADER_BYTES,
    );
    const largesize = largesizeBuffer.readBigUInt64BE(0);
    headerSize = BASE_HEADER_BYTES + LARGESIZE_BYTES;
    if (largesize < BigInt(headerSize)) {
      throw boxFramingError(
        `Box "${type}" at offset ${position} has a largesize smaller than its own header.`,
      );
    }
    if (largesize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw boxFramingError(
        `Box "${type}" at offset ${position} has a largesize beyond safe integer precision.`,
      );
    }
    totalSize = Number(largesize);
  } else if (declaredSize < BASE_HEADER_BYTES) {
    throw boxFramingError(
      `Box "${type}" at offset ${position} declares size ${declaredSize}, smaller than the 8-byte box header.`,
    );
  } else {
    totalSize = declaredSize;
  }

  let usertype: string | undefined;
  let payloadStart = position + headerSize;
  if (type === "uuid") {
    if (payloadStart + USERTYPE_BYTES > fileSize) {
      throw boxFramingError(
        `uuid box at offset ${position} is missing its usertype field.`,
      );
    }
    const usertypeBuffer = await readExactly(
      handle,
      USERTYPE_BYTES,
      payloadStart,
    );
    usertype = usertypeBuffer.toString("hex");
    headerSize += USERTYPE_BYTES;
    payloadStart += USERTYPE_BYTES;
  }

  const end = position + totalSize;
  if (end > fileSize) {
    throw boxFramingError(
      `Box "${type}" at offset ${position} extends past the end of the file.`,
    );
  }
  if (end < payloadStart) {
    throw boxFramingError(
      `Box "${type}" at offset ${position} declares a size smaller than its own header.`,
    );
  }

  return {
    type,
    start: position,
    headerSize,
    size: totalSize,
    payloadStart,
    end,
    ...(usertype !== undefined ? { usertype } : {}),
  };
}

/**
 * Read every top-level box's header (never its payload) from `handle`, bounded by `fileSize`.
 * `budget.countBox()` is checked before each header is recorded (BMF-05: declared values are
 * checked before the read/descent they guard, not after). The first box must be `ftyp`.
 */
export async function readTopLevelBoxes(
  handle: FileHandle,
  fileSize: number,
  budget: IsobmffBudget,
): Promise<readonly BoxHeader[]> {
  const boxes: BoxHeader[] = [];
  let position = 0;
  while (position < fileSize) {
    budget.countBox();
    const header = await readTopLevelBoxHeaderAt(handle, position, fileSize);
    boxes.push(header);
    position = header.end;
  }
  const first = boxes[0];
  if (first === undefined || first.type !== "ftyp") {
    throw boxFramingError('The first top-level box is not "ftyp".');
  }
  return boxes;
}

/**
 * Walk an in-memory container's children (`start`..`end` within `buffer`), checking
 * `budget.checkDepth(depth)` before processing this level and `budget.countBox()` before each
 * child is recorded. Recurses into any child whose type is in `CONTAINER_BOXES`, skipping the
 * 4-byte version/flags field first for `FULLBOX_CONTAINERS` members -- this walks structure only
 * (box framing, count, depth); per-box grammar (`iinf`'s `infe` entries, `iref`'s reference
 * records, etc.) is resolved by later plans.
 */
export function walkContainer(
  buffer: Buffer,
  start: number,
  end: number,
  depth: number,
  budget: IsobmffBudget,
): readonly BoxHeader[] {
  budget.checkDepth(depth);
  const boxes: BoxHeader[] = [];
  let position = start;
  while (position < end) {
    budget.countBox();
    const header = parseBoxHeader(buffer, position, end);
    boxes.push(header);
    if (CONTAINER_BOXES.has(header.type)) {
      const childStart =
        header.payloadStart +
        containerChildOffset(header.type, buffer, header.payloadStart);
      walkContainer(buffer, childStart, header.end, depth + 1, budget);
    }
    position = header.end;
  }
  return boxes;
}
