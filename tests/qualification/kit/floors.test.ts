import { describe, expect, it } from "vitest";
import { assertFloors, countSample, createCounters } from "./floors.js";

describe("assertFloors (D-20 boundary cases)", () => {
  it("passes when a counter is exactly at its floor", () => {
    expect(() => assertFloors({ a: 10 }, { a: 10 })).not.toThrow();
  });

  it("throws naming the counter one below its floor", () => {
    expect(() => assertFloors({ a: 9 }, { a: 10 })).toThrow(/a: measured 9/);
  });

  it("treats a counter missing from counts as 0 and throws", () => {
    expect(() => assertFloors({}, { a: 10 })).toThrow(/a: measured 0/);
  });

  it("lists every violated counter in one error", () => {
    expect(() => assertFloors({ a: 1, b: 5 }, { a: 10, b: 10, c: 10 })).toThrow(
      /a: measured 1[\s\S]*b: measured 5[\s\S]*c: measured 0/,
    );
  });
});

describe("createCounters/countSample", () => {
  it("accumulates counts across repeated keys and samples", () => {
    const counters = createCounters();
    countSample(counters, ["arm:metadata", "kind:EXIF"]);
    countSample(counters, ["arm:metadata", "kind:XMP"]);
    expect(counters).toEqual({
      "arm:metadata": 2,
      "kind:EXIF": 1,
      "kind:XMP": 1,
    });
  });
});
