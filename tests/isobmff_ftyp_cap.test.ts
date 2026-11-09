// SEC-05 (68-01, D-04c, closes AR-62-01): the ftyp parse cap, proved through the REAL engine.
//
// The classifier reads only 256 bytes at selection and admits a declared ftyp box up to that
// size; the parser must enforce the same number, because the source can change between selection
// and admit. The wrapper handler below rewrites the same inode in place during `admit` (the
// race), re-stats the already-open selection handle and hands the NEW size to the real admit: the
// engine passes the stale pre-rewrite size, and a stale size would turn the case into a box
// framing decline on both sides of the fix. The discriminating assertion is the allocation spy:
// before the cap the parser allocates the 992-byte ftyp payload.
//
// 68-02 (D-04a/b/d, D-05) adds the direct matrix: unit refusals through parseIsobmff and
// admitIsobmff, the 256/260 boundary pair, the classifier/parser parity loop and the injectable
// negative control. The sizes below are literals on purpose: they pin the number 256 rather than
// echoing whatever the constant happens to be.
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
  type RegisteredHandler,
} from "../src/admission/registry.js";
import { heicHandler } from "../src/admission/heic-handler.js";
import { admitIsobmff } from "../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../src/isobmff/brand.js";
import {
  DEFAULT_ISOBMFF_CAPS,
  ISOBMFF_MAX_FTYP_BOX_BYTES,
} from "../src/isobmff/caps.js";
import { DECLINE_CLASS_TO_KIND } from "../src/isobmff/errors.js";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { HEIF_REFUSAL_BY_DECLINE_CLASS } from "../src/isobmff/refusals.js";
import { sanitizeFile } from "../src/engine.js";
import { heifFile } from "./isobmff-support/builder.js";

const OVERSIZED_FTYP_BOX_BYTES = 1000;
const OVERSIZED_FTYP_PAYLOAD_BYTES = OVERSIZED_FTYP_BOX_BYTES - 8;

const directories: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (restores.length > 0) restores.pop()?.();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-ftyp-cap-"));
  directories.push(directory);
  return directory;
}

function smallHeic(): Buffer {
  return heifFile({
    primary: {
      itemId: 1,
      itemType: "hvc1",
      width: 16,
      height: 16,
      payload: Buffer.from("primary-payload"),
    },
  });
}

/** A valid HEIC whose ftyp box is exactly 1000 bytes (246 valid compatible brands). */
function oversizedFtypHeic(): Buffer {
  const brandCount = (OVERSIZED_FTYP_PAYLOAD_BYTES - 8) / 4;
  const bytes = heifFile({
    compatibleBrands: [
      "mif1",
      "heic",
      ...Array<string>(brandCount - 2).fill("mif1"),
    ],
    primary: {
      itemId: 1,
      itemType: "hvc1",
      width: 16,
      height: 16,
      payload: Buffer.from("primary-payload"),
    },
  });
  expect(bytes.readUInt32BE(0)).toBe(OVERSIZED_FTYP_BOX_BYTES);
  return bytes;
}

describe("ftyp parse cap (SEC-05, AR-62-01)", () => {
  it("declines a source that grows a larger ftyp between selection and admit, without allocating the ftyp payload", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    const original = smallHeic();
    const replacement = oversizedFtypHeic();
    await writeFile(sourcePath, original);

    const racing: RegisteredHandler = {
      ...heicHandler,
      async admit(handle, _staleSize, signal) {
        const writer = await open(sourcePath, "r+");
        try {
          await writer.truncate(0);
          await writer.write(replacement, 0, replacement.length, 0);
        } finally {
          await writer.close();
        }
        const fresh = await handle.stat();
        expect(fresh.size).toBe(replacement.length);
        return admitIsobmff(handle, fresh.size, signal);
      },
    };
    restores.push(
      setRegisteredHandlersForTests([racing, ...registeredHandlersForTests()]),
    );
    const allocated: number[] = [];
    const realAllocUnsafe = Buffer.allocUnsafe.bind(Buffer);
    vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size: number) => {
      allocated.push(size);
      return realAllocUnsafe(size);
    });

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });

    expect(allocated).not.toContain(OVERSIZED_FTYP_PAYLOAD_BYTES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatchObject({
      code: "unsafe-structure",
      detail: "ftyp box size 1000 exceeds the 256-byte cap.",
    });
    expect(await readdir(directory)).toEqual(["source.heic"]);
    expect((await readFile(sourcePath)).equals(replacement)).toBe(true);
  });
});

/** A valid HEIC whose ftyp holds `brandCount` compatible brands: box size 16 + 4 * brandCount. */
function heicWithCompatibleBrands(brandCount: number): Buffer {
  return heifFile({
    compatibleBrands: Array<string>(brandCount).fill("mif1"),
    primary: {
      itemId: 1,
      itemType: "hvc1",
      width: 16,
      height: 16,
      payload: Buffer.from("primary-payload"),
    },
  });
}

