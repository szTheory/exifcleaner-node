// D-19 (62-10): the identity proof (D-18, 62-09) has teeth -- a flipped byte in a surviving item,
// and each of the five named writer mutants, are caught before publication, with nothing
// published and the source preserved. Every mutant lives in the one declared test seam
// (`tests/isobmff-support/test-handler.ts`, D-19's own isolation rule) and acts on the frozen
// `IsobmffOutputPlan` or the written destination bytes only -- this file never touches `src/`.
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { admitIsobmff } from "../src/isobmff/admission.js";
import { IsobmffStructureError } from "../src/isobmff/errors.js";
import type { IsobmffOutputPlan } from "../src/isobmff/plan.js";
import { colrProf, ispe, pixi } from "./isobmff-support/builder.js";
import { assembleHeif } from "./isobmff-support/hostile.js";
import {
  createFlipOneByteHandler,
  createIsobmffWriterHandlerForTests,
  createPlanMutantHandler,
  mutateIlocOffsetShiftSkipped,
  mutateIlocWidthsNormalizedToEight,
  mutateIpmaRemapOffByOne,
  mutateMdatKeepRemovedRange,
  mutateMinimalExifConstructionMethodOne,
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

/** A single `hvc1` primary item carrying three `ipco` properties (ispe, a `colr prof` ICC
 * property, and `pixi`) so that sanitizing with `preserveColorProfile: false` removes the middle
 * property and non-trivially remaps the surviving associations (D-16) -- the fixture
 * `mutateIpmaRemapOffByOne` needs to make its "+1" corruption land on a real, different property. */
function buildIccRemapFixture(): Buffer {
  const primaryPayload = Buffer.from("rgb-primary-tile-bytes", "ascii");
  return assembleHeif({
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2, 3],
      },
    ],
    properties: [
      ispe(32, 32),
      colrProf(Buffer.from([9, 9, 9, 9])),
      pixi([8, 8, 8]),
    ],
    mdatPayload: primaryPayload,
    twoPass: true,
  });
}

/**
 * Runs `sanitizeFile` with a single `createPlanMutantHandler(createIsobmffWriterHandlerForTests
 * (brand), mutate)` installed as the only registered handler, against a fresh copy of
 * `sourceBytes`. Returns everything a case needs to assert "not-ok, destination absent, source
 * unchanged" without repeating the directory/file bookkeeping in every test.
 */
async function runWithMutant(
  sourceBytes: Buffer,
  brand: "heic" | "avif",
  mutate: (plan: IsobmffOutputPlan) => IsobmffOutputPlan,
  overrides: Partial<Parameters<typeof sanitizeFile>[0]> = {},
): Promise<{
  readonly sanitized: Awaited<ReturnType<typeof sanitizeFile>>;
  readonly directory: string;
  readonly sourceName: string;
  readonly destinationName: string;
  readonly sourcePath: string;
  readonly sourceSnapshot: Buffer;
}> {
  const directory = await freshDirectory();
  const sourceName = `source.${brand}`;
  const destinationName = `destination.${brand}`;
  const sourcePath = join(directory, sourceName);
  await writeFile(sourcePath, sourceBytes);
  const sourceSnapshot = await readFile(sourcePath);
  const destinationPath = join(directory, destinationName);

  const inner = createIsobmffWriterHandlerForTests(brand);
  const restore = setRegisteredHandlersForTests([
    createPlanMutantHandler(inner, mutate),
  ]);
  try {
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...DEFAULT_PRESERVATION,
      ...overrides,
    });
    return {
      sanitized,
      directory,
      sourceName,
      destinationName,
      sourcePath,
      sourceSnapshot,
    };
  } finally {
    restore();
  }
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

/** Shared assertion for every red mutant case: `sanitizeFile` failed with `verification-failed`,
 * nothing was published, and the source bytes are unchanged. */
async function expectRed(
  result: Awaited<ReturnType<typeof runWithMutant>>,
): Promise<void> {
  const {
    sanitized,
    directory,
    sourceName,
    destinationName,
    sourcePath,
    sourceSnapshot,
  } = result;
  expect(sanitized.ok).toBe(false);
  if (sanitized.ok) throw new Error("unreachable");
  expect(sanitized.error.code).toBe("verification-failed");

  await expectNothingPublished(directory, sourceName, destinationName);

  const sourceAfter = await readFile(sourcePath);
  expect(sourceAfter.equals(sourceSnapshot)).toBe(true);
}

describe("D-19 flip-one-byte (62-10)", () => {
  it.each([["first" as const], ["last" as const], ["none" as const]])(
    "heif-enc-grid.heic, flip position %s",
    async (position) => {
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
    },
  );
});

