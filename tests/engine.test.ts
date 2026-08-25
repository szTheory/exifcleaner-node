import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { getCapabilities, inspectFile, sanitizeFile } from "../src/index.js";
import {
  chunk,
  anim,
  animationFrame,
  exifWithOrientation,
  iccProfile,
  iccProfileV4,
  metadataWebp,
  mutateIccProfile,
  readChunks,
  vp8,
  vp8x,
  webp,
  xmpPacket,
} from "./fixtures.js";

const directories: string[] = [];
const UPSTREAM_SAMPLE = Buffer.from(
  "UklGRpAAAABXRUJQVlA4WAoAAAAIAAAAAAAAAAAAVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAABFWElGUgAAAE1NACoAAAAQRXhpZk1ldGEAAwEPAAIAAAALAAAAOgE7AAIAAAAMAAAARgITAAMAAAABAAEAAAAAAABUZXN0Q2FtZXJhAABUZXN0IEF1dGhvcgA=",
  "base64",
);

function webpWithExif(exif: Buffer): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x08) },
    { fourCc: "VP8 ", data: vp8() },
    { fourCc: "EXIF", data: exif },
  ]);
}

function orientationVariant(
  type: number,
  count: number,
  value: number,
): Buffer {
  const exif = exifWithOrientation(6);
  exif.writeUInt16LE(type, 12);
  exif.writeUInt32LE(count, 14);
  exif.writeUInt32LE(value, 18);
  return exif;
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-node-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("getCapabilities", () => {
  it("reports the exact conservative WebP feature set as immutable data", () => {
    const capabilities = getCapabilities();
    expect(capabilities).toEqual({
      formats: [
        {
          format: "webp",
          mimeTypes: ["image/webp"],
          extensions: [".webp"],
          inspect: true,
          sanitize: true,
          preserves: {
            orientation: true,
            colorProfile: true,
            timestamps: true,
            imagePayload: true,
            animationPayload: true,
          },
          animation: {
            supported: true,
            payloadPreservation: "byte-for-byte",
            boundary: "aggregate-chunk-count",
          },
          validation: {
            container: "full",
            codecBitstream: "header-only",
          },
          limits: {
            maxMetadataBytesPerChunk: 16 * 1024 * 1024,
            maxChunkCount: 10_000,
            maxRiffBytes: 4_294_967_294,
          },
          refuses: [
            "unknown-chunks",
            "malformed-container",
            "unsupported-features",
            "resource-limits",
            "trailing-data",
          ],
          removes: ["EXIF", "XMP", "ICC"],
          detection: "magic",
        },
      ],
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.formats[0]?.preserves)).toBe(true);
  });
});

describe("inspectFile", () => {
  it("detects WebP by magic regardless of extension and returns structured EXIF, XMP, and ICC entries", async () => {
    const directory = await workspace();
    const path = join(directory, "not-an-image.txt");
    await writeFile(path, metadataWebp());

    const result = await inspectFile(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format).toBe("webp");
    expect(result.value.entries).toEqual(
      expect.arrayContaining([
        { namespace: "EXIF", name: "Orientation", value: 6 },
        { namespace: "EXIF", name: "Make", value: "CameraCo" },
        { namespace: "XMP", name: "dc:format", value: "image/webp" },
        { namespace: "XMP", name: "dc:description", value: "private workflow" },
        { namespace: "ICC", name: "ColorSpace", value: "RGB " },
        { namespace: "ICC", name: "RenderingIntent", value: 0 },
      ]),
    );
    expect(result.value.warnings).toEqual([]);
  });

  it("returns warnings rather than throwing when removable metadata is internally invalid", async () => {
    const directory = await workspace();
    const path = join(directory, "invalid-metadata.webp");
    await writeFile(
      path,
      webp([
        { fourCc: "VP8X", data: vp8x(0x0c) },
        { fourCc: "VP8 ", data: vp8() },
        { fourCc: "EXIF", data: Buffer.from("bad") },
        { fourCc: "XMP ", data: Buffer.from([0xff]) },
      ]),
    );

    const result = await inspectFile(path);

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.warnings.map((warning) => warning.code)).toEqual([
        "metadata-invalid",
        "metadata-invalid",
      ]);
  });

  it.each([
    ["empty input", Buffer.alloc(0), "unsupported-format"],
    ["wrong magic", Buffer.from("not a webp file"), "unsupported-format"],
    [
      "trailing bytes",
      Buffer.concat([metadataWebp(), Buffer.from([0])]),
      "malformed-file",
    ],
    [
      "declared truncation",
      webp([{ fourCc: "VP8 ", data: vp8(1, 1, Buffer.from([1])) }], 2),
      "malformed-file",
    ],
    [
      "unknown chunk",
      webp([
        { fourCc: "JUNK", data: Buffer.alloc(0) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "unsafe-structure",
    ],
    [
      "non-zero pad",
      webp([
        {
          fourCc: "VP8 ",
          data: vp8(1, 1, Buffer.from([1])),
          padding: 7,
        },
      ]),
      "malformed-file",
    ],
    [
      "duplicate singleton",
      webp([
        { fourCc: "VP8 ", data: vp8() },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "unsafe-structure",
    ],
    [
      "metadata without VP8X",
      webp([
        { fourCc: "VP8 ", data: vp8() },
        { fourCc: "EXIF", data: exifWithOrientation(1) },
      ]),
      "malformed-file",
    ],
    [
      "mismatched flag",
      webp([
        { fourCc: "VP8X", data: vp8x(0x08) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "malformed-file",
    ],
    [
      "reserved VP8X bit",
      webp([
        { fourCc: "VP8X", data: vp8x(0x01) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "malformed-file",
    ],
    [
      "detached alpha chunk",
      webp([
        { fourCc: "VP8X", data: vp8x(0x10) },
        { fourCc: "ALPH", data: Buffer.from([1, 2]) },
        { fourCc: "EXIF", data: exifWithOrientation(1) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
      "malformed-file",
    ],
  ])("refuses %s conservatively", async (_name, fixture, code) => {
    const directory = await workspace();
    const path = join(directory, "input.webp");
    await writeFile(path, fixture);
    const result = await inspectFile(path);
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("reports missing files as a typed JSON-safe error", async () => {
    const directory = await workspace();
    const path = join(directory, "missing.webp");
    const result = await inspectFile(path);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "not-found", path, cause: { code: "ENOENT" } },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("accepts cancellation through InspectOptions", async () => {
    const directory = await workspace();
    const path = join(directory, "input.webp");
    await writeFile(path, metadataWebp());
    const controller = new AbortController();
    controller.abort();

    expect(
      await inspectFile(path, { signal: controller.signal }),
    ).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("reports malformed XMP and invalid numeric entities as warnings", async () => {
    const directory = await workspace();
    for (const [name, xmp] of [
      ["mismatched", "<x:xmpmeta><rdf:RDF></x:xmpmeta>"],
      [
        "numeric",
        "<x:xmpmeta><rdf:RDF><dc:title>&#x110000;</dc:title></rdf:RDF></x:xmpmeta>",
      ],
    ] as const) {
      const path = join(directory, `${name}.webp`);
      await writeFile(
        path,
        webp([
          { fourCc: "VP8X", data: vp8x(0x04) },
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "XMP ", data: Buffer.from(xmp) },
        ]),
      );
      const result = await inspectFile(path);
      expect(result).toMatchObject({
        ok: true,
        value: { entries: [], warnings: [{ code: "metadata-invalid" }] },
      });
    }
  });

  it("bounds ICC tag tables and tag payload offsets", async () => {
    const directory = await workspace();
    const path = join(directory, "bad-icc.webp");
    const icc = Buffer.alloc(144);
    icc.writeUInt32BE(icc.length, 0);
    icc.write("acsp", 36, 4, "ascii");
    icc.writeUInt32BE(1, 128);
    icc.write("desc", 132, 4, "ascii");
    icc.writeUInt32BE(0xfffffff0, 136);
    icc.writeUInt32BE(64, 140);
    await writeFile(
      path,
      webp([
        { fourCc: "VP8X", data: vp8x(0x20) },
        { fourCc: "ICCP", data: icc },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    );

    const result = await inspectFile(path);

    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: expect.arrayContaining([
          { namespace: "ICC", name: "TagCount", value: 1 },
        ]),
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "metadata-invalid" }),
        ]),
      },
    });
  });
});

describe("sanitizeFile", () => {
  it("strips EXIF, XMP, and ICC; updates VP8X flags; preserves image bytes; and leaves source untouched", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    const imagePayload = vp8(1, 1, Buffer.from([9, 8, 7, 6, 5]));
    const source = metadataWebp(imagePayload);
    await writeFile(sourcePath, source);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        format: "webp",
        destinationPath,
        removedNamespaces: ["EXIF", "XMP", "ICC"],
        preserved: {
          orientation: false,
          colorProfile: false,
          timestamps: false,
        },
      },
    });
    expect(await readFile(sourcePath)).toEqual(source);
    const output = await readFile(destinationPath);
    const chunks = readChunks(output);
    expect(chunks.map((item) => item.fourCc)).toEqual(["VP8X", "VP8 "]);
    expect(chunks[0]?.data[0]).toBe(0);
    expect(chunks[1]?.data).toEqual(imagePayload);
    expect(output.readUInt32LE(4) + 8).toBe(output.length);
  });

  it("preserves only EXIF Orientation and the ICC profile when requested", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, metadataWebp());

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: true,
      preserveColorProfile: true,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        removedNamespaces: ["XMP"],
        preserved: { orientation: true, colorProfile: true },
      },
    });
    const inspection = await inspectFile(destinationPath);
    expect(inspection).toMatchObject({
      ok: true,
      value: {
        entries: expect.arrayContaining([
          { namespace: "EXIF", name: "Orientation", value: 6 },
          { namespace: "ICC", name: "ColorSpace", value: "RGB " },
        ]),
      },
    });
    if (inspection.ok) {
      expect(
        inspection.value.entries.some((entry) => entry.name === "Make"),
      ).toBe(false);
      expect(
        inspection.value.entries.some((entry) => entry.namespace === "XMP"),
      ).toBe(false);
    }
    const chunks = readChunks(await readFile(destinationPath));
    expect(chunks[0]?.data[0]).toBe(0x28);
    expect(chunks.find((item) => item.fourCc === "ICCP")?.data).toEqual(
      iccProfile(),
    );
  });

  it("preserves an admitted ICC profile byte-for-byte after reopening the destination", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    const profile = iccProfileV4();
    await writeFile(
      sourcePath,
      webp([
        { fourCc: "VP8X", data: vp8x(0x20) },
        { fourCc: "ICCP", data: profile },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    );

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { preserved: { colorProfile: true } },
    });
    expect(
      readChunks(await readFile(destinationPath)).find(
        (item) => item.fourCc === "ICCP",
      )?.data,
    ).toEqual(profile);
  });

  it("refuses an invalid requested ICC profile before creating the destination", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(
      sourcePath,
      webp([
        { fourCc: "VP8X", data: vp8x(0x20) },
        { fourCc: "ICCP", data: mutateIccProfile(iccProfileV4(), "signature") },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    );

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported-feature",
        feature: "color-profile-preservation",
        reason: "invalid",
      },
    });
    await expect(access(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("concurrently refuses the same invalid ICC profile without creating a destination", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(
      sourcePath,
      webp([
        { fourCc: "VP8X", data: vp8x(0x20) },
        { fourCc: "ICCP", data: mutateIccProfile(iccProfileV4(), "signature") },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    );
    const options = {
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: true,
      preserveTimestamps: false,
    } as const;

    const results = await Promise.all([sanitizeFile(options), sanitizeFile(options)]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: "unsupported-feature",
            feature: "color-profile-preservation",
            reason: "invalid",
          }),
        }),
      ]),
    );
    await expect(access(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves animation chunk ordering and every animation payload byte", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "animation.webp");
    const destinationPath = join(directory, "clean.webp");
    const animationHeader = anim(0x04030201, 0x0605);
    const frameOne = animationFrame({
      duration: 7,
      chunks: [{ fourCc: "VP8 ", data: vp8(1, 1, Buffer.from([8, 9])) }],
    });
    const frameTwo = animationFrame({
      duration: 10,
      chunks: [{ fourCc: "VP8 ", data: vp8(1, 1, Buffer.from([11, 12, 13])) }],
    });
    await writeFile(
      sourcePath,
      webp([
        { fourCc: "VP8X", data: vp8x(0x0e) },
        { fourCc: "ANIM", data: animationHeader },
        { fourCc: "ANMF", data: frameOne },
        { fourCc: "ANMF", data: frameTwo },
        { fourCc: "EXIF", data: exifWithOrientation(6) },
        { fourCc: "XMP ", data: xmpPacket() },
      ]),
    );

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result.ok).toBe(true);
    const outputChunks = readChunks(await readFile(destinationPath));
    expect(outputChunks.map((item) => item.fourCc)).toEqual([
      "VP8X",
      "ANIM",
      "ANMF",
      "ANMF",
    ]);
    expect(outputChunks[1]?.data).toEqual(animationHeader);
    expect(outputChunks[2]?.data).toEqual(frameOne);
    expect(outputChunks[3]?.data).toEqual(frameTwo);
    expect(outputChunks[0]?.data[0]).toBe(0x02);
  });

  it("creates the destination exclusively without changing an existing file", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "existing.webp");
    await writeFile(sourcePath, metadataWebp());
    await writeFile(destinationPath, "do not replace");

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination-exists", path: destinationPath },
    });
    expect(await readFile(destinationPath, "utf8")).toBe("do not replace");
  });

  it.each([
    ["malformed EXIF", Buffer.from("bad")],
    ["non-SHORT Orientation", orientationVariant(4, 1, 6)],
    ["multi-value Orientation", orientationVariant(3, 2, 0x0006_0001)],
    ["out-of-range Orientation", orientationVariant(3, 1, 9)],
  ])(
    "refuses %s when orientation preservation is requested",
    async (_name, exif) => {
      const directory = await workspace();
      const sourcePath = join(directory, "source.webp");
      const destinationPath = join(directory, "clean.webp");
      await writeFile(sourcePath, webpWithExif(exif));

      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: true,
        preserveColorProfile: false,
        preserveTimestamps: false,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "unsupported-feature",
          feature: "orientation-preservation",
        },
      });
      await expect(access(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("strips malformed EXIF when orientation preservation is not requested", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, webpWithExif(Buffer.from("bad")));

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { removedNamespaces: ["EXIF"] },
    });
  });

  it("does not delete or timestamp a replacement destination inode", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(
      sourcePath,
      metadataWebp(vp8(1, 1, Buffer.alloc(4 * 1024 * 1024, 7))),
    );
    const operation = sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: true,
    });
    while (true) {
      try {
        await access(destinationPath);
        break;
      } catch {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    await rm(destinationPath);
    const replacement = Buffer.from("replacement-owned-by-someone-else");
    await writeFile(destinationPath, replacement);
    const replacementTime = new Date("2024-04-05T06:07:08.000Z");
    await utimes(destinationPath, replacementTime, replacementTime);

    const result = await operation;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination-changed", path: destinationPath },
    });
    expect(await readFile(destinationPath)).toEqual(replacement);
    expect((await stat(destinationPath)).mtimeMs).toBe(
      replacementTime.getTime(),
    );
  });

  it("preserves source atime and mtime on the destination when requested", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, metadataWebp());
    const atime = new Date("2020-01-02T03:04:05.000Z");
    const mtime = new Date("2021-02-03T04:05:06.000Z");
    await utimes(sourcePath, atime, mtime);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { preserved: { timestamps: true } },
    });
    const destinationStats = await stat(destinationPath);
    expect(destinationStats.atimeMs).toBe(atime.getTime());
    expect(destinationStats.mtimeMs).toBe(mtime.getTime());
  });

  it("aborts before effects and does not leave a destination", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, metadataWebp());
    const controller = new AbortController();
    controller.abort();

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(await readdir(directory)).toEqual(["source.webp"]);
  });

  it("refuses unsafe input without creating destination or other directory entries", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(
      sourcePath,
      Buffer.concat([metadataWebp(), Buffer.from("trailer")]),
    );

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "malformed-file" },
    });
    expect(await readdir(directory)).toEqual(["source.webp"]);
  });

  it("is deterministic and idempotent", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "source.webp");
    const firstPath = join(directory, "first.webp");
    const secondPath = join(directory, "second.webp");
    const thirdPath = join(directory, "third.webp");
    await writeFile(sourcePath, metadataWebp());
    const options = {
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    } as const;

    expect(
      (
        await sanitizeFile({
          sourcePath,
          destinationPath: firstPath,
          ...options,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await sanitizeFile({
          sourcePath,
          destinationPath: secondPath,
          ...options,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await sanitizeFile({
          sourcePath: firstPath,
          destinationPath: thirdPath,
          ...options,
        })
      ).ok,
    ).toBe(true);

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(await readFile(firstPath)).toEqual(await readFile(thirdPath));
  });

  it("preserves arbitrary bounded VP8 payloads byte-for-byte", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 8_192 }),
        async (bytes) => {
          const directory = await workspace();
          const sourcePath = join(directory, "source.webp");
          const destinationPath = join(directory, "clean.webp");
          const payload = vp8(1, 1, Buffer.from(bytes));
          await writeFile(sourcePath, metadataWebp(payload));
          const result = await sanitizeFile({
            sourcePath,
            destinationPath,
            preserveOrientation: false,
            preserveColorProfile: false,
            preserveTimestamps: false,
          });
          expect(result.ok).toBe(true);
          const outputPayload = readChunks(
            await readFile(destinationPath),
          ).find((item) => item.fourCc === "VP8 ")?.data;
          expect(outputPayload).toEqual(payload);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("copies payloads larger than one I/O block without buffering the file", async () => {
    const directory = await workspace();
    const sourcePath = join(directory, "large-source.webp");
    const destinationPath = join(directory, "large-clean.webp");
    const tail = Buffer.alloc(200_000);
    for (let index = 0; index < tail.length; index += 1)
      tail[index] = index & 0xff;
    const payload = vp8(1, 1, tail);
    await writeFile(sourcePath, metadataWebp(payload));

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });

    expect(result.ok).toBe(true);
    expect(
      readChunks(await readFile(destinationPath)).find(
        (item) => item.fourCc === "VP8 ",
      )?.data,
    ).toEqual(payload);
  });

  it("handles odd-sized generated metadata and payload chunks with valid RIFF padding", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.uint8Array({ minLength: 1, maxLength: 257 }),
        async (privateText, bytes) => {
          const directory = await workspace();
          const sourcePath = join(directory, "source.webp");
          const destinationPath = join(directory, "clean.webp");
          const xmp = xmpPacket(privateText);
          const payload = vp8(1, 1, Buffer.from(bytes));
          await writeFile(
            sourcePath,
            webp([
              { fourCc: "VP8X", data: vp8x(0x04) },
              { fourCc: "VP8 ", data: payload },
              { fourCc: "XMP ", data: xmp },
            ]),
          );
          const result = await sanitizeFile({
            sourcePath,
            destinationPath,
            preserveOrientation: false,
            preserveColorProfile: false,
            preserveTimestamps: false,
          });
          expect(result.ok).toBe(true);
          expect(
            readChunks(await readFile(destinationPath)).find(
              (item) => item.fourCc === "VP8 ",
            )?.data,
          ).toEqual(payload);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("low-level boundary regression fixtures", () => {
  it("rejects a chunk whose advertised size crosses the file boundary", async () => {
    const directory = await workspace();
    const path = join(directory, "crosses.webp");
    const fixture = webp([{ fourCc: "VP8 ", data: vp8() }]);
    fixture.writeUInt32LE(0xffff_ffff, 16);
    await writeFile(path, fixture);
    expect(await inspectFile(path)).toMatchObject({
      ok: false,
      error: { code: "malformed-file" },
    });
  });

  it("rejects an oversized metadata declaration before allocating it", async () => {
    const directory = await workspace();
    const path = join(directory, "oversized.webp");
    const fixture = Buffer.concat([
      webp([
        { fourCc: "VP8X", data: vp8x(0x08) },
        { fourCc: "EXIF", data: Buffer.alloc(0) },
        { fourCc: "VP8 ", data: vp8() },
      ]),
    ]);
    // This becomes a bounds failure without allocating the advertised body.
    fixture.writeUInt32LE(20 * 1024 * 1024, 34);
    await writeFile(path, fixture);
    expect(await inspectFile(path)).toMatchObject({
      ok: false,
      error: { code: "unsafe-structure" },
    });
  });

  it("retains a zero padding byte for odd payloads", () => {
    const encoded = chunk("VP8 ", Buffer.from([1, 2, 3]));
    expect(encoded.at(-1)).toBe(0);
  });
});

describe("pinned upstream ExifCleaner fixture", () => {
  it("matches provenance, inspects fields, and preserves its VP8 payload", async () => {
    expect(UPSTREAM_SAMPLE).toHaveLength(152);
    expect(createHash("sha256").update(UPSTREAM_SAMPLE).digest("hex")).toBe(
      "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
    );
    const directory = await workspace();
    const sourcePath = join(directory, "upstream.webp");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, UPSTREAM_SAMPLE);

    const inspection = await inspectFile(sourcePath);
    expect(inspection).toMatchObject({
      ok: true,
      value: {
        entries: expect.arrayContaining([
          { namespace: "EXIF", name: "Make", value: "TestCamera" },
          { namespace: "EXIF", name: "Artist", value: "Test Author" },
        ]),
      },
    });
    const originalPayload = readChunks(UPSTREAM_SAMPLE).find(
      (item) => item.fourCc === "VP8 ",
    )?.data;
    const sanitized = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
    });
    expect(sanitized).toMatchObject({
      ok: true,
      value: { removedNamespaces: ["EXIF"] },
    });
    expect(
      readChunks(await readFile(destinationPath)).find(
        (item) => item.fourCc === "VP8 ",
      )?.data,
    ).toEqual(originalPayload);
  });
});
