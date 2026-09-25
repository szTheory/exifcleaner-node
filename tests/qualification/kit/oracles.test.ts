import { describe, expect, it } from "vitest";
import { EXCLUDED_GROUPS, metadataGroupDisposition } from "./oracles.js";

describe("metadataGroupDisposition (D-12 total group mapping)", () => {
  describe("excluded groups (measured file-system/tool-volatile/derived)", () => {
    for (const group of EXCLUDED_GROUPS) {
      it(`excludes ${group}`, () => {
        expect(metadataGroupDisposition(group)).toEqual({ compared: false });
      });
    }
  });

  describe("EXIF family", () => {
    for (const group of [
      "IFD0",
      "IFD1",
      "ExifIFD",
      "GPS",
      "InteropIFD",
      "SubIFD",
      "MakerNotes",
    ]) {
      it(`maps ${group} to the EXIF namespace`, () => {
        expect(metadataGroupDisposition(group)).toEqual({
          compared: true,
          namespace: "EXIF",
        });
      });
    }
  });

  describe("XMP family", () => {
    for (const group of ["XMP", "XMP-dc", "XMP-tiff"]) {
      it(`maps ${group} to the XMP namespace`, () => {
        expect(metadataGroupDisposition(group)).toEqual({
          compared: true,
          namespace: "XMP",
        });
      });
    }
  });

  describe("ICC family", () => {
    for (const group of ["ICC_Profile", "ICC-header", "ICC-view", "ICC-meas"]) {
      it(`maps ${group} to the ICC_Profile namespace`, () => {
        expect(metadataGroupDisposition(group)).toEqual({
          compared: true,
          namespace: "ICC_Profile",
        });
      });
    }
  });

  describe("catch-all: an unrecognized group is compared under its own name, never dropped", () => {
    for (const group of ["Adobe", "APP14", "PNG-pHYs"]) {
      it(`compares ${group} under its own group name`, () => {
        expect(metadataGroupDisposition(group)).toEqual({
          compared: true,
          namespace: group,
        });
      });
    }

    it("metadataGroupDisposition(APP14) and metadataGroupDisposition(Adobe) are compared", () => {
      expect(metadataGroupDisposition("APP14").compared).toBe(true);
      expect(metadataGroupDisposition("Adobe").compared).toBe(true);
    });
  });

  it("is total: never returns an ambiguous result for an unknown group", () => {
    const result = metadataGroupDisposition("SomeFutureVendorGroup");
    expect(result.compared).toBe(true);
    if (result.compared) expect(result.namespace).toBe("SomeFutureVendorGroup");
  });
});
