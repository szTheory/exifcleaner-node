import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateIccForPreservation } from "../src/metadata/icc_admission.js";
import { iccProfileV2, iccProfileV4 } from "./fixtures.js";

function expectRejected(
  payload: Buffer,
  reason: "invalid" | "unsupported" | "policy-limit",
): void {
  expect(validateIccForPreservation(payload)).toMatchObject({
    ok: false,
    reason,
  });
}

function withProfileId(profile: Buffer): Buffer {
  const result = Buffer.from(profile);
  result.fill(0, 44, 48);
  result.fill(0, 64, 68);
  result.fill(0, 84, 100);
  createHash("md5").update(result).digest().copy(result, 84);
  return result;
}

describe("validateIccForPreservation", () => {
  it.each([
    ["v2.0", iccProfileV2(), 2, 0x00],
    ["v2.0 bugfix 9", iccProfileV2(), 2, 0x09],
    ["v2.4", iccProfileV2(), 2, 0x40],
    ["v2.4 bugfix 9", iccProfileV2(), 2, 0x49],
    ["v4.0", iccProfileV4(), 4, 0x00],
    ["v4.0 bugfix 9", iccProfileV4(), 4, 0x09],
    ["v4.4", iccProfileV4(), 4, 0x40],
    ["v4.4 bugfix 9", iccProfileV4(), 4, 0x49],
  ])("admits %s", (_name, fixture, major, revision) => {
    fixture[8] = major;
    fixture[9] = revision;
    expect(validateIccForPreservation(fixture)).toEqual({ ok: true });
  });

  it("admits both classes and PCS values", () => {
    for (const deviceClass of ["scnr", "mntr"] as const)
      for (const pcs of ["XYZ ", "Lab "] as const)
        expect(
          validateIccForPreservation(iccProfileV4({ deviceClass, pcs })),
        ).toEqual({ ok: true });
  });

  it("classifies out-of-policy versions and signatures as unsupported", () => {
    const minor = iccProfileV4();
    minor[9] = 0x50;
    expectRejected(minor, "unsupported");
    const major = iccProfileV4();
    major[8] = 5;
    expectRejected(major, "unsupported");
    for (const offset of [12, 16, 20]) {
      const profile = iccProfileV4();
      profile.write("CMYK", offset, 4, "ascii");
      expectRejected(profile, "unsupported");
    }
  });

  it("rejects malformed header fields and reserved bytes as invalid", () => {
    for (const version of [0x4a, 0xa0]) {
      const profile = iccProfileV4();
      profile[9] = version;
      expectRejected(profile, "invalid");
    }
    for (const offset of [10, 11, 100, 127]) {
      const profile = iccProfileV4();
      profile[offset] = 1;
      expectRejected(profile, "invalid");
    }
    for (const offset of [10, 11, 84, 127]) {
      const profile = iccProfileV2();
      profile[offset] = 1;
      expectRejected(profile, "invalid");
    }
    const declared = iccProfileV4();
    declared.writeUInt32BE(declared.length + 4, 0);
    expectRejected(declared, "invalid");
    const signature = iccProfileV4();
    signature.write("nope", 36, 4, "ascii");
    expectRejected(signature, "invalid");
    const date = iccProfileV4();
    date.writeUInt16BE(2, 26);
    date.writeUInt16BE(30, 28);
    expectRejected(date, "invalid");
    const intent = iccProfileV4();
    intent.writeUInt32BE(4, 64);
    expectRejected(intent, "invalid");
    const d50 = iccProfileV4();
    d50[68] = 1;
    expectRejected(d50, "invalid");
  });

  it("accepts zero or correct v4 Profile IDs and rejects a mismatch", () => {
    expect(validateIccForPreservation(iccProfileV4())).toEqual({ ok: true });
    const correct = withProfileId(iccProfileV4());
    expect(validateIccForPreservation(correct)).toEqual({ ok: true });
    correct[84] = (correct[84] ?? 0) ^ 1;
    expectRejected(correct, "invalid");
  });

  it("returns typed invalid results for empty, truncated, and zero-tag profiles", () => {
    expectRejected(Buffer.alloc(0), "invalid");
    expectRejected(iccProfileV4().subarray(0, 131), "invalid");
    const zeroTags = iccProfileV4();
    zeroTags.writeUInt32BE(0, 128);
    expectRejected(zeroTags, "invalid");
    expect(validateIccForPreservation(iccProfileV2())).toEqual({ ok: true });
    expect(validateIccForPreservation(iccProfileV4())).toEqual({ ok: true });
  });

  it("admits exact three-signature aliases and a reversed canonical table", () => {
    const tags = ["rTRC", "gTRC", "bTRC"].map((signature) => ({
      signature,
      offset: 168,
    }));
    expect(validateIccForPreservation(iccProfileV4({}, tags))).toEqual({ ok: true });
    expect(
      validateIccForPreservation(
        iccProfileV4({}, [
          { signature: "bTRC", offset: 176 },
          { signature: "rTRC", offset: 168 },
        ]),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects malformed or ambiguous tag records without unchecked reads", () => {
    const cases: readonly [string, Buffer, "invalid" | "policy-limit"][] = [
      ["zero signature", iccProfileV4({}, [{ signature: "\0\0\0\0" }]), "invalid"],
      ["duplicate signature", iccProfileV4({}, [{ signature: "rTRC" }, { signature: "rTRC" }]), "invalid"],
      ["unaligned range", iccProfileV4({}, [{ signature: "rTRC", offset: 145 }]), "invalid"],
      ["short type header", iccProfileV4({}, [{ signature: "rTRC", size: 7 }]), "invalid"],
      ["nonzero reserved type word", iccProfileV4({}, [{ signature: "rTRC", reserved: 1 }]), "invalid"],
      ["same offset different size", iccProfileV4({}, [{ signature: "rTRC", offset: 156 }, { signature: "gTRC", offset: 156, size: 12 }]), "invalid"],
      ["partial overlap", iccProfileV4({}, [{ signature: "rTRC", offset: 156, size: 12 }, { signature: "gTRC", offset: 164 }]), "invalid"],
    ];
    for (const [_name, profile, reason] of cases) expectRejected(profile, reason);

    const zero = iccProfileV4();
    zero.writeUInt32BE(0, 140);
    expectRejected(zero, "invalid");
    const pastEof = iccProfileV4();
    pastEof.writeUInt32BE(pastEof.length + 4, 140);
    expectRejected(pastEof, "invalid");
    const selfReference = iccProfileV4();
    selfReference.writeUInt32BE(132, 136);
    expectRejected(selfReference, "invalid");
    const truncatedTable = iccProfileV4();
    truncatedTable.writeUInt32BE(2, 128);
    expectRejected(truncatedTable, "invalid");
    const overLimit = iccProfileV4();
    overLimit.writeUInt32BE(4_097, 128);
    expectRejected(overLimit, "policy-limit");
  });

  it("requires canonical zero-padded layout through EOF", () => {
    const touching = iccProfileV4({}, [
      { signature: "rTRC", offset: 156 },
      { signature: "gTRC", offset: 164 },
    ]);
    expect(validateIccForPreservation(touching)).toEqual({ ok: true });
    const leadingGap = iccProfileV4({}, [{ signature: "rTRC", offset: 148 }]);
    expectRejected(leadingGap, "invalid");
    const gap = iccProfileV4({}, [
      { signature: "rTRC", offset: 156 },
      { signature: "gTRC", offset: 168 },
    ]);
    expectRejected(gap, "invalid");
    const trailer = Buffer.concat([iccProfileV4(), Buffer.alloc(4)]);
    trailer.writeUInt32BE(trailer.length, 0);
    expectRejected(trailer, "invalid");
  });
});
