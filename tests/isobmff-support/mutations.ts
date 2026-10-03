// Byte-level mutations of a real HEIC/AVIF file that the QUA-01 differential must catch
// (62.1-REVIEW-INDEPENDENT WR-02, WR-03, IN-05). Each one changes exactly one property or
// entity-group field in place and keeps every box size, so the file stays structurally valid and
// only the comparison under test can tell it apart from the original.
//
// Never imports `src/isobmff/` (the engine under test) or the independent inventory walker: these
// helpers locate their target by its four-character box type alone.

/** The offset of the `occurrence`-th (1-based) four-character `marker` in `bytes`. */
function nthIndexOf(bytes: Buffer, marker: string, occurrence: number): number {
  let from = 0;
  for (let seen = 1; ; seen += 1) {
    const at = bytes.indexOf(Buffer.from(marker, "ascii"), from);
    if (at === -1)
      throw new Error(`mutation: no ${marker} occurrence ${occurrence}`);
    if (seen === occurrence) return at;
    from = at + 1;
  }
}

/**
 * Rewrites the `occurrence`-th `ispe` property's image width and height (WR-02). In
 * `heif-enc-grid.heic` the first `ispe` is the 128x128 grid primary's and the second is the
 * 64x64 tiles' own, which ExifTool's `-json` projection never reports.
 */
export function withIspeExtent(
  bytes: Buffer,
  occurrence: number,
  width: number,
  height: number,
): Buffer {
  const type = nthIndexOf(bytes, "ispe", occurrence);
  const mutated = Buffer.from(bytes);
  // size(4) type(4) version/flags(4) image_width(4) image_height(4); `type` is the type offset.
  mutated.writeUInt32BE(width, type + 8);
  mutated.writeUInt32BE(height, type + 12);
  return mutated;
}

/** Rewrites the first `colr` nclx property's colour primaries and transfer characteristics
 * (IN-05). */
export function withNclxColour(
  bytes: Buffer,
  colourPrimaries: number,
  transferCharacteristics: number,
): Buffer {
  const at = nthIndexOf(bytes, "colrnclx", 1);
  const mutated = Buffer.from(bytes);
  // `at` is the `colr` type offset; colour_type(4) follows it, then the nclx fields.
  mutated.writeUInt16BE(colourPrimaries, at + 8);
  mutated.writeUInt16BE(transferCharacteristics, at + 10);
  return mutated;
}

/**
 * Swaps the last two entity ids of the first `ster` entity group (WR-03): the left and right
 * views exchange places, the group keeps its length. ExifTool 13.59 reports the group only as an
 * unknown binary tag of that length.
 */
export function withSwappedSterEntities(bytes: Buffer): Buffer {
  const type = nthIndexOf(bytes, "ster", 1);
  const size = bytes.readUInt32BE(type - 4);
  const end = type - 4 + size;
  // ster: size(4) type(4) version/flags(4) group_id(4) num_entities(4) entity_id(4)*n.
  if (size < 28 || end > bytes.length || bytes.readUInt32BE(type + 12) < 2)
    throw new Error("mutation: ster group has fewer than two entities");
  const mutated = Buffer.from(bytes);
  bytes.copy(mutated, end - 8, end - 4, end);
  bytes.copy(mutated, end - 4, end - 8, end - 4);
  return mutated;
}
