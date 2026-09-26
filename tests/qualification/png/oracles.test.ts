import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../dist/index.js";
import { encodePngChunk } from "../../../src/png/chunks.js";
import {
  COLOUR_FIXTURES,
  exifWithOrientation,
  metadataPng,
  pngWithChunksBefore,
  screenshotShapedPng,
} from "../../fixtures.js";
import {
  assertPngPayloadIdentity,
  pngAdmitsUnregisteredAncillaryPart,
  pngDifferentialProfile,
  pngSanitizeOptionsForGrants,
  pngStructuralParts,
  runPngcheck,
} from "./oracles.js";

const admittedHost = process.platform === "linux" && process.arch === "x64";

describe("pngStructuralParts (56-07 Task 3)", () => {
  it("returns metadataPng()'s chunk types in file order", () => {
    expect(pngStructuralParts(metadataPng())).toEqual([
      "IHDR",
      "cHRM",
      "bKGD",
      "pHYs",
      "tEXt",
      "tIME",
      "IDAT",
      "IEND",
    ]);
  });
});

describe("pngSanitizeOptionsForGrants (56-07 Task 3)", () => {
  it("maps no grants to every preservation flag false", () => {
    expect(pngSanitizeOptionsForGrants([])).toEqual({
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveResolution: false,
      preserveTimestamps: false,
    });
  });

  it("maps an EXIF:Orientation grant to preserveOrientation", () => {
    expect(pngSanitizeOptionsForGrants(["EXIF:Orientation=6"])).toEqual({
      preserveOrientation: true,
      preserveColorProfile: false,
      preserveResolution: false,
      preserveTimestamps: false,
    });
  });

  it("maps an ICC_Profile:RawProfile grant to preserveColorProfile", () => {
    expect(
      pngSanitizeOptionsForGrants([`ICC_Profile:RawProfile=${"a".repeat(64)}`]),
    ).toEqual({
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveResolution: false,
      preserveTimestamps: false,
    });
  });

  it("maps a Resolution:Preserved grant to preserveResolution", () => {
    expect(pngSanitizeOptionsForGrants(["Resolution:Preserved"])).toEqual({
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveResolution: true,
      preserveTimestamps: false,
    });
  });
});

describe("pngAdmitsUnregisteredAncillaryPart (D-05)", () => {
  it("accepts an unregistered private ancillary chunk type", () => {
    expect(pngAdmitsUnregisteredAncillaryPart("prVt")).toBe(true);
  });

  it("accepts Android's private nine-patch chunk type", () => {
    expect(pngAdmitsUnregisteredAncillaryPart("npTc")).toBe(true);
  });

  it("rejects a registered-but-unmeasured chunk type (gIFg)", () => {
    expect(pngAdmitsUnregisteredAncillaryPart("gIFg")).toBe(false);
  });

  it("rejects a preserve-list chunk type (cHRM)", () => {
    expect(pngAdmitsUnregisteredAncillaryPart("cHRM")).toBe(false);
  });

  it("rejects a removed-by-default chunk type (tEXt)", () => {
    expect(pngAdmitsUnregisteredAncillaryPart("tEXt")).toBe(false);
  });
});

describe("pngDifferentialProfile (56-07 Task 3)", () => {
  it("admits exactly the four expected kind ids", () => {
    expect(
      pngDifferentialProfile.permittedKinds.map((kind) => kind.id),
    ).toEqual([
      "EXIF:Orientation",
      "ICC_Profile:RawProfile",
      "Resolution:Preserved",
      "Structure:UnregisteredAncillaryStripped",
    ]);
  });

  it("wires structuralParts to pngStructuralParts", () => {
    expect(pngDifferentialProfile.structuralParts).toBe(pngStructuralParts);
  });
});

interface SanitizeOptions {
  readonly preserveOrientation?: boolean;
  readonly preserveColorProfile?: boolean;
  readonly preserveTimestamps?: boolean;
  readonly preserveResolution?: boolean;
}

async function sanitize(
  bytes: Buffer,
  options: SanitizeOptions = {},
): Promise<Buffer> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-png-oracle-test-"),
  );
  const sourcePath = join(directory, "source.png");
  const destinationPath = join(directory, "output.png");
  try {
    await writeFile(sourcePath, bytes);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: options.preserveOrientation ?? false,
      preserveColorProfile: options.preserveColorProfile ?? false,
      preserveTimestamps: options.preserveTimestamps ?? false,
      preserveResolution: options.preserveResolution ?? false,
    });
    if (!result.ok) throw new Error(`sanitize failed: ${result.error.code}`);
    return await readFile(destinationPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface PngChunkLocation {
  readonly offset: number;
  readonly length: number;
  readonly dataOffset: number;
}

function findChunk(bytes: Buffer, type: string): PngChunkLocation | undefined {
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > bytes.length) break;
    if (chunkType === type) return { offset, length, dataOffset };
    offset = dataOffset + length + 4;
    if (chunkType === "IEND") break;
  }
  return undefined;
}

