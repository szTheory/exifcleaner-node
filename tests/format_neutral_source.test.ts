import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A format-specific vocabulary token. Any of these appearing in a file meant
 * to stay format-neutral (the shared engine and transaction) is a sign a
 * WebP-only concept crept back into shared code. Plan 08 extends the scan
 * target list with a per-format `oracles.ts`/`webp-handler.ts` allowlist for
 * the kit-neutrality scan; the token set and matcher here stay unchanged.
 */
export const FORMAT_SPECIFIC_TOKEN = /webp|riff|vp8|fourcc|iccp/giu;

export interface FormatSpecificHit {
  readonly line: number;
  readonly token: string;
}

/** Scans `text` line by line and returns every format-specific token hit. */
export function formatSpecificTokens(
  text: string,
): readonly FormatSpecificHit[] {
  const hits: FormatSpecificHit[] = [];
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    const regex = new RegExp(
      FORMAT_SPECIFIC_TOKEN.source,
      FORMAT_SPECIFIC_TOKEN.flags,
    );
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lineText)) !== null) {
      hits.push({ line: index + 1, token: match[0] });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  });
  return hits;
}

export interface ScanTarget {
  /** Path relative to the package root. */
  readonly path: string;
  /** Reserved for Plan 08's per-format allowlist; unused by this scan. */
  readonly allowReason?: string;
}

/** Reads `target.path` from disk (UTF-8) and scans it for format-specific tokens. */
export function scanTargetForFormatSpecificTokens(
  target: ScanTarget,
): readonly FormatSpecificHit[] {
  const text = readFileSync(join(packageRoot, target.path), "utf8");
  return formatSpecificTokens(text);
}

function describeHits(
  target: ScanTarget,
  hits: readonly FormatSpecificHit[],
): string {
  return `${target.path} contains WebP-specific tokens: ${hits
    .map((hit) => `line ${hit.line} ("${hit.token}")`)
    .join(", ")}`;
}

/**
 * The permanent format-neutrality gate (KIT-01 success criterion 1, D-03).
 * Every file listed here must stay free of WebP's own vocabulary; a format
 * handler owns its own naming, the shared engine and transaction never do.
 */
const NEUTRAL_TARGETS: readonly ScanTarget[] = [
  { path: "src/engine.ts" },
  { path: "src/transaction/safe-transaction.ts" },
];

describe("format-neutral source scan (KIT-01 D-03)", () => {
  it.each(NEUTRAL_TARGETS)("$path carries no WebP-specific token", (target) => {
    const hits = scanTargetForFormatSpecificTokens(target);
    expect(hits.length, describeHits(target, hits)).toBe(0);
  });

  it("returns at least two hits for a fixture carrying WebP-specific tokens", () => {
    const hits = formatSpecificTokens(
      'import { MAX_RIFF_BYTES } from "./webp/riff.js"; join(dir, "output.webp");',
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("matches WEBP case-insensitively as a single hit", () => {
    const hits = formatSpecificTokens("WEBP");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1, token: "WEBP" });
  });
});
