// AVIF corpus whole-graph decode compare (62.1-09, QUA-04 decode leg, D-23). The independent
// libheif oracle decodes every image of the source and of the native output (primary, other
// top-level images, thumbnails, auxiliary images) and the two transcripts must agree. Linux x64
// only: the oracle is built by build-oracles.cjs; the proof is the container rehearsal and the
// hosted qualification-linux job, never a local skip.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeFile } from "../../../src/engine.js";
import {
  compareHeifDecodes,
  decodeHeifGraph,
} from "../../isobmff-support/decode-oracle.js";
import {
  downloadGate,
  tracerRecords,
} from "../../isobmff-support/corpus-tracer.js";
import { loadCorpusRecord, materializeRecord } from "../kit/corpus.js";

const LINUX_X64 = process.platform === "linux" && process.arch === "x64";
const DECODE_TIMEOUT_MS = 240_000;

/** The preservation settings the decode leg runs: default, and colour profile not preserved. */
const COLOR_PROFILE_CASES = [true, false] as const;

async function sanitizeRegistered(
  source: Buffer,
  preserveColorProfile: boolean,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-avif-decode-"));
  try {
    const sourcePath = join(directory, "source.avif");
    const destinationPath = join(directory, "destination.avif");
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: true,
      preserveColorProfile,
      preserveTimestamps: true,
      preserveResolution: true,
    });
    if (!result.ok) throw new Error(`sanitizeRegistered: ${result.error.code}`);
    return await readFile(destinationPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("AVIF corpus decode compare (62.1-09)", () => {
  const admitted = tracerRecords("avif").filter(
    (record) => record.outcome.status === "success",
  );

  it("iterates every admitted AVIF corpus record", () => {
    expect(admitted.map((record) => record.id)).toContain("heif-enc-grid-avif");
    expect(admitted.map((record) => record.id)).toContain("c2pa-signed-avif");
  });

  for (const tracer of admitted) {
    const gate = downloadGate(tracer);
    if (gate.kind === "fail") {
      it(`${tracer.id}: download-only record needs the fetch cache in CI`, () => {
        throw new Error(gate.reason);
      });
      continue;
    }
    if (gate.kind === "skip") {
      console.warn(`skipping ${gate.reason}`);
      it.skip(`${tracer.id}: download-only (no local fetch cache)`, () => {});
      continue;
    }
    it.runIf(LINUX_X64)(
      `${tracer.id}: the whole-graph decode of the native output matches the source (preserveColorProfile true and false)`,
      async () => {
        const source = await materializeRecord(
          await loadCorpusRecord(tracer.id),
        );
        const sourceTranscript = decodeHeifGraph(source);
        expect(sourceTranscript.outcome).toBe("decoded");
        const sourceHasIcc = sourceTranscript.images.some((image) => image.icc);
        for (const preserveColorProfile of COLOR_PROFILE_CASES) {
          const output = await sanitizeRegistered(source, preserveColorProfile);
          // preserveColorProfile false on an ICC-bearing source: the exact expectIccRemoved
          // mode (maintainer decision 2026-10-03); otherwise strict whole-graph equality.
          compareHeifDecodes(source, output, {
            expectIccRemoved: !preserveColorProfile && sourceHasIcc,
          });
        }
      },
      DECODE_TIMEOUT_MS,
    );
  }
});