describe("D-19 writer mutants (62-10)", () => {
  const HEIF_ENC_CASES = [
    ["offset shift skipped", mutateIlocOffsetShiftSkipped, false] as const,
    [
      "one removed range kept in the mdat copy ranges",
      mutateMdatKeepRemovedRange,
      false,
    ] as const,
    [
      "iloc widths normalized to 8",
      mutateIlocWidthsNormalizedToEight,
      false,
    ] as const,
    [
      "minimal Exif written to idat with construction method 1",
      mutateMinimalExifConstructionMethodOne,
      false,
    ] as const,
    [
      "identity mutant control",
      (plan: IsobmffOutputPlan) => plan,
      true,
    ] as const,
  ];

  it.each(HEIF_ENC_CASES)("%s", async (_name, mutate, expectOk) => {
    const sourceBytes = await readFile(HEIC_FIXTURE);
    const result = await runWithMutant(sourceBytes, "heic", mutate);

    if (expectOk) {
      expect(result.sanitized.ok).toBe(true);
      const listing = await readdir(result.directory);
      expect(listing.sort()).toEqual(["destination.heic", "source.heic"]);
      return;
    }

    await expectRed(result);
  });

  it("ipma remap off by one (ICC fixture, preserveColorProfile false)", async () => {
    const sourceBytes = buildIccRemapFixture();
    const result = await runWithMutant(
      sourceBytes,
      "heic",
      mutateIpmaRemapOffByOne,
      {
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      },
    );

    await expectRed(result);
  });

  it(
    "mutant 5 re-clean: a minimal Exif item placed in idat (cm=1) declines " +
      "removable-item-in-idat on re-clean, so clean(clean(x)) cannot equal clean(x)",
    async () => {
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.heic");
      await writeFile(sourcePath, await readFile(HEIC_FIXTURE));
      const { size } = await stat(sourcePath);
      const mutantOutputPath = join(directory, "mutant-output.heic");

      const inner = createIsobmffWriterHandlerForTests("heic");
      const sourceHandle = await open(sourcePath, "r");
      try {
        const admission = await inner.admit(sourceHandle, size);
        const orientationValue =
          admission.orientation.status === "valid"
            ? admission.orientation.value
            : undefined;
        const plan = mutateMinimalExifConstructionMethodOne(
          inner.buildOutputPlan(
            admission,
            true,
            true,
            true,
            orientationValue,
          ) as IsobmffOutputPlan,
        );

        // Written directly to a temp file OUTSIDE the normal safe-transaction/verify pipeline --
        // this file is deliberately never cleaned up by a failed verify, so re-clean below has
        // something to read.
        const mutantHandle = await open(mutantOutputPath, "w");
        try {
          await inner.writeOutput(sourceHandle, mutantHandle, plan, undefined);
        } finally {
          await mutantHandle.close();
        }
      } finally {
        await sourceHandle.close();
      }

      // Direct admission re-check: the mutant output's own minimal Exif item (k, construction
      // method 1) is classified "removable" on fresh admission (every Exif item is), and D3's
      // rule 5 declines any removable item whose construction_method is not 0 -- the exact class
      // named by this mutant.
      const mutantHandle = await open(mutantOutputPath, "r");
      let declineClass: string | undefined;
      try {
        const { size: mutantSize } = await stat(mutantOutputPath);
        await admitIsobmff(mutantHandle, mutantSize);
        throw new Error(
          "admitIsobmff unexpectedly admitted the mutant output.",
        );
      } catch (cause) {
        if (cause instanceof IsobmffStructureError) {
          declineClass = cause.declineClass;
        } else {
          throw cause;
        }
      } finally {
        await mutantHandle.close();
      }
      expect(declineClass).toBe("removable-item-in-idat");

      // Re-clean through the full engine too: sanitizing the mutant output with the real writer
      // handler must fail (not publish a second, different "clean" result), proving
      // clean(clean(x)) cannot equal clean(x) for this mutant.
      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests("heic"),
      ]);
      try {
        const reCleanedPath = join(directory, "re-cleaned.heic");
        const reCleaned = await sanitizeFile({
          sourcePath: mutantOutputPath,
          destinationPath: reCleanedPath,
          ...DEFAULT_PRESERVATION,
        });
        expect(reCleaned.ok).toBe(false);
        if (reCleaned.ok) throw new Error("unreachable");
        expect(reCleaned.error.code).toBe("unsupported-format");
        expect(reCleaned.error.detail).toContain("construction_method");
      } finally {
        restore();
      }
    },
  );
});
