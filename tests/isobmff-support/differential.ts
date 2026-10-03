// Shared ISOBMFF structural parts, payload and ICC digests over the independent inventory
// (D-27, QUA-01). Used by both `tests/qualification/heic/oracles.ts` and
// `tests/qualification/avif/oracles.ts` to build their own closed, per-brand
// permitted-difference lists against ExifTool 13.59's `-all=` reference.
//
// Never imports `src/isobmff/` (the engine under test) -- enforced by
// `tests/isobmff_isolation.test.ts`'s `ISOLATION_RULES`. This module owns the comparison logic
// both brands share; `tests/qualification/{heic,avif}/oracles.ts` each supply only their own
// `DifferentialProfile` and permitted-difference citation list.
import { createHash } from "node:crypto";
import {
  compareAdmittedUnknownTags,
  projectMetadata,
  runExiftoolReference,
  validateInput,
  type DifferentialProfile,
  type MetadataEntry,
  type MetadataProjection,
} from "../qualification/kit/oracles.js";
import type { PayloadDigest } from "../qualification/kit/corpus.js";
import { inventoryIsobmff, readItemExtentBytes } from "./inventory.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The five permitted-difference ids this phase measured (D-27): (a) ExifTool keeps a removed
 * metadata item's `infe` declaration with a zero-length extent (F-HEIC-DECL) while native removes
 * the entry outright; (b) ExifTool's "ICC_Profile deleted" `-all=` warning never actually removes
 * the `colr` box's structural bytes (F-HEIC-ICC) while native, correctly asked not to preserve,
 * removes it; (c) ExifTool's own `-TagsFromFile`-rewritten minimal Exif always adds a
 * `YCbCrPositioning` companion that native's minimal Exif never writes; (d) the differential never
 * compares raw output bytes between native and reference, only structure and metadata tags, so a
 * byte-layout difference (e.g. the `exif_tiff_header_offset` prefix) is never itself a failure
 * mode; (e) ExifTool keeps top-level `free`/`skip` boxes (byte-identical, relocated before `mdat`)
 * while native drops them wherever they sit (D-14). A sixth id, HEIC-only and listed per record
 * (maintainer decision 2026-10-03, 62.1-09): (f) ExifTool `-all=` keeps the XMP item describing
 * an auxiliary image (the iPhone HDR gain map's `cdsc` XMP) while native removes it -- explained
 * only for reference-only XMP entries that the reference's own auxiliary-item XMP carries, never
 * for XMP native keeps and the reference drops.
 */
export type IsobmffPermittedDifferenceId =
  | "exiftool-keeps-emptied-metadata-entries"
  | "exiftool-keeps-icc-when-not-preserving"
  | "exiftool-minimal-exif-ycbcr-positioning"
  | "byte-layout-differs"
  | "exiftool-keeps-free-skip"
  | "exiftool-keeps-auxiliary-item-xmp";

export interface IsobmffPermittedDifference {
  readonly id: IsobmffPermittedDifferenceId;
  /** The exact title of the live test (this brand's own `oracles.test.ts`) that measures this
   * difference -- checked for existence by a host-independent citation test. */
  readonly measurement: string;
  /** The exact `##`/`###` heading in `docs/isobmff.md` that records the measurement basis. */
  readonly docsHeading: string;
}

const METADATA_ITEM_TYPES = new Set(["Exif", "mime"]);

interface RawTopLevelBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly payloadStart: number;
}

/** A minimal, independent top-level/child box walker (never `src/isobmff/`) -- used only to
 * reach `meta/iprp/ipco` raw property bytes and top-level `free`/`skip` payloads, which
 * `inventory.ts` does not expose. Assumes "normal" (never largesize/size-zero) framing, true of
 * every fixture this module's own tests build. */
function findBox(
  bytes: Buffer,
  start: number,
  end: number,
  type: string,
): RawTopLevelBox | undefined {
  let offset = start;
  while (offset + 8 <= end) {
    const size = bytes.readUInt32BE(offset);
    const boxType = bytes.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > end) return undefined;
    if (boxType === type)
      return {
        type,
        start: offset,
        end: offset + size,
        payloadStart: offset + 8,
      };
    offset += size;
  }
  return undefined;
}

interface RawIpcoProperty {
  readonly index: number;
  readonly type: string;
  readonly bytes: Buffer;
}

