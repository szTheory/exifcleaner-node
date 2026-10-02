import type { FileHandle } from "node:fs/promises";
import { copyRange } from "../io/copy-range.js";
import type { IsobmffOutputPlan } from "./plan.js";

// ISOBMFF streaming writer (Phase 62, D-15). `writeIsobmffOutput` reads nothing but the plan and
// the source ranges the plan itself names -- it never imports the admission module or any
// item-graph type, so every byte it writes is traceable to (source, plan) alone (T-62-04).

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function writeAll(
  handle: FileHandle,
  data: Buffer,
  position: number,
): Promise<number> {
  let written = 0;
  while (written < data.length) {
    const next = await handle.write(
      data,
      written,
      data.length - written,
      position + written,
    );
    if (next.bytesWritten === 0)
      throw new Error("A file write made no progress.");
    written += next.bytesWritten;
  }
  return position + written;
}

export async function writeIsobmffOutput(
  source: FileHandle,
  destination: FileHandle,
  plan: IsobmffOutputPlan,
  signal?: AbortSignal,
): Promise<void> {
  let position = 0;
  for (const part of plan.parts) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    position =
      part.kind === "bytes"
        ? await writeAll(destination, part.data, position)
        : await copyRange(
            source,
            destination,
            part.sourceOffset,
            part.length,
            position,
            signal,
          );
  }
}