/**
 * Flips one byte inside the first `IDAT` chunk's data and recomputes that
 * chunk's own CRC with the src encoder (`encodePngChunk`) -- an
 * independently-generated mutant, never sharing code with the oracle it is
 * meant to catch.
 */
function flipFirstIdatByte(bytes: Buffer): Buffer {
  const chunk = findChunk(bytes, "IDAT");
  if (chunk === undefined) throw new Error("fixture has no IDAT chunk");
  const data = Buffer.from(
    bytes.subarray(chunk.dataOffset, chunk.dataOffset + chunk.length),
  );
  data[0] = (data[0]! ^ 0xff) & 0xff;
  const rebuilt = encodePngChunk("IDAT", data);
  return Buffer.concat([
    bytes.subarray(0, chunk.offset),
    rebuilt,
    bytes.subarray(chunk.dataOffset + chunk.length + 4),
  ]);
}

/** Flips one byte of the given chunk type's own 4-byte CRC trailer, leaving
 * its data untouched -- a pure CRC corruption, not a data corruption. */
function corruptChunkCrc(bytes: Buffer, type: string): Buffer {
  const chunk = findChunk(bytes, type);
  if (chunk === undefined) throw new Error(`fixture has no ${type} chunk`);
  const mutated = Buffer.from(bytes);
  const crcOffset = chunk.dataOffset + chunk.length;
  mutated[crcOffset] = (mutated[crcOffset]! ^ 0xff) & 0xff;
  return mutated;
}

const ALL_TRUE: Required<SanitizeOptions> = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
};

const ALL_FALSE: Required<SanitizeOptions> = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
};

interface IdentityCase {
  readonly id: string;
  readonly source: Buffer;
  readonly options: SanitizeOptions;
}

function identityCases(): readonly IdentityCase[] {
  const cases: IdentityCase[] = [
    { id: "metadata-png", source: metadataPng(), options: {} },
    {
      id: "screenshot-shaped-png-all-true",
      source: screenshotShapedPng(),
      options: ALL_TRUE,
    },
    {
      id: "screenshot-shaped-png-all-false",
      source: screenshotShapedPng(),
      options: ALL_FALSE,
    },
  ];
  for (const fixture of COLOUR_FIXTURES) {
    cases.push({
      id: `colour-${fixture.id}-preserve`,
      source: fixture.build(),
      options: { preserveColorProfile: true },
    });
    cases.push({
      id: `colour-${fixture.id}-strip`,
      source: fixture.build(),
      options: { preserveColorProfile: false },
    });
  }
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    cases.push({
      id: `orientation-${orientation}`,
      source: pngWithChunksBefore([["eXIf", exifWithOrientation(orientation)]]),
      options: { preserveOrientation: true },
    });
  }
  return cases;
}

describe("PNG-02 payload identity through independent oracles (Plan 08)", () => {
  it.runIf(admittedHost)(
    "proves decoded-pixel identity and pngcheck acceptance across the PNG fixture set",
    async () => {
      const cases = identityCases();
      expect(cases.length).toBeGreaterThan(0);
      for (const testCase of cases) {
        const output = await sanitize(testCase.source, testCase.options);
        expect(() =>
          assertPngPayloadIdentity(testCase.source, output),
        ).not.toThrow();
      }
    },
    180_000,
  );

  it.runIf(admittedHost)(
    "rejects an output whose IDAT pixels differ",
    async () => {
      const source = metadataPng();
      const output = await sanitize(source);
      const mutated = flipFirstIdatByte(output);
      expect(() => assertPngPayloadIdentity(source, mutated)).toThrow();
    },
    30_000,
  );

  it.runIf(admittedHost)(
    "rejects an output with a corrupted chunk CRC through pngcheck",
    async () => {
      const source = metadataPng();
      const output = await sanitize(source);
      // cHRM is in PNG_PRESERVED_CHUNK_TYPES -- unconditionally kept, so a
      // real sanitize output of metadataPng() still carries one.
      const mutated = corruptChunkCrc(output, "cHRM");
      expect(runPngcheck(mutated).ok).toBe(false);
    },
    30_000,
  );
});
