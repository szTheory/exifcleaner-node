// ISO-06 (62-11): re-cleaning is byte-stable. Task 1 proves clean(clean(x)) == clean(x) for the
// two committed heif-enc fixtures under three option sets, for one builder fixture per class named
// in the plan's must-have truth (hidden/auxiliary metadata + C2PA, free/skip, ICC, minimal Exif),
// and for a fixed-seed generator sample per non-hazard arm. Task 2 proves clean(exiftool(x)) ==
// clean(clean(exiftool(x))) against a real ExifTool 13.59, resolved either through the pinned
// KIT-09 linux/x64 authority (read-only `loadOrPrepareOracleTools`) or the electron repo's vendored
// 13.59 download, with the Exif item identity/prefix check the plan names.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeFile } from "../src/engine.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
} from "./isobmff-support/inventory.js";
import {
  auxC,
  box,
  colrNclx,
  colrProf,
  hvcC,
  ispe,
  pixi,
} from "./isobmff-support/builder.js";
import { assembleHeif, type AssembleHeifSpec } from "./isobmff-support/hostile.js";
import { createOrientationExif } from "../src/metadata/exif.js";
import { iccProfileV4 } from "./fixtures.js";
import {
  isobmffArmSampleArbitrary,
  type IsobmffArm,
} from "./isobmff-support/generator.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.avif");

type Brand = "heic" | "avif";
type PreserveOptions = Omit<
  Parameters<typeof sanitizeFile>[0],
  "sourcePath" | "destinationPath"
>;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-idempotence-"));
  directories.push(directory);
  return directory;
}

/** `clean(bytes, brand, options)`: sanitizes through the real (unregistered) ISOBMFF writer
 * handler for `brand`, returning the destination bytes. Throws if the engine declines. */
async function clean(
  bytes: Buffer,
  brand: Brand,
  options: PreserveOptions,
): Promise<Buffer> {
  const directory = await freshDirectory();
  const sourcePath = join(directory, `source.${brand}`);
  const destinationPath = join(directory, `destination.${brand}`);
  await writeFile(sourcePath, bytes);
  const restore = setRegisteredHandlersForTests([
    createIsobmffWriterHandlerForTests(brand),
  ]);
  try {
    const sanitized = await sanitizeFile({ sourcePath, destinationPath, ...options });
    if (!sanitized.ok) {
      throw new Error(`sanitizeFile declined: ${JSON.stringify(sanitized.error)}`);
    }
    return await readFile(destinationPath);
  } finally {
    restore();
  }
}

/** Reads the `ftyp` major_brand directly (bytes [8,12)) -- no `src/isobmff/*` import needed, this
 * file is outside `tests/isobmff-support/`'s D-19 isolation discipline but there is no reason to
 * take on that dependency just to pick which writer handler a generated sample needs. */
function detectBrand(bytes: Buffer): Brand {
  const majorBrand = bytes.toString("ascii", 8, 12);
  if (majorBrand === "avif") return "avif";
  return "heic";
}

const OPTION_SETS: Readonly<Record<string, PreserveOptions>> = {
  "default settings": {
    preserveOrientation: true,
    preserveColorProfile: true,
    preserveTimestamps: true,
    preserveResolution: true,
  },
  "all preserve flags false": {
    preserveOrientation: false,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: false,
  },
  "preserveColorProfile false with orientation and resolution true": {
    preserveOrientation: true,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: true,
  },
};

