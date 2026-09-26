import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCapabilities,
  inspectFile,
  sanitizeFile,
} from "../../../src/engine.js";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
} from "../../../src/admission/registry.js";
import { classifyFallback } from "../../../src/fallback.js";
import {
  assertFormatsCovered,
  QUALIFICATION_FORMATS,
  type QualificationFormat,
} from "../formats.js";

/**
 * KIT-07 rollback proof (D-24): removing a registered handler from the
 * registry through the private test seam makes the library decline that
 * format as `unsupported-format` before any write, with a safe fallback --
 * and restoring the handler proves the decline was caused by the removal,
 * not by some other defect in the sample or the harness. Runs once per
 * currently registered handler (`registeredHandlersForTests()`), so a new
 * format inherits this proof automatically once it is registered.
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

const STAGING_FILE_NAME_PATTERN = /^output\.[a-z0-9]+$/;

describe("registry rollback proof (KIT-07 D-24)", () => {
  it.each(registeredHandlersForTests())(
    "declines a $capability.format sample as unsupported-format once its handler is removed, and accepts it again once restored",
    async (handler) => {
      const format = handler.capability.format;
      const entry: QualificationFormat | undefined =
        QUALIFICATION_FORMATS[format as keyof typeof QUALIFICATION_FORMATS];
      if (entry === undefined) {
        throw new Error(`No qualification sample registered for ${format}`);
      }

      const directory = await freshDirectory();
      const sourceName = "source.bin";
      const sourcePath = join(directory, sourceName);
      const destinationPath = join(directory, "destination.bin");
      const sourceBytes = entry.sample();
      await writeFile(sourcePath, sourceBytes);

      const restore = setRegisteredHandlersForTests(
        registeredHandlersForTests().filter(
          (candidate) => candidate !== handler,
        ),
      );
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
          preserveResolution: false,
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
          getCapabilities().formats.some((entry) => entry.format === format),
        ).toBe(false);
      } finally {
        restore();
      }

      // Positive control: the same sample, on the same paths, succeeds once
      // the handler is restored -- proving the decline above was caused by
      // the handler's removal and not by some other defect in the sample.
      const restored = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: true,
        preserveColorProfile: true,
        preserveTimestamps: true,
        preserveResolution: false,
      });
      expect(restored.ok).toBe(true);
      expect(
        getCapabilities().formats.some((entry) => entry.format === format),
      ).toBe(true);
    },
  );

  it("every registered handler's stagingFileName follows the output.<ext> convention and matches its first capability extension", () => {
    for (const handler of registeredHandlersForTests()) {
      expect(handler.stagingFileName).toMatch(STAGING_FILE_NAME_PATTERN);
      const firstExtension = handler.capability.extensions[0]?.replace(
        /^\./,
        "",
      );
      expect(handler.stagingFileName).toBe(`output.${firstExtension}`);
    }
  });

  it("assertFormatsCovered passes when the registered formats exactly match the qualification registry", () => {
    expect(() =>
      assertFormatsCovered(
        getCapabilities().formats.map((entry) => entry.format),
        QUALIFICATION_FORMATS,
      ),
    ).not.toThrow();
  });

  describe("assertFormatsCovered negative controls", () => {
    const entries = Object.entries(QUALIFICATION_FORMATS) as readonly [
      string,
      QualificationFormat,
    ][];
    const first = entries[0];
    if (first === undefined) {
      throw new Error("QUALIFICATION_FORMATS must not be empty");
    }
    const [registeredFormat, entry] = first;
    // Not any registered format -- a synthetic name, derived from the real
    // one rather than a hardcoded literal, so this stays neutral as more
    // formats are registered.
    const unregisteredFormat = `${registeredFormat}-not-registered`;

    it("throws naming a registered format with no qualification entry", () => {
      expect(() =>
        assertFormatsCovered([registeredFormat, unregisteredFormat], {
          [registeredFormat]: entry,
        }),
      ).toThrow(new RegExp(unregisteredFormat));
    });

    it("throws naming a qualification entry with no matching registered format", () => {
      expect(() =>
        assertFormatsCovered([registeredFormat], {
          [registeredFormat]: entry,
          [unregisteredFormat]: entry,
        }),
      ).toThrow(new RegExp(unregisteredFormat));
    });
  });
});
