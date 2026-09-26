import { describe, expect, it } from "vitest";
import {
  EXCLUDED_GROUPS,
  compareDifferential,
  metadataGroupDisposition,
  type MetadataProjection,
  type PermittedKind,
} from "./oracles.js";

const KINDS: readonly PermittedKind[] = [
  { id: "EXIF:Orientation", measurement: "synthetic orientation measurement" },
  { id: "ICC_Profile:RawProfile", measurement: "synthetic ICC measurement" },
];

const IMPLIED_KINDS: readonly PermittedKind[] = [
  {
    id: "EXIF:Orientation",
    measurement: "synthetic orientation measurement",
    impliedDifference: {
      namespace: "Vendor",
      explains: (onlyLeft, activeKindIds) =>
        onlyLeft.length === 1 &&
        Object.keys(onlyLeft[0]!).length === 1 &&
        onlyLeft[0]!.Flag ===
          (activeKindIds.includes("EXIF:Orientation") ? 1 : 0),
    },
  },
];

// WR-01 gap closure: an ICC_Profile:RawProfile grant that also implies a derived
// Vendor Flag delta, mirroring IMPLIED_KINDS's EXIF:Orientation shape. `explains`
// accepts exactly one `{ Flag: 1 }` entry, and only when the ICC grant is active.
const IMPLIED_ICC_KINDS: readonly PermittedKind[] = [
  {
    id: "ICC_Profile:RawProfile",
    measurement: "synthetic ICC measurement",
    impliedDifference: {
      namespace: "Vendor",
      explains: (onlyLeft, activeKindIds) =>
        onlyLeft.length === 1 &&
        Object.keys(onlyLeft[0]!).length === 1 &&
        onlyLeft[0]!.Flag === 1 &&
        activeKindIds.includes("ICC_Profile:RawProfile"),
    },
  },
];

function projection(
  namespaces: Readonly<
    Record<string, readonly Readonly<Record<string, unknown>>[]>
  >,
  rawIccSha256?: string,
): MetadataProjection {
  return {
    warnings: [],
    namespaces,
    ...(rawIccSha256 === undefined ? {} : { rawIccSha256 }),
  };
}

