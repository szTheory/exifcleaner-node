// D-16/61-10: proves through the REAL engine (never a pure-classifier-only check) that:
//
//   - success criterion 4 -- every one of the 24 `IsobmffDeclineClass` hostile fixtures declines
//     exactly once, before any write, safe to fall back;
//   - success criterion 3 -- HEIC/AVIF are recognized through the widened (256-byte) registry
//     read, both on real `heif-enc` encoder output and on a brand placed past the pre-D-17 12-byte
//     window.
//
// The test-only handler (`createIsobmffTestHandler`, `tests/isobmff-support/test-handler.ts`) is
// installed ADDITIVELY alongside the real `webpHandler`/`pngHandler`/`jpegHandler` via the existing
// private `setRegisteredHandlersForTests` seam, and always restored in `finally` -- the registry
// must never observe our test handler outside the scope of a single test.
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFile, sanitizeFile } from "../src/engine.js";
import {
  registeredHandlersForTests,
  selectHandler,
  setRegisteredHandlersForTests,
} from "../src/admission/registry.js";
import type { RegisteredHandler } from "../src/admission/registry.js";
import { webpHandler } from "../src/admission/webp-handler.js";
import { pngHandler } from "../src/admission/png-handler.js";
import { jpegHandler } from "../src/admission/jpeg-handler.js";
// D-13: `classifyFallback` (src/fallback.ts:3-7) keys ONLY on `error.phase` and
// `error.nativeWrite` -- never on `error.code` -- so the per-class public code asserted below is
// pinned entirely by this test file's own `.toMatchObject({ code: ... })` assertions, not by
// anything `classifyFallback` itself checks. The app never branches on the ISOBMFF-specific code
// either (D-13's other traced call sites), so a wrong code here would be caught only by these
// tests, never by the app's own runtime behavior.
import { classifyFallback } from "../src/fallback.js";
import { ISOBMFF_DECLINE_CLASSES } from "../src/isobmff/errors.js";
import { assembleHeif, HOSTILE_FIXTURES } from "./isobmff-support/hostile.js";
import { colrProf } from "./isobmff-support/builder.js";
import { createIsobmffTestHandler } from "./isobmff-support/test-handler.js";
import { metadataJpeg, metadataPng, metadataWebp } from "./fixtures.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_PATH = join(FIXTURES_DIR, "heif-enc-grid.avif");

/** D-16: hostile runs use no preservation options at all, so only admission decides. */
const NO_PRESERVATION = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
} as const;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-"));
  directories.push(directory);
  return directory;
}

async function writeBytesTo(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
}

async function selectThroughRealRegistry(
  path: string,
): Promise<RegisteredHandler | undefined> {
  const handle: FileHandle = await open(path, "r");
  try {
    return await selectHandler(handle);
  } finally {
    await handle.close();
  }
}

function installTestHandlerAdditively() {
  const { handler, counters } = createIsobmffTestHandler();
  const restore = setRegisteredHandlersForTests([
    ...registeredHandlersForTests(),
    handler,
  ]);
  return { handler, counters, restore };
}

describe("Task 1 tracer: one hostile class (removable-item-in-idat) through the real engine", () => {
  it("declines once, before any write, safe to fall back -- the full D-16 assertion set", async () => {
    const fixture = HOSTILE_FIXTURES["removable-item-in-idat"];
    expect(fixture.stage).toBe("admission");

    const directory = await freshDirectory();
    const sourceName = "source.bin";
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, "destination.bin");
    await fixture.write(sourcePath);
    const sourceBytes = await readFile(sourcePath);

    const { counters, restore } = installTestHandlerAdditively();
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...NO_PRESERVATION,
      });
      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error).toMatchObject({
        code: fixture.expectedCode,
        phase: "admission",
        nativeWrite: "not-started",
      });
      expect(classifyFallback(sanitized.error)).toBe("safe-to-fallback");

      expect(counters.admit).toBe(1);
      expect(counters.buildOutputPlan).toBe(0);
      expect(counters.checkOutputPlan).toBe(0);
      expect(counters.writeOutput).toBe(0);
      expect(counters.verifyOutput).toBe(0);

      const listing = await readdir(directory);
      expect(listing).toEqual([sourceName]);

      const sourceAfter = await readFile(sourcePath);
      expect(sourceAfter.equals(sourceBytes)).toBe(true);

      const inspected = await inspectFile(sourcePath);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) throw new Error("unreachable");
      expect(inspected.error).toMatchObject({
        code: fixture.expectedCode,
        phase: "admission",
      });
    } finally {
      restore();
    }
  });
});

