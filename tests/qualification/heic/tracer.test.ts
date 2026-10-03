import { describe, expect, it } from "vitest";
import { inventoryIsobmff } from "../../isobmff-support/inventory.js";
import {
  assertIso01,
  assertIso02,
  C2PA_UUID_USERTYPE,
  downloadGate,
  isMetadataItem,
  sanitizeAllFalse,
  survivingPayloadDigests,
  tracerRecords,
  type TracerRecord,
} from "../../isobmff-support/corpus-tracer.js";
import {
  isobmffDeclineClassOf,
  PINNABLE_DECLINE_CLASSES,
} from "../../isobmff-support/decline-class.js";
import {
  loadCorpusRecord,
  materializeRecord,
  runQualificationCase,
} from "../kit/corpus.js";
import { HEIC_EXTENSION, heicPayloadDigests } from "./oracles.js";

const OPTIONS = {
  payloadDigests: heicPayloadDigests,
  readDeclineClass: isobmffDeclineClassOf,
};

async function sourceOf(record: TracerRecord): Promise<Buffer> {
  return materializeRecord(await loadCorpusRecord(record.id));
}

/**
 * The HEIC qualification tracer (62.1-08, D-25): every HEIC corpus record runs through the
 * built-package sanitize/reopen round trip via the format-neutral `runQualificationCase` with its
 * exact pinned outcome (an unexpected admit or a different decline class is red). Admitted records
 * then get the ISO-01 corpus checks on an independent all-flags-false output; signed records get
 * ISO-02.
 */
describe("HEIC qualification tracer", () => {
  const records = tracerRecords("heic");

  it("pins the heif-enc grid fixture as a successful EXIF+XMP removal", () => {
    expect(
      records.find((record) => record.id === "heif-enc-grid-heic")?.outcome,
    ).toEqual({
      status: "success",
      removedNamespaces: ["EXIF", "XMP"],
    });
  });

  for (const record of records) {
    // Download-only records (T-62.1-19): fail when CI is set but the fetch cache is not;
    // skip with a logged reason only on a local run (CI unset) without the cache.
    const gate = downloadGate(record);
    if (gate.kind === "fail") {
      it(`${record.id}: download-only record needs the fetch cache in CI`, () => {
        throw new Error(gate.reason);
      });
      continue;
    }
    if (gate.kind === "skip") {
      console.warn(`skipping ${gate.reason}`);
      it.skip(`${record.id}: download-only (no local fetch cache)`, () => {});
      continue;
    }
    if (record.outcome.status === "refused") {
      it(`${record.id}: pinned refusal ${record.outcome.errorCode}/${record.outcome.declineClass}, source unchanged, no destination`, async () => {
        const declineClass = record.outcome.declineClass;
        expect(declineClass).toBeDefined();
        expect(PINNABLE_DECLINE_CLASSES.has(declineClass ?? "")).toBe(true);
        const transcript = await runQualificationCase(record.id, OPTIONS);
        expect(transcript).toMatchObject({
          status: "refused",
          source: { unchanged: true },
          destination: { state: "absent" },
          error: { code: record.outcome.errorCode, nativeWrite: "not-started" },
        });
      });
      continue;
    }

    it(`${record.id}: pinned success, then ISO-01 holds on the output`, async () => {
      const transcript = await runQualificationCase(record.id, OPTIONS);
      expect(transcript).toMatchObject({
        caseId: record.id,
        status: "success",
        reopened: { format: "heic" },
      });
      const source = await sourceOf(record);
      const { output, result } = await sanitizeAllFalse(source, HEIC_EXTENSION);
      expect([...result.removedNamespaces].sort()).toEqual(
        [...(record.outcome.removedNamespaces ?? [])].sort(),
      );
      const report = assertIso01(source, output);
      // Adjacency edge: every surviving item payload is byte-identical to the source's.
      expect(survivingPayloadDigests(output)).toEqual(
        survivingPayloadDigests(source),
      );
      // Empty edge: no metadata item in the source means the item set is unchanged.
      if (report.removedItemIds.length === 0)
        expect(report.outputInventory.items.map((item) => item.id)).toEqual(
          report.sourceInventory.items.map((item) => item.id),
        );
    });
  }

  it("ISO-02: the C2PA uuid box is removed from the signed HEIC fixture and the remaining top-level order is kept", async () => {
    const record = records.find((item) => item.id === "c2pa-signed-heic");
    if (record === undefined)
      throw new Error("c2pa-signed-heic record missing");
    const source = await sourceOf(record);
    const { output } = await sanitizeAllFalse(source, HEIC_EXTENSION);
    // 62.1-01 measured c2patool placing the C2PA uuid right after ftyp.
    expect(assertIso02(source, output)).toEqual([
      "ftyp",
      `uuid:${C2PA_UUID_USERTYPE}`,
      "meta",
      "mdat",
    ]);
  });

  // Negative controls: each ISO-01 check must go red on a real violation.
  it("ISO-01 check is red on an unsanitized output and on a surviving metadata run", async () => {
    const record = await loadCorpusRecord("heif-enc-grid-heic");
    const source = await materializeRecord(record);
    expect(() => assertIso01(source, source)).toThrow(/keeps metadata items/);
    const { output } = await sanitizeAllFalse(source, HEIC_EXTENSION);
    const inventory = inventoryIsobmff(source);
    const exif = inventory.items.find(isMetadataItem);
    if (exif === undefined) throw new Error("fixture lost its metadata item");
    const extent = exif.extents[0];
    if (extent === undefined) throw new Error("metadata item has no extent");
    const start = exif.baseOffset + extent.offset;
    const run = source.subarray(start, start + 40);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + run.length, 0);
    header.write("free", 4, "ascii");
    expect(() =>
      assertIso01(source, Buffer.concat([output, header, run])),
    ).toThrow(/payload survives/);
  });

  it("ISO-02 check is red when the C2PA uuid box survives", async () => {
    const source = await materializeRecord(
      await loadCorpusRecord("c2pa-signed-heic"),
    );
    expect(() => assertIso02(source, source)).toThrow(
      /keeps the top-level C2PA/,
    );
  });

  it("download gate: fails in CI without the cache, skips only locally, runs with it", () => {
    const iphone = records.find(
      (record) => record.id === "ianare-exif-samples-iphone-13-pro-max",
    );
    const vendored = records.find(
      (record) => record.id === "heif-enc-grid-heic",
    );
    if (iphone === undefined || vendored === undefined)
      throw new Error("gate fixtures missing");
    expect(downloadGate(iphone, { CI: "true" }).kind).toBe("fail");
    expect(downloadGate(iphone, { CI: "1" }).kind).toBe("fail");
    expect(downloadGate(iphone, {}).kind).toBe("skip");
    expect(
      downloadGate(iphone, { CI: "true", EXIFCLEANER_CORPUS_CACHE_DIR: "/c" })
        .kind,
    ).toBe("run");
    expect(downloadGate(vendored, { CI: "true" }).kind).toBe("run");
  });
});
