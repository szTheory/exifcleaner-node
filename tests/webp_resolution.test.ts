// WEBP-07 (68-05): native WebP preserves print resolution (EXIF IFD0 XResolution,
// YResolution, ResolutionUnit) through the shared minimal-EXIF writer. Everything here runs
// through the real engine (`sanitizeFile`), never a handler-only shortcut.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import type { RegisteredHandler } from "../src/admission/registry.js";
import { webpHandler } from "../src/admission/webp-handler.js";
import type { WebpAdmission } from "../src/admission/webp-handler.js";
import { sanitizeFile } from "../src/index.js";
import { createMinimalExif, parseExif } from "../src/metadata/exif.js";
import type { MinimalExifTags } from "../src/metadata/exif.js";
import {
  exifWithResolution,
  readChunks,
  vp8,
  vp8x,
  webp,
  type ExifResolutionFixtureOptions,
} from "./fixtures.js";

type EncoderFault = (tags: MinimalExifTags) => MinimalExifTags;

const encoderMock = vi.hoisted(() => ({
  fault: undefined as EncoderFault | undefined,
}));

// The WebP planner AND verifier both call createMinimalExif, so a fault injected here is the
// common-mode encoder defect only a parse-back of the destination can see. With no fault
// installed the mocked module is the real encoder.
vi.mock("../src/metadata/exif.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/metadata/exif.js")>();
  return {
    ...actual,
    createMinimalExif: (tags: MinimalExifTags) =>
      actual.createMinimalExif(
        encoderMock.fault === undefined ? tags : encoderMock.fault(tags),
      ),
  };
});

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-webp-res-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  encoderMock.fault = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Extended WebP: VP8X (EXIF flag), VP8 bitstream, then the given EXIF chunk payload. */
function webpWithExif(exif: Buffer): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x08) },
    { fourCc: "VP8 ", data: vp8() },
    { fourCc: "EXIF", data: exif },
  ]);
}

const RICH: ExifResolutionFixtureOptions = {
  make: "CameraCo",
  artist: "Some Artist",
  orientation: 6,
  xResolution: [300, 1],
  yResolution: [72, 1],
  resolutionUnit: 2,
};

const RICH_RESOLUTION = {
  x: { numerator: 300, denominator: 1 },
  y: { numerator: 72, denominator: 1 },
  unit: 2,
} as const;

interface Flags {
  readonly preserveOrientation: boolean;
  readonly preserveResolution: boolean;
}

async function run(
  source: Buffer,
  flags: Flags,
): Promise<{
  readonly directory: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly result: Awaited<ReturnType<typeof sanitizeFile>>;
}> {
  const directory = await workspace();
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "clean.webp");
  await writeFile(sourcePath, source);
  const result = await sanitizeFile({
    sourcePath,
    destinationPath,
    preserveOrientation: flags.preserveOrientation,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: flags.preserveResolution,
  });
  return { directory, sourcePath, destinationPath, result };
}

function exifChunks(output: Buffer): readonly Buffer[] {
  return readChunks(output)
    .filter((item) => item.fourCc === "EXIF")
    .map((item) => item.data);
}

