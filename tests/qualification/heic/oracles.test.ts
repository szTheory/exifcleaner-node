// HEIC ExifTool differential profile tests (62.1-05, D-27, QUA-01). Still unregistered (D-03) --
// native output is produced only through the `setRegisteredHandlersForTests` test seam, never a
// real registered handler.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setRegisteredHandlersForTests } from "../../../src/admission/registry.js";
import { sanitizeFile } from "../../../src/engine.js";
import { createIsobmffWriterHandlerForTests } from "../../isobmff-support/test-handler.js";
import {
  box,
  colrProf,
  ftypBox,
  hdlrBox,
  hvcC,
  idatBox,
  iinfBox,
  ilocBox,
  infeBox,
  irefBox,
  ispe,
  metaBox,
  pitmBox,
} from "../../isobmff-support/builder.js";
import {
  assembleHeif,
  type AssembleHeifSpec,
} from "../../isobmff-support/hostile.js";
import {
  compareIsobmffFreeSkip,
  compareIsobmffPayloadDigests,
  compareIsobmffMetadataNamespaces,
  compareIsobmffStructuralParts,
  assertIsobmffOracleWarnings,
  isobmffAuxiliaryItemXmpPayloads,
  isobmffFreeSkipBoxes,
  isobmffStructuralParts,
  runIsobmffDifferential,
  type IsobmffFreeSkipBox,
  type IsobmffPermittedDifferenceId,
} from "../../isobmff-support/differential.js";
import {
  downloadGate,
  tracerRecords,
} from "../../isobmff-support/corpus-tracer.js";
import {
  loadCorpusRecord,
  materializeRecord,
  type CorpusRecord,
} from "../kit/corpus.js";
import {
  compareAdmittedUnknownTags,
  projectExiftoolRecord,
  type MetadataProjection,
} from "../kit/oracles.js";
import { iccProfileV4 } from "../../fixtures.js";
import { withIspeExtent } from "../../isobmff-support/mutations.js";
import {
  HEIC_ADMITTED_UNKNOWN_TAGS,
  HEIC_AUXILIARY_ITEM_XMP_MEASUREMENT_TITLE,
  HEIC_DEFAULT_SETTINGS_REFUSALS,
  HEIC_PERMITTED_DIFFERENCES,
  assertHeicOracleToolsAvailable,
  heicAdmittedSourceWarnings,
  heicDifferentialProfile,
  type HeicCorpusSetting,
} from "./oracles.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "corpus",
  "constructed",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heic", "heif-enc-grid.heic");
const LINUX_X64 = process.platform === "linux" && process.arch === "x64";

interface Preservation {
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveTimestamps: boolean;
  readonly preserveResolution: boolean;
}

const DEFAULT_PRESERVATION: Preservation = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
  preserveResolution: true,
};

const ALL_FALSE_PRESERVATION: Preservation = {
  preserveOrientation: false,
  preserveColorProfile: false,
  preserveTimestamps: false,
  preserveResolution: false,
};

/**
 * Produces a native output for `sourceBytes` through the real, registered writer handler
 * (`createIsobmffWriterHandlerForTests`, never a stub) -- the exact engine path 62-05/62-12
 * already exercise -- with `preservation` applied. Mirrors
 * `tests/isobmff_decode_oracle.test.ts`'s own `produceNativeOutput`, generalized to take raw
 * bytes rather than a fixture path so this suite can build its own synthetic sources.
 */
async function produceNativeOutput(
  sourceBytes: Buffer,
  preservation: Preservation,
): Promise<Buffer> {
  assertHeicOracleToolsAvailable();
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-heic-oracles-"));
  try {
    const sourcePath = join(directory, "source.heic");
    await writeFile(sourcePath, sourceBytes);
    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("heic"),
    ]);
    try {
      const destinationPath = join(directory, "destination.heic");
      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...preservation,
      });
      if (!result.ok) {
        throw new Error(
          `produceNativeOutput: sanitizeFile failed: ${result.error.code}`,
        );
      }
      return await readFile(destinationPath);
    } finally {
      restore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A minimal structurally-valid HEIC carrying a `colr` `prof` ICC property on its primary item
 * and no Exif/mime items -- D-16/F-HEIC-ICC is independent of D-13's minimal Exif synthesis. */
function buildIccFixtureHeic(): Buffer {
  const primaryPayload = Buffer.from("heic-icc-primary-bytes", "ascii");
  const spec: AssembleHeifSpec = {
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: primaryPayload.length }],
        propertyIndices: [1, 2, 3],
      },
    ],
    properties: [
      ispe(32, 32),
      hvcC(),
      colrProf(iccProfileV4({ deviceClass: "mntr" })),
    ],
    mdatPayload: primaryPayload,
    twoPass: true,
  };
  return assembleHeif(spec);
}

