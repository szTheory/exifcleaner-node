import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import {
  COLOUR_FIXTURES,
  iccProfileV4,
  mutateIccProfile,
  png,
  pngBomb,
  pngChrm,
  pngChunk,
  pngGama,
  pngIccp,
  pngIdat,
  pngIhdr,
  pngPhys,
  pngWithChunksBefore,
} from "./fixtures.js";

/**
 * D-02, D-08, D-09, D-10 and D-14 end-to-end proof: colour and resolution
 * preservation exactly as locked, and decompression-bound refusals, against
 * the real sanitize output (56-05).
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-png-preservation-"),
  );
  directories.push(directory);
  return directory;
}

interface PreservationFlags {
  preserveOrientation: boolean;
  preserveColorProfile: boolean;
  preserveTimestamps: boolean;
  preserveResolution: boolean;
}

const ALL_FALSE: PreservationFlags = Object.freeze({
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
});

async function sanitizeToDirectory(
  source: Buffer,
  options: Partial<PreservationFlags> = {},
) {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.png");
  const destinationPath = join(directory, "destination.png");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    ...ALL_FALSE,
    ...options,
  });
  return { directory, sourcePath, destinationPath, result };
}

function chunkBytesOfType(file: Buffer, type: string): Buffer | undefined {
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const chunkType = file.toString("ascii", offset + 4, offset + 8);
    const span = 12 + length;
    if (chunkType === type) return file.subarray(offset, offset + span);
    offset += span;
    if (chunkType === "IEND") break;
  }
  return undefined;
}

function chunkTypesOf(file: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

/**
 * A Photoshop-style export: `IHDR iCCP gAMA cHRM IDAT IEND`. Matches the
 * measured 56-CONTEXT.md fixture shape used for D-08's parity proof.
 */
function photoshopStylePng(profile: Buffer): Buffer {
  return pngWithChunksBefore([
    ["iCCP", pngIccp(profile)],
    ["gAMA", pngGama()],
    ["cHRM", pngChrm()],
  ]);
}

