// HEIC/AVIF handler modules, unregistered (62-12): proves `createHeicHandler`/`createAvifHandler`
// (`src/admission/heic-handler.ts`, `avif-handler.ts`) are thin factories over the shared ISOBMFF
// writer engine that sanitize their own brand's fixture through the real engine -- with BOTH
// handlers installed at once via `setRegisteredHandlersForTests`, never through the admission-only
// counting stub -- while remaining unreachable from the real registry (D-02/D-03: `HANDLERS` stays
// `[webp, png, jpeg]` until 62.1-07).
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/engine.js";
import {
  registeredHandlersForTests,
  setRegisteredHandlersForTests,
} from "../src/admission/registry.js";
import { classifyIsobmffBrand } from "../src/isobmff/brand.js";
import {
  ISOBMFF_DECLINE_CLASSES,
  type IsobmffDeclineClass,
} from "../src/isobmff/errors.js";
import {
  HEIF_REFUSAL_BY_DECLINE_CLASS,
  HEIF_REFUSALS,
  type HeifRefusal,
} from "../src/isobmff/refusals.js";
import { createIsobmffWriterCountingHandlerForTests } from "./isobmff-support/test-handler.js";
import { assembleHeif, HOSTILE_FIXTURES } from "./isobmff-support/hostile.js";
import { ftypBox } from "./isobmff-support/builder.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_PATH = join(FIXTURES_DIR, "heif-enc-grid.avif");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-handlers-"));
  directories.push(directory);
  return directory;
}