function readIpcoProperties(bytes: Buffer): readonly RawIpcoProperty[] {
  const meta = findBox(bytes, 0, bytes.length, "meta");
  if (meta === undefined) return [];
  const childrenStart = meta.payloadStart + 4; // meta is a FullBox: version(8) flags(24).
  const iprp = findBox(bytes, childrenStart, meta.end, "iprp");
  if (iprp === undefined) return [];
  const ipco = findBox(bytes, iprp.payloadStart, iprp.end, "ipco");
  if (ipco === undefined) return [];
  const properties: RawIpcoProperty[] = [];
  let offset = ipco.payloadStart;
  let index = 1;
  while (offset + 8 <= ipco.end) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > ipco.end) break;
    properties.push({
      index,
      type,
      bytes: bytes.subarray(offset, offset + size),
    });
    index += 1;
    offset += size;
  }
  return properties;
}

/**
 * Top-level box types in file order, plus one `infe:<type>` part per declared item entry
 * (regardless of whether its extent is live or declared-empty), plus one
 * `ipco:<type>:<sha256>` part per non-`colr` property associated with the primary item.
 * Order-insensitive, multiset comparison between a native output and the ExifTool `-all=`
 * reference is what lets entries (a) and (e) be explained purely from structural part
 * membership -- and lets an unlisted structural difference (a leaked/over-stripped item, a
 * changed `irot`/`nclx` property) surface as an ordinary unpermitted structural difference.
 * `colr` is excluded here -- ICC identity is compared separately via raw profile digests
 * (`isobmffRawColorProfileSha256`), never by structural part membership.
 */
export function isobmffStructuralParts(bytes: Buffer): readonly string[] {
  const inventory = inventoryIsobmff(bytes);
  const parts: string[] = inventory.topLevel.map((box) => box.type);
  for (const item of inventory.items) parts.push(`infe:${item.type}`);

  if (inventory.primaryItemId !== undefined) {
    const association = inventory.associations.find(
      (entry) => entry.itemId === inventory.primaryItemId,
    );
    if (association !== undefined) {
      const rawProperties = readIpcoProperties(bytes);
      for (const { propertyIndex } of association.associations) {
        const property = rawProperties.find(
          (candidate) => candidate.index === propertyIndex,
        );
        if (property === undefined || property.type === "colr") continue;
        parts.push(`ipco:${property.type}:${sha256(property.bytes)}`);
      }
    }
  }
  return parts;
}

/**
 * sha256 of every surviving non-metadata item's payload bytes (via the independent inventory's
 * own `readItemExtentBytes`, never the engine), keyed by item type -- this suite's own
 * `payloadDigests` callback (mirrors `webpPayloadDigests`/`pngPayloadDigests`).
 */
export function isobmffPayloadDigests(bytes: Buffer): readonly PayloadDigest[] {
  const inventory = inventoryIsobmff(bytes);
  const digests: PayloadDigest[] = [];
  for (const item of inventory.items) {
    if (METADATA_ITEM_TYPES.has(item.type)) continue;
    if (item.extents.length === 0) continue;
    const payload = readItemExtentBytes(bytes, inventory, item);
    if (payload.length === 0) continue;
    digests.push({ part: item.type, sha256: sha256(payload) });
  }
  return digests;
}

const XMP_CONTENT_TYPE = "application/rdf+xml";

/**
 * The `mime` XMP items (`application/rdf+xml`) whose every `cdsc` target is an auxiliary image
 * (the `from` item of an `auxl` reference), in item order -- entry (f)'s scope. An XMP item that
 * also describes, or only describes, a non-auxiliary item is never returned. Each returned
 * payload is the item's own non-empty extent bytes.
 */
export function isobmffAuxiliaryItemXmpPayloads(
  bytes: Buffer,
): readonly Buffer[] {
  const inventory = inventoryIsobmff(bytes);
  const auxiliaryItems = new Set(
    inventory.references
      .filter((reference) => reference.type === "auxl")
      .map((reference) => reference.from),
  );
  const payloads: Buffer[] = [];
  for (const item of inventory.items) {
    if (item.type !== "mime" || item.contentType !== XMP_CONTENT_TYPE) continue;
    const targets = inventory.references
      .filter((reference) => reference.type === "cdsc")
      .filter((reference) => reference.from === item.id)
      .flatMap((reference) => reference.to);
    if (targets.length === 0) continue;
    if (!targets.every((target) => auxiliaryItems.has(target))) continue;
    if (item.extents.length === 0) continue;
    const payload = readItemExtentBytes(bytes, inventory, item);
    if (payload.length > 0) payloads.push(payload);
  }
  return payloads;
}

