import { describe, expect, it } from "vitest";
import { inventoryIsobmff } from "../../isobmff-support/inventory.js";
import {
  assertIso01,
  isMetadataItem,
  sanitizeAllFalse,
  survivingPayloadDigests,
  tracerRecords,
} from "../../isobmff-support/corpus-tracer.js";
import { isobmffDeclineClassOf } from "../../isobmff-support/decline-class.js";
import {
  loadCorpusRecord,
  materializeRecord,
  runQualificationCase,
} from "../kit/corpus.js";
import { HEIC_EXTENSION, heicPayloadDigests } from "./oracles.js";

/**
 * The HEIC qualification tracer (62.1-08, D-25): every HEIC corpus record runs through the
 * built-package sanitize/reopen round trip via the format-neutral `runQualificationCase`, with its
 * exact pinned outcome; admitted records then get the ISO-01 corpus checks on an independent
 * all-flags-false output.
 */
describe("HEIC qualification tracer", () => {
  const records = tracerRecords("heic");

  it("pins the heif-enc grid fixture as a successful EXIF+XMP removal", () => {
    expect(records.map((record) => record.id)).toContain("heif-enc-grid-heic");
  });

  for (const record of records) {
    if (record.outcome.status !== "success") continue;

    it(`${record.id}: pinned success, then ISO-01 holds on the output`, async () => {
      const transcript = await runQualificationCase(record.id, {
        payloadDigests: heicPayloadDigests,
        readDeclineClass: isobmffDeclineClassOf,
      });
      expect(transcript).toMatchObject({
        caseId: record.id,
        status: "success",
        reopened: { format: "heic" },
      });
      const source = await materializeRecord(
        record as Parameters<typeof materializeRecord>[0],
      );
      const { output, result } = await sanitizeAllFalse(source, HEIC_EXTENSION);
      expect([...result.removedNamespaces].sort()).toEqual(
        [...(record.outcome.removedNamespaces ?? [])].sort(),
      );
      assertIso01(source, output);
      // Adjacency edge: every surviving item payload is byte-identical to the source's.
      expect(survivingPayloadDigests(output)).toEqual(
        survivingPayloadDigests(source),
      );
    });
  }

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
});
