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
     * Fail-closed placeholder (until 57-06 lands): set when the plan was built
     * with preserveResolution true and the source carries an EXIF IFD0
     * resolution -- JPEG resolution synthesis is not yet admitted, so
     * checkOutputPlan declines before any write.
     */
    readonly declineReason?: string;
}
export declare const jpegHandler: FormatHandler<JpegAdmission, JpegOutputPlan>;
//# sourceMappingURL=jpeg-handler.d.ts.map