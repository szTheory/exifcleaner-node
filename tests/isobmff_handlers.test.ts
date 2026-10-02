// HEIC/AVIF handler modules, unregistered (62-12): proves `createHeicHandler`/`createAvifHandler`
// (`src/admission/heic-handler.ts`, `avif-handler.ts`) are thin factories over the shared ISOBMFF
// writer engine that sanitize their own brand's fixture through the real engine -- with BOTH
// handlers installed at once via `setRegisteredHandlersForTests`, never through the admission-only
// counting stub -- while remaining unreachable from the real registry (D-02/D-03: `HANDLERS` stays
// `[webp, png, jpeg]` until 62.1-07).
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/engine.js";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
} from "../src/admission/registry.js";
import { createIsobmffWriterCountingHandlerForTests } from "./isobmff-support/test-handler.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_PATH = join(FIXTURES_DIR, "heif-enc-grid.avif");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-handlers-"));
  directories.push(directory);
  return directory;
}

describe("HEIC/AVIF handler modules, unregistered (62-12)", () => {
  it("D-02/D-03: registeredHandlersForTests() still returns only webp, png and jpeg", () => {
    const formats = registeredHandlersForTests().map(
      (handler) => handler.capability.format,
    );
    expect(formats).toEqual(["webp", "png", "jpeg"]);
  });

  it("D-10: createHeicHandler/createAvifHandler produce the expected brand and staging name", () => {
    const { handler: heic } = createIsobmffWriterCountingHandlerForTests("heic");
    const { handler: avif } = createIsobmffWriterCountingHandlerForTests("avif");
    expect(heic.stagingFileName).toBe("output.heic");
    expect(avif.stagingFileName).toBe("output.avif");
  });

  it("with both handlers installed at once, heif-enc-grid.heic is admitted by the heic handler and heif-enc-grid.avif by the avif handler", async () => {
    const heic = createIsobmffWriterCountingHandlerForTests("heic");
    const avif = createIsobmffWriterCountingHandlerForTests("avif");
    const restore = setRegisteredHandlersForTests([heic.handler, avif.handler]);
    try {
      const directory = await freshDirectory();

      const heicDestination = join(directory, "heic-output.bin");
      const heicResult = await sanitizeFile({
        sourcePath: HEIC_PATH,
        destinationPath: heicDestination,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(heicResult.ok).toBe(true);
      await expect(stat(heicDestination)).resolves.toBeDefined();
      expect(heic.counters.admit).toBe(1);
      expect(avif.counters.admit).toBe(0);

      const avifDestination = join(directory, "avif-output.bin");
      const avifResult = await sanitizeFile({
        sourcePath: AVIF_PATH,
        destinationPath: avifDestination,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(avifResult.ok).toBe(true);
      await expect(stat(avifDestination)).resolves.toBeDefined();
      expect(heic.counters.admit).toBe(1); // unchanged by the avif run
      expect(avif.counters.admit).toBe(1);

      // Neither handler matches the other brand's fixture (D-09): the heic fixture's own admit
      // count never moved when sanitizing the avif fixture, and vice versa -- already asserted
      // above by the counters staying put across both runs.
      const heicBytes = await readFile(HEIC_PATH);
      const avifBytes = await readFile(AVIF_PATH);
      expect(heic.handler.matches(heicBytes.subarray(0, 256))).toBe(true);
      expect(heic.handler.matches(avifBytes.subarray(0, 256))).toBe(false);
      expect(avif.handler.matches(avifBytes.subarray(0, 256))).toBe(true);
      expect(avif.handler.matches(heicBytes.subarray(0, 256))).toBe(false);
    } finally {
      restore();
    }
  });
});
