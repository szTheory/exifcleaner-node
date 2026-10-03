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
  isobmffArmSampleArbitraryWithoutMetadataArm,
  isobmffMetadataGenerator,
  ISOBMFF_ARM_FLOORS,
} from "./isobmff-support/generator.js";
import { avifMetadataGenerator } from "./qualification/avif/generators.js";
import { heicMetadataGenerator } from "./qualification/heic/generators.js";

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

// The qualification fixed seed and run count (FC_SEED/FC_RUNS, 62.1-06 / D-28).
const FC_SEED = 460046;
const FC_RUNS = 200;

describe("isobmffArmSampleArbitrary meets ISOBMFF_ARM_FLOORS and agrees with admitIsobmff", () => {
  it(`every arm clears its floor over ${FC_RUNS} runs (seed ${FC_SEED}), per brand`, () => {
    for (const brand of ["heic", "avif"] as const) {
      const counters = createCounters();
      fc.assert(
        fc.property(isobmffArmSampleArbitrary(brand), ({ arms }) => {
          countSample(counters, arms);
        }),
        { seed: FC_SEED, numRuns: FC_RUNS },
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
        { seed: FC_SEED, numRuns: FC_RUNS },
      );
    }
  }, 30_000);
});

// IN-01 (62.1-06): QUALIFICATION_FORMATS wires one generator per format, so a sample drawn from
// `isobmffArmSampleArbitrary("heic")` must actually be a heic file. Read the ftyp box directly
// here (not through the engine or the builder) so the brand claim has an independent check.

function ftypBrandOf(bytes: Buffer): "heic" | "avif" | "other" {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") {
    return "other";
  }
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) {
    return "other";
  }
  const brands = [bytes.toString("latin1", 8, 12)];
  for (let offset = 16; offset < size; offset += 4) {
    brands.push(bytes.toString("latin1", offset, offset + 4));
  }
  const isHeic = brands.some((brand) => brand === "heic" || brand === "heix");
  const isAvif = brands.some((brand) => brand === "avif" || brand === "avis");
  if (isHeic && !isAvif) return "heic";
  if (isAvif && !isHeic) return "avif";
  return "other";
}

describe("isobmffArmSampleArbitrary(brand) emits only that brand (IN-01)", () => {
  it("ftypBrandOf reads heic and avif ftyp boxes and rejects anything else (control)", () => {
    const ftyp = (major: string, ...compatible: string[]): Buffer => {
      const body = Buffer.from(
        [major, "\0\0\0\0", ...compatible].join(""),
        "latin1",
      );
      const header = Buffer.alloc(8);
      header.writeUInt32BE(8 + body.length, 0);
      header.write("ftyp", 4, "latin1");
      return Buffer.concat([header, body]);
    };
    expect(ftypBrandOf(ftyp("heic", "mif1", "heic"))).toBe("heic");
    expect(ftypBrandOf(ftyp("avif", "mif1", "avif"))).toBe("avif");
    expect(ftypBrandOf(ftyp("mif1", "heic", "avif"))).toBe("other");
    expect(ftypBrandOf(ftyp("mp42", "isom"))).toBe("other");
    expect(ftypBrandOf(Buffer.from("not a box at all"))).toBe("other");
  });

  for (const brand of ["heic", "avif"] as const) {
    it(`every non-hazard sample from isobmffArmSampleArbitrary("${brand}") classifies as ${brand} (seed ${FC_SEED}, ${FC_RUNS} samples)`, () => {
      const samples = fc.sample(
        isobmffArmSampleArbitrary(brand).filter(
          (armSample) => !armSample.arms.includes("hazard"),
        ),
        { seed: FC_SEED, numRuns: FC_RUNS },
      );
      expect(samples).toHaveLength(FC_RUNS);
      const misclassified = samples
        .map((armSample) => ftypBrandOf(armSample.sample.bytes))
        .filter((classified) => classified !== brand);
      expect(misclassified).toEqual([]);
    });
  }
});

describe("heicMetadataGenerator and avifMetadataGenerator (QUA-03, one generator per format)", () => {
  for (const [brand, generator] of [
    ["heic", heicMetadataGenerator],
    ["avif", avifMetadataGenerator],
  ] as const) {
    it(`${brand}MetadataGenerator names ${brand}, plants EXIF and XMP, and emits only ${brand} files`, () => {
      expect(generator.format).toBe(brand);
      expect(generator.metadataKinds).toEqual(["EXIF", "XMP"]);
      const samples = fc.sample(generator.arbitrary(), {
        seed: FC_SEED,
        numRuns: FC_RUNS,
      });
      expect(samples).toHaveLength(FC_RUNS);
      for (const sample of samples) {
        expect(ftypBrandOf(sample.bytes)).toBe(brand);
        expect(sample.planted.map((item) => item.kind)).toEqual([
          "EXIF",
          "XMP",
        ]);
        assertPlanted(sample.bytes, sample.planted);
      }
    });
  }
});

describe("ISOBMFF_ARM_FLOORS edges (QUA-03)", () => {
  it("adjacency: assertFloors passes at exactly the floor and fails at floor - 1 (hand-built counter)", () => {
    const atFloor = { ...ISOBMFF_ARM_FLOORS };
    expect(() => assertFloors(atFloor, ISOBMFF_ARM_FLOORS)).not.toThrow();
    for (const [arm, floor] of Object.entries(ISOBMFF_ARM_FLOORS)) {
      const belowFloor = { ...ISOBMFF_ARM_FLOORS, [arm]: floor - 1 };
      expect(() => assertFloors(belowFloor, ISOBMFF_ARM_FLOORS)).toThrow(
        `${arm}: measured ${floor - 1}, required at least ${floor}`,
      );
    }
  });

  it("empty arm: a generator variant with no Exif/XMP arm fails the floor assertion itself (D-21 negative control (3))", () => {
    for (const brand of ["heic", "avif"] as const) {
      const counters = createCounters();
      for (const { arms } of fc.sample(
        isobmffArmSampleArbitraryWithoutMetadataArm(brand),
        { seed: FC_SEED, numRuns: FC_RUNS },
      )) {
        expect(arms).toEqual(["hazard"]);
        countSample(counters, arms);
      }
      expect(counters["hazard"]).toBe(FC_RUNS);
      expect(() => assertFloors(counters, ISOBMFF_ARM_FLOORS)).toThrow(
        "xmp: measured 0, required at least 50",
      );
    }
  });

  it("ordering: the same seed replays the identical byte sequence per brand, and a different seed differs", () => {
    const bytesAt = (brand: "heic" | "avif", seed: number): string[] =>
      fc
        .sample(isobmffArmSampleArbitrary(brand), {
          seed,
          numRuns: FC_RUNS,
        })
        .map(({ sample }) => sample.bytes.toString("hex"));
    for (const brand of ["heic", "avif"] as const) {
      const first = bytesAt(brand, FC_SEED);
      expect(bytesAt(brand, FC_SEED)).toEqual(first);
      expect(bytesAt(brand, FC_SEED + 1)).not.toEqual(first);
    }
  });
});
