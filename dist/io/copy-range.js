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
export const COPY_BLOCK_BYTES = 64 * 1024;
function isAborted(signal) {
    return signal?.aborted ?? false;
}
export async function copyRange(source, destination, sourceOffset, length, position, signal) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BLOCK_BYTES, Math.max(length, 1)));
    let copied = 0;
    while (copied < length) {
        if (isAborted(signal))
            throw signal?.reason ?? new DOMException("Aborted", "AbortError");
        const take = Math.min(buffer.length, length - copied);
        const read = await source.read(buffer, 0, take, sourceOffset + copied);
        if (read.bytesRead !== take)
            throw new Error("Source changed or became truncated while copying.");
        let written = 0;
        while (written < take) {
            const result = await destination.write(buffer, written, take - written, position + copied + written);
            if (result.bytesWritten === 0)
                throw new Error("A file write made no progress.");
            written += result.bytesWritten;
        }
        copied += take;
    }
    return position + copied;
}
//# sourceMappingURL=copy-range.js.map