/**
 * sha256 of the first `colr` property whose `colour_type` is `prof` or `rICC` (the embedded ICC
 * profile bytes, not the box header/colour_type), or undefined when none exists. `nclx` `colr`
 * properties are never a raw ICC profile and are ignored. A test-local, independent walker
 * (never `src/isobmff/`), mirroring `pngRawColorProfileSha256`'s own raw-profile digest shape.
 */
export function isobmffRawColorProfileSha256(
  bytes: Buffer,
): string | undefined {
  for (const property of readIpcoProperties(bytes)) {
    if (property.type !== "colr") continue;
    const colourType = property.bytes.toString("ascii", 8, 12);
    if (colourType === "prof" || colourType === "rICC")
      return sha256(property.bytes.subarray(12));
  }
  return undefined;
}

export interface IsobmffFreeSkipBox {
  readonly type: "free" | "skip";
  readonly sha256: string;
}

/** Top-level `free`/`skip` boxes (type + payload digest), in file order -- entry (e)'s own
 * byte-identity check, independent of structural-part membership. */
export function isobmffFreeSkipBoxes(
  bytes: Buffer,
): readonly IsobmffFreeSkipBox[] {
  const boxes: IsobmffFreeSkipBox[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > bytes.length) break;
    if (type === "free" || type === "skip")
      boxes.push({
        type,
        sha256: sha256(bytes.subarray(offset + 8, offset + size)),
      });
    offset += size;
  }
  return boxes;
}

