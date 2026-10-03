// Whole-graph libheif decode oracle proof (QUA-04, D-23, Plan 62.1-03).
//
// Linux-x64-only: `heif_decode_oracle` is a compiled C executable built once per job against the
// D-21 static HEIF stack (`scripts/qualification/build-oracles.cjs`). Every case here is gated
// `it.runIf(process.platform === "linux" && process.arch === "x64")` and is proven not-skipped by
// the container rehearsal recorded in `62.1-EVIDENCE.md`, never by a local pass on this host.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeHeifGraph } from "./isobmff-support/decode-oracle.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_FIXTURE = join(FIXTURES_DIR, "heif-enc-grid.heic");

const LINUX_X64 = process.platform === "linux" && process.arch === "x64";

describe("decodeHeifGraph (62.1-03, D-23)", () => {
  it.runIf(LINUX_X64)(
    "heif-enc-grid.heic yields a top-level image and a thumbnail with stable hashes",
    async () => {
      const bytes = await readFile(HEIC_FIXTURE);

      const first = decodeHeifGraph(bytes);
      expect(first.outcome).toBe("decoded");
      expect(first.images.length).toBeGreaterThanOrEqual(2);

      const topLevel = first.images.find(
        (image) => image.role === "primary" || image.role === "toplevel",
      );
      const thumbnail = first.images.find(
        (image) => image.role === "thumbnail",
      );
      expect(topLevel).toBeDefined();
      expect(thumbnail).toBeDefined();
      expect(topLevel?.planesSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(thumbnail?.planesSha256).toMatch(/^[a-f0-9]{64}$/);

      // Stability: decoding the same bytes again produces the exact same ordered transcript.
      const second = decodeHeifGraph(bytes);
      expect(second).toEqual(first);
    },
  );
});