describe("ISO-06 clean(clean(x)) (62-11)", () => {
  // --- Six committed-fixture cases: two fixtures x three option sets ---

  const COMMITTED_FIXTURE_CASES = (["heic", "avif"] as const).flatMap((brand) =>
    Object.entries(OPTION_SETS).map(
      ([label, options]) => [brand, label, options] as const,
    ),
  );

  describe("committed heif-enc fixtures", () => {
    it.each(COMMITTED_FIXTURE_CASES)(
      "%s fixture, %s: clean(clean(x)) is byte-equal to clean(x)",
      async (brand, _label, options) => {
        const fixturePath = brand === "heic" ? HEIC_FIXTURE : AVIF_FIXTURE;
        const bytes = await readFile(fixturePath);
        const once = await clean(bytes, brand, options);
        const twice = await clean(once, brand, options);
        expect(twice.equals(once)).toBe(true);
      },
    );
  });

  // --- One builder fixture per class named in the must-have truth ---

  function brandSpec(brand: Brand): {
    readonly majorBrand: string;
    readonly compatibleBrands: readonly string[];
  } {
    return brand === "heic"
      ? { majorBrand: "heic", compatibleBrands: ["mif1", "heic"] }
      : { majorBrand: "avif", compatibleBrands: ["mif1", "avif"] };
  }

  const AUX_PRIMARY_ID = 1;
  const AUX_AUX_ID = 2;
  const AUX_EXIF_ID = 3;
  const AUX_XMP_ID = 4;
  const C2PA_UUID_USERTYPE = "d8fec3d61b0e483c92975828877ec481";
  const ALPHA_URN = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha";

  /** Hidden auxiliary image, a hidden Exif item referencing the aux (not the primary), an XMP
   * item, and a top-level C2PA `uuid` right after `ftyp` (62-06 builder fixture class). */
  function buildAuxHiddenC2paFixture(brand: Brand): Buffer {
    const { majorBrand, compatibleBrands } = brandSpec(brand);
    const primaryPayload = Buffer.from([0xa0, 0xa1, 0xa2, 0xa3]);
    const auxPayload = Buffer.from([0xb0, 0xb1, 0xb2, 0xb3]);
    const exifPayload = Buffer.concat([
      Buffer.alloc(4),
      createOrientationExif(1),
    ]);
    const xmpPayload = Buffer.from("<x:xmpmeta>idempotence-62-11</x:xmpmeta>", "ascii");
    const itemType = brand === "heic" ? "hvc1" : "av01";

    const spec: AssembleHeifSpec = {
      majorBrand,
      compatibleBrands,
      primaryItemId: AUX_PRIMARY_ID,
      items: [
        {
          itemId: AUX_PRIMARY_ID,
          itemType,
          extents: [{ relOffset: 0, length: primaryPayload.length }],
          propertyIndices: [1, 2],
        },
        {
          itemId: AUX_AUX_ID,
          itemType,
          hidden: true,
          extents: [
            { relOffset: primaryPayload.length, length: auxPayload.length },
          ],
          propertyIndices: [3],
        },
        {
          itemId: AUX_EXIF_ID,
          itemType: "Exif",
          hidden: true,
          extents: [
            {
              relOffset: primaryPayload.length + auxPayload.length,
              length: exifPayload.length,
            },
          ],
        },
        {
          itemId: AUX_XMP_ID,
          itemType: "mime",
          contentType: "application/rdf+xml",
          extents: [
            {
              relOffset:
                primaryPayload.length + auxPayload.length + exifPayload.length,
              length: xmpPayload.length,
            },
          ],
        },
      ],
      properties: [ispe(32, 32), hvcC(), auxC(ALPHA_URN)],
      refs: [
        { type: "auxl", fromItemId: AUX_AUX_ID, toItemIds: [AUX_PRIMARY_ID] },
        { type: "cdsc", fromItemId: AUX_EXIF_ID, toItemIds: [AUX_AUX_ID] },
        { type: "cdsc", fromItemId: AUX_XMP_ID, toItemIds: [AUX_PRIMARY_ID] },
      ],
      mdatPayload: Buffer.concat([
        primaryPayload,
        auxPayload,
        exifPayload,
        xmpPayload,
      ]),
      topLevelExtraAfterFtyp: [box("uuid", Buffer.concat([
        Buffer.from(C2PA_UUID_USERTYPE, "hex"),
        Buffer.alloc(16, 0x11),
      ]))],
      twoPass: true,
    };
    return assembleHeif(spec);
  }

  /** `free`/`skip` boxes at the top level, which the writer always drops (62-06 D-14). */
  function buildFreeSkipFixture(brand: Brand): Buffer {
    const { majorBrand, compatibleBrands } = brandSpec(brand);
    const itemType = brand === "heic" ? "hvc1" : "av01";
    return assembleHeif({
      majorBrand,
      compatibleBrands,
      items: [
        {
          itemId: 1,
          itemType,
          extents: [{ relOffset: 0, length: 4 }],
          propertyIndices: [1, 2],
        },
      ],
      mdatPayload: Buffer.from([1, 2, 3, 4]),
      topLevelExtraAfterFtyp: [box("free", Buffer.alloc(4))],
      topLevelExtraBeforeMdat: [box("skip", Buffer.alloc(4))],
      twoPass: true,
    });
  }

  /** `colr` prof + nclx + rICC on the primary (62-08 builder fixture class): with
   * `preserveColorProfile: false`, prof/rICC are removed and associations remapped; `nclx`
   * always survives. */
  function colrRicc(iccBytes: Buffer): Buffer {
    return box("colr", Buffer.concat([Buffer.from("rICC", "ascii"), iccBytes]));
  }

  function buildIccFixture(brand: Brand): Buffer {
    const { majorBrand, compatibleBrands } = brandSpec(brand);
    const itemType = brand === "heic" ? "hvc1" : "av01";
    const primaryPayload = Buffer.from("primary-bytes-62-11", "ascii");
    return assembleHeif({
      majorBrand,
      compatibleBrands,
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType,
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
      ],
      properties: [
        ispe(32, 32),
        hvcC(),
        colrProf(iccProfileV4({ deviceClass: "mntr" })),
        colrNclx(1, 13, 6, true),
        pixi([8, 8, 8]),
        colrRicc(iccProfileV4({ deviceClass: "scnr" })),
      ],
      extraIpmaEntries: [
        {
          itemId: 1,
          associations: [
            { propertyIndex: 1, essential: false },
            { propertyIndex: 2, essential: true },
            { propertyIndex: 3, essential: false },
            { propertyIndex: 4, essential: false },
            { propertyIndex: 5, essential: false },
            { propertyIndex: 6, essential: false },
          ],
        },
      ],
      mdatPayload: primaryPayload,
      twoPass: true,
    });
  }

  /** A single surviving primary plus one Exif item (`cdsc` -> primary) carrying a valid minimal
   * TIFF (62-07 builder fixture class): the writer synthesizes/normalizes the minimal Exif item
   * at k's own id. */
  function buildMinimalExifFixture(brand: Brand): Buffer {
    const { majorBrand, compatibleBrands } = brandSpec(brand);
    const itemType = brand === "heic" ? "hvc1" : "av01";
    const primaryPayload = Buffer.from("primary-bytes", "ascii");
    const exifPayload = Buffer.concat([Buffer.alloc(4), createOrientationExif(1)]);
    return assembleHeif({
      majorBrand,
      compatibleBrands,
      primaryItemId: 1,
      items: [
        {
          itemId: 1,
          itemType,
          extents: [{ relOffset: 0, length: primaryPayload.length }],
        },
        {
          itemId: 2,
          itemType: "Exif",
          hidden: true,
          extents: [
            { relOffset: primaryPayload.length, length: exifPayload.length },
          ],
        },
      ],
      refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
      mdatPayload: Buffer.concat([primaryPayload, exifPayload]),
      ilocWidths: { offsetSize: 4, lengthSize: 4, baseOffsetSize: 4 },
      twoPass: true,
    });
  }

  describe("builder fixture classes (62-06/62-07/62-08)", () => {
    it.each(["heic", "avif"] as const)(
      "%s: hidden auxiliary metadata + top-level C2PA fixture (62-06): clean(clean(x)) is byte-equal to clean(x)",
      async (brand) => {
        const bytes = buildAuxHiddenC2paFixture(brand);
        const options = OPTION_SETS["all preserve flags false"]!;
        const once = await clean(bytes, brand, options);
        const twice = await clean(once, brand, options);
        expect(twice.equals(once)).toBe(true);
      },
    );

    it.each(["heic", "avif"] as const)(
      "%s: free/skip top-level boxes fixture (62-06 D-14): clean(clean(x)) is byte-equal to clean(x)",
      async (brand) => {
        const bytes = buildFreeSkipFixture(brand);
        const options = OPTION_SETS["default settings"]!;
        const once = await clean(bytes, brand, options);
        const twice = await clean(once, brand, options);
        expect(twice.equals(once)).toBe(true);
      },
    );

    it("heic: ICC fixture (62-08), preserveColorProfile false: clean(clean(x)) is byte-equal to clean(x)", async () => {
      const bytes = buildIccFixture("heic");
      const options = OPTION_SETS[
        "preserveColorProfile false with orientation and resolution true"
      ]!;
      const once = await clean(bytes, "heic", options);
      const twice = await clean(once, "heic", options);
      expect(twice.equals(once)).toBe(true);
    });

    it.each(["heic", "avif"] as const)(
      "%s: minimal Exif writer fixture (62-07), default settings: clean(clean(x)) is byte-equal to clean(x)",
      async (brand) => {
        const bytes = buildMinimalExifFixture(brand);
        const options = OPTION_SETS["default settings"]!;
        const once = await clean(bytes, brand, options);
        const twice = await clean(once, brand, options);
        expect(twice.equals(once)).toBe(true);
      },
    );
  });

  // --- Generator samples: one admitted, fixed-seed (62) sample per non-hazard arm ---

  const NON_HAZARD_ARMS: readonly IsobmffArm[] = [
    "exif-offset",
    "xmp",
    "colr-none",
    "colr-nclx",
    "colr-prof",
    "colr-ricc",
    "irot-essential",
    "irot-non-essential",
    "imir-essential",
    "imir-non-essential",
    "grid-idat",
    "thmb",
    "auxl",
  ];

  // preserveColorProfile is false throughout: the generator's colr-prof/colr-ricc arms carry a
  // 4-byte fake ICC payload too short to validate, which the engine's own ICC-preservation
  // validity gate refuses to admit when preserveColorProfile is true (measured, 62-09 Task 3).
  const GENERATOR_OPTIONS: PreserveOptions = {
    preserveOrientation: true,
    preserveColorProfile: false,
    preserveTimestamps: false,
    preserveResolution: true,
  };

  describe("generator samples (seed 62)", () => {
    it.each(NON_HAZARD_ARMS)(
      "arm %s (seed 62, numRuns <= 10): a fixed-seed admitted sample satisfies clean(clean(x)) == clean(x)",
      async (arm) => {
        const armArbitrary = fc
          .constantFrom("heic" as const, "avif" as const)
          .chain((brand) => isobmffArmSampleArbitrary(brand))
          .filter((armSample) => armSample.arms.includes(arm));

        let admitted = 0;
        let declined = 0;
        let proven = false;

        await fc.assert(
          fc.asyncProperty(armArbitrary, async (armSample) => {
            const brand = detectBrand(armSample.sample.bytes);
            let once: Buffer;
            try {
              once = await clean(armSample.sample.bytes, brand, GENERATOR_OPTIONS);
            } catch {
              declined += 1;
              return;
            }
            admitted += 1;
            if (!proven) {
              const twice = await clean(once, brand, GENERATOR_OPTIONS);
              expect(twice.equals(once)).toBe(true);
              proven = true;
            }
          }),
          { seed: 62, numRuns: 10 },
        );

        // eslint-disable-next-line no-console
        console.log(
          `ISO-06 generator arm ${arm}: admitted ${admitted}, declined ${declined} (seed 62, numRuns 10)`,
        );
        expect(admitted).toBeGreaterThanOrEqual(1);
        expect(proven).toBe(true);
      },
    );
  });
});

