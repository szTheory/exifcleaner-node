import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFile, sanitizeFile } from "../dist/index.js";
import { parseExif } from "../src/metadata/exif.js";
import { parseIcc } from "../src/metadata/icc.js";
import { parseXmp } from "../src/metadata/xmp.js";
import {
  XMP_ITXT_KEYWORD,
  exifWithOrientation,
  iccProfileV4,
  metadataPng,
  pngCaBX,
  pngGama,
  pngIccp,
  pngItxt,
  pngPhys,
  pngSrgb,
  pngTextChunkData,
  pngTime,
  pngWithChunksBefore,
  pngZtxtChunkData,
  xmpPacket,
} from "./fixtures.js";

/**
 * D-15: PNG text/time/C2PA entries in inspection, and honest
 * removedNamespaces reporting (56-05).
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
    join(tmpdir(), "exifcleaner-png-inspection-"),
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

const ICC_PROFILE = iccProfileV4();
const EXIF_DATA = exifWithOrientation(6);
const XMP_DATA = xmpPacket("private-xmp-workflow");
const CABX_PAYLOAD = Buffer.from("c2pa-jumbf-manifest-payload", "ascii");

/**
 * A PNG carrying every D-15 entry-bearing chunk type, plus pHYs/gAMA/sRGB to
 * prove those produce no entries: `IHDR iCCP eXIf tEXt zTXt iTXt(XMP)
 * iTXt(other) tIME caBX pHYs gAMA sRGB IDAT IEND`.
 */
function everyEntryChunkPng(): Buffer {
  return pngWithChunksBefore([
    ["iCCP", pngIccp(ICC_PROFILE)],
    ["eXIf", EXIF_DATA],
    ["tEXt", pngTextChunkData("Comment", "text-chunk-value")],
    ["zTXt", pngZtxtChunkData("Author", "ztxt-chunk-value")],
    ["iTXt", pngItxt(XMP_ITXT_KEYWORD, XMP_DATA)],
    ["iTXt", pngItxt("UserComment", Buffer.from("itxt-chunk-value", "utf8"))],
    ["tIME", pngTime()],
    ["caBX", pngCaBX(CABX_PAYLOAD)],
    ["pHYs", pngPhys()],
    ["gAMA", pngGama()],
    ["sRGB", pngSrgb()],
  ]);
}

describe("PNG inspection entries (D-15)", () => {
  it("reports exactly the expected entries for every entry-bearing chunk type", async () => {
    const directory = await freshDirectory();
    const sourcePath = join(directory, "source.png");
    await writeFile(sourcePath, everyEntryChunkPng());

    const result = await inspectFile(sourcePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const { entries } = result.value;
    const iccEntries = parseIcc(ICC_PROFILE).entries;
    const exifEntries = parseExif(EXIF_DATA).entries;
    const xmpEntries = parseXmp(XMP_DATA).entries;

    expect(entries).toEqual(
      expect.arrayContaining([...iccEntries, ...exifEntries, ...xmpEntries]),
    );
    expect(entries).toContainEqual({
      namespace: "PNG",
      name: "Comment",
      value: "text-chunk-value",
    });
    expect(entries).toContainEqual({
      namespace: "PNG",
      name: "Author",
      value: "ztxt-chunk-value",
    });
    expect(entries).toContainEqual({
      namespace: "PNG",
      name: "UserComment",
      value: "itxt-chunk-value",
    });
    expect(entries).toContainEqual({
      namespace: "PNG",
      name: "ModifyDate",
      value: "2026:09:25 12:00:00",
    });
    expect(entries).toContainEqual({
      namespace: "C2PA",
      name: "JUMBF",
      value: CABX_PAYLOAD.length,
    });

    // No entry is produced for pHYs, gAMA or sRGB (D-15).
    const expectedTotal =
      iccEntries.length +
      exifEntries.length +
      xmpEntries.length +
      3 /* tEXt, zTXt, iTXt(other) */ +
      1 /* tIME ModifyDate */ +
      1; /* caBX JUMBF */
    expect(entries.length).toBe(expectedTotal);
  });
});

describe("PNG removedNamespaces reporting (D-15)", () => {
  it("metadataPng with all flags false: EXIF absent (no eXIf present), XMP absent, PNG present", async () => {
    const { result } = await sanitizeToDirectory(metadataPng());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).not.toContain("EXIF");
    expect(result.value.removedNamespaces).not.toContain("XMP");
    expect(result.value.removedNamespaces).toContain("PNG");
  });

  it("a PNG with only pHYs removable, preserveResolution false: PNG present (resolutionNamespace)", async () => {
    const source = pngWithChunksBefore([["pHYs", pngPhys()]]);
    const { result } = await sanitizeToDirectory(source, {
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).toEqual(["PNG"]);
    expect(result.value.preserved.resolution).toBe(false);
  });

  it("the same source, preserveResolution true: PNG absent, preserved.resolution true", async () => {
    const source = pngWithChunksBefore([["pHYs", pngPhys()]]);
    const { result } = await sanitizeToDirectory(source, {
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).toEqual([]);
    expect(result.value.preserved.resolution).toBe(true);
  });

  it("a caBX PNG: C2PA present in removedNamespaces", async () => {
    const source = pngWithChunksBefore([["caBX", pngCaBX(CABX_PAYLOAD)]]);
    const { result } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.removedNamespaces).toContain("C2PA");
  });

  it("inspected text entry values never leak into the sanitize output (raw byte canary)", async () => {
    const canary = "private-workflow-canary-9f3a";
    const source = pngWithChunksBefore([
      ["tEXt", pngTextChunkData("Comment", canary)],
      ["zTXt", pngZtxtChunkData("Author", canary)],
      ["iTXt", pngItxt("UserComment", Buffer.from(canary, "utf8"))],
    ]);
    const { destinationPath, result } = await sanitizeToDirectory(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const destination = await readFile(destinationPath);
    expect(destination.includes(Buffer.from(canary, "latin1"))).toBe(false);
    expect(destination.includes(Buffer.from(canary, "utf8"))).toBe(false);
  });
});
