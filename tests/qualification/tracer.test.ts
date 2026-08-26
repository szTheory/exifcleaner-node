import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCorpusRecord,
  loadCorpusRecord,
  materializeCorpusRecord,
  runQualificationCase,
} from "./corpus.js";

const corpusRoot = fileURLToPath(new URL("../corpus/", import.meta.url));

describe("WebP qualification tracer", () => {
  it("proves the provenance-bound sample through built-package sanitize, reopen, and payload checks", async () => {
    const transcript = await runQualificationCase("exifcleaner-sample");

    expect(transcript).toMatchObject({
      version: 1,
      caseId: "exifcleaner-sample",
      status: "success",
      source: {
        relativePath: "sample.webp",
        unchanged: true,
        sha256:
          "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
      },
      destination: { state: "created" },
      reopened: {
        format: "webp",
        namespaces: { EXIF: 0, XMP: 0, ICC: 0 },
      },
    });
    expect(
      transcript.status === "success" && transcript.retainedPayloads,
    ).toEqual([expect.objectContaining({ fourCc: "VP8 " })]);
    expect(JSON.stringify(transcript)).not.toMatch(/\/(?:Users|home|tmp)\//);
  });

  it("refuses the manifested declared-size control before creating a destination", async () => {
    const transcript = await runQualificationCase("declared-size-plus-one");

    expect(transcript).toMatchObject({
      version: 1,
      caseId: "declared-size-plus-one",
      status: "refused",
      source: { unchanged: true },
      destination: { state: "absent" },
      error: { code: "malformed-file", nativeWrite: "not-started" },
    });
  });

  it("rejects malformed or unmanifested corpus records before media materialization", async () => {
    await expect(loadCorpusRecord("not-a-case")).rejects.toThrow(
      "Unknown corpus case",
    );
    await expect(materializeCorpusRecord("../sample.webp")).rejects.toThrow(
      "Unknown corpus case",
    );
    const validRecord = {
      id: "reviewed",
      role: "decode",
      localPath: "sample.webp",
      provenance: {
        revision: "ba365b3459b0d87ce255124a5eef819aca603efd",
        url: "https://example.test/sample.webp",
        license: "MIT",
        licenseStatus: "approved",
      },
      sha256:
        "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
      bytes: 152,
      topology: ["VP8X", "VP8 ", "EXIF"],
      outcome: { status: "success", removedNamespaces: ["EXIF", "XMP", "ICC"] },
      retainedPayloads: [],
      permittedDifferences: [],
    };
    for (const malformed of [
      { ...validRecord, id: "Bad ID" },
      { ...validRecord, role: "unclassified" },
      { ...validRecord, localPath: "../sample.webp" },
      {
        ...validRecord,
        provenance: { ...validRecord.provenance, licenseStatus: "unknown" },
      },
      { ...validRecord, sha256: "digest-drift" },
      { ...validRecord, bytes: 0 },
      { ...validRecord, topology: [] },
      { ...validRecord, outcome: { status: "success" } },
      {
        ...validRecord,
        retainedPayloads: [{ fourCc: "JUNK", sha256: validRecord.sha256 }],
      },
      { ...validRecord, permittedDifferences: [false] },
    ])
      expect(() => assertCorpusRecord(malformed)).toThrow(
        "Invalid corpus record",
      );
    await expect(
      readFile(new URL("manifest.json", `file://${corpusRoot}`)),
    ).resolves.toBeDefined();
  });
});