function sameFreeSkipMultiset(
  left: readonly IsobmffFreeSkipBox[],
  right: readonly IsobmffFreeSkipBox[],
): boolean {
  if (left.length !== right.length) return false;
  const remaining = right.map((box) => `${box.type}:${box.sha256}`);
  for (const box of left) {
    const index = remaining.indexOf(`${box.type}:${box.sha256}`);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function entryKey(entry: MetadataEntry): string {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

function multisetDiffEntries(
  left: readonly MetadataEntry[],
  right: readonly MetadataEntry[],
): {
  readonly onlyLeft: readonly MetadataEntry[];
  readonly onlyRight: readonly MetadataEntry[];
} {
  const remainingRight = right.map(entryKey);
  const onlyLeft: MetadataEntry[] = [];
  for (const entry of left) {
    const index = remainingRight.indexOf(entryKey(entry));
    if (index === -1) onlyLeft.push(entry);
    else remainingRight.splice(index, 1);
  }
  const remainingLeft = left.map(entryKey);
  const onlyRight: MetadataEntry[] = [];
  for (const entry of right) {
    const index = remainingLeft.indexOf(entryKey(entry));
    if (index === -1) onlyRight.push(entry);
    else remainingLeft.splice(index, 1);
  }
  return { onlyLeft, onlyRight };
}

function multisetDiffStrings(
  left: readonly string[],
  right: readonly string[],
): {
  readonly onlyLeft: readonly string[];
  readonly onlyRight: readonly string[];
} {
  const remainingRight = [...right];
  const onlyLeft: string[] = [];
  for (const value of left) {
    const index = remainingRight.indexOf(value);
    if (index === -1) onlyLeft.push(value);
    else remainingRight.splice(index, 1);
  }
  const remainingLeft = [...left];
  const onlyRight: string[] = [];
  for (const value of right) {
    const index = remainingLeft.indexOf(value);
    if (index === -1) onlyRight.push(value);
    else remainingLeft.splice(index, 1);
  }
  return { onlyLeft, onlyRight };
}

/**
 * Entry (d), `byte-layout-differs`: ExifTool 13.59 reports the top-level `mdat` box's own byte
 * position and length as `QuickTime:MediaDataOffset`, `QuickTime:MediaDataSize` and the
 * `QuickTime:MediaData` binary placeholder (whose text carries the length). Those values describe
 * where bytes sit, not what metadata a file carries, so they differ between native and reference
 * whenever the `meta` box or the minimal Exif payload differs in length (measured 62.1-05:
 * `docs/isobmff.md` "### ExifTool 13.59 QuickTime media-data layout tags (62.1-05)"). They are
 * compared by presence only -- each side must report every one of them exactly as many times as
 * the other -- and the bytes they describe are compared instead, by the non-metadata payload
 * digest check (`compareIsobmffPayloadDigests`). Every other QuickTime tag is compared by value.
 */
const LAYOUT_DESCRIPTOR_NAMESPACE = "QuickTime";
const LAYOUT_DESCRIPTOR_TAGS: ReadonlySet<string> = new Set([
  "MediaDataOffset",
  "MediaDataSize",
  "MediaData",
]);

function isLayoutDescriptor(entry: MetadataEntry): boolean {
  const keys = Object.keys(entry);
  return keys.length === 1 && LAYOUT_DESCRIPTOR_TAGS.has(keys[0]!);
}

function layoutDescriptorTags(entries: readonly MetadataEntry[]): string[] {
  return entries
    .filter(isLayoutDescriptor)
    .map((entry) => Object.keys(entry)[0]!)
    .sort();
}

/** Drops entry (d)'s layout descriptors from `entries` only when `other` reports exactly the same
 * descriptor tags, so a descriptor present on one side only still surfaces as a difference. */
function withoutLayoutDescriptors(
  namespace: string,
  entries: readonly MetadataEntry[],
  other: readonly MetadataEntry[],
): readonly MetadataEntry[] {
  if (namespace !== LAYOUT_DESCRIPTOR_NAMESPACE) return entries;
  if (
    layoutDescriptorTags(entries).join(",") !==
    layoutDescriptorTags(other).join(",")
  )
    return entries;
  return entries.filter((entry) => !isLayoutDescriptor(entry));
}

/**
 * Pure (no ExifTool invocation): the bytes entry (d)'s layout descriptors point at. Every
 * surviving non-metadata item payload (`isobmffPayloadDigests`) must be an exact multiset match
 * between native output and the ExifTool `-all=` reference -- a changed, missing or extra image
 * payload throws, so presence-only comparison of `MediaDataOffset`/`MediaDataSize` never hides a
 * payload change.
 */
export function compareIsobmffPayloadDigests(
  outputDigests: readonly PayloadDigest[],
  referenceDigests: readonly PayloadDigest[],
): void {
  const { onlyLeft, onlyRight } = multisetDiffStrings(
    outputDigests.map((entry) => `${entry.part}:${entry.sha256}`),
    referenceDigests.map((entry) => `${entry.part}:${entry.sha256}`),
  );
  if (onlyLeft.length > 0)
    throw new Error(`Unpermitted payload difference: ${onlyLeft[0]}`);
  if (onlyRight.length > 0)
    throw new Error(`Payload over-strip: ${onlyRight[0]}`);
}

export interface IsobmffMetadataComparisonOptions {
  /** True exactly when the reference run invoked `-TagsFromFile` for at least one tag (D-27
   * entry (c)): ExifTool's own minimal-Exif rewrite always adds a `YCbCrPositioning` companion
   * in that case, which native's minimal Exif never writes. */
  readonly allowYCbCrPositioningCompanion: boolean;
  /** D-27 entry (e): the reference's own top-level `free`/`skip` boxes, already proven
   * byte-identical to the source's by `compareIsobmffFreeSkip`. ExifTool reports each kept box as
   * a `QuickTime:Free` / `QuickTime:Skip` tag (measured 62.1-05); exactly that many reference-only
   * reports of each are explained, never more and never native-only. Defaults to none. */
  readonly referenceFreeSkip?: readonly IsobmffFreeSkipBox[];
  /** Entry (f): the XMP-namespace entries ExifTool projects from the reference's own
   * auxiliary-item XMP payloads (`isobmffAuxiliaryItemXmpPayloads`). Reference-only XMP entries
   * are explained only as a sub-multiset of these, and only while native has no XMP entry the
   * reference lacks. Defaults to none. */
  readonly auxiliaryItemXmp?: readonly MetadataEntry[];
}

/** Pure: true when every entry of `subset` is matched by a distinct equal entry of `superset`. */
function isSubMultiset(
  subset: readonly MetadataEntry[],
  superset: readonly MetadataEntry[],
): boolean {
  return multisetDiffEntries(subset, superset).onlyLeft.length === 0;
}

const FREE_SKIP_REPORT_TAGS = { free: "Free", skip: "Skip" } as const;

/** Removes, from reference-only QuickTime entries, at most one `Free`/`Skip` report per
 * matching reference `free`/`skip` box (entry (e)); whatever is left stays unexplained. */
function withoutFreeSkipReports(
  onlyRight: readonly MetadataEntry[],
  referenceFreeSkip: readonly IsobmffFreeSkipBox[],
): readonly MetadataEntry[] {
  const budget = new Map<string, number>();
  for (const freeSkip of referenceFreeSkip) {
    const tag = FREE_SKIP_REPORT_TAGS[freeSkip.type];
    budget.set(tag, (budget.get(tag) ?? 0) + 1);
  }
  return onlyRight.filter((entry) => {
    const keys = Object.keys(entry);
    if (keys.length !== 1) return true;
    const remaining = budget.get(keys[0]!) ?? 0;
    if (remaining === 0) return true;
    budget.set(keys[0]!, remaining - 1);
    return false;
  });
}

/**
 * Pure (no ExifTool invocation): compares every metadata namespace ExifTool reports (via
 * `kit/oracles.ts`'s own group disposition) between a native output's projection and the
 * ExifTool `-all=` reference's projection, order-insensitively. The `ICC_Profile` namespace is
 * excluded -- ICC identity is compared exclusively by `compareIsobmffIccProfile`, via raw
 * profile digests, never by tag-level multiset. A native-only entry in any namespace is always
 * unpermitted (a leak); a reference-only entry is unpermitted unless it is the single
 * `YCbCrPositioning` EXIF tag explained by entry (c).
 */
export function compareIsobmffMetadataNamespaces(
  output: MetadataProjection,
  reference: MetadataProjection,
  options: IsobmffMetadataComparisonOptions,
): void {
  const namespaces = new Set([
    ...Object.keys(output.namespaces),
    ...Object.keys(reference.namespaces),
  ]);
  for (const namespace of namespaces) {
    if (namespace === "ICC_Profile") continue;
    const outputEntries = withoutLayoutDescriptors(
      namespace,
      output.namespaces[namespace] ?? [],
      reference.namespaces[namespace] ?? [],
    );
    const referenceEntries = withoutLayoutDescriptors(
      namespace,
      reference.namespaces[namespace] ?? [],
      output.namespaces[namespace] ?? [],
    );
    const { onlyLeft, onlyRight } = multisetDiffEntries(
      outputEntries,
      referenceEntries,
    );
    if (onlyLeft.length === 0 && onlyRight.length === 0) continue;
    if (onlyLeft.length > 0)
      throw new Error(`Unpermitted metadata difference: ${namespace}`);
    if (
      namespace === LAYOUT_DESCRIPTOR_NAMESPACE &&
      withoutFreeSkipReports(onlyRight, options.referenceFreeSkip ?? [])
        .length === 0
    ) {
      continue;
    }
    if (
      options.allowYCbCrPositioningCompanion &&
      namespace === "EXIF" &&
      onlyRight.every((entry) => {
        const keys = Object.keys(entry);
        return keys.length === 1 && keys[0] === "YCbCrPositioning";
      })
    ) {
      continue;
    }
    if (
      namespace === "XMP" &&
      isSubMultiset(onlyRight, options.auxiliaryItemXmp ?? [])
    ) {
      continue;
    }
    throw new Error(`Over-strip: ${namespace}`);
  }
}

export interface IsobmffIccComparisonInputs {
  readonly rawIccSha256?: string;
}

/**
 * Pure (no ExifTool invocation): compares ICC identity by raw profile digest alone (never by
 * tag-level multiset -- ExifTool's own `ICC_Profile`/`ICC-header` tags are excluded from
 * `compareIsobmffMetadataNamespaces` for exactly this reason). Equal digests (including both
 * absent) always pass. Entry (b) explains the one remaining admitted shape: `preserveColorProfile`
 * is false, native correctly stripped the profile (`output.rawIccSha256` undefined), and the
 * reference still carries the source's own unchanged profile (F-HEIC-ICC: ExifTool's
 * "ICC_Profile deleted" warning never removes the `colr` box's structural bytes). Anything else
 * -- including a mismatch while `preserveColorProfile` is true -- throws.
 */
export function compareIsobmffIccProfile(
  source: IsobmffIccComparisonInputs,
  output: IsobmffIccComparisonInputs,
  reference: IsobmffIccComparisonInputs,
  preserveColorProfile: boolean,
): void {
  if (output.rawIccSha256 === reference.rawIccSha256) return;
  if (
    !preserveColorProfile &&
    output.rawIccSha256 === undefined &&
    reference.rawIccSha256 !== undefined &&
    reference.rawIccSha256 === source.rawIccSha256
  ) {
    return;
  }
  throw new Error("Unpermitted metadata difference: ICC_Profile");
}

/**
 * Pure (no ExifTool invocation): order-insensitive multiset comparison of
 * `isobmffStructuralParts` output between a native output and the ExifTool `-all=` reference. A
 * native-only part is always unpermitted (over the reference, a leak or a structural property
 * ExifTool did not keep). A reference-only part is permitted only as `infe:Exif`, `infe:mime`
 * (entry (a)) or `free`/`skip` (entry (e), which also requires the separate byte-identity check
 * in `runIsobmffDifferential` against the source's own free/skip boxes) -- any other
 * reference-only part (a missing non-metadata item, a changed `irot`/`nclx`/other `ipco`
 * property) throws.
 */
export function compareIsobmffStructuralParts(
  outputParts: readonly string[],
  referenceParts: readonly string[],
): void {
  const { onlyLeft, onlyRight } = multisetDiffStrings(
    outputParts,
    referenceParts,
  );
  if (onlyLeft.length > 0)
    throw new Error(`Unpermitted structural difference: ${onlyLeft[0]}`);
  for (const part of onlyRight) {
    if (
      part === "infe:Exif" ||
      part === "infe:mime" ||
      part === "free" ||
      part === "skip"
    )
      continue;
    throw new Error(`Unpermitted structural difference: ${part}`);
  }
}

/**
 * Pure (no ExifTool invocation): entry (e)'s own byte-identity check. A reference carrying no
 * top-level `free`/`skip` boxes needs no explanation at all. Otherwise: native must hold none
 * (ExifTool-kept free/skip surviving natively would itself be a leak), and the reference's own
 * free/skip boxes must be an exact type+payload multiset match for the source's -- entry (e)
 * never compares box order (ExifTool relocates them before `mdat`), only presence and bytes.
 */
export function compareIsobmffFreeSkip(
  sourceFreeSkip: readonly IsobmffFreeSkipBox[],
  outputFreeSkip: readonly IsobmffFreeSkipBox[],
  referenceFreeSkip: readonly IsobmffFreeSkipBox[],
): void {
  if (referenceFreeSkip.length === 0) return;
  if (outputFreeSkip.length > 0)
    throw new Error(
      "Unpermitted structural difference: free/skip survived natively",
    );
  if (!sameFreeSkipMultiset(sourceFreeSkip, referenceFreeSkip))
    throw new Error("Stale permitted difference: exiftool-keeps-free-skip");
}

export interface IsobmffDifferentialOptions {
  readonly caseId: string;
  readonly profile: DifferentialProfile;
  readonly source: Buffer;
  readonly output: Buffer;
  readonly preserveOrientation: boolean;
  readonly preserveColorProfile: boolean;
  readonly preserveResolution: boolean;
  /** 62.1-09 (QUA-01 on the corpus): when supplied, the closed-list entries this case may use.
   * Every entry the comparison actually needed must be listed here, or the case throws
   * `Unlisted permitted difference: <id>`. Omitted (the 62.1-05 synthetic legs): the five D-27
   * entries apply; entry (f) applies only when explicitly listed. */
  readonly permittedDifferences?: readonly IsobmffPermittedDifferenceId[];
  /** 62.1-09 (maintainer decision 2026-10-03): exact ExifTool warning texts this one case admits
   * on the SOURCE projection only. Each listed text must actually be emitted by the source; any
   * other source warning, and every native or reference warning, still throws `Oracle warning is
   * not permitted`. Omitted: no warning is admitted. */
  readonly admittedSourceWarnings?: readonly string[];
}

/**
 * Pure: the oracle-warning rule. Native and reference warnings are never permitted; a source
 * warning is permitted only when its exact text is in `admittedSourceWarnings`, and every
 * admitted text must actually occur (a stale admission throws).
 */
export function assertIsobmffOracleWarnings(
  source: MetadataProjection,
  others: readonly MetadataProjection[],
  admittedSourceWarnings: readonly string[] = [],
): void {
  if (others.some((projection) => projection.warnings.length > 0))
    throw new Error("Oracle warning is not permitted");
  const admitted = new Set(admittedSourceWarnings);
  if (source.warnings.some((warning) => !admitted.has(warning)))
    throw new Error("Oracle warning is not permitted");
  const stale = admittedSourceWarnings.find(
    (warning) => !source.warnings.includes(warning),
  );
  if (stale !== undefined)
    throw new Error(`Stale admitted source warning: ${stale}`);
}

/** The closed-list entries one comparison actually needed, in closed-list order. */
export type IsobmffDifferentialUsage = readonly IsobmffPermittedDifferenceId[];

const PERMITTED_DIFFERENCE_ORDER: readonly IsobmffPermittedDifferenceId[] = [
  "exiftool-keeps-emptied-metadata-entries",
  "exiftool-keeps-icc-when-not-preserving",
  "exiftool-minimal-exif-ycbcr-positioning",
  "byte-layout-differs",
  "exiftool-keeps-free-skip",
  "exiftool-keeps-auxiliary-item-xmp",
];

const DEFAULT_PERMITTED_DIFFERENCES: readonly IsobmffPermittedDifferenceId[] =
  PERMITTED_DIFFERENCE_ORDER.filter(
    (id) => id !== "exiftool-keeps-auxiliary-item-xmp",
  );

function layoutDescriptorEntries(
  projection: MetadataProjection,
): readonly MetadataEntry[] {
  return (projection.namespaces[LAYOUT_DESCRIPTOR_NAMESPACE] ?? []).filter(
    isLayoutDescriptor,
  );
}

/**
 * Pure: which closed-list entries a comparison that already passed actually needed. (a) a
 * reference-only `infe:Exif`/`infe:mime` part; (b) differing raw ICC digests; (c) the EXIF
 * comparison fails without the `YCbCrPositioning` allowance; (d) the layout descriptors' values
 * differ; (e) the reference keeps top-level free/skip boxes; (f) the reference keeps XMP entries
 * native lacks (already proven a sub-multiset of the reference's auxiliary-item XMP), and a
 * reference-only `infe:mime` that is such a kept item is attributed to (f), not (a).
 */
function neededPermittedDifferences(inputs: {
  readonly outputMeta: MetadataProjection & IsobmffIccComparisonInputs;
  readonly referenceMeta: MetadataProjection & IsobmffIccComparisonInputs;
  readonly outputParts: readonly string[];
  readonly referenceParts: readonly string[];
  readonly referenceFreeSkip: readonly IsobmffFreeSkipBox[];
  readonly allowYCbCrPositioningCompanion: boolean;
  readonly outputAuxiliaryXmpItems: number;
  readonly referenceAuxiliaryXmpItems: number;
  readonly auxiliaryItemXmp: readonly MetadataEntry[];
}): IsobmffDifferentialUsage {
  const needed = new Set<IsobmffPermittedDifferenceId>();
  const { onlyRight } = multisetDiffStrings(
    inputs.outputParts,
    inputs.referenceParts,
  );
  // A reference-only `infe:mime` that is a kept auxiliary-item XMP item is entry (f)'s, not (a)'s.
  const keptAuxiliaryXmpItems = Math.max(
    0,
    inputs.referenceAuxiliaryXmpItems - inputs.outputAuxiliaryXmpItems,
  );
  const referenceOnlyMime = onlyRight.filter(
    (part) => part === "infe:mime",
  ).length;
  if (
    onlyRight.includes("infe:Exif") ||
    referenceOnlyMime > keptAuxiliaryXmpItems
  )
    needed.add("exiftool-keeps-emptied-metadata-entries");
  const xmp = multisetDiffEntries(
    inputs.outputMeta.namespaces.XMP ?? [],
    inputs.referenceMeta.namespaces.XMP ?? [],
  );
  if (xmp.onlyRight.length > 0) needed.add("exiftool-keeps-auxiliary-item-xmp");
  if (inputs.outputMeta.rawIccSha256 !== inputs.referenceMeta.rawIccSha256)
    needed.add("exiftool-keeps-icc-when-not-preserving");
  if (inputs.allowYCbCrPositioningCompanion) {
    try {
      compareIsobmffMetadataNamespaces(
        inputs.outputMeta,
        inputs.referenceMeta,
        {
          allowYCbCrPositioningCompanion: false,
          referenceFreeSkip: inputs.referenceFreeSkip,
          auxiliaryItemXmp: inputs.auxiliaryItemXmp,
        },
      );
    } catch {
      needed.add("exiftool-minimal-exif-ycbcr-positioning");
    }
  }
  const layout = multisetDiffEntries(
    layoutDescriptorEntries(inputs.outputMeta),
    layoutDescriptorEntries(inputs.referenceMeta),
  );
  if (layout.onlyLeft.length > 0 || layout.onlyRight.length > 0)
    needed.add("byte-layout-differs");
  if (inputs.referenceFreeSkip.length > 0)
    needed.add("exiftool-keeps-free-skip");
  return PERMITTED_DIFFERENCE_ORDER.filter((id) => needed.has(id));
}

/**
 * The live, ExifTool-driven differential (D-27): projects metadata for `source`/`output` and a
 * fresh `-all=` reference (requesting `-TagsFromFile` re-derivation of exactly the tags the
 * caller's preservation flags grant, mirroring what the app's own ExifTool-path preservation
 * would ask for), then runs every pure comparison above plus the free/skip byte-identity check.
 * Throws on the first unpermitted difference found; returns the closed-list entries the case
 * needed when every observed difference is explained by one of the five D-27 entries (62.1-09:
 * restricted to `permittedDifferences` when supplied).
 */
export function runIsobmffDifferential(
  options: IsobmffDifferentialOptions,
): IsobmffDifferentialUsage {
  validateInput(options.caseId, options.source);
  validateInput(options.caseId, options.output);

  const sourceMeta = projectMetadata(options.source, options.profile);
  const outputMeta = projectMetadata(options.output, options.profile);
  assertIsobmffOracleWarnings(
    sourceMeta,
    [outputMeta],
    options.admittedSourceWarnings,
  );

  const tagsFromFileArgs: string[] = [];
  if (options.preserveOrientation) tagsFromFileArgs.push("-Orientation");
  if (options.preserveResolution)
    tagsFromFileArgs.push("-XResolution", "-YResolution", "-ResolutionUnit");
  const referenceBytes =
    tagsFromFileArgs.length === 0
      ? runExiftoolReference(options.source, options.profile)
      : runExiftoolReference(options.source, options.profile, [
          "-TagsFromFile",
          "@",
          ...tagsFromFileArgs,
        ]);
  const referenceMeta = projectMetadata(referenceBytes, options.profile);
  if (referenceMeta.warnings.length > 0)
    throw new Error("Oracle warning is not permitted");
  compareAdmittedUnknownTags(sourceMeta, outputMeta, referenceMeta);

  const sourceFreeSkip = isobmffFreeSkipBoxes(options.source);
  const outputFreeSkip = isobmffFreeSkipBoxes(options.output);
  const referenceFreeSkip = isobmffFreeSkipBoxes(referenceBytes);
  compareIsobmffFreeSkip(sourceFreeSkip, outputFreeSkip, referenceFreeSkip);

  const referenceAuxiliaryXmp = isobmffAuxiliaryItemXmpPayloads(referenceBytes);
  const auxiliaryItemXmp = referenceAuxiliaryXmp.flatMap(
    (payload) =>
      projectMetadata(payload, {
        ...options.profile,
        extension: ".xmp",
        rawColorProfileSha256: () => undefined,
        admittedUnknownTags: [],
      }).namespaces.XMP ?? [],
  );
  compareIsobmffMetadataNamespaces(outputMeta, referenceMeta, {
    allowYCbCrPositioningCompanion: tagsFromFileArgs.length > 0,
    referenceFreeSkip,
    auxiliaryItemXmp,
  });
  compareIsobmffIccProfile(
    sourceMeta,
    outputMeta,
    referenceMeta,
    options.preserveColorProfile,
  );

  const outputParts = options.profile.structuralParts?.(options.output) ?? [];
  const referenceParts =
    options.profile.structuralParts?.(referenceBytes) ?? [];
  compareIsobmffStructuralParts(outputParts, referenceParts);
  compareIsobmffPayloadDigests(
    isobmffPayloadDigests(options.output),
    isobmffPayloadDigests(referenceBytes),
  );

  const used = neededPermittedDifferences({
    outputMeta,
    referenceMeta,
    outputParts,
    referenceParts,
    referenceFreeSkip,
    allowYCbCrPositioningCompanion: tagsFromFileArgs.length > 0,
    outputAuxiliaryXmpItems: isobmffAuxiliaryItemXmpPayloads(options.output)
      .length,
    referenceAuxiliaryXmpItems: referenceAuxiliaryXmp.length,
    auxiliaryItemXmp,
  });
  const listed = new Set(
    options.permittedDifferences ?? DEFAULT_PERMITTED_DIFFERENCES,
  );
  const unlisted = used.find((id) => !listed.has(id));
  if (unlisted !== undefined)
    throw new Error(`Unlisted permitted difference: ${unlisted}`);
  return used;
}