const EMPTY_SOURCE = projection({ EXIF: [], XMP: [], ICC_Profile: [] });

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
    for (const group of ["Adobe", "APP14", "Vendor-Resolution"]) {
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

describe("compareDifferential (D-10, D-12 two-directional differential)", () => {
  it("returns [] when native and reference projections are equal", () => {
    const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    expect(
      compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
    ).toEqual([]);
  });

  it("throws Unpermitted metadata difference for an extra native tag (leak)", () => {
    const native = projection({
      EXIF: [{ Artist: "x" }],
      XMP: [],
      ICC_Profile: [],
    });
    const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    expect(() =>
      compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
    ).toThrow("Unpermitted metadata difference");
  });

  it("throws Over-strip naming the group when reference keeps a tag native lacks", () => {
    const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    const reference = projection({
      EXIF: [],
      XMP: [],
      ICC_Profile: [],
      Adobe: [{ DCTEncodeVersion: 100 }],
    });
    expect(() =>
      compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
    ).toThrow("Over-strip: Adobe");
  });

  describe("EXIF:Orientation grant", () => {
    it("permits native to hold exactly one Orientation entry the reference lacks", () => {
      const source = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const native = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(
        compareDifferential(
          source,
          native,
          reference,
          ["EXIF:Orientation=6"],
          KINDS,
        ),
      ).toEqual([]);
    });

    it("throws when any other EXIF delta accompanies the granted Orientation", () => {
      const native = projection({
        EXIF: [{ Orientation: 6 }, { Make: "CameraCo" }],
        XMP: [],
        ICC_Profile: [],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          EMPTY_SOURCE,
          native,
          reference,
          ["EXIF:Orientation=6"],
          KINDS,
        ),
      ).toThrow("Requested Orientation was not preserved");
    });
  });

  describe("ICC_Profile:RawProfile grant", () => {
    const sha = "c".repeat(64);

    it("permits native ICC_Profile to equal the source's when both raw digests match the grant", () => {
      const source = projection(
        { EXIF: [], XMP: [], ICC_Profile: [{ RedTRC: 1 }] },
        sha,
      );
      const native = projection(
        { EXIF: [], XMP: [], ICC_Profile: [{ RedTRC: 1 }] },
        sha,
      );
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(
        compareDifferential(
          source,
          native,
          reference,
          [`ICC_Profile:RawProfile=${sha}`],
          KINDS,
        ),
      ).toEqual([]);
    });

    it("throws when the raw digest does not match the granted value", () => {
      const source = projection(
        { EXIF: [], XMP: [], ICC_Profile: [{ RedTRC: 1 }] },
        "d".repeat(64),
      );
      const native = projection(
        { EXIF: [], XMP: [], ICC_Profile: [{ RedTRC: 1 }] },
        "d".repeat(64),
      );
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          source,
          native,
          reference,
          [`ICC_Profile:RawProfile=${sha}`],
          KINDS,
        ),
      ).toThrow("Requested ICC profile was not preserved");
    });
  });

  it("throws Unknown permitted metadata difference for a grant kind outside the profile", () => {
    const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    expect(() =>
      compareDifferential(
        EMPTY_SOURCE,
        native,
        reference,
        ["XMP:Foo=1"],
        KINDS,
      ),
    ).toThrow("Unknown permitted metadata difference");
  });

  it("throws Stale permitted difference when a grant explains no actual delta", () => {
    const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
    expect(() =>
      compareDifferential(
        EMPTY_SOURCE,
        native,
        reference,
        ["EXIF:Orientation=6"],
        KINDS,
      ),
    ).toThrow("Stale permitted difference");
  });

  describe("KIT-04 edge cases", () => {
    it("adjacency: identical projections yield [], any single-tag delta throws", () => {
      const equalNative = projection({ EXIF: [{ Make: "x" }] });
      const equalReference = projection({ EXIF: [{ Make: "x" }] });
      expect(
        compareDifferential(
          EMPTY_SOURCE,
          equalNative,
          equalReference,
          [],
          KINDS,
        ),
      ).toEqual([]);

      const extraNative = projection({ EXIF: [{ Make: "x" }, { Model: "y" }] });
      expect(() =>
        compareDifferential(
          EMPTY_SOURCE,
          extraNative,
          equalReference,
          [],
          KINDS,
        ),
      ).toThrow("Unpermitted metadata difference");

      const missingNative = projection({ EXIF: [] });
      expect(() =>
        compareDifferential(
          EMPTY_SOURCE,
          missingNative,
          equalReference,
          [],
          KINDS,
        ),
      ).toThrow("Over-strip");
    });

    it("empty: both sides empty passes; empty native against a non-empty reference over-strips", () => {
      const bothEmpty = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(
        compareDifferential(EMPTY_SOURCE, bothEmpty, bothEmpty, [], KINDS),
      ).toEqual([]);

      const nonEmptyReference = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: [],
        Adobe: [{ DCTEncodeVersion: 100 }],
      });
      expect(() =>
        compareDifferential(
          EMPTY_SOURCE,
          bothEmpty,
          nonEmptyReference,
          [],
          KINDS,
        ),
      ).toThrow("Over-strip: Adobe");
    });

    it("ordering: reversed entry order within a namespace still yields []", () => {
      const native = projection({
        EXIF: [{ Make: "x" }, { Model: "y" }],
      });
      const reference = projection({
        EXIF: [{ Model: "y" }, { Make: "x" }],
      });
      expect(
        compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
      ).toEqual([]);
    });
  });

  describe("PermittedKind.impliedDifference (a grant also covers a derived tag)", () => {
    it("an active grant's implied namespace delta is explained and does not throw", () => {
      const source = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const native = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
        Vendor: [{ Flag: 1 }],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(
        compareDifferential(
          source,
          native,
          reference,
          ["EXIF:Orientation=6"],
          IMPLIED_KINDS,
        ),
      ).toEqual([]);
    });

    it("an implied-tag value that doesn't match the grant still fails", () => {
      const source = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const native = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
        Vendor: [{ Flag: 99 }],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          source,
          native,
          reference,
          ["EXIF:Orientation=6"],
          IMPLIED_KINDS,
        ),
      ).toThrow("Unpermitted metadata difference: Vendor");
    });

    it("an implied namespace with no active grant declaring it is not consulted", () => {
      const native = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: [],
        Vendor: [{ Flag: 1 }],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(EMPTY_SOURCE, native, reference, [], IMPLIED_KINDS),
      ).toThrow("Unpermitted metadata difference: Vendor");
    });
  });

  describe("differential negative controls (D-13)", () => {
    it("(a) injected leak: an extra native EXIF entry throws Unpermitted metadata difference", () => {
      const native = projection({
        EXIF: [{ Artist: "x" }],
        XMP: [],
        ICC_Profile: [],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
      ).toThrow("Unpermitted metadata difference");
    });

    it("(b) over-strip: a reference-kept Adobe entry missing from native throws Over-strip: Adobe", () => {
      const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      const reference = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: [],
        Adobe: [{ DCTEncodeVersion: 100 }],
      });
      expect(() =>
        compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
      ).toThrow("Over-strip: Adobe");
    });

    it("(c) silent-drop fix: APP14 is compared (was silently dropped under the old mapping) and over-strips", () => {
      expect(metadataGroupDisposition("APP14").compared).toBe(true);
      const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      const reference = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: [],
        APP14: [{ DCTEncodeVersion: 100 }],
      });
      expect(() =>
        compareDifferential(EMPTY_SOURCE, native, reference, [], KINDS),
      ).toThrow("Over-strip: APP14");
    });

    it("(d) stale grant: EXIF:Orientation=6 with neither source nor native carrying Orientation throws", () => {
      const native = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          EMPTY_SOURCE,
          native,
          reference,
          ["EXIF:Orientation=6"],
          KINDS,
        ),
      ).toThrow("Stale permitted difference");
    });

    it("(e) stale grant masked by an implied delta: EXIF:Orientation=6 with no EXIF delta and an implied Vendor Flag delta still throws Stale permitted difference: EXIF:Orientation (WR-01)", () => {
      const source = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const native = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: [],
        Vendor: [{ Flag: 1 }],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          source,
          native,
          reference,
          ["EXIF:Orientation=6"],
          IMPLIED_KINDS,
        ),
      ).toThrow("Stale permitted difference: EXIF:Orientation");
    });

    it("(f) mismatched grant: source carries Orientation 3 but the grant requests 6 throws Requested Orientation was not preserved (WR-01)", () => {
      const source = projection({
        EXIF: [{ Orientation: 3 }],
        XMP: [],
        ICC_Profile: [],
      });
      const native = projection({
        EXIF: [{ Orientation: 6 }],
        XMP: [],
        ICC_Profile: [],
      });
      const reference = projection({ EXIF: [], XMP: [], ICC_Profile: [] });
      expect(() =>
        compareDifferential(
          source,
          native,
          reference,
          ["EXIF:Orientation=6"],
          KINDS,
        ),
      ).toThrow("Requested Orientation was not preserved");
    });

    it("(g) ICC stale grant masked by an implied delta: an ICC_Profile:RawProfile grant with an unchanged ICC projection and an implied Vendor Flag delta still throws Stale permitted difference: ICC_Profile:RawProfile (WR-01)", () => {
      const grantedDigest = "a".repeat(64);
      const iccEntries = [{ RawProfile: "x" }];
      const source = projection(
        { EXIF: [], XMP: [], ICC_Profile: iccEntries },
        grantedDigest,
      );
      const native = projection(
        {
          EXIF: [],
          XMP: [],
          ICC_Profile: iccEntries,
          Vendor: [{ Flag: 1 }],
        },
        grantedDigest,
      );
      const reference = projection({
        EXIF: [],
        XMP: [],
        ICC_Profile: iccEntries,
      });
      expect(() =>
        compareDifferential(
          source,
          native,
          reference,
          [`ICC_Profile:RawProfile=${grantedDigest}`],
          IMPLIED_ICC_KINDS,
        ),
      ).toThrow("Stale permitted difference: ICC_Profile:RawProfile");
    });
  });
});
