// src/isobmff/brand.ts coverage (D-17/D-18, BMF-02). Proves two separate claims:
//   1. `classifyIsobmffBrand` is a fail-closed major-∪-compatible-brand matrix, pinned against
//      hand-constructed `ftyp` byte layouts (never the builder's own report of what it wrote).
//   2. A brand that sits past byte 12 of `ftyp` is recognized only because `selectHandler`'s
//      magic read was widened to 256 bytes (D-17) -- proven through the *real* `selectHandler`,
//      with a test-only handler installed via the existing `setRegisteredHandlersForTests` seam,
//      never by calling `classifyIsobmffBrand` directly on a slice the registry wouldn't produce.
//
// The widened read must change nothing for the three existing formats (blast radius): the
// "every existing fixture still selects its own handler" block below exercises WebP/PNG/JPEG
// fixtures from tests/fixtures.ts through the same real `selectHandler`, with no test-only
// handler installed.
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AVIF_BRAND,
  classifyIsobmffBrand,
  HEIC_BRANDS,
  SEQUENCE_BRANDS,
} from "../src/isobmff/brand.js";
import {
  registeredHandlersForTests,
  selectHandler,
  setRegisteredHandlersForTests,
  type RegisteredHandler,
} from "../src/admission/registry.js";
import { webpHandler } from "../src/admission/webp-handler.js";
import { pngHandler } from "../src/admission/png-handler.js";
import { jpegHandler } from "../src/admission/jpeg-handler.js";
import type { FormatCapabilities } from "../src/types.js";
import { heifFile } from "./isobmff-support/builder.js";
import {
  metadataJpeg,
  metadataPng,
  metadataWebp,
  minimalJpeg,
  minimalPng,
} from "./fixtures.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-brand-"));
  cleanupDirectories.push(directory);
  return directory;
}

async function writeFixture(bytes: Buffer): Promise<string> {
  const directory = await freshDirectory();
  const path = join(directory, "input.bin");
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
  return path;
}

async function selectThroughRealRegistry(
  path: string,
): Promise<RegisteredHandler | undefined> {
  const handle: FileHandle = await open(path, "r");
  try {
    return await selectHandler(handle);
  } finally {
    await handle.close();
  }
}

function notUsedInThisTest(): never {
  throw new Error("not used in this test");
}

/**
 * Test-only handler (D-16-style proof harness, scoped to this plan's single claim): `matches` is
 * the real brand classifier; every write-side/admission method throws if ever called, since this
 * plan proves selection only, never admission or write (that is Phase 62's handler).
 *
 * `inspect` is the one exception: it does not throw, because Node's console/`util.inspect` and
 * vitest's own failure-diff printer (`loupe`) both honor a legacy convention of calling an
 * object's own `inspect` method to render it -- so an *assertion failure* anywhere near this
 * object (e.g. a `toBe` mismatch while proving the registry reverted to a 12-byte read declines
 * to select it) would otherwise surface a confusing "not used in this test" throw from the
 * printer itself instead of the real assertion diff. A benign placeholder keeps failure output
 * legible without weakening the proof -- this test never asserts anything about `inspect`'s
 * return value.
 */
const brandOnlyHandler: RegisteredHandler = {
  capability: undefined as unknown as FormatCapabilities,
  stagingFileName: "output.test-only-brand",
  matches(magic: Buffer): boolean {
    return classifyIsobmffBrand(magic) !== "decline";
  },
  admit: notUsedInThisTest,
  inspect: (() =>
    "[brandOnlyHandler test stub]") as unknown as RegisteredHandler["inspect"],
  buildOutputPlan: notUsedInThisTest,
  checkOutputPlan: notUsedInThisTest,
  writeOutput: notUsedInThisTest,
  verifyOutput: notUsedInThisTest,
  classifyAdmissionFailure: notUsedInThisTest,
};

