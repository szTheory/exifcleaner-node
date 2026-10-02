import type { FileHandle } from "node:fs/promises";
import { admitIsobmff, type IsobmffAdmission } from "../isobmff/admission.js";
import { classifyIsobmffBrand } from "../isobmff/brand.js";
import {
  classifyIsobmffAdmissionFailure,
  IsobmffStructureError,
} from "../isobmff/errors.js";
import {
  buildIsobmffOutputPlan,
  checkIsobmffOutputPlan,
  type IsobmffOutputPlan,
} from "../isobmff/plan.js";
import { verifyIsobmffOutput } from "../isobmff/verify.js";
import { writeIsobmffOutput } from "../isobmff/writer.js";
import type { AdmissionDeclineDetail, FormatHandler } from "./handler.js";
import type { FormatCapabilities, Inspection, Result } from "../types.js";

// Engine-bound ISOBMFF handler factory (Phase 62, D-02 shape (c), settled 62-SPLIT open issue 1).
// `FormatHandler.capability` is typed `FormatCapabilities` (handler.ts:66), and the
// `NativeFormat`/`FormatCapabilities` union gains heic/avif members only in 62.1-07. A frozen
// production `heicHandler` constant here would need either a fabricated capability literal (a
// placeholder, forbidden by D-03) or a borrowed capability frozen into a production module (a
// latent misreport if it were ever registered). So production code is this factory, taking the
// capability as a parameter -- only tests supply a borrowed capability (test-handler.ts
// precedent); 62.1-07 passes the real D-05 literal to this same factory in its atomic
// registration commit. This module is never imported by `src/admission/registry.ts` in this
// plan (D-02/D-03): the handler it produces stays unregistered until 62.1.

export interface CreateIsobmffHandlerOptions {
  readonly brand: "heic" | "avif";
  readonly stagingFileName: string;
  readonly capability: FormatCapabilities;
}

/**
 * D-09(b): re-classifies the parsed `ftyp` brand set the SAME way `matches` does at selection
 * (`classifyIsobmffBrand`), but over `admitIsobmff`'s own already-parsed `model.majorBrand` /
 * `model.compatibleBrands` rather than a fresh magic-byte read -- catching a file swapped between
 * selection and admission (a TOCTOU race: `matches` saw one brand, the bytes `admitIsobmff`
 * actually parsed are a different file's). A synthetic minimal `ftyp` buffer is built from the
 * already-parsed strings (never re-reading the file) and handed to the SAME classifier `matches`
 * uses, so both checks share one brand-classification rule, never two divergent copies of it.
 */
function reclassifyParsedBrands(
  majorBrand: string,
  compatibleBrands: readonly string[],
): ReturnType<typeof classifyIsobmffBrand> {
  const size = 16 + compatibleBrands.length * 4;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(size, 0);
  bytes.write("ftyp", 4, 4, "ascii");
  bytes.write(majorBrand, 8, 4, "ascii");
  compatibleBrands.forEach((compatibleBrand, index) => {
    bytes.write(compatibleBrand, 16 + index * 4, 4, "ascii");
  });
  return classifyIsobmffBrand(bytes);
}

export function createIsobmffHandler(
  options: CreateIsobmffHandlerOptions,
): FormatHandler<IsobmffAdmission, IsobmffOutputPlan> {
  const { brand, stagingFileName, capability } = options;

  return Object.freeze({
    capability,
    stagingFileName,

    matches(magic: Buffer): boolean {
      return classifyIsobmffBrand(magic) === brand;
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<IsobmffAdmission> {
      const admission = await admitIsobmff(handle, size, signal);
      const reclassified = reclassifyParsedBrands(
        admission.model.majorBrand,
        admission.model.compatibleBrands,
      );
      if (reclassified !== brand) {
        throw new IsobmffStructureError(
          "brand-mismatch",
          `Parsed brand classification "${reclassified}" does not match this handler's own brand "${brand}" (D-09b).`,
        );
      }
      return admission;
    },

    inspect(admission: IsobmffAdmission): Inspection {
      return {
        format: capability.format,
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },

    buildOutputPlan: buildIsobmffOutputPlan,

    checkOutputPlan(plan: IsobmffOutputPlan): string | undefined {
      return checkIsobmffOutputPlan(plan);
    },

    classifyAdmissionFailure(
      cause: unknown,
    ): AdmissionDeclineDetail | undefined {
      return classifyIsobmffAdmissionFailure(cause);
    },

    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: IsobmffOutputPlan,
      signal?: AbortSignal,
    ): Promise<void> {
      return writeIsobmffOutput(source, destination, plan, signal);
    },

    async verifyOutput(
      sourceHandle: FileHandle,
      admission: IsobmffAdmission,
      destinationHandle: FileHandle,
      destinationSize: number,
      destinationPath: string,
      preserveOrientation: boolean,
      preserveColorProfile: boolean,
      preserveResolution: boolean,
      expectedOrientation: number | undefined,
      signal?: AbortSignal,
    ): Promise<Result<void>> {
      return verifyIsobmffOutput(
        sourceHandle,
        admission,
        destinationHandle,
        destinationSize,
        destinationPath,
        preserveOrientation,
        preserveColorProfile,
        preserveResolution,
        expectedOrientation,
        signal,
      );
    },
  });
}
