import { describe, expect, it } from "vitest";
import { loadCorpusRecord, runQualificationCase } from "../kit/corpus.js";
import { pngPayloadDigests } from "./oracles.js";

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
});
