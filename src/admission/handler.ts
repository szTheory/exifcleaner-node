import type { FileHandle } from "node:fs/promises";
import type { parseExif } from "../metadata/exif.js";
import type {
  FormatCapabilities,
  Inspection,
  MetadataEntry,
  MetadataErrorDetails,
  MetadataWarning,
  Result,
} from "../types.js";

/** The orientation admission state a source's EXIF (or equivalent) yielded. */
export type OrientationState = ReturnType<typeof parseExif>["orientation"];

/**
 * The format-neutral admission surface every registered handler must produce.
 * A concrete handler's own admission type extends this with format-specific
 * fields (e.g. WebP's parsed RIFF tree); the shared transaction and engine
 * only ever see this base shape.
 */
export interface FormatAdmission {
  readonly entries: readonly MetadataEntry[];
  readonly warnings: readonly MetadataWarning[];
  readonly orientation: OrientationState;
  /** The buffered ICC payload used for preservation admission, if present. */
  readonly colorProfile: Buffer | undefined;
  /** Metadata namespaces present in the source container. */
  readonly namespaces: readonly ("EXIF" | "XMP" | "ICC")[];
}

// Omit does not distribute over a union on its own -- Pick's keyof over a
// union collapses to the common keys, which would silently drop every
// discriminant-specific field. This distributes explicitly so each member of
// MetadataErrorDetails loses only `path`, keeping the rest of its shape.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** admissionDecline's error parameter, minus the `path` the caller supplies. */
export type AdmissionDeclineDetail = DistributiveOmit<
  MetadataErrorDetails,
  "path"
>;

/**
 * The declared contract every native format handler implements. Method
 * syntax (rather than arrow-function properties) is required here: it makes
 * a concrete `FormatHandler<SpecificAdmission, SpecificPlan>` assignable to
 * `RegisteredHandler` via TypeScript's bivariant method-parameter checking,
 * which is what lets a heterogeneous registry hold handlers with different
 * Admission/Plan types behind one array element type.
 */
export interface FormatHandler<Admission extends FormatAdmission, Plan> {
  readonly capability: FormatCapabilities;
  /** `output` plus the primary extension, e.g. `"output.webp"`. */
  readonly stagingFileName: string;
  matches(magic: Buffer): boolean;
  admit(
    handle: FileHandle,
    size: number,
    signal?: AbortSignal,
  ): Promise<Admission>;
  inspect(admission: Admission): Inspection;
  buildOutputPlan(
    admission: Admission,
    preserveOrientation: boolean,
    preserveColorProfile: boolean,
    orientation: number | undefined,
  ): Plan;
  /** Returns the decline detail when the plan cannot be written, else undefined. */
  checkOutputPlan(plan: Plan): string | undefined;
  writeOutput(
    source: FileHandle,
    destination: FileHandle,
    plan: Plan,
    signal?: AbortSignal,
  ): Promise<void>;
  verifyOutput(
    sourceHandle: FileHandle,
    admission: Admission,
    destinationHandle: FileHandle,
    destinationSize: number,
    destinationPath: string,
    preserveOrientation: boolean,
    preserveColorProfile: boolean,
    expectedOrientation: number | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void>>;
  classifyAdmissionFailure(
    cause: unknown,
    preserveColorProfile: boolean,
  ): AdmissionDeclineDetail | undefined;
}

/** The widened, heterogeneous-registry-safe form every registered handler is stored as. */
export type RegisteredHandler = FormatHandler<FormatAdmission, unknown>;
