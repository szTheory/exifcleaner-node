// tests/isobmff-support/generator.ts coverage (BMF-03/BMF-04, D-19, Locked Decision 18): proves
// the shared ISOBMFF property generator's per-arm floors and agreement with the real
// `admitIsobmff` classifier, and that it is NOT wired into the qualification kit this phase.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { admitIsobmff } from "../src/isobmff/admission.js";
import {
  DECLINE_CLASS_TO_KIND,
  ISOBMFF_DECLINE_CLASSES,
  IsobmffStructureError,
  type IsobmffDeclineClass,
} from "../src/isobmff/errors.js";
import {
  assertFloors,
  countSample,
  createCounters,
} from "./qualification/kit/floors.js";
import { assertPlanted } from "./qualification/kit/generators.js";
import {
  isobmffArmSampleArbitrary,
  isobmffMetadataGenerator,
  ISOBMFF_ARM_FLOORS,
} from "./isobmff-support/generator.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function withTempFile<T>(
  bytes: Buffer,
  fn: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-isobmff-generator-"),
  );
  cleanupDirectories.push(directory);
  const path = join(directory, "sample.heic");
  const writeHandle = await open(path, "w");
  try {
    await writeHandle.write(bytes, 0, bytes.length, 0);
  } finally {
    await writeHandle.close();
  }
  const readHandle = await open(path, "r");
  try {
    return await fn(readHandle, bytes.length);
  } finally {
    await readHandle.close();
  }
}

describe("tests/isobmff-support/generator.ts exports", () => {
  it("exports isobmffMetadataGenerator, isobmffArmSampleArbitrary, ISOBMFF_ARM_FLOORS", () => {
    expect(isobmffMetadataGenerator.format).toBe("isobmff");
    expect(isobmffMetadataGenerator.metadataKinds).toEqual(["EXIF", "XMP"]);
    expect(typeof isobmffArmSampleArbitrary).toBe("function");
    expect(typeof ISOBMFF_ARM_FLOORS).toBe("object");
  });

  it("every IsobmffHazardClass literal the generator uses is a real IsobmffDeclineClass", () => {
    // The generator cannot import IsobmffDeclineClass (isolation rule) -- it hardcodes literal
    // strings instead. This test, unrestricted, proves those literals still name real classes.
    const hazardLiterals: readonly IsobmffDeclineClass[] = [
      "unknown-item-type",
      "construction-method-2",
      "external-data-reference",
      "removable-item-referenced",
    ];
    for (const literal of hazardLiterals) {
      expect(ISOBMFF_DECLINE_CLASSES).toContain(literal);
    }
  });
});

describe("the generator is not wired into QUALIFICATION_FORMATS (D-19)", () => {
  it("tests/qualification/formats.ts has no isobmff key", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "tests/qualification/formats.ts"),
      "utf8",
    );
    expect(/^\s*isobmff:/mu.test(source)).toBe(false);
  });

  it("tests/qualification/isobmff/ does not exist", () => {
    expect(existsSync(join(PROJECT_ROOT, "tests/qualification/isobmff"))).toBe(
      false,
    );
  });
});

const SEED = 20261001;
const NUM_RUNS = 150;

describe("isobmffArmSampleArbitrary meets ISOBMFF_ARM_FLOORS and agrees with admitIsobmff", () => {
  it(`every arm clears its floor over ${NUM_RUNS} runs (seed ${SEED}), per brand`, () => {
    for (const brand of ["heic", "avif"] as const) {
      const counters = createCounters();
      fc.assert(
        fc.property(isobmffArmSampleArbitrary(brand), ({ arms }) => {
          countSample(counters, arms);
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
      assertFloors(counters, ISOBMFF_ARM_FLOORS);
    }
  });

  it("every non-hazard sample admits with its canaries present and Exif/XMP removable; every hazard sample declines with its own class", async () => {
    for (const brand of ["heic", "avif"] as const) {
      await fc.assert(
        fc.asyncProperty(
          isobmffArmSampleArbitrary(brand),
          async (armSample) => {
            const { sample, arms, hazardClass } = armSample;

            if (arms.includes("hazard")) {
              if (hazardClass === undefined) {
                throw new Error("hazard arm sample is missing its hazardClass");
              }
              let caught: unknown;
              try {
                await withTempFile(sample.bytes, (handle, size) =>
                  admitIsobmff(handle, size),
                );
              } catch (error) {
                caught = error;
              }
              if (!(caught instanceof IsobmffStructureError)) {
                throw new Error(
                  `hazard sample (class ${hazardClass}) did not decline with an IsobmffStructureError`,
                );
              }
              expect(caught.declineClass).toBe(hazardClass);
              expect(caught.kind).toBe(DECLINE_CLASS_TO_KIND[hazardClass]);
              return;
            }

            assertPlanted(sample.bytes, sample.planted);
            const admission = await withTempFile(sample.bytes, (handle, size) =>
              admitIsobmff(handle, size),
            );
            const exifItems = admission.model.items.filter(
              (item) => item.type === "Exif",
            );
            const xmpItems = admission.model.items.filter(
              (item) => item.type === "mime",
            );
            expect(exifItems.length).toBeGreaterThan(0);
            expect(xmpItems.length).toBeGreaterThan(0);
            for (const item of [...exifItems, ...xmpItems]) {
              expect(admission.classification.removableItemIds).toContain(
                item.id,
              );
            }
          },
        ),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    }
  });
});
