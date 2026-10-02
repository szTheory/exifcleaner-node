// Test-only ISOBMFF proof harness handler (D-16): the one handler both 61-10's "declines once,
// before any write" proof (success criterion 4) and its "recognized through the widened registry
// read" proof (success criterion 3) install through the existing private
// `setRegisteredHandlersForTests` seam (`src/admission/registry.ts`). It is never added to the
// real `HANDLERS` array and never shipped as production `heic-handler.ts`/`avif-handler.ts` (D-15).
//
// `matches` and `admit` are the real engine (`classifyIsobmffBrand`/`admitIsobmff`) -- a
// pure-classifier-only proof would not demonstrate the engine path the app actually observes. The
// five write-side methods (`inspect`, `buildOutputPlan`, `checkOutputPlan`, `writeOutput`,
// `verifyOutput`) are counting spies: every hostile-class run through `sanitizeFile` must decline
// at admission, strictly before `buildOutputPlan`/`checkOutputPlan`/`writeOutput`/`verifyOutput`
// are ever reached, so those four counters must stay at 0. `inspect` is exercised by the positive
// recognition proofs (`inspectFile`) and is counted too, for symmetry and so a future assertion
// can pin it if needed.
//
// This module is the one narrow, declared exception in `tests/isobmff_isolation.test.ts`'s
// `ISOLATION_RULES` allowed to import `src/isobmff/` directly -- it is the seam between the
// engine and test support, not an independent oracle like `builder.ts`/`inventory.ts`/`hostile.ts`,
// none of which may import it (see that file's `test-handler.ts` rule and the three updated
// `forbiddenSpecifierSubstrings` entries).
import type { FileHandle } from "node:fs/promises";
import type {
  AdmissionDeclineDetail,
  FormatAdmission,
} from "../../src/admission/handler.js";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import { registeredHandlersForTests } from "../../src/admission/registry.js";
import { createIsobmffHandler } from "../../src/admission/isobmff-handler.js";
import { admitIsobmff } from "../../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../../src/isobmff/brand.js";
import { classifyIsobmffAdmissionFailure } from "../../src/isobmff/errors.js";
import type { Inspection, Result } from "../../src/types.js";

export interface IsobmffTestHandlerCounters {
  admit: number;
  inspect: number;
  buildOutputPlan: number;
  checkOutputPlan: number;
  writeOutput: number;
  verifyOutput: number;
}

export interface IsobmffTestHandler {
  readonly handler: RegisteredHandler;
  readonly counters: IsobmffTestHandlerCounters;
}

/**
 * Builds one fresh test-only `RegisteredHandler` plus its own counters object. A fresh instance
 * per call (never a module-level singleton) so concurrent/sequential test cases never share
 * counter state.
 */