describe("PNG colour preservation: iCCP by request, ICC policy and bomb declines (D-08, D-14)", () => {
  it("Photoshop-style iCCP+gAMA+cHRM, preserveColorProfile on: iCCP kept byte-identical, cHRM kept, gAMA absent, preserved.colorProfile true", async () => {
    const profile = iccProfileV4();
    const source = photoshopStylePng(profile);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.colorProfile).toBe(true);

    const destination = await readFile(destinationPath);
    const types = chunkTypesOf(destination);
    expect(types).toContain("iCCP");
    expect(types).toContain("cHRM");
    expect(types).not.toContain("gAMA");

    const sourceIccp = chunkBytesOfType(source, "iCCP");
    const destinationIccp = chunkBytesOfType(destination, "iCCP");
    expect(sourceIccp).toBeDefined();
    expect(destinationIccp?.equals(sourceIccp!)).toBe(true);
  });

  it("Same source, preserveColorProfile off: iCCP and gAMA absent, cHRM kept, ICC in removedNamespaces", async () => {
    const profile = iccProfileV4();
    const source = photoshopStylePng(profile);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveColorProfile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.colorProfile).toBe(false);
    expect(result.value.removedNamespaces).toContain("ICC");

    const destination = await readFile(destinationPath);
    const types = chunkTypesOf(destination);
    expect(types).not.toContain("iCCP");
    expect(types).not.toContain("gAMA");
    expect(types).toContain("cHRM");
  });

  it("An iCCP whose profile fails the ICC policy (device-class prtr), preserveColorProfile on: declines color-profile-preservation, reason unsupported, no destination", async () => {
    const profile = mutateIccProfile(iccProfileV4(), "device-class");
    const source = photoshopStylePng(profile);
    const { result, directory } = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if (result.error.code !== "unsupported-feature")
      throw new Error("unreachable");
    expect(result.error.feature).toBe("color-profile-preservation");
    if (result.error.feature !== "color-profile-preservation")
      throw new Error("unreachable");
    expect(result.error.reason).toBe("unsupported");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.png"]);
  });

  it("Same profile, preserveColorProfile off: success, iCCP removed", async () => {
    const profile = mutateIccProfile(iccProfileV4(), "device-class");
    const source = photoshopStylePng(profile);
    const { destinationPath, result } = await sanitizeToDirectory(source, {
      preserveColorProfile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const destination = await readFile(destinationPath);
    expect(chunkTypesOf(destination)).not.toContain("iCCP");
  });

  it("iCCP bomb (17 MiB inflated), preserveColorProfile on: declines color-profile-preservation, reason policy-limit, before any write", async () => {
    const source = pngWithChunksBefore([
      ["iCCP", pngBomb("iCCP", 17 * 1024 * 1024)],
    ]);
    const { result, directory } = await sanitizeToDirectory(source, {
      preserveColorProfile: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsupported-feature");
    if (result.error.code !== "unsupported-feature")
      throw new Error("unreachable");
    expect(result.error.feature).toBe("color-profile-preservation");
    if (result.error.feature !== "color-profile-preservation")
      throw new Error("unreachable");
    expect(result.error.reason).toBe("policy-limit");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.png"]);
  });

  it("Same bomb, preserveColorProfile off: declines unsafe-structure, before any write", async () => {
    const source = pngWithChunksBefore([
      ["iCCP", pngBomb("iCCP", 17 * 1024 * 1024)],
    ]);
    const { result, directory } = await sanitizeToDirectory(source, {
      preserveColorProfile: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.png"]);
  });
});

const COLOUR_CHUNK_TYPES = [
  "iCCP",
  "gAMA",
  "sRGB",
  "cHRM",
  "cICP",
  "mDCv",
  "cLLi",
] as const;

/** Every colour-signalling chunk present in `file`, keyed by type, full
 * chunk bytes (header + data + CRC) -- used for both the D-08 byte-identity
 * check and the D-09 subset invariant. */
function colourChunks(file: Buffer): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const span = 12 + length;
    if ((COLOUR_CHUNK_TYPES as readonly string[]).includes(type)) {
      map.set(type, file.subarray(offset, offset + span));
    }
    offset += span;
    if (type === "IEND") break;
  }
  return map;
}

const FLAG_COMBOS: readonly [boolean, boolean][] = [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
];

describe("PNG colour matrix: D-10 fixtures x colour/resolution flags (D-02, D-08, D-09, D-10)", () => {
  describe.each(COLOUR_FIXTURES)("$id", ({ id, build }) => {
    it.each(FLAG_COMBOS)(
      "preserveColorProfile=%s preserveResolution=%s",
      async (preserveColorProfile, preserveResolution) => {
        const source = build();
        const { destinationPath, result } = await sanitizeToDirectory(source, {
          preserveColorProfile,
          preserveResolution,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");

        const destination = await readFile(destinationPath);
        const sourceColours = colourChunks(source);
        const destinationColours = colourChunks(destination);

        // D-09 non-goal invariant: native never writes a colour chunk -- the
        // output's colour-chunk set is always a subset of the source's.
        for (const type of destinationColours.keys()) {
          expect(sourceColours.has(type)).toBe(true);
        }
        if (id === "none") {
          expect(destinationColours.size).toBe(0);
        }

        // D-08: gAMA and sRGB are removed on every request, unconditionally.
        expect(destinationColours.has("gAMA")).toBe(false);
        expect(destinationColours.has("sRGB")).toBe(false);

        // D-08: cHRM, cICP, mDCv, cLLi are always kept byte-identical.
        for (const type of ["cHRM", "cICP", "mDCv", "cLLi"] as const) {
          if (sourceColours.has(type)) {
            expect(
              destinationColours.get(type)?.equals(sourceColours.get(type)!),
            ).toBe(true);
          } else {
            expect(destinationColours.has(type)).toBe(false);
          }
        }

        // D-08: iCCP follows preserveColorProfile, byte-identical when kept.
        if (sourceColours.has("iCCP")) {
          if (preserveColorProfile) {
            expect(
              destinationColours
                .get("iCCP")
                ?.equals(sourceColours.get("iCCP")!),
            ).toBe(true);
          } else {
            expect(destinationColours.has("iCCP")).toBe(false);
          }
        } else {
          expect(destinationColours.has("iCCP")).toBe(false);
        }
      },
    );
  });
});

/** Palette (colorType 3) PNG, IHDR PLTE, with `pHYs` placed either before or
 * after PLTE -- both legal per PNG_ORDER (pHYs is only constrained to occur
 * before the first IDAT, not relative to PLTE). */
function palettePngWithPhys(position: "before-plte" | "after-plte"): Buffer {
  const ihdr = pngChunk("IHDR", pngIhdr(1, 1, 8, 3));
  const plte = pngChunk("PLTE", Buffer.from([0, 0, 0]));
  const phys = pngChunk("pHYs", pngPhys());
  const idat = pngChunk("IDAT", pngIdat());
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const ordered =
    position === "before-plte"
      ? [ihdr, phys, plte, idat, iend]
      : [ihdr, plte, phys, idat, iend];
  return png(ordered);
}

describe.each(["before-plte", "after-plte"] as const)(
  "PNG resolution matrix: pHYs %s (D-02)",
  (position) => {
    it("preserveResolution true: pHYs kept byte-identical at the same relative position, preserved.resolution true", async () => {
      const source = palettePngWithPhys(position);
      const { destinationPath, result } = await sanitizeToDirectory(source, {
        preserveResolution: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.preserved.resolution).toBe(true);

      const destination = await readFile(destinationPath);
      const sourceTypes = chunkTypesOf(source);
      const destinationTypes = chunkTypesOf(destination);
      const sourcePhysIndex = sourceTypes.indexOf("pHYs");
      const destinationPhysIndex = destinationTypes.indexOf("pHYs");
      expect(destinationPhysIndex).toBeGreaterThanOrEqual(0);
      // Same neighbour on each side confirms the relative position held.
      expect(destinationTypes[destinationPhysIndex - 1]).toBe(
        sourceTypes[sourcePhysIndex - 1],
      );
      expect(destinationTypes[destinationPhysIndex + 1]).toBe(
        sourceTypes[sourcePhysIndex + 1],
      );

      const sourcePhys = chunkBytesOfType(source, "pHYs");
      const destinationPhys = chunkBytesOfType(destination, "pHYs");
      expect(destinationPhys?.equals(sourcePhys!)).toBe(true);
    });

    it("preserveResolution false: pHYs absent, preserved.resolution false", async () => {
      const source = palettePngWithPhys(position);
      const { destinationPath, result } = await sanitizeToDirectory(source, {
        preserveResolution: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.preserved.resolution).toBe(false);

      const destination = await readFile(destinationPath);
      expect(chunkTypesOf(destination)).not.toContain("pHYs");
    });
  },
);

describe("PNG decompression bounds: text-chunk bombs decline pre-write regardless of flags (D-14)", () => {
  it.each(FLAG_COMBOS)(
    "zTXt bomb (20 MiB inflated), preserveColorProfile=%s preserveResolution=%s",
    async (preserveColorProfile, preserveResolution) => {
      const source = pngWithChunksBefore([
        ["zTXt", pngBomb("zTXt", 20 * 1024 * 1024)],
      ]);
      const { result, directory } = await sanitizeToDirectory(source, {
        preserveColorProfile,
        preserveResolution,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("unsafe-structure");
      expect(result.error.nativeWrite).toBe("not-started");
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");

      const listing = await readdir(directory);
      expect(listing).toEqual(["source.png"]);
    },
    2000,
  );

  it.each(FLAG_COMBOS)(
    "compressed iTXt bomb (20 MiB inflated), preserveColorProfile=%s preserveResolution=%s",
    async (preserveColorProfile, preserveResolution) => {
      const source = pngWithChunksBefore([
        ["iTXt", pngBomb("iTXt", 20 * 1024 * 1024)],
      ]);
      const { result, directory } = await sanitizeToDirectory(source, {
        preserveColorProfile,
        preserveResolution,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("unsafe-structure");
      expect(result.error.nativeWrite).toBe("not-started");
      expect(classifyFallback(result.error)).toBe("safe-to-fallback");

      const listing = await readdir(directory);
      expect(listing).toEqual(["source.png"]);
    },
    2000,
  );

  it("aggregate zTXt budget: four 15 MiB chunks (each under the per-chunk cap) decline because the 48 MiB total is exceeded", async () => {
    const source = pngWithChunksBefore([
      ["zTXt", pngBomb("zTXt", 15 * 1024 * 1024)],
      ["zTXt", pngBomb("zTXt", 15 * 1024 * 1024)],
      ["zTXt", pngBomb("zTXt", 15 * 1024 * 1024)],
      ["zTXt", pngBomb("zTXt", 15 * 1024 * 1024)],
    ]);
    const { result, directory } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unsafe-structure");
    expect(result.error.nativeWrite).toBe("not-started");
    expect(classifyFallback(result.error)).toBe("safe-to-fallback");

    const listing = await readdir(directory);
    expect(listing).toEqual(["source.png"]);
  }, 2000);
});