/** Hand-built `ftyp` box: size(32) "ftyp"(32) major_brand(32) minor_version(32) compatible*(32). */
function ftypBytes(
  majorBrand: string,
  compatibleBrands: readonly string[],
  opts: {
    readonly declaredSize?: number;
    readonly trailingPadding?: number;
  } = {},
): Buffer {
  const parts = [
    Buffer.from(majorBrand, "ascii"),
    Buffer.alloc(4), // minor_version, unused by the classifier
    ...compatibleBrands.map((brand) => Buffer.from(brand, "ascii")),
  ];
  const payload = Buffer.concat(parts);
  const naturalSize = 8 + payload.length;
  const declaredSize = opts.declaredSize ?? naturalSize;
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32BE(declaredSize, 0);
  const box = Buffer.concat([sizeField, Buffer.from("ftyp", "ascii"), payload]);
  const padding = Buffer.alloc(opts.trailingPadding ?? 0);
  return Buffer.concat([box, padding]);
}

const SIMPLE_PRIMARY = {
  itemId: 1,
  itemType: "hvc1",
  width: 8,
  height: 8,
  payload: Buffer.alloc(4),
};

describe("classifyIsobmffBrand: matrix (D-18, D6)", () => {
  it("major heic -> heic", () => {
    expect(classifyIsobmffBrand(ftypBytes("heic", []))).toBe("heic");
  });

  it.each(["heix", "heim", "heis"])(
    "major mif1 with compatible %s -> heic",
    (compatible) => {
      expect(
        classifyIsobmffBrand(ftypBytes("mif1", ["miaf", compatible])),
      ).toBe("heic");
    },
  );

  it("major avif -> avif", () => {
    expect(classifyIsobmffBrand(ftypBytes("avif", []))).toBe("avif");
  });

  it("major mif1 with compatible avif -> avif", () => {
    expect(classifyIsobmffBrand(ftypBytes("mif1", ["miaf", "avif"]))).toBe(
      "avif",
    );
  });

  it("compatible list containing both avif and heic -> decline", () => {
    expect(classifyIsobmffBrand(ftypBytes("mif1", ["avif", "heic"]))).toBe(
      "decline",
    );
  });

  it("mif1/miaf only (neither avif nor heic) -> decline", () => {
    expect(classifyIsobmffBrand(ftypBytes("mif1", ["miaf"]))).toBe("decline");
  });

  it("avif + avis -> decline", () => {
    expect(classifyIsobmffBrand(ftypBytes("avif", ["avis"]))).toBe("decline");
  });

  it("heic + msf1 -> decline", () => {
    expect(classifyIsobmffBrand(ftypBytes("heic", ["msf1"]))).toBe("decline");
  });
});

describe("classifyIsobmffBrand: fail-closed framing (D-18)", () => {
  it("fewer than 16 bytes -> decline", () => {
    expect(classifyIsobmffBrand(Buffer.alloc(15))).toBe("decline");
  });

  it("type not ftyp -> decline", () => {
    const bytes = Buffer.alloc(20);
    bytes.writeUInt32BE(20, 0);
    bytes.write("free", 4, "ascii");
    bytes.write("heic", 8, "ascii");
    expect(classifyIsobmffBrand(bytes)).toBe("decline");
  });

  it("declared size 15 (below 16) -> decline", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(15, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("heic", 8, "ascii");
    expect(classifyIsobmffBrand(bytes)).toBe("decline");
  });

  it("declared size 18 (not a multiple of 4 after 16) -> decline", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(18, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("heic", 8, "ascii");
    expect(classifyIsobmffBrand(bytes)).toBe("decline");
  });

  it("declared size extends past the bytes given -> decline", () => {
    const bytes = ftypBytes("heic", []); // natural size 16, buffer exactly 16 bytes
    const truncated = bytes.subarray(0, bytes.length - 1); // 15 bytes, below the 16-byte floor
    expect(classifyIsobmffBrand(truncated)).toBe("decline");

    const sameLengthButLargerDeclared = Buffer.from(bytes);
    sameLengthButLargerDeclared.writeUInt32BE(20, 0); // declares 20 in a 16-byte buffer
    expect(classifyIsobmffBrand(sameLengthButLargerDeclared)).toBe("decline");
  });

  it("declared size exactly 256 in a 256-byte window classifies", () => {
    // 256 - 16 = 240 bytes of compatible brands = 60 brands; fill every one with "heic" so the
    // brand set is unambiguous, then pad the ftyp box out to exactly 256 bytes.
    const compatible = new Array(60).fill("heic");
    const bytes = ftypBytes("heic", compatible, { declaredSize: 256 });
    expect(bytes.length).toBe(256);
    expect(classifyIsobmffBrand(bytes)).toBe("heic");
  });

  it("declared size 260 in the same 256-byte window declines", () => {
    const compatible = new Array(60).fill("heic");
    const bytes = ftypBytes("heic", compatible, { declaredSize: 260 });
    expect(bytes.length).toBe(256);
    expect(classifyIsobmffBrand(bytes)).toBe("decline");
  });
});

