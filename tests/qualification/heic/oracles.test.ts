// HEIC ExifTool differential profile tests (62.1-05, D-27, QUA-01). Still unregistered (D-03) --
// native output is produced only through the `setRegisteredHandlersForTests` test seam, never a
// real registered handler.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { setRegisteredHandlersForTests } from "../../../src/admission/registry.js";
import { sanitizeFile } from "../../../src/engine.js";
import { createIsobmffWriterHandlerForTests } from "../../isobmff-support/test-handler.js";
import { runIsobmffDifferential } from "../../isobmff-support/differential.js";
import { heicDifferentialProfile } from "./oracles.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");
const LINUX_X64 = process.platform === "linux" && process.arch === "x64";

interface Preservation {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
  readonly preserveResolution: boolean;
}

const DEFAULT_PRESERVATION: Preservation = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
};

/**
 * Produces a native output for `sourceBytes` through the real, registered writer handler
 * (`createIsobmffWriterHandlerForTests`, never a stub) -- the exact engine path 62-05/62-12
 * already exercise -- with `preservation` applied. Mirrors
 * `tests/isobmff_decode_oracle.test.ts`'s own `produceNativeOutput`, generalized to take raw
 * bytes rather than a fixture path so this suite can build its own synthetic sources.
 */
async function produceNativeOutput(
  sourceBytes: Buffer,
  preservation: Preservation,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-heic-oracles-"));
  try {
    const sourcePath = join(directory, "source.heic");
    await writeFile(sourcePath, sourceBytes);
    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("heic"),
    ]);
    try {
      const destinationPath = join(directory, "destination.heic");
      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...preservation,
      });
      if (!result.ok) {
        throw new Error(
          `produceNativeOutput: sanitizeFile failed: ${result.error.code}`,
        );
      }
      return await readFile(destinationPath);
    } finally {
      restore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("HEIC differential (62.1-05)", () => {
  it.runIf(LINUX_X64)(
    "sanitizes heif-enc-grid.heic through the seam with default settings and passes the ExifTool differential (62.1-05)",
    async () => {
      const source = await readFile(HEIC_FIXTURE);
      const output = await produceNativeOutput(source, DEFAULT_PRESERVATION);
      runIsobmffDifferential({
        caseId: "heic-default-settings",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: DEFAULT_PRESERVATION.preserveOrientation,
        preserveColorProfile: DEFAULT_PRESERVATION.preserveColorProfile,
        preserveResolution: DEFAULT_PRESERVATION.preserveResolution,
      });
    },
    30_000,
  );
});
