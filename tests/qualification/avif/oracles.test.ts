// AVIF ExifTool differential profile tests (62.1-05, D-27, QUA-01). Still unregistered (D-03) --
// native output is produced only through the `setRegisteredHandlersForTests` test seam, never a
// real registered handler.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setRegisteredHandlersForTests } from "../../../src/admission/registry.js";
import { sanitizeFile } from "../../../src/engine.js";
import { createIsobmffWriterHandlerForTests } from "../../isobmff-support/test-handler.js";
import { av1C, box, colrProf, ispe } from "../../isobmff-support/builder.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
} from "../../isobmff-support/hostile.js";
import {
  compareIsobmffFreeSkip,
  compareIsobmffMetadataNamespaces,
  compareIsobmffStructuralParts,
  isobmffFreeSkipBoxes,
  runIsobmffDifferential,
  type IsobmffFreeSkipBox,
} from "../../isobmff-support/differential.js";
import type { MetadataProjection } from "../kit/oracles.js";
import { iccProfileV4 } from "../../fixtures.js";
import {
  AVIF_PERMITTED_DIFFERENCES,
  assertAvifOracleToolsAvailable,
  avifDifferentialProfile,
} from "./oracles.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "isobmff-support",
  "fixtures",
);
const AVIF_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.avif");
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

const ALL_FALSE_PRESERVATION: Preservation = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
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
  assertAvifOracleToolsAvailable();
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-avif-oracles-"));
  try {
    const sourcePath = join(directory, "source.avif");
    await writeFile(sourcePath, sourceBytes);
    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("avif"),
    ]);
    try {
      const destinationPath = join(directory, "destination.avif");
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

/** A minimal structurally-valid AVIF carrying a `colr` `prof` ICC property on its primary item
 * and no Exif/mime items -- D-16/F-HEIC-ICC is independent of D-13's minimal Exif synthesis. */
function buildIccFixtureAvif(): Buffer {
  const primaryPayload = Buffer.from("avif-icc-primary-bytes", "ascii");
  const spec: AssembleHeifSpec = {
    majorBrand: "avif",
    compatibleBrands: ["mif1", "avif"],
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "av01",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2, 3],
      },
    ],
    properties: [
      ispe(32, 32),
      av1C(Buffer.from([0x81, 0x08, 0x0c, 0x00])),
      colrProf(iccProfileV4({ deviceClass: "mntr" })),
    ],
    mdatPayload: primaryPayload,
  };
  return assembleHeif(spec);
}