describe("D-18 negative control: brand past byte 12 recognized only through the widened read", () => {
  it("selects a test-only handler on the mif1/miaf/MA1B/avif brand (avif starts at byte 24), which a 12-byte-only read cannot see", async () => {
    const fileBytes = heifFile({
      majorBrand: "mif1",
      compatibleBrands: ["miaf", "MA1B", "avif"],
      primary: SIMPLE_PRIMARY,
    });

    // The avif brand sits at byte 24: ftyp box header (8) + major_brand (4) + minor_version (4)
    // + "miaf" (4) + "MA1B" (4) = offset 24..28.
    expect(fileBytes.toString("ascii", 24, 28)).toBe("avif");

    const path = await writeFixture(fileBytes);
    const restore = setRegisteredHandlersForTests([
      ...registeredHandlersForTests(),
      brandOnlyHandler,
    ]);
    try {
      const selected = await selectThroughRealRegistry(path);
      expect(selected).toBe(brandOnlyHandler);
    } finally {
      restore();
    }

    // The same brand is invisible to a 12-byte read: classifying only the first 12 bytes of the
    // identical file declines, proving the test above discriminates on the widened read and not
    // on some other property of the fixture.
    expect(classifyIsobmffBrand(fileBytes.subarray(0, 12))).toBe("decline");
  });
});

describe("existing formats unaffected by the 256-byte read (blast radius, D-17)", () => {
  it.each([
    { name: "webp", bytes: metadataWebp(), handler: webpHandler },
    { name: "png (minimal)", bytes: minimalPng(), handler: pngHandler },
    { name: "png (metadata)", bytes: metadataPng(), handler: pngHandler },
    { name: "jpeg (minimal)", bytes: minimalJpeg(), handler: jpegHandler },
    { name: "jpeg (metadata)", bytes: metadataJpeg(), handler: jpegHandler },
  ])(
    "$name still selects its own handler through the real, unmodified registry, and never classifies as an ISOBMFF brand",
    async ({ bytes, handler }) => {
      const path = await writeFixture(bytes);
      const selected = await selectThroughRealRegistry(path);
      expect(selected).toBe(handler);
      expect(
        classifyIsobmffBrand(bytes.subarray(0, Math.min(256, bytes.length))),
      ).toBe("decline");
    },
  );
});

describe("exported brand sets (D-18)", () => {
  it("HEIC_BRANDS, AVIF_BRAND and SEQUENCE_BRANDS are the closed sets the matrix above exercises", () => {
    expect([...HEIC_BRANDS].sort()).toEqual(["heic", "heim", "heis", "heix"]);
    expect(AVIF_BRAND).toBe("avif");
    expect([...SEQUENCE_BRANDS].sort()).toEqual(["avis", "msf1"]);
  });
});
