import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../src/index.js";
import {
  INVARIANT_MESSAGES,
  assertAdmittedOutcome,
  assertCanariesDistinct,
  assertNonSuccessBlastRadius,
  assertTotal,
  withSampleWorkspace,
} from "./invariants.js";

const refusal = (code: string) => ({ ok: false as const, error: { code } });

describe("INVARIANT_MESSAGES", () => {
  it("has six distinct frozen labels", () => {
    const keys = Object.keys(INVARIANT_MESSAGES).sort();
    expect(keys).toEqual(
      [
        "canariesNotDistinct",
        "residue",
        "sourceChanged",
        "untypedParserThrow",
        "untypedThrow",
        "verificationFailed",
      ].sort(),
    );
    expect(new Set(Object.values(INVARIANT_MESSAGES)).size).toBe(6);
    expect(Object.isFrozen(INVARIANT_MESSAGES)).toBe(true);
  });
});

describe("withSampleWorkspace", () => {
  it("writes the source and removes the directory afterwards", async () => {
    let captured = "";
    await withSampleWorkspace(
      "a.bin",
      "b.bin",
      Buffer.from("xyz"),
      async (w) => {
        captured = w.directory;
        expect(await readFile(w.sourcePath)).toEqual(Buffer.from("xyz"));
        expect(w.destinationPath).toBe(join(w.directory, "b.bin"));
      },
    );
    await expect(readFile(join(captured, "a.bin"))).rejects.toBeDefined();
  });

  it("removes the directory when the body throws", async () => {
    let captured = "";
    await expect(
      withSampleWorkspace("a.bin", "b.bin", Buffer.alloc(1), async (w) => {
        captured = w.directory;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(readFile(join(captured, "a.bin"))).rejects.toBeDefined();
  });
});

describe("assertAdmittedOutcome", () => {
  it("accepts success and typed refusals", () => {
    expect(() => assertAdmittedOutcome({ ok: true })).not.toThrow();
    expect(() =>
      assertAdmittedOutcome(refusal("malformed-file")),
    ).not.toThrow();
  });
  it("rejects verification-failed with its label", () => {
    expect(() => assertAdmittedOutcome(refusal("verification-failed"))).toThrow(
      INVARIANT_MESSAGES.verificationFailed,
    );
  });
  it("rejects read-failed with its label", () => {
    expect(() => assertAdmittedOutcome(refusal("read-failed"))).toThrow(
      INVARIANT_MESSAGES.untypedThrow,
    );
  });
});

describe("assertNonSuccessBlastRadius", () => {
  it("passes on an untouched directory", async () => {
    await withSampleWorkspace(
      "s.bin",
      "d.bin",
      Buffer.from("abc"),
      async (w) => {
        await assertNonSuccessBlastRadius({
          directory: w.directory,
          sourcePath: w.sourcePath,
          sourceBytes: Buffer.from("abc"),
        });
      },
    );
  });
  it("fails with sourceChanged when the source differs", async () => {
    await withSampleWorkspace(
      "s.bin",
      "d.bin",
      Buffer.from("abc"),
      async (w) => {
        await writeFile(w.sourcePath, Buffer.from("abcd"));
        await expect(
          assertNonSuccessBlastRadius({
            directory: w.directory,
            sourcePath: w.sourcePath,
            sourceBytes: Buffer.from("abc"),
          }),
        ).rejects.toThrow(INVARIANT_MESSAGES.sourceChanged);
      },
    );
  });
  it("fails with residue when a destination exists", async () => {
    await withSampleWorkspace(
      "s.bin",
      "d.bin",
      Buffer.from("abc"),
      async (w) => {
        await writeFile(w.destinationPath, "x");
        await expect(
          assertNonSuccessBlastRadius({
            directory: w.directory,
            sourcePath: w.sourcePath,
            sourceBytes: Buffer.from("abc"),
          }),
        ).rejects.toThrow(INVARIANT_MESSAGES.residue);
      },
    );
  });
  it("fails with residue for a stage file differing only by a suffix (adjacency)", async () => {
    await withSampleWorkspace(
      "s.bin",
      "d.bin",
      Buffer.from("abc"),
      async (w) => {
        await writeFile(`${w.destinationPath}.stage`, "x");
        await expect(
          assertNonSuccessBlastRadius({
            directory: w.directory,
            sourcePath: w.sourcePath,
            sourceBytes: Buffer.from("abc"),
          }),
        ).rejects.toThrow(INVARIANT_MESSAGES.residue);
      },
    );
  });
  it("compares a sorted listing, independent of creation order", async () => {
    await withSampleWorkspace(
      "m.bin",
      "d.bin",
      Buffer.from("abc"),
      async (w) => {
        await writeFile(join(w.directory, "z.stage"), "x");
        await writeFile(join(w.directory, "a.stage"), "x");
        await expect(
          assertNonSuccessBlastRadius({
            directory: w.directory,
            sourcePath: w.sourcePath,
            sourceBytes: Buffer.from("abc"),
          }),
        ).rejects.toThrow(INVARIANT_MESSAGES.residue);
      },
    );
  });
});

describe("assertCanariesDistinct", () => {
  const item = (canary: string) => ({ kind: "K", canary });
  it("passes for distinct, non-nested canaries", () => {
    expect(() =>
      assertCanariesDistinct([item("alpha-1"), item("beta-2")]),
    ).not.toThrow();
  });
  it("fails for equal canaries", () => {
    expect(() => assertCanariesDistinct([item("same"), item("same")])).toThrow(
      INVARIANT_MESSAGES.canariesNotDistinct,
    );
  });
  it("fails when one contains the other", () => {
    expect(() =>
      assertCanariesDistinct([item("abc"), item("xxabcxx")]),
    ).toThrow(INVARIANT_MESSAGES.canariesNotDistinct);
  });
});

describe("assertTotal", () => {
  class Typed extends Error {}
  const isTyped = (error: unknown) => error instanceof Typed;
  it("returns the value when parse resolves", async () => {
    await expect(assertTotal(async () => 7, isTyped)).resolves.toEqual({
      resolved: true,
      value: 7,
    });
  });
  it("accepts a typed throw", async () => {
    const outcome = await assertTotal(async () => {
      throw new Typed("t");
    }, isTyped);
    expect(outcome.resolved).toBe(false);
  });
  it("fails an untyped throw with its label", async () => {
    await expect(
      assertTotal(async () => {
        throw new Error("plain");
      }, isTyped),
    ).rejects.toThrow(INVARIANT_MESSAGES.untypedParserThrow);
  });
});

describe("empty sources through the real sanitizer (PBT-03 edges)", () => {
  it("a zero-byte regular file is a typed refusal that passes both invariants", async () => {
    await withSampleWorkspace(
      "empty.bin",
      "out.bin",
      Buffer.alloc(0),
      async (w) => {
        const result = await sanitizeFile({
          sourcePath: w.sourcePath,
          destinationPath: w.destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(result.ok).toBe(false);
        assertAdmittedOutcome(result);
        await assertNonSuccessBlastRadius({
          directory: w.directory,
          sourcePath: w.sourcePath,
          sourceBytes: Buffer.alloc(0),
        });
      },
    );
  });
  it("a directory source yields read-failed, to which assertAdmittedOutcome is not applied", async () => {
    await withSampleWorkspace(
      "s.bin",
      "out.bin",
      Buffer.alloc(1),
      async (w) => {
        const dir = join(w.directory, "adir");
        await mkdir(dir);
        const result = await sanitizeFile({
          sourcePath: dir,
          destinationPath: w.destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "read-failed" },
        });
        // the helper would (rightly) flag it, which is why callers never apply it here
        expect(() => assertAdmittedOutcome(result)).toThrow(
          INVARIANT_MESSAGES.untypedThrow,
        );
      },
    );
  });
});
