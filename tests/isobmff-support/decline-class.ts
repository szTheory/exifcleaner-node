// The engine's internal decline class for a HEIC/AVIF source (62.1-08, D-25).
//
// The public sanitize error carries only `code`/`nativeWrite`, never the internal
// `IsobmffDeclineClass`, so the corpus tracer suites read the class here and hand it to the kit's
// `readDeclineClass` option, which compares it to a refused record's pinned `declineClass`. This
// module deliberately imports the engine (`src/isobmff/`): it reports what the engine decides, it
// is not an independent oracle, and it carries no `ISOLATION_RULES` entry for that reason.
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitIsobmff } from "../../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../../src/isobmff/brand.js";
import {
  ISOBMFF_DECLINE_CLASSES,
  IsobmffStructureError,
} from "../../src/isobmff/errors.js";

/**
 * The pinned class for a file the brand selector declines before any handler admits it (the
 * public error is `unsupported-format`; no `IsobmffStructureError` is ever raised).
 */
export const SELECTION_DECLINE = "selection-decline";

/** Every class a HEIC/AVIF record may pin: the engine's closed set plus the selector decline. */
export const PINNABLE_DECLINE_CLASSES: ReadonlySet<string> = new Set([
  ...ISOBMFF_DECLINE_CLASSES,
  SELECTION_DECLINE,
]);

/**
 * `selection-decline` when `classifyIsobmffBrand` declines; otherwise the
 * `IsobmffStructureError.declineClass` that `admitIsobmff` raises, or `undefined` when it admits.
 * Any other error is rethrown: an unexpected failure is never reported as a decline class.
 */
export async function isobmffDeclineClassOf(
  bytes: Buffer,
): Promise<string | undefined> {
  if (classifyIsobmffBrand(bytes) === "decline") return SELECTION_DECLINE;
  const directory = await mkdtemp(join(tmpdir(), "isobmff-decline-class-"));
  try {
    const path = join(directory, "source.bin");
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      await admitIsobmff(handle, bytes.length);
      return undefined;
    } catch (error) {
      if (error instanceof IsobmffStructureError) return error.declineClass;
      throw error;
    } finally {
      await handle.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
