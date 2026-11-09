// SEC-05 (68-01, D-04c, closes AR-62-01): the ftyp parse cap, proved through the REAL engine.
//
// The classifier reads only 256 bytes at selection and admits a declared ftyp box up to that
// size; the parser must enforce the same number, because the source can change between selection
// and admit. The wrapper handler below rewrites the same inode in place during `admit` (the
// race), re-stats the already-open selection handle and hands the NEW size to the real admit: the
// engine passes the stale pre-rewrite size, and a stale size would turn the case into a box
// framing decline on both sides of the fix. The discriminating assertion is the allocation spy:
// before the cap the parser allocates the 992-byte ftyp payload.
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