describe("WEBP-07 tracer: resolution and orientation through the real engine", () => {
  it("keeps only the minimal EXIF (orientation plus the raw resolution triple) and sets the VP8X EXIF flag", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { directory, sourcePath, destinationPath, result } = await run(
      source,
      { preserveOrientation: true, preserveResolution: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    expect(result.value.preserved.orientation).toBe(true);

    const output = await readFile(destinationPath);
    const expected: MinimalExifTags = {
      orientation: 6,
      resolution: RICH_RESOLUTION,
    };
    expect(exifChunks(output)).toEqual([createMinimalExif(expected)]);
    const chunks = readChunks(output);
    expect(chunks.map((item) => item.fourCc)).toEqual(["VP8X", "VP8 ", "EXIF"]);
    expect(chunks[0]?.data[0]).toBe(0x08);
    expect(output.includes(Buffer.from("CameraCo"))).toBe(false);
    expect(output.includes(Buffer.from("Some Artist"))).toBe(false);

    expect((await readdir(directory)).sort()).toEqual([
      "clean.webp",
      "source.webp",
    ]);
    expect((await readFile(sourcePath)).equals(source)).toBe(true);
  });
});

describe("WEBP-07 edge cases (D-10, D-11, D-12)", () => {
  const BOTH: Flags = { preserveOrientation: true, preserveResolution: true };

  it.each([
    ["with the Exif identifier prefix", true],
    ["without the Exif identifier prefix", false],
  ] as const)(
    "copies the raw resolution from a source EXIF payload %s",
    async (_name, exifPrefix) => {
      const source = webpWithExif(exifWithResolution({ ...RICH, exifPrefix }));
      const { result, destinationPath } = await run(source, BOTH);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.preserved.resolution).toBe(true);
      expect(result.value.preserved.orientation).toBe(true);
      expect(exifChunks(await readFile(destinationPath))).toEqual([
        createMinimalExif({ orientation: 6, resolution: RICH_RESOLUTION }),
      ]);
    },
  );

  it("copies unreduced rationals exactly as stored (never reduced or reconciled)", async () => {
    const source = webpWithExif(
      exifWithResolution({
        xResolution: [3_000_000, 10_000],
        yResolution: [720_000, 10_000],
        resolutionUnit: 2,
      }),
    );
    const { result, destinationPath } = await run(source, {
      preserveOrientation: false,
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    expect(exifChunks(await readFile(destinationPath))).toEqual([
      createMinimalExif({
        resolution: {
          x: { numerator: 3_000_000, denominator: 10_000 },
          y: { numerator: 720_000, denominator: 10_000 },
          unit: 2,
        },
      }),
    ]);
  });

  it("writes no ResolutionUnit when the source had none (omission keeps the TIFF meaning)", async () => {
    const source = webpWithExif(
      exifWithResolution({
        orientation: 6,
        xResolution: [300, 1],
        yResolution: [72, 1],
      }),
    );
    const { result, destinationPath } = await run(source, BOTH);
    expect(result.ok).toBe(true);
    const chunks = exifChunks(await readFile(destinationPath));
    expect(chunks).toEqual([
      createMinimalExif({
        orientation: 6,
        resolution: {
          x: { numerator: 300, denominator: 1 },
          y: { numerator: 72, denominator: 1 },
        },
      }),
    ]);
    expect(parseExif(chunks[0]!).entries.map((entry) => entry.name)).toEqual([
      "Orientation",
      "XResolution",
      "YResolution",
    ]);
  });

  it("copies a centimetre ResolutionUnit (3) exactly", async () => {
    const source = webpWithExif(
      exifWithResolution({
        xResolution: [118, 1],
        yResolution: [118, 1],
        resolutionUnit: 3,
      }),
    );
    const { result, destinationPath } = await run(source, {
      preserveOrientation: false,
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    expect(exifChunks(await readFile(destinationPath))).toEqual([
      createMinimalExif({
        resolution: {
          x: { numerator: 118, denominator: 1 },
          y: { numerator: 118, denominator: 1 },
          unit: 3,
        },
      }),
    ]);
  });

  it("succeeds without a resolution when the source has none: preserved.resolution false, orientation-only EXIF, no decline", async () => {
    const source = webpWithExif(
      exifWithResolution({ make: "CameraCo", orientation: 6 }),
    );
    const { result, destinationPath } = await run(source, BOTH);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(result.value.preserved.orientation).toBe(true);
    expect(exifChunks(await readFile(destinationPath))).toEqual([
      createMinimalExif({ orientation: 6 }),
    ]);
  });

  it("writes no EXIF chunk and collapses to simple format when there is nothing to keep (no resolution, no orientation)", async () => {
    const source = webpWithExif(exifWithResolution({ make: "CameraCo" }));
    const { result, destinationPath } = await run(source, BOTH);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(result.value.preserved.orientation).toBe(false);
    expect(
      (await readFile(destinationPath)).equals(
        webp([{ fourCc: "VP8 ", data: vp8() }]),
      ),
    ).toBe(true);
  });

  it.each([
    ["XResolution only", { xResolution: [300, 1] }],
    ["YResolution only", { yResolution: [72, 1] }],
  ] as const)(
    "treats a one-sided pair (%s) as no resolution",
    async (_name, pair) => {
      const source = webpWithExif(
        exifWithResolution({ ...pair, resolutionUnit: 2 }),
      );
      const { result, destinationPath } = await run(source, {
        preserveOrientation: false,
        preserveResolution: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.preserved.resolution).toBe(false);
      expect(
        (await readFile(destinationPath)).equals(
          webp([{ fourCc: "VP8 ", data: vp8() }]),
        ),
      ).toBe(true);
    },
  );

  it("orientation only (resolution not requested): the output is byte-identical to the pre-change orientation-only file", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { result, destinationPath } = await run(source, {
      preserveOrientation: true,
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(
      (await readFile(destinationPath)).equals(
        webp([
          { fourCc: "VP8X", data: vp8x(0x08) },
          { fourCc: "VP8 ", data: vp8() },
          { fourCc: "EXIF", data: createMinimalExif({ orientation: 6 }) },
        ]),
      ),
    ).toBe(true);
  });

  it("no flags: the output is byte-identical to the pre-change stripped simple-format file", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { result, destinationPath } = await run(source, {
      preserveOrientation: false,
      preserveResolution: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(false);
    expect(
      (await readFile(destinationPath)).equals(
        webp([{ fourCc: "VP8 ", data: vp8() }]),
      ),
    ).toBe(true);
  });

  it("resolution requested without orientation while the source has both: the EXIF carries resolution only", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { result, destinationPath } = await run(source, {
      preserveOrientation: false,
      preserveResolution: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.preserved.resolution).toBe(true);
    expect(result.value.preserved.orientation).toBe(false);
    const chunks = exifChunks(await readFile(destinationPath));
    expect(chunks).toEqual([
      createMinimalExif({ resolution: RICH_RESOLUTION }),
    ]);
    expect(parseExif(chunks[0]!).orientation).toEqual({ status: "absent" });
  });
});

const RESOLUTION_DETAIL =
  "EXIF resolution did not parse back to the source resolution.";
const ORIENTATION_DETAIL = "EXIF Orientation was not preserved.";
const TAGS_DETAIL = "EXIF chunk did not match the requested minimal tags.";

async function expectNothingPublished(
  directory: string,
  sourcePath: string,
  source: Buffer,
  result: Awaited<ReturnType<typeof sanitizeFile>>,
  detail: string,
): Promise<void> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("verification-failed");
  expect(result.error.detail).toBe(detail);
  const listing = await readdir(directory);
  expect(listing).toContain("source.webp");
  expect(listing).not.toContain("clean.webp");
  for (const entry of listing) {
    if (entry === "source.webp") continue;
    expect(entry.startsWith(".exifcleaner-stage-")).toBe(true);
  }
  expect((await readFile(sourcePath)).equals(source)).toBe(true);
}

describe("WEBP-07 verifier faults (D-12): nothing is published", () => {
  const BOTH: Flags = { preserveOrientation: true, preserveResolution: true };

  it.each([
    ["orientation and resolution requested", BOTH],
    [
      "resolution only requested",
      { preserveOrientation: false, preserveResolution: true } as Flags,
    ],
  ] as const)(
    "a planner that loses the source resolution (%s) fails verification",
    async (_name, flags) => {
      const wrapped: RegisteredHandler = {
        ...webpHandler,
        buildOutputPlan(admission, ...rest) {
          const lossy: WebpAdmission = {
            ...(admission as WebpAdmission),
            sourceResolution: undefined,
          };
          return webpHandler.buildOutputPlan(lossy, ...rest);
        },
      };
      const restore = setRegisteredHandlersForTests([wrapped]);
      try {
        const source = webpWithExif(exifWithResolution(RICH));
        const { directory, sourcePath, result } = await run(source, flags);
        await expectNothingPublished(
          directory,
          sourcePath,
          source,
          result,
          TAGS_DETAIL,
        );
      } finally {
        restore();
      }
    },
  );

  interface FaultCase {
    readonly name: string;
    readonly flags: Flags;
    readonly fault: EncoderFault;
    readonly detail: string;
  }
  const swap = (tags: MinimalExifTags): MinimalExifTags => ({
    ...tags,
    resolution: {
      x: tags.resolution!.y,
      y: tags.resolution!.x,
      unit: tags.resolution!.unit!,
    },
  });
  const withResolution = (
    tags: MinimalExifTags,
    change: Partial<{
      xn: number;
      xd: number;
      yn: number;
      yd: number;
      unit: number | undefined;
    }>,
  ): MinimalExifTags => {
    const r = tags.resolution!;
    const unit = "unit" in change ? change.unit : r.unit;
    return {
      ...tags,
      resolution: {
        x: {
          numerator: change.xn ?? r.x.numerator,
          denominator: change.xd ?? r.x.denominator,
        },
        y: {
          numerator: change.yn ?? r.y.numerator,
          denominator: change.yd ?? r.y.denominator,
        },
        ...(unit === undefined ? {} : { unit }),
      },
    };
  };
  const CASES: readonly FaultCase[] = [
    {
      name: "swaps x and y",
      flags: BOTH,
      fault: swap,
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "drops the ResolutionUnit",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { unit: undefined }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "changes only the ResolutionUnit",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { unit: 3 }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "changes only the x numerator",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { xn: 301 }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "changes only the x denominator",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { xd: 2 }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "changes only the y numerator",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { yn: 73 }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "changes only the y denominator",
      flags: BOTH,
      fault: (tags) => withResolution(tags, { yd: 2 }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "omits the resolution although it was requested",
      flags: BOTH,
      fault: (tags) => ({ orientation: tags.orientation! }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "writes a resolution that was not requested",
      flags: { preserveOrientation: true, preserveResolution: false },
      fault: (tags) => ({ ...tags, resolution: RICH_RESOLUTION }),
      detail: RESOLUTION_DETAIL,
    },
    {
      name: "replaces the orientation value 6 by 3",
      flags: BOTH,
      fault: (tags) => ({ ...tags, orientation: 3 }),
      detail: ORIENTATION_DETAIL,
    },
    {
      name: "omits the orientation although it was requested",
      flags: BOTH,
      fault: (tags) => ({ resolution: tags.resolution! }),
      detail: ORIENTATION_DETAIL,
    },
    {
      name: "writes an orientation that was not requested",
      flags: { preserveOrientation: false, preserveResolution: true },
      fault: (tags) => ({ ...tags, orientation: 6 }),
      detail: ORIENTATION_DETAIL,
    },
  ];

  it.each(CASES)(
    "an encoder that $name is refused: verification-failed, nothing published, source preserved",
    async ({ flags, fault, detail }) => {
      const source = webpWithExif(exifWithResolution(RICH));
      encoderMock.fault = fault;
      try {
        const { directory, sourcePath, result } = await run(source, flags);
        await expectNothingPublished(
          directory,
          sourcePath,
          source,
          result,
          detail,
        );
      } finally {
        encoderMock.fault = undefined;
      }
    },
  );

  it("control: the faithful encoder with both requested succeeds under the same harness", async () => {
    const source = webpWithExif(exifWithResolution(RICH));
    const { directory, sourcePath, result } = await run(source, BOTH);
    expect(result.ok).toBe(true);
    expect((await readdir(directory)).sort()).toEqual([
      "clean.webp",
      "source.webp",
    ]);
    expect((await readFile(sourcePath)).equals(source)).toBe(true);
  });
});