describe("AVIF differential (62.1-05)", () => {
  it.runIf(LINUX_X64)(
    "sanitizes heif-enc-grid.avif through the seam with default settings and passes the ExifTool differential (62.1-05)",
    async () => {
      const source = await readFile(AVIF_FIXTURE);
      const output = await produceNativeOutput(source, DEFAULT_PRESERVATION);
      runIsobmffDifferential({
        caseId: "avif-default-settings",
        profile: avifDifferentialProfile,
        source,
        output,
        preserveOrientation: DEFAULT_PRESERVATION.preserveOrientation,
        preserveColorProfile: DEFAULT_PRESERVATION.preserveColorProfile,
        preserveResolution: DEFAULT_PRESERVATION.preserveResolution,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures emptied Exif/XMP metadata entries as the only permitted AVIF structural difference (62.1-05)",
    async () => {
      const source = await readFile(AVIF_FIXTURE);
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "avif-emptied-metadata",
        profile: avifDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool keeping ICC when not preserving as a permitted AVIF difference (62.1-05)",
    async () => {
      const source = buildIccFixtureAvif();
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "avif-icc-not-preserving",
        profile: avifDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool's minimal-Exif YCbCrPositioning companion as a permitted AVIF difference (62.1-05)",
    async () => {
      const source = await readFile(AVIF_FIXTURE);
      const output = await produceNativeOutput(source, {
        ...ALL_FALSE_PRESERVATION,
        preserveOrientation: true,
      });
      runIsobmffDifferential({
        caseId: "avif-ycbcr-positioning",
        profile: avifDifferentialProfile,
        source,
        output,
        preserveOrientation: true,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool keeping top-level free/skip as a permitted AVIF difference (62.1-05)",
    async () => {
      const fixture = await readFile(AVIF_FIXTURE);
      const source = Buffer.concat([
        fixture,
        box("free", Buffer.alloc(16, 0xab)),
        box("skip", Buffer.alloc(16, 0xcd)),
      ]);
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "avif-free-skip",
        profile: avifDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it("cites the exact live test title and docs/isobmff.md heading for every AVIF permitted difference", () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const testFileText = readFileSync(testFilePath, "utf8");
    const docsPath = join(
      dirname(testFilePath),
      "..",
      "..",
      "..",
      "docs",
      "isobmff.md",
    );
    const docsText = readFileSync(docsPath, "utf8");
    expect(AVIF_PERMITTED_DIFFERENCES).toHaveLength(5);
    for (const entry of AVIF_PERMITTED_DIFFERENCES) {
      expect(testFileText).toContain(entry.measurement);
      expect(docsText).toContain(entry.docsHeading);
    }
  });

  describe("pure red controls (no ExifTool)", () => {
    const emptyProjection = (): MetadataProjection => ({
      warnings: [],
      namespaces: {},
    });

    it("a native output with an extra XMP tag throws (leak)", () => {
      const output: MetadataProjection = {
        warnings: [],
        namespaces: { XMP: [{ XMPToolkit: "leaked" }] },
      };
      expect(() =>
        compareIsobmffMetadataNamespaces(output, emptyProjection(), {
          allowYCbCrPositioningCompanion: false,
        }),
      ).toThrow(/Unpermitted metadata difference: XMP/);
    });

    it("a reference whose thumbnail item is missing throws (over-strip of a non-metadata item)", () => {
      const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1", "infe:hvc1"];
      const referenceParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).toThrow(/Unpermitted structural difference: infe:hvc1/);
    });

    it("an nclx or irot difference throws", () => {
      const outputParts = ["ftyp", "meta", "mdat", "ipco:irot:aaaa"];
      const referenceParts = ["ftyp", "meta", "mdat", "ipco:irot:bbbb"];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).toThrow(/Unpermitted structural difference: ipco:irot:aaaa/);

      const outputNclxParts = ["ftyp", "meta", "mdat", "ipco:nclx:aaaa"];
      const referenceNclxParts = ["ftyp", "meta", "mdat", "ipco:nclx:bbbb"];
      expect(() =>
        compareIsobmffStructuralParts(outputNclxParts, referenceNclxParts),
      ).toThrow(/Unpermitted structural difference: ipco:nclx:aaaa/);
    });

    it("explains reference-only infe:Exif/infe:mime and free/skip structural parts, in any order (entries a/e)", () => {
      const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
      const referenceParts = [
        "mdat",
        "infe:mime",
        "free",
        "ftyp",
        "infe:hvc1",
        "infe:Exif",
        "skip",
        "meta",
      ];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).not.toThrow();
    });

    it.each([
      ["first", ["bogus-part", "ftyp", "meta", "mdat", "infe:hvc1"]],
      ["middle", ["ftyp", "meta", "bogus-part", "mdat", "infe:hvc1"]],
      ["last", ["ftyp", "meta", "mdat", "infe:hvc1", "bogus-part"]],
    ])(
      "an unlisted reference-only part at the %s position throws",
      (_label, referenceParts) => {
        const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
        expect(() =>
          compareIsobmffStructuralParts(outputParts, referenceParts),
        ).toThrow(/Unpermitted structural difference: bogus-part/);
      },
    );

    it("an empty permitted set never admits a difference (empty edge)", () => {
      expect(() => compareIsobmffStructuralParts([], [])).not.toThrow();
      expect(() => compareIsobmffStructuralParts([], ["bogus-part"])).toThrow(
        /Unpermitted structural difference: bogus-part/,
      );
    });

    it("explains a free box before mdat in reference and a skip box after mdat in source, by presence and bytes, never by order (entry e adjacency)", () => {
      const sourceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
        { type: "skip", sha256: "b".repeat(64) },
      ];
      const referenceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "skip", sha256: "b".repeat(64) },
        { type: "free", sha256: "a".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(sourceFreeSkip, [], referenceFreeSkip),
      ).not.toThrow();
    });

    it("a free/skip box with the same type but different bytes throws (entry e byte identity)", () => {
      const sourceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
      ];
      const referenceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "c".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(sourceFreeSkip, [], referenceFreeSkip),
      ).toThrow(/Stale permitted difference: exiftool-keeps-free-skip/);
    });

    it("free/skip surviving natively throws, even when the reference also keeps it", () => {
      const freeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(freeSkip, freeSkip, freeSkip),
      ).toThrow(
        /Unpermitted structural difference: free\/skip survived natively/,
      );
    });

    it("isobmffFreeSkipBoxes reads type and payload sha256 for a synthetic free/skip pair", () => {
      const bytes = Buffer.concat([
        box("ftyp", Buffer.alloc(4)),
        box("free", Buffer.alloc(16, 0xab)),
        box("skip", Buffer.alloc(16, 0xcd)),
      ]);
      expect(isobmffFreeSkipBoxes(bytes).map((entry) => entry.type)).toEqual([
        "free",
        "skip",
      ]);
    });
  });
});