async function withFile<T>(
  bytes: Buffer,
  run: (handle: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>,
): Promise<T> {
  const directory = await workspace();
  const path = join(directory, "input.heic");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  try {
    return await run(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

describe("ftyp parse cap: refusals (D-04a)", () => {
  it.each([
    { brands: 61, size: 260 },
    { brands: 253, size: 1028 },
  ])(
    "parseIsobmff refuses a $size-byte ftyp as unsafe-structure/cap-ftyp-bytes",
    async ({ brands, size }) => {
      const bytes = heicWithCompatibleBrands(brands);
      expect(bytes.readUInt32BE(0)).toBe(size);
      const error = await withFile(bytes, (handle, fileSize) =>
        parseIsobmff(handle, fileSize).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(error).toMatchObject({
        name: "IsobmffStructureError",
        declineClass: "cap-ftyp-bytes",
        kind: "unsafe-structure",
        message: `ftyp box size ${size} exceeds the 256-byte cap.`,
        limit: { cap: "maxFtypBoxBytes", size, limit: 256 },
      });
      expect((error as { limit: object }).limit).toStrictEqual({
        cap: "maxFtypBoxBytes",
        size,
        limit: 256,
      });
    },
  );

  it.each([
    { brands: 61, size: 260 },
    { brands: 253, size: 1028 },
  ])(
    "admitIsobmff refuses a $size-byte ftyp as unsafe-structure/cap-ftyp-bytes",
    async ({ brands, size }) => {
      const bytes = heicWithCompatibleBrands(brands);
      const error = await withFile(bytes, (handle, fileSize) =>
        admitIsobmff(handle, fileSize).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(error).toMatchObject({
        declineClass: "cap-ftyp-bytes",
        kind: "unsafe-structure",
        limit: { cap: "maxFtypBoxBytes", size, limit: 256 },
      });
    },
  );

  it("maps the class to the unsafe-structure kind and the resource-limits public refusal", () => {
    expect(DECLINE_CLASS_TO_KIND["cap-ftyp-bytes"]).toBe("unsafe-structure");
    expect(HEIF_REFUSAL_BY_DECLINE_CLASS["cap-ftyp-bytes"]).toBe(
      "resource-limits",
    );
  });
});

describe("ftyp parse cap: boundary (D-01, D-04b)", () => {
  it.each([
    { brands: 60, size: 256 },
    { brands: 59, size: 252 },
  ])(
    "parses a $size-byte ftyp and admits it past the cap",
    async ({ brands, size }) => {
      const bytes = heicWithCompatibleBrands(brands);
      expect(bytes.readUInt32BE(0)).toBe(size);
      const model = await withFile(bytes, (handle, fileSize) =>
        parseIsobmff(handle, fileSize),
      );
      expect(model.majorBrand).toBe("heic");
      expect(model.compatibleBrands).toHaveLength(brands);
      const admission = await withFile(bytes, (handle, fileSize) =>
        admitIsobmff(handle, fileSize),
      );
      expect(admission).toBeDefined();
    },
  );

  it("pins the cap at 256 and wires it into the default caps", () => {
    expect(ISOBMFF_MAX_FTYP_BOX_BYTES).toBe(256);
    expect(DEFAULT_ISOBMFF_CAPS.maxFtypBoxBytes).toBe(256);
  });
});

describe("ftyp parse cap: classifier parity (D-01, D-04b)", () => {
  it("accepts exactly what the classifier admits (0..60 brands) and refuses what it declines (61..70)", async () => {
    for (let brands = 0; brands <= 70; brands += 1) {
      const bytes = heicWithCompatibleBrands(brands);
      const total = 16 + 4 * brands;
      expect(bytes.readUInt32BE(0)).toBe(total);
      const verdict = classifyIsobmffBrand(bytes.subarray(0, 256));
      const outcome = await withFile(bytes, (handle, fileSize) =>
        parseIsobmff(handle, fileSize).then(
          () => "accepted" as const,
          (cause: unknown) =>
            (cause as { declineClass?: string }).declineClass ?? "other",
        ),
      );
      if (brands <= 60) {
        expect(verdict, `${brands} brands`).toBe("heic");
        expect(outcome, `${brands} brands`).toBe("accepted");
      } else {
        expect(verdict, `${brands} brands`).toBe("decline");
        expect(outcome, `${brands} brands`).toBe("cap-ftyp-bytes");
      }
    }
  });
});

describe("ftyp parse cap: injectable negative control (D-05)", () => {
  it("parses the 260-byte ftyp when the cap alone is removed", async () => {
    const bytes = heicWithCompatibleBrands(61);
    expect(bytes.readUInt32BE(0)).toBe(260);
    const model = await withFile(bytes, (handle, fileSize) =>
      parseIsobmff(handle, fileSize, {
        ...DEFAULT_ISOBMFF_CAPS,
        maxFtypBoxBytes: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(model.compatibleBrands).toHaveLength(61);
  });

  it("refuses at a lowered injected cap using that cap as the limit", async () => {
    const bytes = heicWithCompatibleBrands(2);
    const error = await withFile(bytes, (handle, fileSize) =>
      parseIsobmff(handle, fileSize, {
        ...DEFAULT_ISOBMFF_CAPS,
        maxFtypBoxBytes: 23,
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );
    expect(error).toMatchObject({
      declineClass: "cap-ftyp-bytes",
      message: "ftyp box size 24 exceeds the 23-byte cap.",
      limit: { cap: "maxFtypBoxBytes", size: 24, limit: 23 },
    });
  });
});
