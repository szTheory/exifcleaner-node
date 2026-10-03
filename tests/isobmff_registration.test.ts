// HEIC/AVIF registration invariants (62.1-07): pins the published D-05 capability literals against
// the classifier and engine constants they must agree with, the D-07 preserves-equality between
// the two ISOBMFF formats (type-level and runtime, with a negative control), and the D-08
// single-match property of the real registry over a table of buffers (with an overlapping-handler
// negative control).
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getCapabilities, sanitizeFile } from "../src/engine.js";
import {
  registeredHandlersForTests,
  type RegisteredHandler,
} from "../src/admission/registry.js";
import { AVIF_CAPABILITY } from "../src/admission/avif-handler.js";
import { HEIC_CAPABILITY } from "../src/admission/heic-handler.js";
import { AVIF_BRAND, HEIC_BRANDS } from "../src/isobmff/brand.js";
import {
  ISOBMFF_MAX_BOX_COUNT,
  ISOBMFF_MAX_BOX_DEPTH,
  ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
  ISOBMFF_MAX_META_BYTES,
} from "../src/isobmff/caps.js";
import { HEIF_REFUSALS, type HeifRefusal } from "../src/isobmff/refusals.js";
import type {
  AvifCapabilities,
  FormatCapabilities,
  HeicCapabilities,
} from "../src/types.js";
import { ftypBox } from "./isobmff-support/builder.js";
import { QUALIFICATION_FORMATS } from "./qualification/formats.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// D-07: the two ISOBMFF formats advertise the same preserves record, at type level.
const preservesTypePin: Equals<
  HeicCapabilities["preserves"],
  AvifCapabilities["preserves"]
> = true;
// D-05: `refuses` is the coarse HeifRefusal set, element type exactly HeifRefusal.
const heicRefusesElementPin: Equals<
  HeicCapabilities["refuses"][number],
  HeifRefusal
> = true;
const avifRefusesElementPin: Equals<
  AvifCapabilities["refuses"][number],
  HeifRefusal
> = true;
const heicDetectionPin: Equals<HeicCapabilities["detection"], "magic"> = true;
const avifDetectionPin: Equals<AvifCapabilities["detection"], "magic"> = true;
void [
  preservesTypePin,
  heicRefusesElementPin,
  avifRefusesElementPin,
  heicDetectionPin,
  avifDetectionPin,
];

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const HEIF_ENC_HEIC = join(
  TESTS_DIR,
  "isobmff-support",
  "fixtures",
  "heif-enc-grid.heic",
);
const HEIF_ENC_AVIF = join(
  TESTS_DIR,
  "isobmff-support",
  "fixtures",
  "heif-enc-grid.avif",
);
const SIGNED_HEIC = join(
  TESTS_DIR,
  "corpus",
  "constructed",
  "heic",
  "c2pa-signed.heic",
);
const SIGNED_AVIF = join(
  TESTS_DIR,
  "corpus",
  "constructed",
  "avif",
  "c2pa-signed.avif",
);

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
    join(tmpdir(), "exifcleaner-isobmff-registration-"),
  );
  directories.push(directory);
  return directory;
}

/** D-07 runtime helper: the two capabilities' preserves records must be deep-equal. */
function expectSamePreserves(
  left: FormatCapabilities,
  right: FormatCapabilities,
): void {
  expect(left.preserves).toEqual(right.preserves);
}

/** The same 256-byte window `selectHandler` reads before asking each handler. */
function magicWindow(bytes: Buffer): Buffer {
  return bytes.subarray(0, 256);
}

/**
 * D-08 helper: over every row, at most one handler in `handlers` matches. Throws (through
 * `expect`) naming the row when two or more do.
 */
function expectAtMostOneMatch(
  handlers: readonly Pick<RegisteredHandler, "matches">[],
  rows: ReadonlyMap<string, Buffer>,
): void {
  for (const [name, row] of rows) {
    const matching = handlers.filter((handler) =>
      handler.matches(magicWindow(row)),
    ).length;
    expect(matching, `row ${name}`).toBeLessThanOrEqual(1);
  }
}

