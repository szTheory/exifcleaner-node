import type { FileHandle } from "node:fs/promises";
import { admitIsobmff, type IsobmffAdmission } from "../isobmff/admission.js";
import { classifyIsobmffBrand } from "../isobmff/brand.js";
import { classifyIsobmffAdmissionFailure } from "../isobmff/errors.js";
import {
  buildIsobmffOutputPlan,
  checkIsobmffOutputPlan,
  type IsobmffOutputPlan,
} from "../isobmff/plan.js";
import { verifyIsobmffOutput } from "../isobmff/verify.js";
import { writeIsobmffOutput } from "../isobmff/writer.js";
import type {
  AdmissionDeclineDetail,
  FormatHandler,
} from "./handler.js";
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
      return admitIsobmff(handle, size, signal);
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

    classifyAdmissionFailure(cause: unknown): AdmissionDeclineDetail | undefined {
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
