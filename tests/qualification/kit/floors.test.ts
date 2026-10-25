import { describe, expect, it } from "vitest";
import {
  assertFloors,
  assertSlotRates,
  countSample,
  createCounters,
  parseStatisticsRates,
  slotRateFloors,
} from "./floors.js";

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

const row = (label: string, rate: string) =>
  `${label}${".".repeat(30 - label.length - rate.length)}${rate}%`;

describe("parseStatisticsRates", () => {
  it("parses label and percentage, ignoring non-row lines", () => {
    const rates = parseStatisticsRates([
      "",
      "not a row",
      row("one", "12.50"),
      row("two", "7.00"),
    ]);
    expect(rates).toEqual(
      new Map([
        ["one", 12.5],
        ["two", 7],
      ]),
    );
  });
});

describe("slotRateFloors", () => {
  it("states each rate as floor over the measured run count", () => {
    expect(
      slotRateFloors({ "k:a": 31, "k:b": 40 }, ["a", "b"], (l) => `k:${l}`),
    ).toEqual({ a: 15.5, b: 20 });
  });

  it("throws naming the slot when its floor key is missing", () => {
    expect(() =>
      slotRateFloors({ "k:a": 31 }, ["a", "b"], (l) => `k:${l}`),
    ).toThrow(/slot b/);
  });
});

describe("assertSlotRates (precision, empty and ordering)", () => {
  const floors = { a: 15.5, b: 20 };

  it("passes at exactly the floor and with rows in shuffled order", () => {
    expect(() =>
      assertSlotRates([row("b", "20.00"), row("a", "15.50")], floors),
    ).not.toThrow();
  });

  it("passes at half the print resolution below, throws 0.01 below naming the slot", () => {
    expect(() =>
      assertSlotRates([row("a", "15.50"), row("b", "19.995")], floors),
    ).not.toThrow();
    expect(() =>
      assertSlotRates([row("a", "15.49"), row("b", "20.00")], floors),
    ).toThrow(/slot a/);
  });

  it("throws naming a slot that is absent", () => {
    expect(() => assertSlotRates([row("a", "15.50")], floors)).toThrow(
      /slot b: absent/,
    );
    expect(() => assertSlotRates([], floors)).toThrow(/slot a[\s\S]*slot b/);
  });
});