// --- Task 2: clean(exiftool(x)) against ExifTool 13.59 ---

interface ExecutableAuthority {
  readonly path: string;
  readonly sha256: string;
}

interface PreparedOracleTools {
  readonly exiftool: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly loadOrPrepareOracleTools: () => PreparedOracleTools;
}

interface ExiftoolRunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ResolvedExiftool {
  readonly run: (args: readonly string[]) => ExiftoolRunResult;
}

type ExiftoolResolution =
  | { readonly exiftool: ResolvedExiftool }
  | { readonly skipReason: string };

/** Resolves a real ExifTool 13.59: on linux/x64, the pinned KIT-09 authority (read-only
 * `loadOrPrepareOracleTools`, disposed on process exit); elsewhere, the electron repo's vendored
 * 13.59 download, run through `perl`, provided it exists and reports exactly version 13.59.
 * Otherwise the whole describe block is skipped with a named reason (62-14 then confirms from the
 * hosted quality job log that the linux leg actually ran rather than skipped). */
function resolveExiftool(): ExiftoolResolution {
  if (process.platform === "linux" && process.arch === "x64") {
    try {
      const require = createRequire(import.meta.url);
      const authorityBuilder = require(
        "../scripts/qualification/build-oracles.cjs",
      ) as AuthorityBuilder;
      const tools = authorityBuilder.loadOrPrepareOracleTools();
      process.once("exit", () => tools.dispose());
      return {
        exiftool: {
          run: (args) => {
            const result = spawnSync(tools.exiftool.path, args, {
              encoding: "utf8",
              maxBuffer: 8 * 1024 * 1024,
              timeout: 20_000,
            });
            return {
              status: result.status ?? 1,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
            };
          },
        },
      };
    } catch (error) {
      return {
        skipReason: `linux/x64 KIT-09 oracle preparation failed: ${String(error)}`,
      };
    }
  }

  const electronExiftoolPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "exifcleaner-electron",
    "exiftool_downloads",
    "Image-ExifTool-13.59",
    "exiftool",
  );
  if (!existsSync(electronExiftoolPath)) {
    return {
      skipReason:
        `not on linux/x64 and no ExifTool found at ${electronExiftoolPath}`,
    };
  }
  const versionResult = spawnSync("perl", [electronExiftoolPath, "-ver"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const version = (versionResult.stdout ?? "").trim();
  if (versionResult.status !== 0 || version !== "13.59") {
    return {
      skipReason:
        `ExifTool at ${electronExiftoolPath} reported version "${version}" ` +
        `(status ${String(versionResult.status)}), expected "13.59"`,
    };
  }
  return {
    exiftool: {
      run: (args) => {
        const result = spawnSync("perl", [electronExiftoolPath, ...args], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 20_000,
        });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      },
    },
  };
}