export function createIsobmffTestHandler(): IsobmffTestHandler {
  const counters: IsobmffTestHandlerCounters = {
    admit: 0,
    inspect: 0,
    buildOutputPlan: 0,
    checkOutputPlan: 0,
    writeOutput: 0,
    verifyOutput: 0,
  };

  // Borrow the real PNG handler's capability literal rather than fabricating one: `NativeFormat`
  // has no "heic"/"avif" value until Phase 62 registers real handlers, and this test harness must
  // not widen that public union. The borrowed capability is never mutated; only this handler's own
  // `stagingFileName` differs from PNG's.
  const pngHandler = registeredHandlersForTests().find(
    (candidate) => candidate.capability.format === "png",
  );
  if (pngHandler === undefined) {
    throw new Error(
      "createIsobmffTestHandler: no registered png handler to borrow a capability from",
    );
  }
  const capability = pngHandler.capability;

  function notReached(name: string): never {
    throw new Error(
      `isobmff test handler: ${name} must not run -- every hostile/declined fixture must be rejected at admission, before any write-side method runs`,
    );
  }

  const handler: RegisteredHandler = Object.freeze({
    capability,
    stagingFileName: ".isobmff-test-stage",

    matches(magic: Buffer): boolean {
      return classifyIsobmffBrand(magic) !== "decline";
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      counters.admit += 1;
      return admitIsobmff(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      counters.inspect += 1;
      return {
        format: capability.format,
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },

    buildOutputPlan(): unknown {
      counters.buildOutputPlan += 1;
      return notReached("buildOutputPlan");
    },

    checkOutputPlan(): string | undefined {
      counters.checkOutputPlan += 1;
      return notReached("checkOutputPlan");
    },

    async writeOutput(): Promise<void> {
      counters.writeOutput += 1;
      return notReached("writeOutput");
    },

    async verifyOutput(): Promise<Result<void>> {
      counters.verifyOutput += 1;
      return notReached("verifyOutput");
    },

    classifyAdmissionFailure(
      cause: unknown,
    ): AdmissionDeclineDetail | undefined {
      return classifyIsobmffAdmissionFailure(cause);
    },
  }) as RegisteredHandler;

  return { handler, counters };
}

/**
 * 62-02 (D-10): builds the one real engine-bound ISOBMFF writer handler (`createIsobmffHandler`,
 * `src/admission/isobmff-handler.ts`), borrowing the registered png capability the same way
 * `createIsobmffTestHandler` above does -- `NativeFormat` gains no "heic"/"avif" member until
 * 62.1-07, so this test harness must not widen that public union. The staging file name is D-10's
 * `output.heic` / `output.avif`.
 */
export function createIsobmffWriterHandlerForTests(
  brand: "heic" | "avif",
): RegisteredHandler {
  const pngHandler = registeredHandlersForTests().find(
    (candidate) => candidate.capability.format === "png",
  );
  if (pngHandler === undefined) {
    throw new Error(
      "createIsobmffWriterHandlerForTests: no registered png handler to borrow a capability from",
    );
  }
  return createIsobmffHandler({
    brand,
    stagingFileName: brand === "heic" ? "output.heic" : "output.avif",
    capability: pngHandler.capability,
  }) as RegisteredHandler;
}

/**
 * 62-05 (D-12): a counting wrapper around the REAL writer handler (never the admission-only
 * `createIsobmffTestHandler` stub, whose write-side methods all throw `notReached`). A `"plan"`
 * stage hostile fixture (currently: `offset-rewrite-overflow` only) admits cleanly through
 * `admitIsobmff` and must be declined one stage later, inside `checkOutputPlan` -- so
 * `buildOutputPlan`/`checkOutputPlan` must actually run their real logic, not a stub that assumes
 * every decline happens at admission. `writeOutput`/`verifyOutput` stay counted too, so a test can
 * still assert they are never reached.
 */
export function createIsobmffWriterCountingHandlerForTests(
  brand: "heic" | "avif",
): IsobmffTestHandler {
  const real = createIsobmffWriterHandlerForTests(brand);
  const counters: IsobmffTestHandlerCounters = {
    admit: 0,
    inspect: 0,
    buildOutputPlan: 0,
    checkOutputPlan: 0,
    writeOutput: 0,
    verifyOutput: 0,
  };

  const handler: RegisteredHandler = Object.freeze({
    capability: real.capability,
    stagingFileName: real.stagingFileName,

    matches(magic: Buffer): boolean {
      return real.matches(magic);
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      counters.admit += 1;
      return real.admit(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      counters.inspect += 1;
      return real.inspect(admission);
    },

    buildOutputPlan(
      admission: FormatAdmission,
      preserveOrientation: boolean,
      preserveColorProfile: boolean,
      preserveResolution: boolean,
      orientation: number | undefined,
    ): unknown {
      counters.buildOutputPlan += 1;
      return real.buildOutputPlan(
        admission,
        preserveOrientation,
        preserveColorProfile,
        preserveResolution,
        orientation,
      );
    },

    checkOutputPlan(plan: unknown): string | undefined {
      counters.checkOutputPlan += 1;
      return real.checkOutputPlan(plan as never);
    },

    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: unknown,
      signal?: AbortSignal,
    ): Promise<void> {
      counters.writeOutput += 1;
      return real.writeOutput(source, destination, plan as never, signal);
    },

    async verifyOutput(
      ...args: Parameters<RegisteredHandler["verifyOutput"]>
    ): Promise<Result<void>> {
      counters.verifyOutput += 1;
      return real.verifyOutput(...args);
    },

    classifyAdmissionFailure(
      cause: unknown,
      preserveColorProfile: boolean,
    ): AdmissionDeclineDetail | undefined {
      return real.classifyAdmissionFailure(cause, preserveColorProfile);
    },
  }) as RegisteredHandler;

  return { handler, counters };
}
