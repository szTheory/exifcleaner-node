// Whole-graph libheif decode oracle, TypeScript side (QUA-04, D-23, Plan 62.1-03).
//
// `decodeHeifGraph` spawns the dedicated `heif_decode_oracle` C executable (never `src/isobmff/`
// -- this is our own reading of the container, not libheif's) and returns an ordered transcript
// of every image it decoded: a top-level image, each of its thumbnails, and each of its
// auxiliary images (filter 0, D-23). ICC presence is reported as its own field, separate from the
// pixel hash, and never folded into it. `compareHeifDecodes` compares two such transcripts for
// exact equality of the ordered image list (role, item ID, header fields, plane hash) and of the
// overall decode outcome.
//
// Isolated from the engine under test (tests/isobmff_isolation.test.ts ISOLATION_RULES): this
// file must never import `src/isobmff/`.
import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { digest } from "../qualification/kit/oracles.js";

const require = createRequire(import.meta.url);
const authorityBuilder =
  require("../../scripts/qualification/build-oracles.cjs") as AuthorityBuilder;

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ORACLE_INPUT_BYTES = 128 * 1024 * 1024;
/**
 * D-23 discretion: the per-image plane byte cap this TS side will hash. A 12MP whole-graph decode
 * runs to tens of megabytes per image; failing closed above this bound keeps a pathological input
 * from exhausting the test process's memory while hashing, without needing a cap inside the C
 * oracle itself (which only ever writes one image's planes to one file at a time).
 */
const MAX_PLANE_BYTES_PER_IMAGE = 256 * 1024 * 1024;
/** D-23: the whole-graph decode of a real multi-image file (grid + thumbnail + auxiliaries) can
 * run longer than the kit's own 20s default; 60s per this plan's own instruction. */
const ORACLE_TIMEOUT_MS = 60_000;

interface ExecutableAuthority {
  readonly path: string;
  readonly sha256: string;
}

interface PreparedOracleTools {
  readonly heifDecode: ExecutableAuthority;
  readonly dispose: () => void;
}

interface AuthorityBuilder {
  readonly loadOrPrepareOracleTools: () => PreparedOracleTools;
}

let preparedTools: PreparedOracleTools | undefined;
function tools(): PreparedOracleTools {
  preparedTools ??= authorityBuilder.loadOrPrepareOracleTools();
  return preparedTools;
}
process.once("exit", () => preparedTools?.dispose());

/** One image the oracle decoded: a top-level image (role "primary"/"toplevel"), a thumbnail, or
 * an auxiliary image. `nclx`/`icc` are presence flags only -- their own bytes are never hashed,
 * and never enter `planesSha256`. */
export interface HeifGraphImage {
  readonly role: string;
  readonly itemId: number;
  readonly width: number;
  readonly height: number;
  readonly chroma: number;
  readonly bitDepth: number;
  readonly alpha: boolean;
  readonly nclx: boolean;
  readonly icc: boolean;
  readonly planesSha256: string;
}

/** The oracle's own outcome for one input: `"rejected"` covers a non-zero exit (malformed input,
 * a mid-graph decode failure, a truncated file) -- `images` is always empty in that case; the
 * oracle never reports a partial graph. */
export interface HeifGraphTranscript {
  readonly outcome: "decoded" | "rejected";
  readonly images: readonly HeifGraphImage[];
}

function validateInput(bytes: Buffer): void {
  if (bytes.length === 0 || bytes.length > MAX_ORACLE_INPUT_BYTES)
    throw new Error("heif decode oracle input outside bounds");
}

function parseHeaderLine(line: string): Omit<HeifGraphImage, "planesSha256"> {
  const fields = line.split(" ");
  if (fields.length !== 9 || fields[0] !== "IMG")
    throw new Error(`decodeHeifGraph: unrecognized header line: ${line}`);
  const [, role, itemId, width, height, chroma, bitDepth, alpha, nclx, icc] =
    fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
  return {
    role,
    itemId: Number(itemId),
    width: Number(width),
    height: Number(height),
    chroma: Number(chroma),
    bitDepth: Number(bitDepth),
    alpha: alpha === "1",
    nclx: nclx === "nclx",
    icc: icc === "icc",
  };
}

/**
 * Spawns `heif_decode_oracle` against `bytes`: a fresh temp input file and a fresh temp planes
 * directory, both deleted in `finally` regardless of outcome. A non-zero oracle exit (malformed
 * input, a decode failure anywhere in the graph) returns `{ outcome: "rejected", images: [] }`
 * rather than throwing, so a caller comparing two transcripts can report a decode-outcome
 * mismatch as data, exactly like any other field (D-23 behavior clause 3: a truncated output
 * differs from its source in decode outcome, and that must be a reportable comparison result, not
 * an uncaught exception).
 */
