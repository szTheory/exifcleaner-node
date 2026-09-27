// JPEG trailer classification and the D-13 measured refusal switch. Classifies
// what is present after a JPEG's primary EOI (or referenced by its XMP/APP2 MPF
// segments) into a closed set of classes, then declines only the classes
// 57-EVIDENCE.md measured unsafe -- never by assumption (D-13).

import type { MetadataEntry } from "../types.js";
import type { JpegRefusal } from "./markers.js";

export type JpegTrailerClass =
  | "mpf"
  | "mpf-index-invalid"
  | "google-motion-photo"
  | "gain-map"
  | "samsung-trailer"
  | "plain-trailer";

export interface ClassifyTrailerClassesInput {
  /** The raw APP2 MPF payload (identifier `"MPF\0"` prefix included, as
   * buffered by `parseJpeg`), if the file carries one. */
  readonly mpfPayload: Buffer | undefined;
  /** The parsed entries of the file's standard XMP packet, if any. */
  readonly xmpEntries: readonly MetadataEntry[];
  /** The bytes from the primary EOI to end of file. */
  readonly trailerTail: Buffer;
  /** The trailer byte count (`size - primaryEoiEnd`). */
  readonly trailerBytes: number;
  readonly fileSize: number;
}

// -- APP2 MPF classification (CIPA DC-007) -----------------------------------

const MPF_IDENTIFIER_BYTES = 4; // "MPF\0"
const MPF_IFD_ENTRY_BYTES = 12;
const MPF_ENTRY_BYTES = 16;
const MPF_TAG_NUMBER_OF_IMAGES = 0xb001;
const MPF_TAG_MP_ENTRY = 0xb002;

function classifyMpfPayload(
  mpfPayload: Buffer,
  fileSize: number,
): "mpf" | "mpf-index-invalid" {
  const invalid = "mpf-index-invalid" as const;
  if (mpfPayload.length < MPF_IDENTIFIER_BYTES + 8) return invalid;
  const header = mpfPayload.subarray(MPF_IDENTIFIER_BYTES);

  const byteOrder = header.toString("ascii", 0, 2);
  const little = byteOrder === "II";
  const big = byteOrder === "MM";
  if (!little && !big) return invalid;
  const readU16 = (offset: number): number =>
    little ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);

  if (header.length < 8) return invalid;
  if (readU16(2) !== 42) return invalid;

  const ifdOffset = readU32(4);
  // Bound the IFD entry count against the payload actually present before
  // ever reading a single entry (D-12/D-13: "index count bounded by the
  // actual payload before iterating").
  if (ifdOffset + 2 > header.length) return invalid;
  const entryCount = readU16(ifdOffset);
  const entriesStart = ifdOffset + 2;
  const maxIfdEntriesByPayload = Math.floor(
    (header.length - entriesStart) / MPF_IFD_ENTRY_BYTES,
  );
  if (entryCount === 0 || entryCount > maxIfdEntriesByPayload) return invalid;

  let numberOfImages: number | undefined;
  let mpEntryOffset: number | undefined;
  let mpEntryDeclaredBytes: number | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesStart + index * MPF_IFD_ENTRY_BYTES;
    if (entryOffset + MPF_IFD_ENTRY_BYTES > header.length) return invalid;
    const tag = readU16(entryOffset);
    if (tag === MPF_TAG_NUMBER_OF_IMAGES) {
      numberOfImages = readU32(entryOffset + 8);
    } else if (tag === MPF_TAG_MP_ENTRY) {
      mpEntryDeclaredBytes = readU32(entryOffset + 4);
      mpEntryOffset = readU32(entryOffset + 8);
    }
  }
  if (numberOfImages === undefined || numberOfImages < 2) return invalid;
  if (mpEntryOffset === undefined || mpEntryDeclaredBytes === undefined) {
    return invalid;
  }

  const declaredEntries = Math.floor(mpEntryDeclaredBytes / MPF_ENTRY_BYTES);
  if (declaredEntries < numberOfImages) return invalid;
  if (mpEntryOffset + declaredEntries * MPF_ENTRY_BYTES > header.length) {
    return invalid;
  }

  // Every secondary entry's data offset+size must land within the file (a
  // relative-to-header offset can never legitimately exceed the whole file's
  // size). Index 0 is the primary image (dataOffset 0 by CIPA DC-007
  // convention) and is not checked here.
  for (let index = 1; index < declaredEntries; index += 1) {
    const entryBase = mpEntryOffset + index * MPF_ENTRY_BYTES;
    const size = readU32(entryBase + 4);
    const dataOffset = readU32(entryBase + 8);
    if (dataOffset + size > fileSize) return invalid;
  }

  return "mpf";
}

// -- XMP-based classification (Google Motion Photo, Adobe gain-map) ---------

function hasEntry(entries: readonly MetadataEntry[], name: string): boolean {
  return entries.some((entry) => entry.name === name);
}

// -- Samsung SEFH/SEFT trailer classification --------------------------------

const SEFT_TAIL_BYTES = 8;
const SEFT_MAGIC = "SEFT";

