// D-19 (62-10): the identity proof (D-18, 62-09) has teeth -- a flipped byte in a surviving item
// is caught before publication, with nothing published and the source preserved. The wrapper
// lives in the one declared test seam (`tests/isobmff-support/test-handler.ts`, D-19's own
// isolation rule) and acts on the written destination bytes only -- this file never touches
// `src/`.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import {
  createFlipOneByteHandler,
  createIsobmffWriterHandlerForTests,
} from "./isobmff-support/test-handler.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");

/** The preservation flags every heif-enc-grid.heic case uses -- the same "default settings" 62-07
 * already measured synthesize exactly one minimal Exif item (id 6) at the mdat tail. */
const DEFAULT_PRESERVATION = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
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
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-isobmff-negative-"),
  );
  directories.push(directory);
  return directory;
}

/**
 * Asserts the directory holds the source and, at most, the engine's own private stage
 * directory/file (`.exifcleaner-stage-<uuid>`, `src/transaction/safe-transaction.ts`) -- a failed
 * verification never renames that private, 0700-permission directory to the public destination
 * path, so no entry is ever the public destination filename, but the private directory itself is
 * documented, pre-existing residue of a non-committed run (see e.g. `tests/safe_transaction.test
 * .ts`'s "owned-partial-remains" case) that this test-only plan does not touch (`src/transaction/
 * **` is out of scope, 62-CONTEXT.md). "Nothing is published" is the claim this proves -- not
 * "the stage directory is swept," which is `src/transaction/safe-transaction.ts`'s own concern.
 */
async function expectNothingPublished(
  directory: string,
  sourceName: string,
  destinationName: string,
): Promise<void> {
  const listing = await readdir(directory);
  expect(listing).toContain(sourceName);
  expect(listing).not.toContain(destinationName);
  for (const entry of listing) {
    if (entry === sourceName) continue;
    expect(entry.startsWith(".exifcleaner-stage-")).toBe(true);
  }
}

describe("D-19 flip-one-byte (62-10)", () => {
  it.each([
    ["first" as const],
    ["last" as const],
    ["none" as const],
  ])("heif-enc-grid.heic, flip position %s", async (position) => {
    const directory = await freshDirectory();
    const sourceName = "source.heic";
    const sourcePath = join(directory, sourceName);
    await writeFile(sourcePath, await readFile(HEIC_FIXTURE));
    const sourceSnapshot = await readFile(sourcePath);
    const destinationPath = join(directory, "destination.heic");

    const inner = createIsobmffWriterHandlerForTests("heic");
    const restore = setRegisteredHandlersForTests([
      createFlipOneByteHandler(inner, { position }),
    ]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...DEFAULT_PRESERVATION,
      });

      if (position === "none") {
        expect(sanitized.ok).toBe(true);
        const listing = await readdir(directory);
        expect(listing.sort()).toEqual(["destination.heic", "source.heic"]);
        return;
      }

      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error.code).toBe("verification-failed");

      await expectNothingPublished(directory, sourceName, "destination.heic");

      const sourceAfter = await readFile(sourcePath);
      expect(sourceAfter.equals(sourceSnapshot)).toBe(true);
    } finally {
      restore();
    }
  });
});
