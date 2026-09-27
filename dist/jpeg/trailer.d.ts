import type { MetadataEntry } from "../types.js";
import type { JpegRefusal } from "./markers.js";
export type JpegTrailerClass = "mpf" | "mpf-index-invalid" | "google-motion-photo" | "gain-map" | "samsung-trailer" | "plain-trailer";
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
/**
 * Classifies a JPEG's trailer/MPF/motion-photo shape into the closed
 * `JpegTrailerClass` set (D-12/D-13). Every input is derived from bytes
 * `parseJpeg` already located; this function performs no I/O.
 */
export declare function classifyTrailerClasses(input: ClassifyTrailerClassesInput): ReadonlySet<JpegTrailerClass>;
export declare const JPEG_REFUSED_TRAILER_CLASSES: ReadonlySet<JpegTrailerClass>;
/**
 * Returns the `JpegRefusal` literal for the first refused class present in
 * `classes`, or `undefined` if none is refused. Every refused class (`mpf`,
 * `gain-map`) maps to the same `mpf-secondary-image` literal --
 * `motion-photo-trailer` is not added to `JpegRefusal` since no measured
 * class currently maps to it (google-motion-photo and samsung-trailer both
 * promote).
 */
export declare function trailerRefusal(classes: ReadonlySet<JpegTrailerClass>): JpegRefusal | undefined;
//# sourceMappingURL=trailer.d.ts.map