import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../dist/index.js";
import {
  iccProfileV4,
  mutateIccProfile,
  pngBomb,
  pngChrm,
  pngGama,
  pngIccp,
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