describe("HEIC differential (62.1-05)", () => {
  it.runIf(LINUX_X64)(
    "sanitizes heif-enc-grid.heic through the seam with default settings and passes the ExifTool differential (62.1-05)",
    async () => {
      const source = await readFile(HEIC_FIXTURE);
      const output = await produceNativeOutput(source, DEFAULT_PRESERVATION);
      runIsobmffDifferential({
        caseId: "heic-default-settings",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: DEFAULT_PRESERVATION.preserveOrientation,
        preserveColorProfile: DEFAULT_PRESERVATION.preserveColorProfile,
        preserveResolution: DEFAULT_PRESERVATION.preserveResolution,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures emptied Exif/XMP metadata entries as the only permitted HEIC structural difference (62.1-05)",
    async () => {
      const source = await readFile(HEIC_FIXTURE);
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "heic-emptied-metadata",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool keeping ICC when not preserving as a permitted HEIC difference (62.1-05)",
    async () => {
      const source = buildIccFixtureHeic();
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "heic-icc-not-preserving",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool's minimal-Exif YCbCrPositioning companion as a permitted HEIC difference (62.1-05)",
    async () => {
      const source = await readFile(HEIC_FIXTURE);
      const output = await produceNativeOutput(source, {
        ...ALL_FALSE_PRESERVATION,
        preserveOrientation: true,
      });
      runIsobmffDifferential({
        caseId: "heic-ycbcr-positioning",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: true,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it.runIf(LINUX_X64)(
    "measures ExifTool keeping top-level free/skip as a permitted HEIC difference (62.1-05)",
    async () => {
      const fixture = await readFile(HEIC_FIXTURE);
      const source = Buffer.concat([
        fixture,
        box("free", Buffer.alloc(16, 0xab)),
        box("skip", Buffer.alloc(16, 0xcd)),
      ]);
      const output = await produceNativeOutput(source, ALL_FALSE_PRESERVATION);
      runIsobmffDifferential({
        caseId: "heic-free-skip",
        profile: heicDifferentialProfile,
        source,
        output,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveResolution: false,
      });
    },
    30_000,
  );

  it("cites the exact live test title and docs/isobmff.md heading for every HEIC permitted difference", () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const testFileText = readFileSync(testFilePath, "utf8");
    const docsPath = join(
      dirname(testFilePath),
      "..",
      "..",
      "..",
      "docs",
      "isobmff.md",
    );
    const docsText = readFileSync(docsPath, "utf8");
    expect(HEIC_PERMITTED_DIFFERENCES).toHaveLength(6);
    for (const entry of HEIC_PERMITTED_DIFFERENCES) {
      expect(testFileText).toContain(entry.measurement);
      expect(docsText).toContain(entry.docsHeading);
    }
  });

  describe("pure red controls (no ExifTool)", () => {
    const emptyProjection = (): MetadataProjection => ({
      warnings: [],
      namespaces: {},
    });

    it("a native output with an extra XMP tag throws (leak)", () => {
      const output: MetadataProjection = {
        warnings: [],
        namespaces: { XMP: [{ XMPToolkit: "leaked" }] },
      };
      expect(() =>
        compareIsobmffMetadataNamespaces(output, emptyProjection(), {
          allowYCbCrPositioningCompanion: false,
        }),
      ).toThrow(/Unpermitted metadata difference: XMP/);
    });

    it("a reference whose thumbnail item is missing throws (over-strip of a non-metadata item)", () => {
      const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1", "infe:hvc1"];
      const referenceParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).toThrow(/Unpermitted structural difference: infe:hvc1/);
    });

    it("an nclx or irot difference throws", () => {
      const outputParts = ["ftyp", "meta", "mdat", "ipco:irot:aaaa"];
      const referenceParts = ["ftyp", "meta", "mdat", "ipco:irot:bbbb"];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).toThrow(/Unpermitted structural difference: ipco:irot:aaaa/);

      const outputNclxParts = ["ftyp", "meta", "mdat", "ipco:nclx:aaaa"];
      const referenceNclxParts = ["ftyp", "meta", "mdat", "ipco:nclx:bbbb"];
      expect(() =>
        compareIsobmffStructuralParts(outputNclxParts, referenceNclxParts),
      ).toThrow(/Unpermitted structural difference: ipco:nclx:aaaa/);
    });

    it("explains reference-only infe:Exif/infe:mime and free/skip structural parts, in any order (entries a/e)", () => {
      const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
      const referenceParts = [
        "mdat",
        "infe:mime",
        "free",
        "ftyp",
        "infe:hvc1",
        "infe:Exif",
        "skip",
        "meta",
      ];
      expect(() =>
        compareIsobmffStructuralParts(outputParts, referenceParts),
      ).not.toThrow();
    });

    it.each([
      ["first", ["bogus-part", "ftyp", "meta", "mdat", "infe:hvc1"]],
      ["middle", ["ftyp", "meta", "bogus-part", "mdat", "infe:hvc1"]],
      ["last", ["ftyp", "meta", "mdat", "infe:hvc1", "bogus-part"]],
    ])(
      "an unlisted reference-only part at the %s position throws",
      (_label, referenceParts) => {
        const outputParts = ["ftyp", "meta", "mdat", "infe:hvc1"];
        expect(() =>
          compareIsobmffStructuralParts(outputParts, referenceParts),
        ).toThrow(/Unpermitted structural difference: bogus-part/);
      },
    );

    it("an empty permitted set never admits a difference (empty edge)", () => {
      expect(() => compareIsobmffStructuralParts([], [])).not.toThrow();
      expect(() => compareIsobmffStructuralParts([], ["bogus-part"])).toThrow(
        /Unpermitted structural difference: bogus-part/,
      );
    });

    it("explains a free box before mdat in reference and a skip box after mdat in source, by presence and bytes, never by order (entry e adjacency)", () => {
      const sourceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
        { type: "skip", sha256: "b".repeat(64) },
      ];
      const referenceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "skip", sha256: "b".repeat(64) },
        { type: "free", sha256: "a".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(sourceFreeSkip, [], referenceFreeSkip),
      ).not.toThrow();
    });

    it("a free/skip box with the same type but different bytes throws (entry e byte identity)", () => {
      const sourceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
      ];
      const referenceFreeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "c".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(sourceFreeSkip, [], referenceFreeSkip),
      ).toThrow(/Stale permitted difference: exiftool-keeps-free-skip/);
    });

    it("free/skip surviving natively throws, even when the reference also keeps it", () => {
      const freeSkip: readonly IsobmffFreeSkipBox[] = [
        { type: "free", sha256: "a".repeat(64) },
      ];
      expect(() =>
        compareIsobmffFreeSkip(freeSkip, freeSkip, freeSkip),
      ).toThrow(
        /Unpermitted structural difference: free\/skip survived natively/,
      );
    });

    it("compares QuickTime media-data layout descriptors by presence, never by value (entry d)", () => {
      const layout = (offset: number, size: number): MetadataProjection => ({
        warnings: [],
        namespaces: {
          QuickTime: [
            { MediaDataOffset: offset },
            { MediaDataSize: size },
            {
              MediaData: `(Binary data ${size} bytes, use -b option to extract)`,
            },
            { HandlerType: "pict" },
          ],
        },
      });
      const options = { allowYCbCrPositioningCompanion: false };
      expect(() =>
        compareIsobmffMetadataNamespaces(
          layout(853, 275),
          layout(984, 287),
          options,
        ),
      ).not.toThrow();

      const missingDescriptor: MetadataProjection = {
        warnings: [],
        namespaces: {
          QuickTime: [{ MediaDataSize: 275 }, { HandlerType: "pict" }],
        },
      };
      expect(() =>
        compareIsobmffMetadataNamespaces(
          missingDescriptor,
          layout(984, 287),
          options,
        ),
      ).toThrow(/QuickTime/);

      const otherTag: MetadataProjection = {
        warnings: [],
        namespaces: {
          QuickTime: [
            { MediaDataOffset: 853 },
            { MediaDataSize: 275 },
            { MediaData: "(Binary data 275 bytes, use -b option to extract)" },
            { HandlerType: "vide" },
          ],
        },
      };
      expect(() =>
        compareIsobmffMetadataNamespaces(otherTag, layout(984, 287), options),
      ).toThrow(/Unpermitted metadata difference: QuickTime/);

      const elsewhere: MetadataProjection = {
        warnings: [],
        namespaces: { XMP: [{ MediaDataOffset: 1 }] },
      };
      expect(() =>
        compareIsobmffMetadataNamespaces(elsewhere, emptyProjection(), options),
      ).toThrow(/Unpermitted metadata difference: XMP/);
    });

    it("a changed, extra or missing non-metadata payload throws (entry d never hides payload bytes)", () => {
      const primary = { part: "hvc1", sha256: "a".repeat(64) };
      const thumb = { part: "hvc1", sha256: "b".repeat(64) };
      expect(() =>
        compareIsobmffPayloadDigests([thumb, primary], [primary, thumb]),
      ).not.toThrow();
      expect(() =>
        compareIsobmffPayloadDigests(
          [primary, { ...thumb, sha256: "c".repeat(64) }],
          [primary, thumb],
        ),
      ).toThrow(/Unpermitted payload difference/);
      expect(() =>
        compareIsobmffPayloadDigests([primary], [primary, thumb]),
      ).toThrow(/Payload over-strip/);
      expect(() =>
        compareIsobmffPayloadDigests([primary, thumb], [primary]),
      ).toThrow(/Unpermitted payload difference/);
    });

    it("explains ExifTool's QuickTime:Free/Skip reports only for the reference's own byte-proven free/skip boxes (entry e)", () => {
      const options = {
        allowYCbCrPositioningCompanion: false,
        referenceFreeSkip: [
          { type: "free", sha256: "a".repeat(64) },
          { type: "skip", sha256: "b".repeat(64) },
        ] as const,
      };
      const report = (...tags: string[]): MetadataProjection => ({
        warnings: [],
        namespaces: {
          QuickTime: tags.map((tag) => ({
            [tag]: "(Binary data 16 bytes, use -b option to extract)",
          })),
        },
      });
      expect(() =>
        compareIsobmffMetadataNamespaces(
          report(),
          report("Free", "Skip"),
          options,
        ),
      ).not.toThrow();
      expect(() =>
        compareIsobmffMetadataNamespaces(
          report(),
          report("Free", "Skip", "Skip"),
          options,
        ),
      ).toThrow(/Over-strip: QuickTime/);
      expect(() =>
        compareIsobmffMetadataNamespaces(report(), report("Free"), {
          allowYCbCrPositioningCompanion: false,
        }),
      ).toThrow(/Over-strip: QuickTime/);
      expect(() =>
        compareIsobmffMetadataNamespaces(report("Free"), report(), options),
      ).toThrow(/Unpermitted metadata difference: QuickTime/);
    });
    it("isobmffFreeSkipBoxes reads type and payload sha256 for a synthetic free/skip pair", () => {
      const bytes = Buffer.concat([
        box("ftyp", Buffer.alloc(4)),
        box("free", Buffer.alloc(16, 0xab)),
        box("skip", Buffer.alloc(16, 0xcd)),
      ]);
      expect(isobmffFreeSkipBoxes(bytes).map((entry) => entry.type)).toEqual([
        "free",
        "skip",
      ]);
    });
  });
});

type SanitizeOutcome =
  | { readonly ok: true; readonly output: Buffer }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

/** Sanitizes `source` through the registered engine (62.1-07 registered `heicHandler`), with
 * `preservation` applied -- the corpus legs below never use the test seam. */
async function sanitizeRegistered(
  source: Buffer,
  preservation: Preservation,
): Promise<SanitizeOutcome> {
  assertHeicOracleToolsAvailable();
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-heic-corpus-"));
  try {
    const sourcePath = join(directory, "source.heic");
    const destinationPath = join(directory, "destination.heic");
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      ...preservation,
    });
    if (!result.ok)
      return {
        ok: false,
        error: { ...result.error } as Record<string, unknown>,
      };
    return { ok: true, output: await readFile(destinationPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const HEIC_CLOSED_IDS: ReadonlySet<string> = new Set(
  HEIC_PERMITTED_DIFFERENCES.map((entry) => entry.id),
);

function closedListed(
  record: CorpusRecord,
): readonly IsobmffPermittedDifferenceId[] {
  for (const id of record.permittedDifferences) {
    if (!HEIC_CLOSED_IDS.has(id))
      throw new Error(`${record.id}: ${id} is not in the HEIC closed list`);
  }
  return record.permittedDifferences as readonly IsobmffPermittedDifferenceId[];
}

const CORPUS_SETTINGS: readonly (readonly [HeicCorpusSetting, Preservation])[] =
  [
    ["default", DEFAULT_PRESERVATION],
    ["all-false", ALL_FALSE_PRESERVATION],
  ];

interface CorpusDifferentialOptions {
  readonly settings?: readonly HeicCorpusSetting[];
  readonly admittedSourceWarnings?: (
    recordId: string,
    setting: HeicCorpusSetting,
  ) => readonly string[];
}

/** Runs the differential for default settings and all flags false with exactly the record's
 * listed entries; returns the union of entries the runs needed. A record with a pinned
 * default-settings refusal must refuse exactly that way under default settings. */
async function runCorpusDifferential(
  record: CorpusRecord,
  permitted: readonly IsobmffPermittedDifferenceId[],
  options: CorpusDifferentialOptions = {},
): Promise<ReadonlySet<IsobmffPermittedDifferenceId>> {
  const source = await materializeRecord(record);
  const used = new Set<IsobmffPermittedDifferenceId>();
  const admitted = options.admittedSourceWarnings ?? heicAdmittedSourceWarnings;
  for (const [setting, preservation] of CORPUS_SETTINGS) {
    if (options.settings !== undefined && !options.settings.includes(setting))
      continue;
    const outcome = await sanitizeRegistered(source, preservation);
    const refusal =
      setting === "default"
        ? HEIC_DEFAULT_SETTINGS_REFUSALS[record.id]
        : undefined;
    if (refusal !== undefined) {
      if (outcome.ok)
        throw new Error(
          `${record.id}: expected the pinned default-settings refusal, got an output`,
        );
      expect(outcome.error).toMatchObject({
        ...refusal,
        phase: "admission",
        nativeWrite: "not-started",
      });
      continue;
    }
    if (!outcome.ok)
      throw new Error(`sanitizeRegistered: ${String(outcome.error.code)}`);
    const needed = runIsobmffDifferential({
      caseId: `${record.id}-${setting}`,
      profile: heicDifferentialProfile,
      source,
      output: outcome.output,
      preserveOrientation: preservation.preserveOrientation,
      preserveColorProfile: preservation.preserveColorProfile,
      preserveResolution: preservation.preserveResolution,
      permittedDifferences: permitted,
      admittedSourceWarnings: admitted(record.id, setting),
    });
    for (const id of needed) used.add(id);
  }
  return used;
}

const IPHONE_RECORD = "ianare-exif-samples-iphone-13-pro-max";
const C034_RECORD = "nokia-heif-conformance-c034";
const CORPUS_TIMEOUT_MS = 240_000;

/** Registers `title` for `recordId` honouring the download-only gate (KIT-10). */
function corpusIt(
  recordId: string,
  title: string,
  body: () => Promise<void>,
): void {
  const tracer = tracerRecords("heic").find((record) => record.id === recordId);
  if (tracer === undefined) throw new Error(`no HEIC record ${recordId}`);
  const gate = downloadGate(tracer);
  if (gate.kind === "fail") {
    it(`${title} (download-only record needs the fetch cache in CI)`, () => {
      throw new Error(gate.reason);
    });
    return;
  }
  if (gate.kind === "skip") {
    console.warn(`skipping ${gate.reason}`);
    it.skip(`${title} (download-only, no local fetch cache)`, () => {});
    return;
  }
  it.runIf(LINUX_X64)(title, body, CORPUS_TIMEOUT_MS);
}

describe("HEIC corpus differential (62.1-09)", () => {
  const admitted = tracerRecords("heic").filter(
    (record) => record.outcome.status === "success",
  );

  it("iterates every admitted HEIC corpus record, each listing only closed-list entries", async () => {
    expect(admitted.map((record) => record.id)).toContain("heif-enc-grid-heic");
    expect(admitted.map((record) => record.id)).toContain(IPHONE_RECORD);
    expect(admitted.map((record) => record.id)).toContain(C034_RECORD);
    for (const tracer of admitted)
      closedListed(await loadCorpusRecord(tracer.id));
  });

  it("lists exiftool-keeps-auxiliary-item-xmp on the iPhone record only", async () => {
    for (const tracer of admitted) {
      const record = await loadCorpusRecord(tracer.id);
      expect(
        record.permittedDifferences.includes(
          "exiftool-keeps-auxiliary-item-xmp",
        ),
      ).toBe(record.id === IPHONE_RECORD);
    }
  });

  for (const tracer of admitted) {
    corpusIt(
      tracer.id,
      `${tracer.id}: passes the ExifTool differential (default and all flags false) with exactly its listed entries`,
      async () => {
        const record = await loadCorpusRecord(tracer.id);
        const listed = closedListed(record);
        const used = await runCorpusDifferential(record, listed);
        // Listed only when needed: no stale entry may sit in the record.
        expect([...used].sort()).toEqual([...listed].sort());
      },
    );
  }

  corpusIt(
    "heif-enc-grid-heic",
    "an empty permittedDifferences list fails a record whose output needs an entry (the per-record list is load-bearing)",
    async () => {
      const record = await loadCorpusRecord("heif-enc-grid-heic");
      expect(record.permittedDifferences.length).toBeGreaterThan(0);
      await expect(runCorpusDifferential(record, [])).rejects.toThrow(
        /^Unlisted permitted difference: /,
      );
    },
  );

  corpusIt(
    IPHONE_RECORD,
    "measures ExifTool keeping the iPhone gain-map auxiliary item's XMP as a permitted HEIC difference (62.1-09)",
    async () => {
      const record = await loadCorpusRecord(IPHONE_RECORD);
      const listed = closedListed(record);
      expect(listed).toContain("exiftool-keeps-auxiliary-item-xmp");
      const used = await runCorpusDifferential(record, listed, {
        settings: ["default"],
      });
      expect(used.has("exiftool-keeps-auxiliary-item-xmp")).toBe(true);
      // Negative control: the same record without the entry fails as unlisted.
      await expect(
        runCorpusDifferential(
          record,
          listed.filter((id) => id !== "exiftool-keeps-auxiliary-item-xmp"),
          { settings: ["default"] },
        ),
      ).rejects.toThrow(
        "Unlisted permitted difference: exiftool-keeps-auxiliary-item-xmp",
      );
    },
  );

  corpusIt(
    C034_RECORD,
    "c034 under all flags false fails without its exact source-warning admission (the admission is load-bearing)",
    async () => {
      const record = await loadCorpusRecord(C034_RECORD);
      await expect(
        runCorpusDifferential(record, closedListed(record), {
          settings: ["all-false"],
          admittedSourceWarnings: () => [],
        }),
      ).rejects.toThrow("Oracle warning is not permitted");
    },
  );
});

describe("HEIC 62.1-09 maintainer decisions: pure negative controls (no ExifTool)", () => {
  const projection = (
    warnings: readonly string[],
    namespaces: MetadataProjection["namespaces"] = {},
  ): MetadataProjection => ({ warnings, namespaces });

  describe("admitted unknown tags", () => {
    it("the HEIC profile admits exactly ster, base and idat", () => {
      expect(heicDifferentialProfile.admittedUnknownTags).toEqual([
        "QuickTime:Unknown_ster",
        "QuickTime:Unknown_base",
        "Meta:Unknown_idat",
      ]);
      expect(HEIC_ADMITTED_UNKNOWN_TAGS).toBe(
        heicDifferentialProfile.admittedUnknownTags,
      );
    });

    it("each admitted tag projects out of the namespaces", () => {
      for (const key of HEIC_ADMITTED_UNKNOWN_TAGS) {
        const projected = projectExiftoolRecord(
          { [key]: "(Binary data 8 bytes)" },
          HEIC_ADMITTED_UNKNOWN_TAGS,
        );
        expect(projected.admittedUnknownTags).toEqual({
          [key]: "(Binary data 8 bytes)",
        });
      }
    });

    it("another unknown tag still throws in HEIC", () => {
      expect(() =>
        projectExiftoolRecord(
          { "QuickTime:Unknown_grpl": "x" },
          HEIC_ADMITTED_UNKNOWN_TAGS,
        ),
      ).toThrow("ExifTool oracle found an unknown tag");
    });

    it("an admitted tag whose value differs between source, native and reference throws", () => {
      const admitted = (value: string): MetadataProjection => ({
        ...projection([]),
        admittedUnknownTags: { "QuickTime:Unknown_ster": value },
      });
      expect(() =>
        compareAdmittedUnknownTags(admitted("a"), admitted("a"), admitted("a")),
      ).not.toThrow();
      expect(() =>
        compareAdmittedUnknownTags(admitted("a"), admitted("a"), admitted("b")),
      ).toThrow("Admitted unknown tag differs: QuickTime:Unknown_ster");
      expect(() =>
        compareAdmittedUnknownTags(admitted("a"), admitted("b"), admitted("a")),
      ).toThrow("Admitted unknown tag differs: QuickTime:Unknown_ster");
    });
  });

  describe("c034 source warning admission", () => {
    const admitted = heicAdmittedSourceWarnings(C034_RECORD, "all-false");

    it("admits exactly `Missing Exif header` on c034 under all flags false", () => {
      expect(admitted).toEqual(["Missing Exif header"]);
      expect(() =>
        assertIsobmffOracleWarnings(
          projection(["Missing Exif header"]),
          [projection([])],
          admitted,
        ),
      ).not.toThrow();
    });

    it("any other warning text on c034 still fails", () => {
      expect(() =>
        assertIsobmffOracleWarnings(
          projection(["Missing Exif header", "Bad IFD0 directory"]),
          [projection([])],
          admitted,
        ),
      ).toThrow("Oracle warning is not permitted");
    });

    it("the same warning on another record, or on c034 under default settings, still fails", () => {
      for (const [recordId, setting] of [
        ["heif-enc-grid-heic", "all-false"],
        [IPHONE_RECORD, "all-false"],
        [C034_RECORD, "default"],
      ] as const) {
        expect(() =>
          assertIsobmffOracleWarnings(
            projection(["Missing Exif header"]),
            [projection([])],
            heicAdmittedSourceWarnings(recordId, setting),
          ),
        ).toThrow("Oracle warning is not permitted");
      }
    });

    it("the warning on the native or reference side is never admitted", () => {
      expect(() =>
        assertIsobmffOracleWarnings(
          projection(["Missing Exif header"]),
          [projection(["Missing Exif header"])],
          admitted,
        ),
      ).toThrow("Oracle warning is not permitted");
    });

    it("an admission the source does not emit is stale and fails", () => {
      expect(() =>
        assertIsobmffOracleWarnings(projection([]), [projection([])], admitted),
      ).toThrow("Stale admitted source warning: Missing Exif header");
    });

    it("pins c034's default-settings refusal exactly, and only c034's", () => {
      expect(HEIC_DEFAULT_SETTINGS_REFUSALS).toEqual({
        [C034_RECORD]: {
          code: "unsupported-feature",
          feature: "orientation-preservation",
          detail: "EXIF TIFF header is truncated",
        },
      });
    });
  });

  describe("exiftool-keeps-auxiliary-item-xmp scope", () => {
    const gainMapXmp = [
      { HDRGainMapVersion: 65536 },
      { XMPToolkit: "XMP Core 6.0.0" },
    ];

    it("explains reference-only XMP that the reference's auxiliary-item XMP carries", () => {
      expect(() =>
        compareIsobmffMetadataNamespaces(
          projection([], { XMP: [] }),
          projection([], { XMP: gainMapXmp }),
          {
            allowYCbCrPositioningCompanion: false,
            auxiliaryItemXmp: gainMapXmp,
          },
        ),
      ).not.toThrow();
    });

    it("native keeping XMP the reference drops still fails", () => {
      expect(() =>
        compareIsobmffMetadataNamespaces(
          projection([], { XMP: gainMapXmp }),
          projection([], { XMP: [] }),
          {
            allowYCbCrPositioningCompanion: false,
            auxiliaryItemXmp: gainMapXmp,
          },
        ),
      ).toThrow("Unpermitted metadata difference: XMP");
    });

    it("reference-only XMP outside the auxiliary-item XMP still fails as over-strip", () => {
      expect(() =>
        compareIsobmffMetadataNamespaces(
          projection([], { XMP: [] }),
          projection([], { XMP: [...gainMapXmp, { Creator: "someone" }] }),
          {
            allowYCbCrPositioningCompanion: false,
            auxiliaryItemXmp: gainMapXmp,
          },
        ),
      ).toThrow("Over-strip: XMP");
      expect(() =>
        compareIsobmffMetadataNamespaces(
          projection([], { XMP: [] }),
          projection([], { XMP: gainMapXmp }),
          { allowYCbCrPositioningCompanion: false },
        ),
      ).toThrow("Over-strip: XMP");
    });

    /** primary hvc1 1, auxiliary hvc1 2 (`auxl` 2 -> 1), XMP mime 3 describing `cdscTargets`. */
    function auxXmpFixture(cdscTargets: readonly number[]): {
      readonly bytes: Buffer;
      readonly xmp: Buffer;
    } {
      const xmp = Buffer.from("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>");
      const meta = metaBox([
        hdlrBox("pict"),
        pitmBox(0, 1),
        iinfBox(0, [
          infeBox({ version: 2, itemId: 1, itemType: "hvc1" }),
          infeBox({ version: 2, itemId: 2, itemType: "hvc1" }),
          infeBox({
            version: 2,
            itemId: 3,
            itemType: "mime",
            contentType: "application/rdf+xml",
          }),
        ]),
        irefBox(0, [
          { type: "auxl", fromItemId: 2, toItemIds: [1] },
          { type: "cdsc", fromItemId: 3, toItemIds: cdscTargets },
        ]),
        idatBox(xmp),
        ilocBox({
          version: 1,
          offsetSize: 4,
          lengthSize: 4,
          baseOffsetSize: 0,
          indexSize: 0,
          items: [
            {
              itemId: 3,
              constructionMethod: 1,
              extents: [{ offset: 0, length: xmp.length }],
            },
          ],
        }),
      ]);
      return {
        bytes: Buffer.concat([ftypBox("heic", 0, ["mif1", "heic"]), meta]),
        xmp,
      };
    }

    it("scopes to XMP items describing only auxiliary images", () => {
      const aux = auxXmpFixture([2]);
      expect(isobmffAuxiliaryItemXmpPayloads(aux.bytes)).toEqual([aux.xmp]);
      expect(isobmffAuxiliaryItemXmpPayloads(auxXmpFixture([1]).bytes)).toEqual(
        [],
      );
      expect(
        isobmffAuxiliaryItemXmpPayloads(auxXmpFixture([1, 2]).bytes),
      ).toEqual([]);
    });

    it("cites SEED-004's render measurement (native and reference render identically) in docs/isobmff.md", () => {
      const docsText = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "..",
          "docs",
          "isobmff.md",
        ),
        "utf8",
      );
      const entry = HEIC_PERMITTED_DIFFERENCES.find(
        (candidate) => candidate.id === "exiftool-keeps-auxiliary-item-xmp",
      );
      expect(entry?.measurement).toBe(
        HEIC_AUXILIARY_ITEM_XMP_MEASUREMENT_TITLE,
      );
      const start = docsText.indexOf(entry!.docsHeading);
      expect(start).toBeGreaterThanOrEqual(0);
      const section = docsText
        .slice(start, docsText.indexOf("\n### ", start + 1))
        .replace(/\s+/g, " ");
      for (const cited of [
        ".planning/seeds/SEED-004-iphone-hdr-gain-map-loss.md",
        "`contentHeadroom` 1.0",
        "max linear 1.26978",
        "153 px > 1.0",
        "render identically",
      ])
        expect(section).toContain(cited);
    });
  });
});

/** 62.1-REVIEW-INDEPENDENT: each reviewer reproducer, committed as a fixture mutation the
 * differential must reject. The pure legs need no ExifTool; the live legs run the whole
 * differential on a native output carrying the mutation. */
describe("HEIC differential catches every reviewed blind spot (62.1-REVIEW-INDEPENDENT)", () => {
  const grid = readFileSync(HEIC_FIXTURE);

  describe("pure structural parts (no ExifTool)", () => {
    it("the unmutated grid matches itself (negative control)", () => {
      expect(() =>
        compareIsobmffStructuralParts(
          isobmffStructuralParts(grid),
          isobmffStructuralParts(grid),
        ),
      ).not.toThrow();
    });

    it("WR-02: a tile item's ispe changed from 64x64 to 63x63 is an unpermitted structural difference", () => {
      const mutated = withIspeExtent(grid, 2, 63, 63);
      expect(() =>
        compareIsobmffStructuralParts(
          isobmffStructuralParts(mutated),
          isobmffStructuralParts(grid),
        ),
      ).toThrow(/^Unpermitted structural difference: ipco:/);
      expect(() =>
        compareIsobmffStructuralParts(
          isobmffStructuralParts(grid),
          isobmffStructuralParts(mutated),
        ),
      ).toThrow(/^Unpermitted structural difference: ipco:/);
    });
  });

  it.runIf(LINUX_X64)(
    "WR-02: a native output whose tile ispe changed fails the differential without the decode oracle",
    async () => {
      const output = await produceNativeOutput(grid, DEFAULT_PRESERVATION);
      expect(() =>
        runIsobmffDifferential({
          caseId: "heic-wr02-tile-ispe",
          profile: heicDifferentialProfile,
          source: grid,
          output: withIspeExtent(output, 2, 63, 63),
          preserveOrientation: true,
          preserveColorProfile: true,
          preserveResolution: true,
        }),
      ).toThrow(/^Unpermitted structural difference: ipco:/);
    },
    30_000,
  );
});