describe("HEIC/AVIF handler modules, unregistered (62-12)", () => {
  it("D-02/D-03: registeredHandlersForTests() still returns only webp, png and jpeg", () => {
    const formats = registeredHandlersForTests().map(
      (handler) => handler.capability.format,
    );
    expect(formats).toEqual(["webp", "png", "jpeg"]);
  });

  it("D-10: createHeicHandler/createAvifHandler produce the expected brand and staging name", () => {
    const { handler: heic } = createIsobmffWriterCountingHandlerForTests("heic");
    const { handler: avif } = createIsobmffWriterCountingHandlerForTests("avif");
    expect(heic.stagingFileName).toBe("output.heic");
    expect(avif.stagingFileName).toBe("output.avif");
  });

  it("with both handlers installed at once, heif-enc-grid.heic is admitted by the heic handler and heif-enc-grid.avif by the avif handler", async () => {
    const heic = createIsobmffWriterCountingHandlerForTests("heic");
    const avif = createIsobmffWriterCountingHandlerForTests("avif");
    const restore = setRegisteredHandlersForTests([heic.handler, avif.handler]);
    try {
      const directory = await freshDirectory();

      const heicDestination = join(directory, "heic-output.bin");
      const heicResult = await sanitizeFile({
        sourcePath: HEIC_PATH,
        destinationPath: heicDestination,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(heicResult.ok).toBe(true);
      await expect(stat(heicDestination)).resolves.toBeDefined();
      expect(heic.counters.admit).toBe(1);
      expect(avif.counters.admit).toBe(0);

      const avifDestination = join(directory, "avif-output.bin");
      const avifResult = await sanitizeFile({
        sourcePath: AVIF_PATH,
        destinationPath: avifDestination,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(avifResult.ok).toBe(true);
      await expect(stat(avifDestination)).resolves.toBeDefined();
      expect(heic.counters.admit).toBe(1); // unchanged by the avif run
      expect(avif.counters.admit).toBe(1);

      // Neither handler matches the other brand's fixture (D-09): the heic fixture's own admit
      // count never moved when sanitizing the avif fixture, and vice versa -- already asserted
      // above by the counters staying put across both runs.
      const heicBytes = await readFile(HEIC_PATH);
      const avifBytes = await readFile(AVIF_PATH);
      expect(heic.handler.matches(heicBytes.subarray(0, 256))).toBe(true);
      expect(heic.handler.matches(avifBytes.subarray(0, 256))).toBe(false);
      expect(avif.handler.matches(avifBytes.subarray(0, 256))).toBe(true);
      expect(avif.handler.matches(heicBytes.subarray(0, 256))).toBe(false);
    } finally {
      restore();
    }
  });
});

// --- D-09 exact matching, oversized ftyp, and the brand-mismatch class (62-12, Task 2) ---------

/** Builds a minimal, synthetic `ftyp` box buffer for the classifier table below -- real bytes,
 * never a stub, through the same `ftypBox` encoder `tests/isobmff-support/hostile.ts` uses. */
function ftyp(majorBrand: string, compatibleBrands: readonly string[]): Buffer {
  return ftypBox(majorBrand, 0, compatibleBrands);
}

/** D-09's negative control: bypasses the classifier entirely and reads `major_brand` only
 * (bytes 8..12), never consulting compatible brands or any decline rule -- this is exactly the
 * kind of `matches` shortcut D-09 forbids ("no other logic"). */
const BYPASS_HEIC_MATCHER = {
  matches(magic: Buffer): boolean {
    return magic.length >= 12 && magic.toString("ascii", 8, 12) === "heic";
  },
};

/**
 * D-09 table helper: for every row, a handler's `matches` must equal
 * `classifyIsobmffBrand(row) === brand` exactly. Used both to prove the two real handlers hold
 * this property on every row (tautologically true by construction, but proven against the real
 * object, never assumed) and to prove a bypassing stand-in FAILS it on at least one row.
 */
function expectClassifierExactMatch(
  handler: { matches(magic: Buffer): boolean },
  brand: "heic" | "avif",
  rows: ReadonlyMap<string, Buffer>,
): void {
  for (const [, row] of rows) {
    const expected = classifyIsobmffBrand(row) === brand;
    expect(handler.matches(row)).toBe(expected);
  }
}

const CLASSIFIER_TABLE_ROWS: ReadonlyMap<string, Buffer> = new Map([
  ["heic", ftyp("heic", ["mif1", "heic"])],
  ["avif", ftyp("avif", ["mif1", "avif"])],
  ["mif1-only", ftyp("mif1", ["mif1"])],
  ["both-brands", ftyp("heic", ["mif1", "heic", "avif"])],
  ["mif1-major-heic-compatible", ftyp("mif1", ["mif1", "heic"])],
  ["msf1", ftyp("msf1", ["msf1"])],
  ["avis", ftyp("avis", ["avis"])],
  ["mif2-only", ftyp("mif2", ["mif2"])],
  ["truncated-ftyp", Buffer.from("ftyp", "ascii")], // < 16 bytes
  [
    "ftyp-larger-than-256-bytes",
    // 65 compatible brands: 16 + 65*4 = 276 > 256, the registry's own magic-buffer cap.
    ftyp("heic", Array.from({ length: 65 }, () => "heic")),
  ],
  ["non-isobmff", Buffer.from("RIFF0000WEBPVP8 ", "ascii")],
]);

describe("D-09 exact classifier matching (62-12, Task 2)", () => {
  it("both real handlers' matches equal classifyIsobmffBrand(row) === their own brand, on every row", () => {
    const { handler: heic } = createIsobmffWriterCountingHandlerForTests("heic");
    const { handler: avif } = createIsobmffWriterCountingHandlerForTests("avif");
    expectClassifierExactMatch(heic, "heic", CLASSIFIER_TABLE_ROWS);
    expectClassifierExactMatch(avif, "avif", CLASSIFIER_TABLE_ROWS);
  });

  it("a bypassing matcher (major_brand === 'heic' only) fails the table helper on at least one row", () => {
    expect(() =>
      expectClassifierExactMatch(
        BYPASS_HEIC_MATCHER,
        "heic",
        CLASSIFIER_TABLE_ROWS,
      ),
    ).toThrow();
  });
});

describe("D-09(a) oversized ftyp is rejected at selection (62-12, Task 2)", () => {
  it("a 300+-byte ftyp source with both handlers installed declines unsupported-format; neither handler's admit runs", async () => {
    const heic = createIsobmffWriterCountingHandlerForTests("heic");
    const avif = createIsobmffWriterCountingHandlerForTests("avif");
    const restore = setRegisteredHandlersForTests([heic.handler, avif.handler]);
    try {
      const directory = await freshDirectory();
      const sourcePath = join(directory, "oversized-ftyp.heic");
      const destinationPath = join(directory, "destination.bin");

      // 65 compatible brands: ftyp declared size 16 + 65*4 = 276 bytes, past the registry's own
      // 256-byte magic-buffer read (src/admission/registry.ts) -- classifyIsobmffBrand declines
      // because declaredSize > bytes.length, before either handler's matches ever sees enough of
      // the real brand set to decide. A structurally complete HEIF body follows the ftyp so the
      // fixture is realistic, not merely a truncated stub.
      const bytes = assembleHeif({
        compatibleBrands: Array.from({ length: 65 }, () => "heic"),
      });
      const handle = await open(sourcePath, "w");
      try {
        await handle.write(bytes, 0, bytes.length, 0);
      } finally {
        await handle.close();
      }

      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });
      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error).toMatchObject({ code: "unsupported-format" });
      expect(heic.counters.admit).toBe(0);
      expect(avif.counters.admit).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("D-09(b) brand-mismatch decline at handler admit (62-12, Task 2)", () => {
  it("the heic handler's admit on heif-enc-grid.avif rejects brand-mismatch/unsupported-format; buildOutputPlan never called", async () => {
    const { handler, counters } = createIsobmffWriterCountingHandlerForTests("heic");
    const avifBytes = await readFile(AVIF_PATH);
    const handle = await open(AVIF_PATH, "r");
    try {
      await expect(handler.admit(handle, avifBytes.length)).rejects.toMatchObject(
        { declineClass: "brand-mismatch", kind: "unsupported-format" },
      );
      expect(counters.buildOutputPlan).toBe(0);
      expect(counters.checkOutputPlan).toBe(0);
      expect(counters.writeOutput).toBe(0);
      expect(counters.verifyOutput).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("HOSTILE_FIXTURES['brand-mismatch'] carries stage 'handler', expectedCode unsupported-format, and the heic handler declines it the same way", async () => {
    const fixture = HOSTILE_FIXTURES["brand-mismatch"];
    expect(fixture.stage).toBe("handler");
    expect(fixture.expectedCode).toBe("unsupported-format");

    const directory = await freshDirectory();
    const path = join(directory, "brand-mismatch.bin");
    await fixture.write(path);
    const bytes = await readFile(path);
    const { handler, counters } = createIsobmffWriterCountingHandlerForTests("heic");
    const handle = await open(path, "r");
    try {
      await expect(handler.admit(handle, bytes.length)).rejects.toMatchObject({
        declineClass: "brand-mismatch",
        kind: "unsupported-format",
      });
      expect(counters.buildOutputPlan).toBe(0);
    } finally {
      await handle.close();
    }
  });
});

// --- Coarse refusal table (D-06, 62-12 Task 3) --------------------------------------------------

/** D-06's explicit mapping table (`.planning/phases/.../62-CONTEXT.md`), restated here as the
 * one pin every row is checked against -- a change to `HEIF_REFUSAL_BY_DECLINE_CLASS` that
 * doesn't match this table must fail this test, not just typecheck. */
const EXPECTED_HEIF_REFUSAL_TABLE: Record<IsobmffDeclineClass, HeifRefusal> = {
  "box-framing": "malformed-container",
  "meta-not-fullbox": "malformed-container",
  "duplicate-meta": "malformed-container",
  "extent-outside-mdat": "malformed-container",
  "item-graph-invalid": "malformed-container",

  "cap-meta-bytes": "resource-limits",
  "cap-box-count": "resource-limits",
  "cap-box-depth": "resource-limits",
  "cap-buffered-bytes": "resource-limits",

  "sequence-box": "image-sequence",
  "sequence-brand": "image-sequence",

  "top-level-box-not-allowed": "unknown-boxes",
  "unknown-meta-child": "unknown-boxes",

  "unknown-item-type": "unknown-item-types",

  "removable-item-in-idat": "unsupported-features",
  "construction-method-2": "unsupported-features",
  "external-data-reference": "unsupported-features",
  "multiple-mdat": "unsupported-features",
  "meta-handler-not-pict": "unsupported-features",
  "unsupported-box-version": "unsupported-features",
  "brand-mismatch": "unsupported-features",

  "removable-extent-overlap": "unsafe-item-layout",
  "removable-item-referenced": "unsafe-item-layout",
  "surviving-zero-length-extent": "unsafe-item-layout",
  "surviving-offset-width-zero": "unsafe-item-layout",
  "offset-rewrite-overflow": "unsafe-item-layout",
};

describe("D-06 coarse refusal table (62-12, Task 3)", () => {
  it("every IsobmffDeclineClass maps to its expected HeifRefusal, pinned row by row", () => {
    for (const declineClass of ISOBMFF_DECLINE_CLASSES) {
      expect(HEIF_REFUSAL_BY_DECLINE_CLASS[declineClass]).toBe(
        EXPECTED_HEIF_REFUSAL_TABLE[declineClass],
      );
    }
  });

  it("the table covers exactly ISOBMFF_DECLINE_CLASSES, with no extra or missing keys", () => {
    const tableKeys = Object.keys(HEIF_REFUSAL_BY_DECLINE_CLASS).sort();
    const declineClasses = [...ISOBMFF_DECLINE_CLASSES].sort();
    expect(tableKeys).toEqual(declineClasses);
  });

  it("the value set equals exactly the seven HeifRefusal literals", () => {
    const observedValues = new Set(
      Object.values(HEIF_REFUSAL_BY_DECLINE_CLASS),
    );
    expect(observedValues).toEqual(new Set(HEIF_REFUSALS));
    expect(HEIF_REFUSALS.length).toBe(7);
    expect(new Set(HEIF_REFUSALS).size).toBe(7);
  });
});
