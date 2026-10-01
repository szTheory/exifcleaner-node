/** Compatible/major brands that select the HEIC item-file classifier (D-18, D6). */
export declare const HEIC_BRANDS: ReadonlySet<string>;
/** The compatible/major brand that selects the AVIF item-file classifier (D-18, D6). */
export declare const AVIF_BRAND = "avif";
/** Image-sequence brands: never classify as a still HEIC/AVIF item file (D-18, D6). */
export declare const SEQUENCE_BRANDS: ReadonlySet<string>;
export type IsobmffBrand = "heic" | "avif" | "decline";
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
export declare function classifyIsobmffBrand(bytes: Buffer): IsobmffBrand;
//# sourceMappingURL=brand.d.ts.map