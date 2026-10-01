import type { FileHandle } from "node:fs/promises";
/**
 * KIT-11: the single bounded block-copy helper shared by every format
 * handler that moves source bytes into a destination file handle. One call
 * copies exactly one contiguous range (`[sourceOffset, sourceOffset +
 * length)`) to `position` in the destination -- there is no multi-extent
 * API here (D-18); a caller that needs to copy several ranges calls this
 * once per range. Writes go only through `destination.write` (no `writev`,
 * no direct fd access), so the existing during-bounded-copy fault-injection
 * tests keep working unchanged.
 */
export declare const COPY_BLOCK_BYTES: number;
export declare function copyRange(source: FileHandle, destination: FileHandle, sourceOffset: number, length: number, position: number, signal?: AbortSignal): Promise<number>;
//# sourceMappingURL=copy-range.d.ts.map