const EXIFTOOL_RESOLUTION = resolveExiftool();

// The app's full preserving argument shape (measured, 62-01 / docs/isobmff.md "ExifTool 13.59
// minimal-Exif placement"), restated here as a literal rather than imported -- this file may not
// import from the independent `exifcleaner-electron` repository.
// `exifcleaner-electron/src/domain/exif/exif.ts:69-78` (RESOLUTION_PRESERVE_ARGS, read-only).
const RESOLUTION_PRESERVE_ARGS: readonly string[] = [
  "-JFIF:XResolution>JFIF:XResolution",
  "-JFIF:YResolution>JFIF:YResolution",
  "-JFIF:ResolutionUnit>JFIF:ResolutionUnit",
  "-IFD0:XResolution>IFD0:XResolution",
  "-IFD0:YResolution>IFD0:YResolution",
  "-IFD0:ResolutionUnit>IFD0:ResolutionUnit",
  "-PNG:PixelsPerUnitX>PNG:PixelsPerUnitX",
  "-PNG:PixelsPerUnitY>PNG:PixelsPerUnitY",
  "-PNG:PixelUnits>PNG:PixelUnits",
];

const ARG_FORMS: Readonly<Record<string, readonly string[]>> = {
  "plain -all=": [],
  "preserving -all= -TagsFromFile @ -Orientation <RESOLUTION_PRESERVE_ARGS>": [
    "-TagsFromFile",
    "@",
    "-Orientation",
    ...RESOLUTION_PRESERVE_ARGS,
  ],
};

