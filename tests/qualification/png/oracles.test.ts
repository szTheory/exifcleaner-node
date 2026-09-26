import { describe, expect, it } from "vitest";
import { metadataPng } from "../../fixtures.js";
import {
  pngAdmitsUnregisteredAncillaryPart,
  pngDifferentialProfile,
  pngSanitizeOptionsForGrants,
  pngStructuralParts,
} from "./oracles.js";

/**
 * Reserved for Plan 09's live external-oracle tests (`admittedHost`
 * gate, mirroring `webp/oracles.test.ts`'s shape). Unused by this plan's
 * host-independent suite; kept here so Plan 09 only has to add tests, not
 * re-derive the gate.
 */
const admittedHost = process.platform === "linux" && process.arch === "x64";
void admittedHost;

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
