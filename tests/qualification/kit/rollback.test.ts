import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCapabilities,
  inspectFile,
  sanitizeFile,
} from "../../../src/engine.js";
import { setRegisteredHandlersForTests } from "../../../src/admission/registry.js";
import { classifyFallback } from "../../../src/fallback.js";
import { metadataWebp } from "../../fixtures.js";

/**
 * KIT-07 rollback proof (D-24): removing a registered handler from the
 * registry through the private test seam makes the library decline that
 * format as `unsupported-format` before any write, with a safe fallback --
 * and restoring the handler proves the decline was caused by the removal,
 * not by some other defect in the sample or the harness.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-rollback-"));
  directories.push(directory);
  return directory;
}

describe("registry rollback proof (KIT-07 D-24)", () => {
  it("declines a WebP sample as unsupported-format once the WebP handler is removed, and accepts it again once restored", async () => {
    const directory = await freshDirectory();
    const sourceName = "source.bin";
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, "destination.bin");
    const sourceBytes = metadataWebp();
    await writeFile(sourcePath, sourceBytes);

    const restore = setRegisteredHandlersForTests([]);
    try {
      const inspected = await inspectFile(sourcePath);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) throw new Error("unreachable");
      expect(inspected.error).toMatchObject({
        code: "unsupported-format",
        phase: "admission",
        nativeWrite: "not-started",
      });
      expect(classifyFallback(inspected.error)).toBe("safe-to-fallback");

      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: true,
        preserveColorProfile: true,
        preserveTimestamps: true,
      });
      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error).toMatchObject({
        code: "unsupported-format",
        phase: "admission",
        nativeWrite: "not-started",
      });
      expect(classifyFallback(sanitized.error)).toBe("safe-to-fallback");

      const listing = await readdir(directory);
      expect(listing).toEqual([sourceName]);

      const sourceAfter = await readFile(sourcePath);
      expect(sourceAfter.equals(sourceBytes)).toBe(true);

      expect(
        getCapabilities().formats.some((format) => format.format === "webp"),
      ).toBe(false);
    } finally {
      restore();
    }

    // Positive control: the same sample, on the same paths, succeeds once
    // the handler is restored -- proving the decline above was caused by the
    // handler's removal and not by some other defect in the sample or setup.
    const restored = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: true,
      preserveColorProfile: true,
      preserveTimestamps: true,
    });
    expect(restored.ok).toBe(true);
    expect(
      getCapabilities().formats.some((format) => format.format === "webp"),
    ).toBe(true);
  });
});