function isSamsungSeftTail(trailerTail: Buffer): boolean {
  if (trailerTail.length < SEFT_TAIL_BYTES) return false;
  const magicStart = trailerTail.length - SEFT_TAIL_BYTES;
  return (
    trailerTail.subarray(magicStart, magicStart + 4).toString("ascii") ===
    SEFT_MAGIC
  );
}

/**
 * Classifies a JPEG's trailer/MPF/motion-photo shape into the closed
 * `JpegTrailerClass` set (D-12/D-13). Every input is derived from bytes
 * `parseJpeg` already located; this function performs no I/O.
 */
export function classifyTrailerClasses(
  input: ClassifyTrailerClassesInput,
): ReadonlySet<JpegTrailerClass> {
  const classes = new Set<JpegTrailerClass>();

  if (input.trailerBytes > 0) classes.add("plain-trailer");

  if (input.mpfPayload !== undefined) {
    classes.add(classifyMpfPayload(input.mpfPayload, input.fileSize));
  }

  // 57-11 (D-13 native half, measured 2026-09-27): an XMP tag NAMING a
  // motion-photo/gain-map container is only a residue risk when the file
  // also carries actual secondary bytes to leak (an appended trailer or an
  // MPF payload) -- classifying purely on the XMP tag's presence refused the
  // REAL Google.jpg fixture (hdrgm:Version XMP, zero trailer bytes, no MPF
  // segment: nothing for a secondary image to leak from) even though 57-01
  // measured its ExifTool half as a clean `promote` with no secondary bytes
  // in the output. Every constructed class fixture that actually carries
  // secondary bytes (buildGainmapMpfHdrgm, buildGoogleMotionPhotoShape) still
  // appends a real trailer, so this added condition does not change their
  // classification.
  const hasSecondaryBytes =
    input.trailerBytes > 0 || input.mpfPayload !== undefined;
  if (hasEntry(input.xmpEntries, "GCamera:MotionPhoto") && hasSecondaryBytes) {
    classes.add("google-motion-photo");
  }
  if (hasEntry(input.xmpEntries, "hdrgm:Version") && hasSecondaryBytes) {
    classes.add("gain-map");
  }

  if (isSamsungSeftTail(input.trailerTail)) {
    classes.add("samsung-trailer");
  }

  return classes;
}

// -- D-13 measured refusal switch --------------------------------------------

// 57-EVIDENCE.md "Full MPF/motion/trailer decision table" (measured
// 2026-09-27), applying the D-13 rule mechanically to each row's verdict:
//   - mpf (cipa-mpf-two-images.jpg): refuse -- measured confound
//     (secondaryBytesInOutput true; 57-01-SUMMARY.md's diagnostic re-run shows
//     0/16 windows match the distinguishing marker, all matches land in
//     shared DQT/DHT/SOF0 table bytes -- recorded refuse per the D-13 rule
//     text mechanically, not by preference).
//   - gain-map (gainmap-mpf-hdrgm.jpg): refuse -- same measured confound.
//   - mpf-index-invalid (mpf-index-truncated.jpg, mpf-index-out-of-range.jpg):
//     promote -- ExifTool's `-all=` deletes the whole MPF segment before ever
//     parsing its IFD, so a malformed index produces a clean output with no
//     warning (measured, not assumed).
//   - google-motion-photo (google-motion-photo-shape.jpg): promote -- clean
//     measurement, no shared bytes with the primary. (57-11: the REAL
//     Google.jpg fixture does not actually classify google-motion-photo --
//     its XMP carries hdrgm:Version, not GCamera:MotionPhoto -- see below.)
//   - gain-map, real Google.jpg (hdrgm:Version XMP, zero trailer bytes, no
//     MPF segment): classifies as an EMPTY set, not gain-map -- 57-11
//     measured that classifyTrailerClasses's added hasSecondaryBytes
//     condition (an XMP tag alone, with nothing appended or MPF-referenced,
//     is not itself a leak risk) correctly promotes this file, matching
//     57-01's ExifTool-half `promote` measurement. This is why the
//     evidence table's own "gain-map (Google.jpg)" row and the constructed
//     "gain-map (gainmap-mpf-hdrgm.jpg)" row diverge: only the latter
//     carries real secondary bytes.
//   - samsung-trailer (samsung-sefh-seft-trailer.jpg): promote.
//   - plain-trailer: never refused (D-11 -- `-all=` truncates any trailer at
//     the primary EOI regardless of content).
export const JPEG_REFUSED_TRAILER_CLASSES: ReadonlySet<JpegTrailerClass> =
  Object.freeze(new Set<JpegTrailerClass>(["mpf", "gain-map"]));

/**
 * Returns the `JpegRefusal` literal for the first refused class present in
 * `classes`, or `undefined` if none is refused. Every refused class (`mpf`,
 * `gain-map`) maps to the same `mpf-secondary-image` literal --
 * `motion-photo-trailer` is not added to `JpegRefusal` since no measured
 * class currently maps to it (google-motion-photo and samsung-trailer both
 * promote).
 */
export function trailerRefusal(
  classes: ReadonlySet<JpegTrailerClass>,
): JpegRefusal | undefined {
  for (const cls of classes) {
    if (JPEG_REFUSED_TRAILER_CLASSES.has(cls)) {
      return "mpf-secondary-image";
    }
  }
  return undefined;
}
