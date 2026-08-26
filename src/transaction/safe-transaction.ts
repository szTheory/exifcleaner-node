import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  executionError,
  jsonSafeCause,
  withDestinationFinalization,
} from "../errors.js";
import { err, ok } from "../result.js";
import type {
  JsonSafeCause,
  MetadataError,
  PostCommitResidue,
  Result,
  SanitizeOptions,
  SanitizeResult,
} from "../types.js";
import type { RegisteredHandler } from "../admission/registry.js";
import type {
  WebpAdmission,
  WebpOutputChunk,
} from "../admission/webp-handler.js";
import {
  DIRECT_FINAL_FLAGS,
  REOPEN_FLAGS,
  STAGE_DIRECTORY_FLAGS,
  type FileOps,
} from "./file-ops.js";
import {
  identitiesDistinct,
  identityOf,
  sourcePathMatchesSnapshot,
  timestampsMatchAtMillisecondPrecision,
  type FileIdentity,
  type SourceSnapshot,
} from "./identity.js";
import {
  createPrivateStageDirectory,
  disposePrivateStageDirectory,
  publishNoReplace,
  type NativeStageDirectoryCapability,
} from "./native-publication.js";

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function stageResidue(cause: JsonSafeCause): PostCommitResidue {
  return {
    state: "private-empty-stage-directory-remains",
    cause,
  };
}

function isVerifiedPosixStageDirectory(stats: Stats): boolean {
  const euid = process.geteuid?.();
  return (
    stats.isDirectory() &&
    euid !== undefined &&
    stats.uid === euid &&
    (stats.mode & 0o077) === 0
  );
}

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
  /** Private test-only scheduling seam immediately before the one native call. */
  readonly beforePublish?: () => void | Promise<void>;
  /** Private test-only seam before bounded terminal-stage finalization. */
  readonly beforeStageFinalization?: (paths: {
    readonly stageDirectoryPath: string;
    readonly stagePath: string;
  }) => void | Promise<void>;
  /** Private platform seam for deterministic capability-finalization coverage. */
  readonly platform?: NodeJS.Platform;
}

