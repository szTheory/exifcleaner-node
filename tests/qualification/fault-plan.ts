import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import type { FileOps } from "../../src/transaction/file-ops.js";

export const LOGICAL_OPERATIONS = [
  "stage-directory-create",
  "stage-directory-verify",
  "stage-open",
  "stage-write",
  "stage-sync",
  "stage-close",
  "stage-reopen",
  "output-verification",
  "source-recheck",
  "timestamps",
  "destination-directory-open",
  "publication",
  "stage-disposition",
] as const;

export type LogicalOperation = (typeof LOGICAL_OPERATIONS)[number];
export type SyntheticError = "EIO" | "ENOSPC" | "EPERM";

export interface FaultPlan {
  readonly operation: LogicalOperation;
  readonly occurrence: number;
  readonly error: SyntheticError;
}

interface FaultEvidence {
  readonly injected: number;
  readonly writerAttempts: number;
  readonly publicationAttempts: number;
  readonly openHandles: number;
  readonly occurrences: Readonly<Record<string, number>>;
}

interface FaultController {
  readonly fileOps: FileOps;
  readonly hit: (operation: LogicalOperation) => void;
  readonly wrapHandler: (handler: RegisteredHandler) => RegisteredHandler;
  readonly beforePublish: () => void;
  readonly evidence: () => FaultEvidence;
}

function validatePlan(plan: FaultPlan | undefined): void {
  if (plan === undefined) return;
  if (
    !LOGICAL_OPERATIONS.includes(plan.operation) ||
    !Number.isSafeInteger(plan.occurrence) ||
    plan.occurrence <= 0 ||
    !new Set<SyntheticError>(["EIO", "ENOSPC", "EPERM"]).has(plan.error)
  )
    throw new Error("Invalid fault plan");
}

function isStageDirectory(path: string): boolean {
  return path.includes(".exifcleaner-stage-") && !path.endsWith("output.webp");
}

function isStageFile(path: string): boolean {
  return path.includes(".exifcleaner-stage-") && path.endsWith("output.webp");
}

export function applyFaultPlan(
  base: FileOps,
  plan?: FaultPlan,
): FaultController {
  validatePlan(plan);
  const occurrences = new Map<LogicalOperation, number>();
  const handles = new Map<number, string>();
  let injected = 0;
  let writerAttempts = 0;
  let publicationAttempts = 0;

  const hit = (operation: LogicalOperation): void => {
    const occurrence = (occurrences.get(operation) ?? 0) + 1;
    occurrences.set(operation, occurrence);
    if (
      plan?.operation === operation &&
      plan.occurrence === occurrence &&
      injected === 0
    ) {
      injected += 1;
      throw Object.assign(
        new Error(`Synthetic ${plan.error} at ${operation}`),
        {
          code: plan.error,
        },
      );
    }
  };

  const fileOps: FileOps = {
    createDirectory: async (path, mode) => {
      hit("stage-directory-create");
      await base.createDirectory(path, mode);
    },
    open: async (path, flags, mode) => {
      if (isStageFile(path)) {
        if ((flags & fsConstants.O_EXCL) !== 0) {
          writerAttempts += 1;
          hit("stage-open");
        } else hit("stage-reopen");
      } else if (
        !isStageDirectory(path) &&
        (flags & fsConstants.O_DIRECTORY) !== 0
      )
        hit("destination-directory-open");
      const handle = await base.open(path, flags, mode);
      handles.set(handle.fd, path);
      return handle;
    },
    statPath: async (path) => {
      if (!isStageDirectory(path)) hit("source-recheck");
      return base.statPath(path);
    },
    statHandle: async (handle) => {
      const path = handles.get(handle.fd);
      if (path !== undefined && isStageDirectory(path))
        hit("stage-directory-verify");
      return base.statHandle(handle);
    },
    sync: async (handle) => {
      if (isStageFile(handles.get(handle.fd) ?? "")) hit("stage-sync");
      await base.sync(handle);
    },
    close: async (handle) => {
      const descriptor = handle.fd;
      const path = handles.get(descriptor);
      if (path !== undefined && isStageFile(path)) hit("stage-close");
      await base.close(handle);
      handles.delete(descriptor);
    },
    utimes: async (handle, atime, mtime) => {
      hit("timestamps");
      await base.utimes(handle, atime, mtime);
    },
  };

  return {
    fileOps,
    hit,
    wrapHandler(handler) {
      return {
        ...handler,
        writeOutput: async (...args) => {
          hit("stage-write");
          return handler.writeOutput(...args);
        },
        verifyOutput: async (...args) => {
          hit("output-verification");
          return handler.verifyOutput(...args);
        },
      };
    },
    beforePublish() {
      if (plan?.operation === "publication") {
        publicationAttempts += 1;
        hit("publication");
      }
    },
    evidence() {
      return {
        injected,
        writerAttempts,
        publicationAttempts,
        openHandles: handles.size,
        occurrences: Object.fromEntries(occurrences),
      };
    },
  };
}

export class NamedBarrier {
  readonly name: string;
  #reached = false;
  #released = false;
  #resolveReached!: () => void;
  #resolveRelease!: () => void;
  #reachedPromise: Promise<void>;
  #releasePromise: Promise<void>;

  constructor(name: string) {
    if (!/^[a-z][a-z-]+$/.test(name)) throw new Error("Invalid barrier name");
    this.name = name;
    this.#reachedPromise = new Promise((resolve) => {
      this.#resolveReached = resolve;
    });
    this.#releasePromise = new Promise((resolve) => {
      this.#resolveRelease = resolve;
    });
  }

  async pause(): Promise<void> {
    if (this.#reached) throw new Error(`Barrier reached twice: ${this.name}`);
    this.#reached = true;
    this.#resolveReached();
    await this.#releasePromise;
  }

  waitUntilReached(): Promise<void> {
    return this.#reachedPromise;
  }

  release(): void {
    if (!this.#reached || this.#released)
      throw new Error(`Barrier release is invalid: ${this.name}`);
    this.#released = true;
    this.#resolveRelease();
  }
}
