// Shared HEIC/AVIF corpus tracer checks (62.1-08, ISO-01/ISO-02 on the real corpora).
//
// The per-format `tests/qualification/{heic,avif}/tracer.test.ts` suites run every manifest record
// of their format through the kit's `runQualificationCase`, then call these checks on a second,
// independently produced output. Every structural fact comes from the independent inventory
// walker (`inventory.ts`), never from the engine under test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeFile } from "../../dist/index.js";
import type { SanitizeResult } from "../../src/types.js";
import {
  ilocItemOrder,
  inventoryIsobmff,
  readItemExtentBytes,
  type InventoryItem,
  type IsobmffInventory,
} from "./inventory.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("../corpus/manifest.json", import.meta.url),
);

/** The C2PA manifest-store `uuid` usertype (C2PA 2.x, "Embedding manifests into BMFF"). */
export const C2PA_UUID_USERTYPE = "d8fec3d61b0e483c92975828877ec481";
const XMP_CONTENT_TYPE = "application/rdf+xml";
/** ISO-01 residue window: no 32-byte run of a removed payload may survive anywhere. */
export const RESIDUE_WINDOW = 32;

export interface TracerRecord {
  readonly id: string;
  readonly format: string;
  readonly roles: readonly string[];
  readonly localPath?: string;
  readonly provenance: { readonly kind?: string };
  readonly sha256: string;
  readonly outcome: {
    readonly status: "success" | "refused";
    readonly removedNamespaces?: readonly string[];
    readonly errorCode?: string;
    readonly declineClass?: string;
  };
  readonly retainedPayloads: readonly {
    readonly part: string;
    readonly sha256: string;
  }[];
}

/** Every manifest record of one format, read directly (the kit validates them on load). */
export function tracerRecords(format: string): readonly TracerRecord[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    readonly records: readonly TracerRecord[];
  };
  return manifest.records.filter((record) => record.format === format);
}

/** A removable metadata item: an `Exif` item or a `mime` item carrying XMP. */
export function isMetadataItem(item: InventoryItem): boolean {
  return (
    item.type === "Exif" ||
    (item.type === "mime" && item.contentType === XMP_CONTENT_TYPE)
  );
}

export interface SanitizedPair {
  readonly source: Buffer;
  readonly output: Buffer;
  readonly result: SanitizeResult;
}