export async function runSafeTransaction(
  input: SafeTransactionInput,
): Promise<Result<SanitizeResult>> {
  const {
    sourceHandle,
    sourceSnapshot,
    sourceMode,
    handler,
    admission,
    plan,
    orientation,
    options,
    fileOps,
    beforePublish,
    beforeStageFinalization,
    platform = process.platform,
  } = input;
  const { sourcePath, destinationPath, signal } = options;
  const stageDirectoryPath = join(
    dirname(destinationPath),
    `.exifcleaner-stage-${randomUUID()}`,
  );
  const stagePath = join(stageDirectoryPath, "output.webp");
  let stageDirectory: FileHandle | undefined;
  let stageFile: FileHandle | undefined;
  let directoryCreated = false;
  let directoryIdentity: FileIdentity | undefined;
  let directoryCapability: NativeStageDirectoryCapability | undefined;
  let fileCreated = false;
  let fileIdentity: FileIdentity | undefined;
  let failure: MetadataError | undefined;

  try {
    if (aborted(signal)) throw new DOMException("Aborted", "AbortError");
    await fileOps.createDirectory(stageDirectoryPath, 0o700);
    directoryCreated = true;
    stageDirectory = await fileOps.open(
      stageDirectoryPath,
      STAGE_DIRECTORY_FLAGS,
    );
    if (platform === "win32") {
      const capability = createPrivateStageDirectory();
      if (capability !== undefined) {
        directoryCapability = capability as NativeStageDirectoryCapability;
      }
    }
    const directoryStats = await fileOps.statHandle(stageDirectory);
    directoryIdentity = identityOf(directoryStats);
    if (
      directoryIdentity === undefined ||
      platform === "win32" ||
      !isVerifiedPosixStageDirectory(directoryStats)
    ) {
      failure = executionError(
        {
          code: "write-failed",
          detail:
            "Could not verify a private owner-controlled staging directory.",
          path: destinationPath,
        },
        "not-started",
      );
      throw new Error("Private stage verification failed.");
    }
    stageFile = await fileOps.open(
      stagePath,
      DIRECT_FINAL_FLAGS,
      sourceMode & 0o666,
    );
    fileCreated = true;
    fileIdentity = identityOf(await fileOps.statHandle(stageFile));
    if (
      fileIdentity === undefined ||
      !identitiesDistinct(
        { dev: sourceSnapshot.dev, ino: sourceSnapshot.ino },
        await fileOps.statHandle(stageFile),
      )
    ) {
      failure = executionError(
        {
          code: "write-failed",
          detail:
            "Could not prove that the staged output is distinct from source.",
          path: destinationPath,
        },
        "started",
      );
      throw new Error("Stage file identity unavailable or aliases source.");
    }
    await handler.writeOutput(sourceHandle, stageFile, plan, signal);
    await fileOps.sync(stageFile);
    await fileOps.close(stageFile);
    stageFile = await fileOps.open(stagePath, REOPEN_FLAGS);
    const stageStats = await fileOps.statHandle(stageFile);
    if (identityOf(stageStats) === undefined) {
      failure = executionError(
        {
          code: "write-failed",
          detail: "Could not reopen the staged output by its owned identity.",
          path: destinationPath,
        },
        "started",
      );
      throw new Error("Staged output identity unavailable.");
    }
    const verified = await handler.verifyOutput(
      sourceHandle,
      admission.parsed,
      stageFile,
      stageStats.size,
      destinationPath,
      options.preserveOrientation,
      options.preserveColorProfile,
      orientation,
      signal,
    );
    if (!verified.ok) {
      failure = verified.error;
      throw new Error("Staged output verification failed.");
    }
    if (
      !sourcePathMatchesSnapshot(
        sourceSnapshot,
        await fileOps.statPath(sourcePath),
      )
    ) {
      failure = executionError(
        {
          code: "source-changed",
          detail:
            "Source changed during sanitization; staged output was retained.",
          path: sourcePath,
        },
        "started",
      );
      throw new Error("Source changed.");
    }
    if (options.preserveTimestamps) {
      await fileOps.utimes(
        stageFile,
        sourceSnapshot.atime,
        sourceSnapshot.mtime,
      );
      if (
        !timestampsMatchAtMillisecondPrecision(
          sourceSnapshot,
          await fileOps.statHandle(stageFile),
        )
      ) {
        failure = executionError(
          {
            code: "write-failed",
            detail: "Could not verify requested staged-output timestamps.",
            path: destinationPath,
          },
          "started",
        );
        throw new Error("Staged timestamp proof failed.");
      }
    }
    await fileOps.sync(stageFile);
    await fileOps.close(stageFile);
    stageFile = undefined;
    await beforePublish?.();
    const publication = publishNoReplace(stagePath, destinationPath);
    if (publication.state !== "published") {
      failure = executionError(
        {
          code:
            publication.state === "destination-exists"
              ? "destination-exists"
              : "write-failed",
          detail:
            publication.state === "destination-exists"
              ? "Destination already exists."
              : "Native no-replace publication could not complete.",
          path: destinationPath,
        },
        "started",
      );
      throw new Error("Native publication did not succeed.");
    }
    await fileOps.close(stageDirectory);
    stageDirectory = undefined;
    await fileOps.close(sourceHandle);
    const namespaces = new Set(
      admission.parsed.chunks.flatMap((chunk) =>
        chunk.fourCc === "EXIF"
          ? ["EXIF" as const]
          : chunk.fourCc === "XMP "
            ? ["XMP" as const]
            : chunk.fourCc === "ICCP"
              ? ["ICC" as const]
              : [],
      ),
    );
    return ok({
      format: handler.capability.format,
      destinationPath,
      removedNamespaces: [
        ...(namespaces.has("EXIF") &&
        !(options.preserveOrientation && orientation !== undefined)
          ? ["EXIF" as const]
          : []),
        ...(namespaces.has("XMP") ? ["XMP" as const] : []),
        ...(namespaces.has("ICC") && !options.preserveColorProfile
          ? ["ICC" as const]
          : []),
      ],
      preserved: {
        orientation: options.preserveOrientation && orientation !== undefined,
        colorProfile: options.preserveColorProfile && namespaces.has("ICC"),
        timestamps: options.preserveTimestamps,
      },
      warnings: admission.warnings,
      postCommitResidue: stageResidue({
        code: "ENOTSUP",
        message: "identity-bound directory cleanup unavailable",
      }),
    });
  } catch (cause) {
    failure ??= executionError(
      {
        code: aborted(signal) ? "aborted" : "write-failed",
        detail: aborted(signal)
          ? "The operation was aborted."
          : "Could not complete the private staged destination.",
        path: destinationPath,
        cause: jsonSafeCause(cause),
      },
      fileCreated ? "started" : "not-started",
    );
  } finally {
    if (stageFile !== undefined)
      await fileOps.close(stageFile).catch(() => undefined);
    if (stageDirectory !== undefined)
      await fileOps.close(stageDirectory).catch(() => undefined);
    await fileOps.close(sourceHandle).catch(() => undefined);
  }
  await Promise.resolve(
    beforeStageFinalization?.({ stageDirectoryPath, stagePath }),
  ).catch(() => undefined);
  if (
    directoryCreated &&
    !fileCreated &&
    platform === "win32" &&
    directoryCapability !== undefined &&
    disposePrivateStageDirectory(directoryCapability).state === "disposed"
  ) {
    return err(
      withDestinationFinalization(failure!, { state: "owned-partial-removed" }),
    );
  }
  const residueCause = fileCreated
    ? {
        message:
          "Private staged file remains after terminal publication failure.",
      }
    : directoryCreated
      ? {
          message:
            "Private staging directory remains after terminal setup failure.",
        }
      : { message: "Private staging setup did not complete." };
  return err(
    withDestinationFinalization(failure!, {
      state: "owned-partial-remains",
      cause: residueCause,
    }),
  );
}