async function bufferTable(): Promise<ReadonlyMap<string, Buffer>> {
  const rows = new Map<string, Buffer>();
  for (const [format, entry] of Object.entries(QUALIFICATION_FORMATS)) {
    rows.set(`qualification sample ${format}`, entry.sample());
  }
  rows.set("heif-enc-grid.heic", await readFile(HEIF_ENC_HEIC));
  rows.set("heif-enc-grid.avif", await readFile(HEIF_ENC_AVIF));
  rows.set("c2pa-signed.heic", await readFile(SIGNED_HEIC));
  rows.set("c2pa-signed.avif", await readFile(SIGNED_AVIF));
  rows.set("mif1-only", ftypBox("mif1", 0, ["mif1"]));
  rows.set("both-brands", ftypBox("heic", 0, ["mif1", "heic", "avif"]));
  rows.set("msf1", ftypBox("msf1", 0, ["msf1"]));
  rows.set("avis", ftypBox("avis", 0, ["avis"]));
  rows.set("mif2-only", ftypBox("mif2", 0, ["mif2"]));
  rows.set(
    "ftyp-larger-than-256-bytes",
    ftypBox(
      "heic",
      0,
      Array.from({ length: 65 }, () => "heic"),
    ),
  );
  rows.set("truncated-ftyp", Buffer.from("ftyp", "ascii"));
  rows.set("non-isobmff", Buffer.from("not an image at all", "ascii"));
  return rows;
}