describe("Task 2: every ISOBMFF decline class declines once before any write (BMF-03/D-16)", () => {
  it.each(ISOBMFF_DECLINE_CLASSES)(
    "%s declines through the real engine, safe to fall back",
    async (declineClass) => {
      const fixture = HOSTILE_FIXTURES[declineClass];
      const directory = await freshDirectory();
      const sourceName = "source.bin";
      const sourcePath = join(directory, sourceName);
      const destinationPath = join(directory, "destination.bin");
      await fixture.write(sourcePath);
      const sourceBytes = await readFile(sourcePath);

      const { counters, restore } = installTestHandlerAdditively();
      try {
        const sanitized = await sanitizeFile({
          sourcePath,
          destinationPath,
          ...NO_PRESERVATION,
        });
        expect(sanitized.ok).toBe(false);
        if (sanitized.ok) throw new Error("unreachable");
        expect(sanitized.error).toMatchObject({
          code: fixture.expectedCode,
          phase: "admission",
          nativeWrite: "not-started",
        });
        expect(classifyFallback(sanitized.error)).toBe("safe-to-fallback");

        if (fixture.stage === "selection") {
          // D-12: a non-matching brand never reaches our handler's `admit` at all -- it is the
          // existing no-handler decline (`src/engine.ts`), already safe to fall back.
          expect(counters.admit).toBe(0);
        } else {
          expect(counters.admit).toBe(1);
        }
        expect(counters.buildOutputPlan).toBe(0);
        expect(counters.checkOutputPlan).toBe(0);
        expect(counters.writeOutput).toBe(0);
        expect(counters.verifyOutput).toBe(0);

        const listing = await readdir(directory);
        expect(listing).toEqual([sourceName]);

        const sourceAfter = await readFile(sourcePath);
        expect(sourceAfter.equals(sourceBytes)).toBe(true);

        if (fixture.stage === "admission") {
          const inspected = await inspectFile(sourcePath);
          expect(inspected.ok).toBe(false);
          if (inspected.ok) throw new Error("unreachable");
          expect(inspected.error).toMatchObject({
            code: fixture.expectedCode,
            phase: "admission",
          });
        }
      } finally {
        restore();
      }
    },
  );

  it("ICC carve-out: an invalid primary colr ICC declines unsupported-feature/color-profile-preservation at admission, not as an IsobmffStructureError", async () => {
    // D-12's explicit carve-out: ICC-preservation failure is never an `IsobmffStructureError` --
    // the engine (src/engine.ts:186-198) declines it once `admission.colorProfile` is set, using
    // the same `validateIccForPreservation` policy every other format shares.
    const invalidIcc = Buffer.from("not-a-real-icc-profile", "ascii");
    const primaryPayload = Buffer.from([1, 2, 3, 4]);
    const bytes = assembleHeif({
      items: [
        {
          itemId: 1,
          itemType: "hvc1",
          extents: [{ relOffset: 0, length: primaryPayload.length }],
          propertyIndices: [1],
        },
      ],
      properties: [colrProf(invalidIcc)],
      mdatPayload: primaryPayload,
      twoPass: true,
    });

    const directory = await freshDirectory();
    const sourceName = "source.bin";
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, "destination.bin");
    await writeBytesTo(sourcePath, bytes);

    const { counters, restore } = installTestHandlerAdditively();
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: true,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error).toMatchObject({
        code: "unsupported-feature",
        feature: "color-profile-preservation",
        phase: "admission",
        nativeWrite: "not-started",
      });
      expect(classifyFallback(sanitized.error)).toBe("safe-to-fallback");
      expect(counters.admit).toBe(1);
      expect(counters.writeOutput).toBe(0);
      expect(counters.buildOutputPlan).toBe(0);
      expect(counters.checkOutputPlan).toBe(0);
      expect(counters.verifyOutput).toBe(0);

      // The ICC policy applies only to preservation: the same file inspects clean (no
      // IsobmffStructureError, no decline at all) because inspectFile never validates the ICC
      // payload for preservation -- it only reports what is present.
      const inspected = await inspectFile(sourcePath);
      expect(inspected.ok).toBe(true);
    } finally {
      restore();
    }
  });

  it("positive recognition (success criterion 3): heif-enc-grid.heic/avif and a mif1/miaf/MA1B/avif brand past byte 12 all inspect ok through the widened registry read", async () => {
    const d18Bytes = assembleHeif({
      majorBrand: "mif1",
      compatibleBrands: ["miaf", "MA1B", "avif"],
      twoPass: true,
    });
    const directory = await freshDirectory();
    const d18Path = join(directory, "d18-brand.bin");
    await writeBytesTo(d18Path, d18Bytes);

    for (const path of [HEIC_PATH, AVIF_PATH, d18Path]) {
      const { counters, restore } = installTestHandlerAdditively();
      try {
        const inspected = await inspectFile(path);
        expect(inspected.ok).toBe(true);
        expect(counters.admit).toBe(1);
        expect(counters.buildOutputPlan).toBe(0);
        expect(counters.checkOutputPlan).toBe(0);
        expect(counters.writeOutput).toBe(0);
        expect(counters.verifyOutput).toBe(0);
      } finally {
        restore();
      }
    }
  });

  it("existing-format routing: webp/png/jpeg fixtures still select their own real handler while the ISOBMFF test handler is installed", async () => {
    const cases: readonly {
      readonly name: string;
      readonly bytes: Buffer;
      readonly handler: RegisteredHandler;
    }[] = [
      { name: "webp", bytes: metadataWebp(), handler: webpHandler },
      { name: "png", bytes: metadataPng(), handler: pngHandler },
      { name: "jpeg", bytes: metadataJpeg(), handler: jpegHandler },
    ];

    for (const { bytes, handler } of cases) {
      const directory = await freshDirectory();
      const path = join(directory, "input.bin");
      await writeFile(path, bytes);

      const { restore } = installTestHandlerAdditively();
      try {
        const selected = await selectThroughRealRegistry(path);
        expect(selected).toBe(handler);
      } finally {
        restore();
      }
    }
  });
});
