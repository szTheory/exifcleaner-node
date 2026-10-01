import type { FileHandle } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COPY_BLOCK_BYTES, copyRange } from "../src/io/copy-range.js";

interface ReadCall {
  readonly length: number;
  readonly position: number;
}

interface WriteCall {
  readonly offset: number;
  readonly length: number;
  readonly position: number;
}

function makeSource(
  data: Buffer,
  opts?: { readonly shortReadOnCall?: number },
) {
  const calls: ReadCall[] = [];
  let callIndex = 0;
  const handle = {
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      callIndex += 1;
      calls.push({ length, position });
      const bytesRead =
        opts?.shortReadOnCall === callIndex ? length - 1 : length;
      data.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
  } as unknown as FileHandle;
  return { handle, calls };
}

function makeDestination(
  size: number,
  opts?: {
    readonly zeroProgressOnCall?: number;
    readonly maxBytesPerWrite?: number;
    readonly onWrite?: (callIndex: number) => void;
  },
) {
  const out = Buffer.alloc(size);
  const calls: WriteCall[] = [];
  let callIndex = 0;
  const handle = {
    write: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      callIndex += 1;
      calls.push({ offset, length, position });
      if (opts?.zeroProgressOnCall === callIndex) {
        return { bytesWritten: 0, buffer };
      }
      const take = opts?.maxBytesPerWrite
        ? Math.min(opts.maxBytesPerWrite, length)
        : length;
      buffer.copy(out, position, offset, offset + take);
      const result = { bytesWritten: take, buffer };
      opts?.onWrite?.(callIndex);
      return result;
    },
  } as unknown as FileHandle;
  return { handle, calls, out };
}

describe("copyRange (KIT-11, D-21 fake-handle coverage)", () => {
  it("length 0 makes no read or write calls and returns position unchanged (control: length 1 makes one of each)", async () => {
    const src = makeSource(Buffer.alloc(10));
    const dst = makeDestination(10);
    const result = await copyRange(src.handle, dst.handle, 0, 0, 5);
    expect(result).toBe(5);
    expect(src.calls.length).toBe(0);
    expect(dst.calls.length).toBe(0);

    const src2 = makeSource(Buffer.from([7]));
    const dst2 = makeDestination(10);
    const result2 = await copyRange(src2.handle, dst2.handle, 0, 1, 5);
    expect(result2).toBe(6);
    expect(src2.calls.length).toBe(1);
    expect(dst2.calls.length).toBe(1);
  });

  it("copies a length spanning more than one block with exact bytes, and every read requests at most one block (COPY_BLOCK_BYTES * 2 + 17)", async () => {
    const length = COPY_BLOCK_BYTES * 2 + 17;
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i++) data[i] = i % 256;
    const position = 100;
    const src = makeSource(data);
    const dst = makeDestination(position + length);

    const result = await copyRange(src.handle, dst.handle, 0, length, position);

    expect(result).toBe(position + length);
    expect(dst.out.subarray(position, position + length).equals(data)).toBe(
      true,
    );
    for (const call of src.calls) {
      expect(call.length).toBeLessThanOrEqual(COPY_BLOCK_BYTES);
    }
    expect(src.calls.length).toBeGreaterThan(1);
  });

  it("rejects with 'Source changed or became truncated while copying.' on a short read on the second block (control: an unfaulted source copies identical bytes)", async () => {
    const length = COPY_BLOCK_BYTES * 2;
    const data = Buffer.alloc(length, 1);

    const faultySrc = makeSource(data, { shortReadOnCall: 2 });
    const faultyDst = makeDestination(length);
    await expect(
      copyRange(faultySrc.handle, faultyDst.handle, 0, length, 0),
    ).rejects.toThrow("Source changed or became truncated while copying.");

    const okSrc = makeSource(data);
    const okDst = makeDestination(length);
    const result = await copyRange(okSrc.handle, okDst.handle, 0, length, 0);
    expect(result).toBe(length);
    expect(okDst.out.equals(data)).toBe(true);
  });

  it("rejects with 'A file write made no progress.' when a write returns bytesWritten 0 (control: an unfaulted destination copies identical bytes)", async () => {
    const length = 100;
    const data = Buffer.alloc(length, 2);

    const faultySrc = makeSource(data);
    const faultyDst = makeDestination(length, { zeroProgressOnCall: 1 });
    await expect(
      copyRange(faultySrc.handle, faultyDst.handle, 0, length, 0),
    ).rejects.toThrow("A file write made no progress.");

    const okSrc = makeSource(data);
    const okDst = makeDestination(length);
    const result = await copyRange(okSrc.handle, okDst.handle, 0, length, 0);
    expect(result).toBe(length);
    expect(okDst.out.equals(data)).toBe(true);
  });

  it("produces exact bytes at exact positions when the destination writes at most 3 bytes per call (control: an unthrottled destination produces identical output)", async () => {
    const length = 37;
    const position = 5;
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i++) data[i] = (100 + i) % 256;

    const throttledSrc = makeSource(data);
    const throttledDst = makeDestination(position + length, {
      maxBytesPerWrite: 3,
    });
    const result = await copyRange(
      throttledSrc.handle,
      throttledDst.handle,
      0,
      length,
      position,
    );
    expect(result).toBe(position + length);
    expect(
      throttledDst.out.subarray(position, position + length).equals(data),
    ).toBe(true);
    expect(throttledDst.calls.length).toBeGreaterThan(1);

    const unthrottledSrc = makeSource(data);
    const unthrottledDst = makeDestination(position + length);
    await copyRange(
      unthrottledSrc.handle,
      unthrottledDst.handle,
      0,
      length,
      position,
    );
    expect(
      unthrottledDst.out.subarray(position, position + length).equals(data),
    ).toBe(true);
  });

  it("rejects with the signal's reason and issues no further read when aborted after the first write (control: an un-aborted signal completes)", async () => {
    const length = COPY_BLOCK_BYTES * 3;
    const data = Buffer.alloc(length, 3);
    const controller = new AbortController();
    const reason = new Error("aborted for test");

    const src = makeSource(data);
    const dst = makeDestination(length, {
      onWrite: (callIndex) => {
        if (callIndex === 1) controller.abort(reason);
      },
    });

    await expect(
      copyRange(src.handle, dst.handle, 0, length, 0, controller.signal),
    ).rejects.toBe(reason);
    expect(src.calls.length).toBe(1);
    expect(dst.calls.length).toBe(1);

    const okSrc = makeSource(data);
    const okDst = makeDestination(length);
    const okController = new AbortController();
    const result = await copyRange(
      okSrc.handle,
      okDst.handle,
      0,
      length,
      0,
      okController.signal,
    );
    expect(result).toBe(length);
    expect(okDst.out.equals(data)).toBe(true);
  });
});
