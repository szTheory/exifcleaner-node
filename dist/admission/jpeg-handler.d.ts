import { type MinimalExifResolution } from "../metadata/exif.js";
import type { FormatAdmission, FormatHandler } from "./handler.js";
import { type ParsedJpeg } from "../jpeg/parser.js";
import { type JpegTrailerClass } from "../jpeg/trailer.js";
export type JpegSegmentClass = "structural" | "keep" | "conditional-color" | "conditional-resolution" | "remove";
export interface JpegAdmission extends FormatAdmission {
    readonly parsed: ParsedJpeg;
    /** One classification per entry in `parsed.segments`, same index order. */
    readonly classes: readonly JpegSegmentClass[];
    /** The `parsed.segments` index of the source's (first) Exif segment. */
    readonly exifSlot: number | undefined;
    /** D-06: true when an APP0 JFIF segment was removed unconditionally because
     * an APP14 Adobe segment is also present, regardless of preserveResolution. */
    readonly jfifDroppedForAdobe: boolean;
    /** The source's raw (unreduced) IFD0 X/YResolution, if its Exif carries one. */
    readonly sourceResolution: MinimalExifResolution | undefined;
    /** D-01/JPG-01: true when a kept-candidate APP0 JFIF segment carries a
     * non-zero Xthumbnail/Ythumbnail -- such a JFIF is never kept byte-identical
     * (its thumbnail bytes never survive the grouped resolution copy-back), so
     * `checkOutputPlan` declines resolution preservation pre-write instead of
     * silently dropping the thumbnail. */
    readonly jfifHasThumbnail: boolean;
    readonly trailerClasses: ReadonlySet<JpegTrailerClass>;
}
export type JpegOutputPlanPart = {
    readonly kind: "copy";
    readonly sourceOffset: number;
    readonly length: number;
} | {
    readonly kind: "insert";
    readonly data: Buffer;
};
export interface JpegOutputPlan {
    readonly parts: readonly JpegOutputPlanPart[];
    readonly expectedMarkers: readonly number[];
    readonly copiedRanges: readonly {
        readonly sourceOffset: number;
        readonly length: number;
    }[];
    readonly preserveResolution: boolean;
    /**
     * D-01/JPG-01: set when the plan was built with preserveResolution true
     * and the source's kept-candidate JFIF carries a non-zero embedded
     * thumbnail -- such a JFIF can never be kept byte-identical, so
     * checkOutputPlan declines resolution preservation before any write,
     * falling back to the ExifTool route.
     */
    readonly declineReason?: string;
}
export declare const jpegHandler: FormatHandler<JpegAdmission, JpegOutputPlan>;
//# sourceMappingURL=jpeg-handler.d.ts.map