async function freshDirectoryForExiftool(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-exiftool-"));
  return directory;
}

/** Produces `exiftool(x)`: runs the resolved ExifTool over `bytes` with `-all= ...tagsFromFileArgs
 * -o <output> <input>`, in a fresh temp directory, with a fixed argument array (no shell). */
async function runExiftool(
  exiftool: ResolvedExiftool,
  bytes: Buffer,
  extension: ".heic" | ".avif",
  tagsFromFileArgs: readonly string[],
): Promise<Buffer> {
  const directory = await freshDirectoryForExiftool();
  try {
    const inputPath = join(directory, `input${extension}`);
    const outputPath = join(directory, `reference${extension}`);
    await writeFile(inputPath, bytes);
    const result = exiftool.run([
      "-all=",
      ...tagsFromFileArgs,
      "-o",
      outputPath,
      inputPath,
    ]);
    if (result.status !== 0) {
      throw new Error(`ExifTool reference run failed: ${result.stderr}`);
    }
    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("ISO-06 clean(exiftool(x)) (62-11)", () => {
  if ("skipReason" in EXIFTOOL_RESOLUTION) {
    it.skip(`skipped: ${EXIFTOOL_RESOLUTION.skipReason}`, () => {
      // no-op
    });
  } else {
    const exiftool = EXIFTOOL_RESOLUTION.exiftool;
    const CASES = (["heic", "avif"] as const).flatMap((brand) =>
      Object.entries(ARG_FORMS).map(
        ([argFormLabel, tagsFromFileArgs]) =>
          [brand, argFormLabel, tagsFromFileArgs] as const,
      ),
    );

    it.each(CASES)(
      "%s, %s: clean(exiftool(x)) is byte-equal to clean(clean(exiftool(x)))",
      async (brand, _argFormLabel, tagsFromFileArgs) => {
        const fixturePath = brand === "heic" ? HEIC_FIXTURE : AVIF_FIXTURE;
        const sourceBytes = await readFile(fixturePath);
        const extension = brand === "heic" ? ".heic" : ".avif";

        const e = await runExiftool(exiftool, sourceBytes, extension, tagsFromFileArgs);
        const defaultSettings = OPTION_SETS["default settings"]!;
        const cleanedOnce = await clean(e, brand, defaultSettings);
        const cleanedTwice = await clean(cleanedOnce, brand, defaultSettings);
        expect(cleanedTwice.equals(cleanedOnce)).toBe(true);

        // When e holds a non-emptied Exif item (D-13's k candidate -- the plain "-all=" form was
        // measured to leave only a zero-length, emptied Exif item behind, which is correctly never
        // a k candidate and so writes no minimal Exif item at all), the native output's Exif item
        // keeps the same item ID and its payload prefix is four zero bytes (measured,
        // docs/isobmff.md "ExifTool 13.59 minimal-Exif placement": the payload's first four bytes
        // are 00000000 on both ExifTool argument forms, never the "Exif\0\0" prefix 62-CONTEXT
        // D-13 originally claimed).
        const sourceExifItem = inventoryIsobmff(e).items.find(
          (item) =>
            item.type === "Exif" &&
            item.extents.reduce((sum, extent) => sum + extent.length, 0) > 0,
        );
        if (sourceExifItem !== undefined) {
          const outputInventory = inventoryIsobmff(cleanedOnce);
          const outputExifItem = outputInventory.items.find(
            (item) => item.type === "Exif",
          );
          expect(outputExifItem).toBeDefined();
          expect(outputExifItem!.id).toBe(sourceExifItem.id);
          const outputPayload = readItemExtentBytes(
            cleanedOnce,
            outputInventory,
            outputExifItem!,
          );
          expect(outputPayload.length).toBeGreaterThanOrEqual(4);
          expect(outputPayload.subarray(0, 4).equals(Buffer.alloc(4))).toBe(true);
        }
      },
    );
  }
});