export function decodeHeifGraph(bytes: Buffer): HeifGraphTranscript {
  validateInput(bytes);
  const authority = tools().heifDecode;
  if (!SHA256.test(authority.sha256))
    throw new Error("Invalid oracle tool authority");

  const inputDir = mkdtempSync(
    join(tmpdir(), "exifcleaner-heif-decode-input-"),
  );
  const planesDir = mkdtempSync(
    join(tmpdir(), "exifcleaner-heif-decode-planes-"),
  );
  try {
    const inputPath = join(inputDir, "input.heif");
    writeFileSync(inputPath, bytes, { flag: "wx" });

    const result = spawnSync(authority.path, [inputPath, planesDir], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: ORACLE_TIMEOUT_MS,
    });
    if (result.error !== undefined)
      throw new Error(
        `heif decode oracle process failed: ${result.error.message}`,
      );
    if ((result.status ?? 1) !== 0) return { outcome: "rejected", images: [] };

    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const images: HeifGraphImage[] = lines.map((line, index) => {
      const header = parseHeaderLine(line);
      const planesPath = join(planesDir, `${index}.planes`);
      const { size } = statSync(planesPath);
      if (size > MAX_PLANE_BYTES_PER_IMAGE)
        throw new Error(
          `decodeHeifGraph: image ${index} planes exceed the ${MAX_PLANE_BYTES_PER_IMAGE}-byte cap`,
        );
      const planesSha256 = digest(readFileSync(planesPath));
      return { ...header, planesSha256 };
    });
    return { outcome: "decoded", images };
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(planesDir, { recursive: true, force: true });
  }
}

export interface HeifDecodeCompareOptions {
  /**
   * D-23 negative control, demonstration-only: restricts the comparison to the primary/
   * top-level image(s), proving that a primary-only check misses a non-primary (e.g. thumbnail)
   * corruption the full whole-graph comparison catches. Never used by a production-equivalent
   * comparison -- every real caller omits this option.
   */
  readonly primaryOnly?: boolean;
}

function selectImages(
  transcript: HeifGraphTranscript,
  options: HeifDecodeCompareOptions | undefined,
): readonly HeifGraphImage[] {
  if (options?.primaryOnly !== true) return transcript.images;
  return transcript.images.filter(
    (image) => image.role === "primary" || image.role === "toplevel",
  );
}

/**
 * Compares two whole-graph decode transcripts of `source` and `output` for exact equality: the
 * same decode outcome, then the same ordered image list -- role, item ID, header fields (width,
 * height, chroma, bit depth, alpha, nclx, ICC presence) and plane hash, in that order. ICC
 * presence is compared as its own field (so an ICC-presence regression is still caught) but is
 * never part of what `planesSha256` hashes (D-23) -- the pixel hash and the ICC-presence flag are
 * always independent facts about an image.
 *
 * Throws, naming the first image whose fields disagree (by its role and item ID), or naming the
 * index where the two image lists diverge in length, or naming a decode-outcome mismatch when the
 * two inputs do not even agree on whether they decoded at all (`options` has no effect on the
 * outcome check -- a rejected transcript always compares unequal to a decoded one).
 */
export function compareHeifDecodes(
  source: Buffer,
  output: Buffer,
  options?: HeifDecodeCompareOptions,
): void {
  const sourceTranscript = decodeHeifGraph(source);
  const outputTranscript = decodeHeifGraph(output);
  if (sourceTranscript.outcome !== outputTranscript.outcome) {
    throw new Error(
      `compareHeifDecodes: decode outcome differs: source=${sourceTranscript.outcome} output=${outputTranscript.outcome}`,
    );
  }

  const sourceImages = selectImages(sourceTranscript, options);
  const outputImages = selectImages(outputTranscript, options);
  const length = Math.max(sourceImages.length, outputImages.length);
  for (let index = 0; index < length; index++) {
    const left = sourceImages[index];
    const right = outputImages[index];
    if (left === undefined || right === undefined) {
      throw new Error(
        `compareHeifDecodes: image count differs at index ${index} (role ${
          left?.role ?? right?.role ?? "unknown"
        })`,
      );
    }
    if (
      left.role !== right.role ||
      left.itemId !== right.itemId ||
      left.width !== right.width ||
      left.height !== right.height ||
      left.chroma !== right.chroma ||
      left.bitDepth !== right.bitDepth ||
      left.alpha !== right.alpha ||
      left.nclx !== right.nclx ||
      left.icc !== right.icc ||
      left.planesSha256 !== right.planesSha256
    ) {
      throw new Error(
        `compareHeifDecodes: image ${index} (role ${left.role}, item ${left.itemId}) differs`,
      );
    }
  }
}
