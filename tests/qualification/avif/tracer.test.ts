import { describe, expect, it } from "vitest";
import {
  assertIso01,
  assertIso02,
  C2PA_UUID_USERTYPE,
  downloadGate,
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
import { AVIF_EXTENSION, avifPayloadDigests } from "./oracles.js";

const OPTIONS = {
  payloadDigests: avifPayloadDigests,
  readDeclineClass: isobmffDeclineClassOf,
};

async function sourceOf(record: TracerRecord): Promise<Buffer> {
  return materializeRecord(await loadCorpusRecord(record.id));
}

/**
 * The AVIF qualification tracer (62.1-08, D-25): every AVIF corpus record runs through the
 * built-package sanitize/reopen round trip via the format-neutral `runQualificationCase` with its
 * exact pinned outcome (an unexpected admit or a different decline class is red). Admitted records
 * then get the ISO-01 corpus checks on an independent all-flags-false output; signed records get
 * ISO-02.
 */
describe("AVIF qualification tracer", () => {
  const records = tracerRecords("avif");

  it("pins the heif-enc grid fixture as a successful EXIF+XMP removal", () => {
    expect(
      records.find((record) => record.id === "heif-enc-grid-avif")?.outcome,
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
        reopened: { format: "avif" },
      });
      const source = await sourceOf(record);
      const { output, result } = await sanitizeAllFalse(source, AVIF_EXTENSION);
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

  it("ISO-02: the C2PA uuid box is removed from the signed AVIF fixture and the remaining top-level order is kept", async () => {
    const record = records.find((item) => item.id === "c2pa-signed-avif");
    if (record === undefined)
      throw new Error("c2pa-signed-avif record missing");
    const source = await sourceOf(record);
    const { output } = await sanitizeAllFalse(source, AVIF_EXTENSION);
    // 62.1-01 measured c2patool placing the C2PA uuid right after ftyp.
    expect(assertIso02(source, output)).toEqual([
      "ftyp",
      `uuid:${C2PA_UUID_USERTYPE}`,
      "meta",
      "mdat",
    ]);
  });
});