/** Sanitizes `source` with every preservation flag false and returns the output bytes. */
export async function sanitizeAllFalse(
  source: Buffer,
  extension: string,
): Promise<SanitizedPair> {
  const directory = await mkdtemp(join(tmpdir(), "isobmff-corpus-tracer-"));
  try {
    const sourcePath = join(directory, `source${extension}`);
    const destinationPath = join(directory, `sanitized${extension}`);
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    if (!result.ok)
      throw new Error(`Expected success, got ${result.error.code}`);
    return {
      source,
      output: await readFile(destinationPath),
      result: result.value,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first 32-byte window of `payload` found anywhere in `haystack`, or -1 when none is. */
export function firstSurvivingWindow(
  payload: Buffer,
  haystack: Buffer,
): number {
  if (payload.length === 0) return -1;
  const width = Math.min(RESIDUE_WINDOW, payload.length);
  for (let start = 0; start + width <= payload.length; start += 1) {
    if (haystack.indexOf(payload.subarray(start, start + width)) !== -1)
      return start;
  }
  return -1;
}

export interface Iso01Report {
  readonly removedItemIds: readonly number[];
  readonly sourceInventory: IsobmffInventory;
  readonly outputInventory: IsobmffInventory;
}

/**
 * ISO-01 on one admitted record (all preservation flags false):
 * - the output has zero Exif and zero XMP `mime` items among ALL items, hidden and auxiliary
 *   included;
 * - the removed item set is exactly the source's metadata items, and no `iref` entry names one;
 * - no 32-byte window of any removed payload survives anywhere in the output file;
 * - ordering edge: surviving `iinf`, `iloc` and `ipma` entry order equals the source's order with
 *   the removed entries deleted;
 * - empty edge: a source with no metadata item keeps its exact item set.
 * Throws with a specific message on the first violation.
 */
export function assertIso01(source: Buffer, output: Buffer): Iso01Report {
  const sourceInventory = inventoryIsobmff(source);
  const outputInventory = inventoryIsobmff(output);
  const leaked = outputInventory.items.filter(isMetadataItem);
  if (leaked.length > 0)
    throw new Error(
      `Output keeps metadata items: ${leaked.map((item) => `${item.id}:${item.type}`).join(", ")}`,
    );
  const metadataIds = sourceInventory.items
    .filter(isMetadataItem)
    .map((item) => item.id);
  const outputIds = new Set(outputInventory.items.map((item) => item.id));
  const removedItemIds = sourceInventory.items
    .map((item) => item.id)
    .filter((id) => !outputIds.has(id));
  if (JSON.stringify(removedItemIds) !== JSON.stringify(metadataIds))
    throw new Error(
      `Removed items ${JSON.stringify(removedItemIds)} differ from metadata items ${JSON.stringify(metadataIds)}`,
    );
  const removed = new Set(removedItemIds);
  for (const reference of outputInventory.references) {
    if (
      removed.has(reference.from) ||
      reference.to.some((id) => removed.has(id))
    )
      throw new Error(
        `iref ${reference.type} still names a removed item (${reference.from} -> ${reference.to.join(",")})`,
      );
  }
  for (const item of sourceInventory.items.filter(isMetadataItem)) {
    const payload = readItemExtentBytes(source, sourceInventory, item);
    const at = firstSurvivingWindow(payload, output);
    if (at !== -1)
      throw new Error(
        `Removed item ${item.id} (${item.type}) payload survives at window ${at}`,
      );
  }
  const keep = (ids: readonly number[]): number[] =>
    ids.filter((id) => !removed.has(id));
  const orders: readonly [string, readonly number[], readonly number[]][] = [
    [
      "iinf",
      sourceInventory.items.map((item) => item.id),
      outputInventory.items.map((item) => item.id),
    ],
    ["iloc", ilocItemOrder(source), ilocItemOrder(output)],
    [
      "ipma",
      sourceInventory.associations.map((entry) => entry.itemId),
      outputInventory.associations.map((entry) => entry.itemId),
    ],
  ];
  for (const [box, before, after] of orders) {
    if (JSON.stringify(keep(before)) !== JSON.stringify(after))
      throw new Error(
        `${box} order changed: ${JSON.stringify(keep(before))} -> ${JSON.stringify(after)}`,
      );
  }
  return { removedItemIds, sourceInventory, outputInventory };
}

/** Digests of every surviving non-metadata item payload, in `iinf` order (adjacency edge). */
export function survivingPayloadDigests(
  bytes: Buffer,
): readonly { readonly id: number; readonly sha256: string }[] {
  const inventory = inventoryIsobmff(bytes);
  return inventory.items
    .filter((item) => !isMetadataItem(item) && item.extents.length > 0)
    .map((item) => ({
      id: item.id,
      sha256: sha256(readItemExtentBytes(bytes, inventory, item)),
    }));
}

/** The top-level box list with each `uuid` box's 16-byte usertype appended (`uuid:<hex>`). */
export function topLevelSignature(bytes: Buffer): readonly string[] {
  return inventoryIsobmff(bytes).topLevel.map((box) => {
    if (box.type !== "uuid") return box.type;
    const largeSize = bytes.readUInt32BE(box.offset) === 1;
    const start = box.offset + (largeSize ? 16 : 8);
    return `uuid:${bytes.toString("hex", start, start + 16)}`;
  });
}

/**
 * ISO-02 on one signed record: the output has no top-level C2PA `uuid` box, and the remaining
 * top-level order equals the source's with that box deleted. Returns the source's signature so
 * the caller can pin where the C2PA box sat.
 */
export function assertIso02(source: Buffer, output: Buffer): readonly string[] {
  const c2pa = `uuid:${C2PA_UUID_USERTYPE}`;
  const before = topLevelSignature(source);
  const after = topLevelSignature(output);
  if (!before.includes(c2pa))
    throw new Error("Source carries no top-level C2PA uuid box");
  if (after.includes(c2pa))
    throw new Error("Output keeps the top-level C2PA uuid box");
  const expected = before.filter((entry) => entry !== c2pa);
  if (JSON.stringify(expected) !== JSON.stringify(after))
    throw new Error(
      `Top-level order changed: ${JSON.stringify(expected)} -> ${JSON.stringify(after)}`,
    );
  return before;
}

export type DownloadGate =
  | { readonly kind: "run" }
  | { readonly kind: "fail"; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * How a tracer suite treats one record (KIT-10/D-14, T-62.1-19). Vendored records always run. A
 * download-only record runs when `EXIFCLEANER_CORPUS_CACHE_DIR` is set (a cache miss then fails in
 * `materializeRecord`); with no cache it FAILS whenever `CI` is set, and is skipped with a logged
 * reason only on a local run where `CI` is unset -- it never skips silently in CI.
 */
export function downloadGate(
  record: TracerRecord,
  env: NodeJS.ProcessEnv = process.env,
): DownloadGate {
  if (record.provenance.kind !== "download-only") return { kind: "run" };
  const cache = env.EXIFCLEANER_CORPUS_CACHE_DIR;
  if (cache !== undefined && cache.length > 0) return { kind: "run" };
  const reason = `${record.id} is download-only and EXIFCLEANER_CORPUS_CACHE_DIR is not set (run node scripts/qualification/fetch-corpus.cjs --cache <dir> first)`;
  const ci = env.CI;
  if (ci !== undefined && ci.length > 0) return { kind: "fail", reason };
  return { kind: "skip", reason };
}
