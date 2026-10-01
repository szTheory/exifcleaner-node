import { IsobmffStructureError } from "./errors.js";

// Injectable resource caps (BMF-05). Each cap guards a distinct resource so each one can be
// removed alone in a negative control (61-CONTEXT.md): `maxMetaBytes` bounds the single `meta`
// read; `maxBoxCount` and `maxBoxDepth` bound the box walk itself; `maxBufferedBytesTotal`
// bounds every byte buffered from outside `meta` (Exif/XMP item payload reads, wired in 61-08).
// Mirrors `BufferedBudget`/`InflateBudget` (src/png/chunks.ts:548-571, 817-838): an injectable
// object checked against the *declared* size before the corresponding read or descent, never
// after.

export const ISOBMFF_MAX_META_BYTES = 16 * 1024 * 1024;
export const ISOBMFF_MAX_BOX_COUNT = 65_536;
export const ISOBMFF_MAX_BOX_DEPTH = 8;
export const ISOBMFF_MAX_BUFFERED_BYTES_TOTAL = 32 * 1024 * 1024;

export interface IsobmffCaps {
  readonly maxMetaBytes: number;
  readonly maxBoxCount: number;
  readonly maxBoxDepth: number;
  readonly maxBufferedBytesTotal: number;
}

export const DEFAULT_ISOBMFF_CAPS: IsobmffCaps = Object.freeze({
  maxMetaBytes: ISOBMFF_MAX_META_BYTES,
  maxBoxCount: ISOBMFF_MAX_BOX_COUNT,
  maxBoxDepth: ISOBMFF_MAX_BOX_DEPTH,
  maxBufferedBytesTotal: ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
});

/**
 * Running counters checked against an `IsobmffCaps` before the read/descent they guard. One
 * instance is threaded through an entire `parseIsobmff` call so box count and buffered bytes
 * accumulate across the whole file, not per-container.
 */
export class IsobmffBudget {
  readonly #caps: IsobmffCaps;
  #boxCount = 0;
  #bufferedBytes = 0;

  constructor(caps: IsobmffCaps = DEFAULT_ISOBMFF_CAPS) {
    this.#caps = caps;
  }

  /** Check a declared `meta` payload size before that payload is read into memory. */
  checkMetaSize(size: number): void {
    if (size > this.#caps.maxMetaBytes) {
      throw new IsobmffStructureError(
        "cap-meta-bytes",
        `meta payload size ${size} exceeds the ${this.#caps.maxMetaBytes}-byte cap.`,
        { cap: "maxMetaBytes", size, limit: this.#caps.maxMetaBytes },
      );
    }
  }

  /** Record one more box before it is recorded in a box list. */
  countBox(): void {
    this.#boxCount += 1;
    if (this.#boxCount > this.#caps.maxBoxCount) {
      throw new IsobmffStructureError(
        "cap-box-count",
        `box count ${this.#boxCount} exceeds the ${this.#caps.maxBoxCount} cap.`,
        {
          cap: "maxBoxCount",
          size: this.#boxCount,
          limit: this.#caps.maxBoxCount,
        },
      );
    }
  }

  /** Check a container descent's depth before descending into it. */
  checkDepth(depth: number): void {
    if (depth > this.#caps.maxBoxDepth) {
      throw new IsobmffStructureError(
        "cap-box-depth",
        `box nesting depth ${depth} exceeds the ${this.#caps.maxBoxDepth} cap.`,
        { cap: "maxBoxDepth", size: depth, limit: this.#caps.maxBoxDepth },
      );
    }
  }

  /** Check an aggregate buffered-byte total before buffering `n` more bytes (wired in 61-08). */
  consumeBuffered(n: number): void {
    const total = this.#bufferedBytes + n;
    if (total > this.#caps.maxBufferedBytesTotal) {
      throw new IsobmffStructureError(
        "cap-buffered-bytes",
        `aggregate buffered bytes ${total} exceeds the ${this.#caps.maxBufferedBytesTotal}-byte cap.`,
        {
          cap: "maxBufferedBytesTotal",
          size: total,
          limit: this.#caps.maxBufferedBytesTotal,
        },
      );
    }
    this.#bufferedBytes = total;
  }

  boxCount(): number {
    return this.#boxCount;
  }

  bufferedBytes(): number {
    return this.#bufferedBytes;
  }
}
