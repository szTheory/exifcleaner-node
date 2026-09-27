import { describe, expect, it } from "vitest";
import { xmpOrientation } from "../src/metadata/xmp.js";
import { xmpPacket, xmpWithOrientation } from "./fixtures.js";

/**
 * D-05: xmpOrientation is format-neutral, lives in src/metadata/xmp.ts, and
 * returns only a number, "invalid" or undefined -- never XMP bytes.
 */

function xmpWithOrientationElement(value: number | string): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/"><tiff:Orientation>${String(value)}</tiff:Orientation></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

describe("xmpOrientation", () => {
  it("attribute form: tiff:Orientation=\"6\" returns 6", () => {
    expect(xmpOrientation(xmpWithOrientation(6))).toBe(6);
  });

  it("element form: <tiff:Orientation>6</tiff:Orientation> returns 6", () => {
    expect(xmpOrientation(xmpWithOrientationElement(6))).toBe(6);
  });

  it('out-of-range value "9" returns "invalid"', () => {
    expect(xmpOrientation(xmpWithOrientation("9"))).toBe("invalid");
  });

  it('non-integer value "6.0" returns "invalid"', () => {
    expect(xmpOrientation(xmpWithOrientation("6.0"))).toBe("invalid");
  });

  it(
    "empty value: parseXmp drops empty-text entries as if absent (measured, " +
      "unchanged by this move), so an empty attribute returns undefined, not " +
      '"invalid" -- indistinguishable from no Orientation entry at all',
    () => {
      expect(xmpOrientation(xmpWithOrientation(""))).toBeUndefined();
    },
  );

  it("no Orientation entry returns undefined", () => {
    expect(xmpOrientation(xmpPacket())).toBeUndefined();
  });

  it("the return type is never a Buffer", () => {
    type Equals<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type ReturnT = ReturnType<typeof xmpOrientation>;
    const neverBuffer: Equals<Extract<ReturnT, Buffer>, never> = true;
    expect(neverBuffer).toBe(true);
  });
});
