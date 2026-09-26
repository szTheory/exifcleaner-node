import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpusRecord, runQualificationCase } from "../kit/corpus.js";
import { pngPayloadDigests } from "./oracles.js";

interface ManifestRecordSummary {
  readonly id: string;
  readonly format: string;
  readonly outcome: {
    readonly status: string;
    readonly errorCode?: string;
    readonly nativeWrite?: string;
  };
}

function pngRefusalRecordIds(): readonly string[] {
  const manifestPath = fileURLToPath(
    new URL("../../corpus/manifest.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly records: readonly ManifestRecordSummary[];
  };
  return manifest.records
    .filter(
      (record) =>
        record.format === "png" && record.outcome.status === "refused",
    )
    .map((record) => record.id);
}

/**
 * The PNG qualification tracer (Plan 09 Task 1): mirrors
 * `webp/tracer.test.ts` -- runs the first upstream PNG corpus record through
 * the built-package `sanitizeFile`/`inspectFile` round trip via the
 * format-neutral `runQualificationCase`, proving the corpus loader's
 * generalization (KIT-01 D-03) qualifies a real non-WebP record end to end.
 */
describe("PNG qualification tracer", () => {
  it("proves the libpng rgb-8-sRGB upstream fixture through built-package sanitize, reopen, and payload checks", async () => {
    const transcript = await runQualificationCase("libpng-1.6.58-rgb-8-srgb", {
      payloadDigests: pngPayloadDigests,
    });

    expect(transcript).toMatchObject({
      version: 1,
      caseId: "libpng-1.6.58-rgb-8-srgb",
      status: "success",
      source: {
        relativePath: "upstream/libpng-1.6.58/rgb-8-sRGB.png",
        unchanged: true,
        sha256:
          "4f94dfdb92acaeffab3aff43fbaf935fe0e5816566792b56a75a9f8802028e7e",
      },
      destination: { state: "created" },
      reopened: {
        format: "png",
        namespaces: { EXIF: 0, XMP: 0, ICC: 0, PNG: 0, C2PA: 0 },
      },
    });
    expect(
      transcript.status === "success" && transcript.retainedPayloads,
    ).toEqual([expect.objectContaining({ part: "IDAT" })]);
    expect(JSON.stringify(transcript)).not.toMatch(/\/(?:Users|home|tmp)\//);
  });

  it("admits the immutable libpng fixture with the differential and structural roles", async () => {
    const record = await loadCorpusRecord("libpng-1.6.58-rgb-8-srgb");
    expect(record).toMatchObject({
      format: "png",
      roles: ["differential", "structural"],
      localPath: "upstream/libpng-1.6.58/rgb-8-sRGB.png",
      provenance: {
        revision: "3061454d980de7d53608f594194cfac722721d2a",
        license: "libpng-2.0",
        licenseStatus: "approved",
      },
      bytes: 772,
      outcome: { status: "success", removedNamespaces: ["PNG"] },
    });
  });

  it("refuses every PNG negative-control corpus record before creating a destination", async () => {
    const ids = pngRefusalRecordIds();
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      const record = await loadCorpusRecord(id);
      if (record.outcome.status !== "refused")
        throw new Error(`Fixture invariant violated: ${id} is not a refusal`);
      const transcript = await runQualificationCase(id, {
        payloadDigests: pngPayloadDigests,
      });
      expect(transcript).toMatchObject({
        version: 1,
        caseId: id,
        status: "refused",
        destination: { state: "absent" },
        error: {
          code: record.outcome.errorCode,
          nativeWrite: record.outcome.nativeWrite,
        },
      });
    }
  });
});
