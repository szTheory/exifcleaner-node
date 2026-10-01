// ISOBMFF/HEIF brand classifier (D-18, BMF-02). Classifies a file's `ftyp` major and compatible
// brands, read straight from the registry's widened 256-byte magic buffer (D-17) -- this module
// never reads past the bytes it is given, and fails closed (`"decline"`) on any truncated,
// malformed or ambiguous `ftyp`. It is deliberately standalone from `src/isobmff/boxes.ts`'s
// `parseBoxHeader`: that walker is built for the full structural parse (largesize, usertype,
// container recursion) that only runs once a handler has already been selected, while brand
// classification must run *before* selection, on a short, fixed-size, possibly-truncated buffer.
/** Compatible/major brands that select the HEIC item-file classifier (D-18, D6). */
export const HEIC_BRANDS = new Set([
    "heic",
    "heix",
    "heim",
    "heis",
]);
/** The compatible/major brand that selects the AVIF item-file classifier (D-18, D6). */
export const AVIF_BRAND = "avif";
/** Image-sequence brands: never classify as a still HEIC/AVIF item file (D-18, D6). */
export const SEQUENCE_BRANDS = new Set(["msf1", "avis"]);
const FTYP_HEADER_BYTES = 16; // size(32) type(32) major_brand(32) minor_version(32)
const BRAND_BYTES = 4;
/**
 * Classify a buffer's leading `ftyp` box by its major ∪ compatible brand set. Fails closed
 * (`"decline"`) rather than throwing: this runs on an admission-time magic buffer, not a
 * structurally-validated file, so every malformed shape below is an expected input, not a bug.
 *
 * Decline conditions (D-18):
 *  - fewer than 16 bytes given (not enough for `ftyp`'s fixed header);
 *  - bytes 4..8 are not the ASCII type `"ftyp"`;
 *  - the declared box size (bytes 0..4, big-endian uint32) is below 16;
 *  - `(declaredSize - 16)` is not a multiple of 4 (a partial trailing compatible brand);
 *  - the declared size extends past the bytes actually given;
 *  - the resolved brand set contains both an AVIF and a HEIC brand, contains neither, or
 *    contains any sequence brand (`msf1`/`avis`).
 */
export function classifyIsobmffBrand(bytes) {
    if (bytes.length < FTYP_HEADER_BYTES)
        return "decline";
    if (bytes.toString("ascii", 4, 8) !== "ftyp")
        return "decline";
    const declaredSize = bytes.readUInt32BE(0);
    if (declaredSize < FTYP_HEADER_BYTES)
        return "decline";
    const compatibleBytes = declaredSize - FTYP_HEADER_BYTES;
    if (compatibleBytes % BRAND_BYTES !== 0)
        return "decline";
    if (declaredSize > bytes.length)
        return "decline";
    const majorBrand = bytes.toString("ascii", 8, 12);
    const compatibleCount = compatibleBytes / BRAND_BYTES;
    const brands = new Set([majorBrand]);
    for (let index = 0; index < compatibleCount; index += 1) {
        const start = FTYP_HEADER_BYTES + index * BRAND_BYTES;
        brands.add(bytes.toString("ascii", start, start + BRAND_BYTES));
    }
    for (const brand of brands) {
        if (SEQUENCE_BRANDS.has(brand))
            return "decline";
    }
    let hasAvif = false;
    let hasHeic = false;
    for (const brand of brands) {
        if (brand === AVIF_BRAND)
            hasAvif = true;
        if (HEIC_BRANDS.has(brand))
            hasHeic = true;
    }
    if (hasAvif && hasHeic)
        return "decline";
    if (hasAvif)
        return "avif";
    if (hasHeic)
        return "heic";
    return "decline";
}
//# sourceMappingURL=brand.js.map