describe("HEIC/AVIF registration invariants (62.1-07)", () => {
  describe("D-05 capability literals", () => {
    it("HEIC brands equal the classifier's HEIC_BRANDS and AVIF brands equal [AVIF_BRAND]", () => {
      expect([...HEIC_CAPABILITY.brands]).toEqual([...HEIC_BRANDS]);
      expect([...AVIF_CAPABILITY.brands]).toEqual([AVIF_BRAND]);
    });

    it("MIME types and extensions: .heif only under heic, no .hif, no sequence MIME type", () => {
      expect(HEIC_CAPABILITY.mimeTypes).toEqual(["image/heic", "image/heif"]);
      expect(HEIC_CAPABILITY.extensions).toEqual([".heic", ".heif"]);
      expect(AVIF_CAPABILITY.mimeTypes).toEqual(["image/avif"]);
      expect(AVIF_CAPABILITY.extensions).toEqual([".avif"]);
      for (const capability of getCapabilities().formats) {
        expect(capability.extensions).not.toContain(".hif");
        for (const mime of capability.mimeTypes) {
          expect(mime).not.toMatch(/sequence/u);
        }
        if (capability.format !== "heic") {
          expect(capability.extensions).not.toContain(".heif");
        }
      }
    });

    it("refuses equals HEIF_REFUSALS in order; removes, limits and detection are pinned", () => {
      for (const capability of [HEIC_CAPABILITY, AVIF_CAPABILITY]) {
        expect([...capability.refuses]).toEqual([...HEIF_REFUSALS]);
        expect(capability.removes).toEqual(["EXIF", "XMP", "ICC", "C2PA"]);
        expect(capability.limits).toEqual({
          maxMetaBytes: ISOBMFF_MAX_META_BYTES,
          maxBoxCount: ISOBMFF_MAX_BOX_COUNT,
          maxBoxDepth: ISOBMFF_MAX_BOX_DEPTH,
          maxBufferedBytesTotal: ISOBMFF_MAX_BUFFERED_BYTES_TOTAL,
        });
        expect(capability.detection).toBe("magic");
        expect(capability.inspect).toBe(true);
        expect(capability.sanitize).toBe(true);
        expect(capability.validation).toEqual({
          container: "full",
          codecBitstream: "not-decoded",
        });
      }
    });

    it("the colorProfile block equals PNG's", () => {
      const png = getCapabilities().formats.find(
        (capability) => capability.format === "png",
      );
      expect(png).toBeDefined();
      if (png === undefined || png.format !== "png") return;
      expect(HEIC_CAPABILITY.colorProfile).toEqual(png.colorProfile);
      expect(AVIF_CAPABILITY.colorProfile).toEqual(png.colorProfile);
    });

    it("the registered handlers publish exactly these frozen literals", () => {
      const byFormat = new Map(
        getCapabilities().formats.map((capability) => [
          capability.format,
          capability,
        ]),
      );
      expect(byFormat.get("heic")).toBe(HEIC_CAPABILITY);
      expect(byFormat.get("avif")).toBe(AVIF_CAPABILITY);
      expect(Object.isFrozen(HEIC_CAPABILITY)).toBe(true);
      expect(Object.isFrozen(AVIF_CAPABILITY)).toBe(true);
    });
  });

  describe("D-07 preserves equality", () => {
    it("HEIC and AVIF preserves records are deep-equal at runtime", () => {
      expectSamePreserves(HEIC_CAPABILITY, AVIF_CAPABILITY);
      expect(HEIC_CAPABILITY.preserves).toEqual({
        orientation: true,
        colorProfile: true,
        timestamps: true,
        resolution: true,
        imagePayload: true,
        animationPayload: false,
      });
    });

    it("negative control: a copy whose resolution flag differs fails the same helper", () => {
      const mutated = {
        ...AVIF_CAPABILITY,
        preserves: { ...AVIF_CAPABILITY.preserves, resolution: false },
      } as unknown as FormatCapabilities;
      expect(() => expectSamePreserves(HEIC_CAPABILITY, mutated)).toThrow();
    });

    it("AVIF bytes saved as source.heic sanitize natively, reporting format avif", async () => {
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.heic");
      await copyFile(HEIF_ENC_AVIF, sourcePath);
      const result = await sanitizeFile({
        sourcePath,
        destinationPath: join(directory, "output.heic"),
        preserveOrientation: true,
        preserveColorProfile: true,
        preserveTimestamps: true,
        preserveResolution: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.format).toBe("avif");
    });

    it("HEIC bytes saved as source.avif sanitize natively, reporting format heic", async () => {
      const directory = await freshDirectory();
      const sourcePath = join(directory, "source.avif");
      await copyFile(HEIF_ENC_HEIC, sourcePath);
      const result = await sanitizeFile({
        sourcePath,
        destinationPath: join(directory, "output.avif"),
        preserveOrientation: true,
        preserveColorProfile: true,
        preserveTimestamps: true,
        preserveResolution: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.format).toBe("heic");
    });
  });

  describe("D-08 registry order and single match", () => {
    it("getCapabilities().formats lists webp, png, jpeg, heic, avif in that order", () => {
      expect(getCapabilities().formats.map((c) => c.format)).toEqual([
        "webp",
        "png",
        "jpeg",
        "heic",
        "avif",
      ]);
    });

    it("every buffer in the table matches at most one registered handler", async () => {
      const rows = await bufferTable();
      expectAtMostOneMatch(registeredHandlersForTests(), rows);
      // The table is not vacuous: each registered format's sample is matched by exactly one.
      for (const format of Object.keys(QUALIFICATION_FORMATS)) {
        const row = rows.get(`qualification sample ${format}`);
        expect(row).toBeDefined();
        if (row === undefined) continue;
        const matching = registeredHandlersForTests().filter((handler) =>
          handler.matches(magicWindow(row)),
        );
        expect(matching.map((handler) => handler.capability.format)).toEqual([
          format,
        ]);
      }
    });

    it("negative control: an overlapping test handler makes the helper fail", async () => {
      const rows = await bufferTable();
      const overlapping = { matches: (): boolean => true };
      expect(() =>
        expectAtMostOneMatch(
          [...registeredHandlersForTests(), overlapping],
          rows,
        ),
      ).toThrow();
    });
  });
});
