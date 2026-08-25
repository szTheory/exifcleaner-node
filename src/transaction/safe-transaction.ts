import type { FileHandle } from "node:fs/promises";
import { executionError, isNodeErrorCode, jsonSafeCause } from "../errors.js";
import { err, ok } from "../result.js";
import type { MetadataError, Result, SanitizeOptions, SanitizeResult } from "../types.js";
import type { RegisteredHandler } from "../admission/registry.js";
import type { WebpAdmission, WebpOutputChunk } from "../admission/webp-handler.js";
import { DIRECT_FINAL_FLAGS, REOPEN_FLAGS, type FileOps } from "./file-ops.js";
import { identityMatches, identityOf, sourceSnapshotMatches, type SourceSnapshot } from "./identity.js";

function aborted(signal: AbortSignal | undefined): boolean { return signal?.aborted ?? false; }

export interface SafeTransactionInput {
  readonly sourceHandle: FileHandle;
  readonly sourceSnapshot: SourceSnapshot;
  readonly sourceMode: number;
  readonly handler: RegisteredHandler;
  readonly admission: WebpAdmission;
  readonly plan: readonly WebpOutputChunk[];
  readonly orientation: number | undefined;
  readonly options: SanitizeOptions;
  readonly fileOps: FileOps;
}

export async function runSafeTransaction(input: SafeTransactionInput): Promise<Result<SanitizeResult>> {
  const { sourceHandle, sourceSnapshot, sourceMode, handler, admission, plan, orientation, options, fileOps } = input;
  const { sourcePath, destinationPath, signal } = options;
  let destination: FileHandle | undefined;
  let owned: ReturnType<typeof identityOf> | undefined;
  let started = false;
  let failure: MetadataError | undefined;
  try {
    if (aborted(signal)) throw new DOMException("Aborted", "AbortError");
    try {
      destination = await fileOps.open(destinationPath, DIRECT_FINAL_FLAGS, sourceMode & 0o777);
    } catch (cause) {
      return err(executionError({ code: isNodeErrorCode(cause, "EEXIST") ? "destination-exists" : "write-failed", detail: isNodeErrorCode(cause, "EEXIST") ? "Destination already exists." : "Could not create the destination exclusively.", path: destinationPath, cause: jsonSafeCause(cause) }, "not-started"));
    }
    started = true;
    owned = identityOf(await fileOps.statHandle(destination));
    await handler.writeOutput(sourceHandle, destination, plan, signal);
    await fileOps.sync(destination);
    await fileOps.close(destination);
    destination = undefined;
    if (!identityMatches(owned, await fileOps.lstatPath(destinationPath))) {
      failure = executionError({ code: "destination-changed", detail: "Destination path no longer names the file created by this operation.", path: destinationPath }, "started");
      throw new Error("Destination changed.");
    }
    destination = await fileOps.open(destinationPath, REOPEN_FLAGS);
    const destinationStats = await fileOps.statHandle(destination);
    if (!identityMatches(owned, destinationStats) || !identityMatches(owned, await fileOps.lstatPath(destinationPath))) {
      failure = executionError({ code: "destination-changed", detail: "Destination path no longer names the file created by this operation.", path: destinationPath }, "started");
      throw new Error("Destination changed.");
    }
    const verified = await handler.verifyOutput(sourceHandle, admission.parsed, destination, destinationStats.size, destinationPath, options.preserveOrientation, options.preserveColorProfile, orientation, signal);
    if (!verified.ok) { failure = verified.error; throw new Error("Destination verification failed."); }
    await fileOps.close(destination);
    destination = undefined;
    if (!sourceSnapshotMatches(sourceSnapshot, await fileOps.statPath(sourcePath))) {
      failure = executionError({ code: "source-changed", detail: "Source changed during sanitization; output was discarded.", path: sourcePath }, "started");
      throw new Error("Source changed.");
    }
    if (options.preserveTimestamps) await fileOps.utimes(destinationPath, sourceSnapshot.atime, sourceSnapshot.mtime);
    if (!identityMatches(owned, await fileOps.lstatPath(destinationPath))) {
      failure = executionError({ code: "destination-changed", detail: "Destination path was replaced before sanitization completed.", path: destinationPath }, "started");
      throw new Error("Destination changed.");
    }
    await fileOps.close(sourceHandle);
    const namespaces = new Set(admission.parsed.chunks.flatMap((chunk) => chunk.fourCc === "EXIF" ? ["EXIF" as const] : chunk.fourCc === "XMP " ? ["XMP" as const] : chunk.fourCc === "ICCP" ? ["ICC" as const] : []));
    return ok({ format: handler.capability.format, destinationPath, removedNamespaces: [ ...(namespaces.has("EXIF") && !(options.preserveOrientation && orientation !== undefined) ? ["EXIF" as const] : []), ...(namespaces.has("XMP") ? ["XMP" as const] : []), ...(namespaces.has("ICC") && !options.preserveColorProfile ? ["ICC" as const] : []) ], preserved: { orientation: options.preserveOrientation && orientation !== undefined, colorProfile: options.preserveColorProfile && namespaces.has("ICC"), timestamps: options.preserveTimestamps }, warnings: admission.warnings });
  } catch (cause) {
    failure ??= executionError({ code: aborted(signal) ? "aborted" : "write-failed", detail: aborted(signal) ? "The operation was aborted." : "Could not complete the sanitized destination.", path: destinationPath, cause: jsonSafeCause(cause) }, started ? "started" : "not-started");
  } finally {
    if (destination !== undefined) await fileOps.close(destination).catch(() => undefined);
    await fileOps.close(sourceHandle).catch(() => undefined);
  }
  if (started && owned !== undefined) {
    try {
      if (identityMatches(owned, await fileOps.lstatPath(destinationPath))) await fileOps.remove(destinationPath);
    } catch { /* Root failure remains authoritative; cleanup is bounded. */ }
  }
  return err(failure!);
}
