import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync, renameSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  webpHandler,
  webpOutputSize,
} from "../../src/admission/webp-handler.js";
import { classifyFallback } from "../../src/fallback.js";
import { NODE_FILE_OPS, type FileOps } from "../../src/transaction/file-ops.js";
import { snapshotSource } from "../../src/transaction/identity.js";
import { setNativePublicationBindingForTests } from "../../src/transaction/native-publication.js";
import { runSafeTransaction } from "../../src/transaction/safe-transaction.js";
import { encodeChunkHeader, encodeRiffHeader } from "../../src/webp/riff.js";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import type {
  WebpAdmission,
  WebpOutputChunk,
} from "../../src/admission/webp-handler.js";
import { metadataWebp } from "../fixtures.js";
import {
  LOGICAL_OPERATIONS,
  NamedBarrier,
  applyFaultPlan,
  type LogicalOperation,
} from "./fault-plan.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface TransactionFixture {
  readonly directory: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceBytes: Buffer;
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly sourceSnapshot: ReturnType<typeof snapshotSource>;
  readonly sourceMode: number;
  readonly admission: WebpAdmission;
  readonly plan: readonly WebpOutputChunk[];
}

async function fixture(): Promise<TransactionFixture> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-qtx-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "destination.webp");
  const sourceBytes = metadataWebp();
  await writeFile(sourcePath, sourceBytes);
  const source = await open(sourcePath, fsConstants.O_RDONLY);
  const stats = await source.stat();
  const admission = await webpHandler.admit(source, stats.size);
  return {
    directory,
    sourcePath,
    destinationPath,
    sourceBytes,
    source,
    sourceSnapshot: snapshotSource(stats),
    sourceMode: stats.mode,
    admission,
    plan: webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    ),
  };
}

async function run(
  prepared: TransactionFixture,
  options: {
    readonly fileOps: FileOps;
    readonly handler?: RegisteredHandler;
    readonly signal?: AbortSignal;
    readonly preserveTimestamps?: boolean;
    readonly beforePublish?: (paths: {
      readonly stageDirectoryPath: string;
      readonly stagePath: string;
    }) => void | Promise<void>;
    readonly beforeStageFinalization?: (paths: {
      readonly stageDirectoryPath: string;
      readonly stagePath: string;
    }) => void | Promise<void>;
    readonly platform?: NodeJS.Platform;
  },
) {
  return runSafeTransaction({
    sourceHandle: prepared.source,
    sourceSnapshot: prepared.sourceSnapshot,
    sourceMode: prepared.sourceMode,
    handler: options.handler ?? webpHandler,
    admission: prepared.admission,
    plan: prepared.plan,
    orientation: undefined,
    options: {
      sourcePath: prepared.sourcePath,
      destinationPath: prepared.destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: options.preserveTimestamps ?? false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    fileOps: options.fileOps,
    ...(options.beforePublish === undefined
      ? {}
      : { beforePublish: options.beforePublish }),
    ...(options.beforeStageFinalization === undefined
      ? {}
      : { beforeStageFinalization: options.beforeStageFinalization }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
}

const terminalFaults = LOGICAL_OPERATIONS.filter(
  (operation) => operation !== "stage-disposition",
);

const postPublicationCloseTargets = [
  "stage-directory",
  "destination-directory",
  "published-stage-file",
  "source-handle",
] as const;

type PostPublicationCloseTarget = (typeof postPublicationCloseTargets)[number];

async function expectedOutput(prepared: TransactionFixture): Promise<Buffer> {
  const source = await readFile(prepared.sourcePath);
  return Buffer.concat([
    encodeRiffHeader(webpOutputSize(prepared.plan)),
    ...prepared.plan.flatMap((chunk) => {
      const data =
        chunk.data ??
        source.subarray(
          chunk.source!.dataOffset,
          chunk.source!.dataOffset + chunk.size,
        );
      return [
        encodeChunkHeader(chunk.fourCc, chunk.size),
        data,
        ...(chunk.size & 1 ? [Buffer.alloc(1)] : []),
      ];
    }),
  ]);
}

function postPublicationCloseFaultFileOps(
  prepared: TransactionFixture,
  target: PostPublicationCloseTarget,
  published: () => boolean,
): { readonly fileOps: FileOps; readonly closeAttempts: readonly string[] } {
  const paths = new Map<number, string>();
  const closeAttempts: string[] = [];
  const nameFor = (handle: Awaited<ReturnType<typeof open>>): string => {
    if (handle === prepared.source) return "source-handle";
    const path = paths.get(handle.fd);
    if (path === undefined) return "unknown";
    if (path.includes(".exifcleaner-stage-") && !path.endsWith("output.webp"))
      return "stage-directory";
    if (path === prepared.directory) return "destination-directory";
    return "published-stage-file";
  };
  return {
    fileOps: {
      ...NODE_FILE_OPS,
      open: async (path, flags, mode) => {
        const handle = await NODE_FILE_OPS.open(path, flags, mode);
        paths.set(handle.fd, path);
        return handle;
      },
      close: async (handle) => {
        const name = nameFor(handle);
        if (published()) closeAttempts.push(name);
        await NODE_FILE_OPS.close(handle);
        paths.delete(handle.fd);
        if (published() && name === target)
          throw Object.assign(new Error(`Synthetic EIO at ${name}`), {
            code: "EIO",
          });
      },
    },
    closeAttempts,
  };
}

describe("deterministic transaction qualification", () => {
  it.each(postPublicationCloseTargets)(
    "retains committed success when post-publication %s close fails",
    async (target: PostPublicationCloseTarget) => {
      const prepared = await fixture();
      let published = false;
      let stageDirectoryPath: string | undefined;
      const fault = postPublicationCloseFaultFileOps(
        prepared,
        target,
        () => published,
      );
      const restore = setNativePublicationBindingForTests({
        createPrivateStageDirectory: () => undefined,
        publishNoReplace() {
          if (stageDirectoryPath === undefined)
            throw new Error("Expected private stage directory");
          renameSync(
            join(stageDirectoryPath, "output.webp"),
            prepared.destinationPath,
          );
          published = true;
          return "published";
        },
        disposePrivateStageDirectory: () => "unsupported",
      });
      const fileOps: FileOps = {
        ...fault.fileOps,
        open: async (path, flags, mode) => {
          const handle = await fault.fileOps.open(path, flags, mode);
          if (
            path.includes(".exifcleaner-stage-") &&
            !path.endsWith("output.webp")
          )
            stageDirectoryPath = path;
          return handle;
        },
      };
      try {
        const expected = await expectedOutput(prepared);
        const result = await run(prepared, { fileOps, platform: "darwin" });

        expect(result).toMatchObject({
          ok: true,
          value: {
            postCommitResidue: {
              state: "private-empty-stage-directory-remains",
            },
          },
        });
        expect(await readFile(prepared.destinationPath)).toEqual(expected);
        expect(await readFile(prepared.sourcePath)).toEqual(
          prepared.sourceBytes,
        );
        expect(fault.closeAttempts).toEqual(postPublicationCloseTargets);
        await expect(
          prepared.source.read(Buffer.alloc(1), 0, 1, 0),
        ).rejects.toMatchObject({ code: "EBADF" });
      } finally {
        restore();
      }
    },
  );

  it.each(terminalFaults)(
    "injects %s once with terminal safety and complete handle accounting",
    async (operation: LogicalOperation) => {
      const prepared = await fixture();
      const controller = applyFaultPlan(NODE_FILE_OPS, {
        operation,
        occurrence: 1,
        error: "EIO",
      });
      const result = await run(prepared, {
        fileOps: controller.fileOps,
        handler: controller.wrapHandler(webpHandler),
        preserveTimestamps: operation === "timestamps",
        beforePublish: controller.beforePublish,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        phase: "transaction",
        nativeWrite:
          operation === "stage-directory-create" ||
          operation === "stage-directory-verify" ||
          operation === "stage-open"
            ? "not-started"
            : "started",
        finalization: { state: "owned-partial-remains" },
      });
      expect(classifyFallback(result.error)).toBe("do-not-fallback");
      expect(controller.evidence()).toMatchObject({
        injected: 1,
        openHandles: 0,
        publicationAttempts: operation === "publication" ? 1 : 0,
      });
      expect(controller.evidence().writerAttempts).toBe(
        operation === "stage-directory-create" ||
          operation === "stage-directory-verify"
          ? 0
          : 1,
      );
      expect(digest(await readFile(prepared.sourcePath))).toBe(
        digest(prepared.sourceBytes),
      );
      await expect(access(prepared.destinationPath)).rejects.toBeDefined();
      await expect(
        prepared.source.read(Buffer.alloc(1), 0, 1, 0),
      ).rejects.toMatchObject({
        code: "EBADF",
      });
    },
  );

  it("records a single capability-disposition fault as truthful post-commit residue", async () => {
    const prepared = await fixture();
    const controller = applyFaultPlan(NODE_FILE_OPS, {
      operation: "stage-disposition",
      occurrence: 1,
      error: "EIO",
    });
    const capability: { path?: string } = {};
    const restore = setNativePublicationBindingForTests({
      createPrivateStageDirectory(stageDirectoryPath) {
        capability.path = stageDirectoryPath;
        mkdirSync(stageDirectoryPath, { mode: 0o700 });
        return capability;
      },
      publishNoReplace(...args) {
        const destinationPath = args[1];
        if (typeof destinationPath !== "string")
          throw new Error("Expected Windows publication arguments");
        renameSync(join(capability.path!, "output.webp"), destinationPath);
        return "published";
      },
      disposePrivateStageDirectory() {
        controller.hit("stage-disposition");
        return "published";
      },
    });
    try {
      const result = await run(prepared, {
        fileOps: controller.fileOps,
        handler: controller.wrapHandler(webpHandler),
        platform: "win32",
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          postCommitResidue: {
            state: "private-empty-stage-directory-remains",
          },
        },
      });
      expect(controller.evidence()).toMatchObject({
        injected: 1,
        openHandles: 0,
        writerAttempts: 1,
      });
      expect(await readFile(prepared.destinationPath)).toBeInstanceOf(Buffer);
      expect(await readFile(prepared.sourcePath)).toEqual(prepared.sourceBytes);
    } finally {
      restore();
    }
  });

  it.each([
    "after-stage-creation",
    "during-bounded-copy",
    "after-write-sync",
    "after-reopen-verification",
    "before-publication",
    "during-finalization",
  ] as const)("controls %s without sleeps or scheduler luck", async (point) => {
    const prepared = await fixture();
    const controller = applyFaultPlan(NODE_FILE_OPS);
    const barrier = new NamedBarrier(point);
    const abort = new AbortController();
    let finalizationPaths:
      | { readonly stageDirectoryPath: string; readonly stagePath: string }
      | undefined;
    let syncs = 0;
    const fileOps: FileOps = {
      ...controller.fileOps,
      createDirectory: async (path, mode) => {
        await controller.fileOps.createDirectory(path, mode);
        if (point === "after-stage-creation") await barrier.pause();
      },
      sync: async (handle) => {
        await controller.fileOps.sync(handle);
        syncs += 1;
        if (point === "after-write-sync" && syncs === 1) await barrier.pause();
      },
    };
    const handler: RegisteredHandler = {
      ...controller.wrapHandler(webpHandler),
      writeOutput: async (source, destination, plan, signal) => {
        if (point !== "during-bounded-copy")
          return controller
            .wrapHandler(webpHandler)
            .writeOutput(source, destination, plan, signal);
        let paused = false;
        const wrappedDestination = {
          write: async (...args: Parameters<typeof destination.write>) => {
            const result = await destination.write(...args);
            if (!paused) {
              paused = true;
              await barrier.pause();
            }
            return result;
          },
        } as unknown as typeof destination;
        return controller
          .wrapHandler(webpHandler)
          .writeOutput(source, wrappedDestination, plan, signal);
      },
      verifyOutput: async (...args) => {
        const result = await controller
          .wrapHandler(webpHandler)
          .verifyOutput(...args);
        if (point === "after-reopen-verification") await barrier.pause();
        return result;
      },
    };
    const transaction = run(prepared, {
      fileOps,
      handler,
      signal: abort.signal,
      beforePublish: async () => {
        if (point === "before-publication") await barrier.pause();
        if (point === "during-finalization")
          throw Object.assign(new Error("bounded finalization trigger"), {
            code: "EIO",
          });
      },
      beforeStageFinalization: async (paths) => {
        if (point === "during-finalization") {
          finalizationPaths = paths;
          await barrier.pause();
        }
      },
    });

    await barrier.waitUntilReached();
    if (
      point === "after-stage-creation" ||
      point === "during-bounded-copy" ||
      point === "after-write-sync" ||
      point === "after-reopen-verification"
    )
      abort.abort();
    else if (point === "before-publication")
      await writeFile(prepared.destinationPath, "competitor");
    else {
      const paths = finalizationPaths!;
      const moved = join(prepared.directory, "moved-stage");
      await rename(paths.stageDirectoryPath, moved);
      await mkdir(paths.stageDirectoryPath, { mode: 0o700 });
      await writeFile(paths.stagePath, "replacement");
    }
    barrier.release();
    const result = await transaction;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (point === "before-publication") {
      expect(result.error.code).toBe("destination-exists");
      expect(await readFile(prepared.destinationPath, "utf8")).toBe(
        "competitor",
      );
    } else if (point === "during-finalization") {
      expect(result.error.code).toBe("write-failed");
      expect(await readFile(finalizationPaths!.stagePath, "utf8")).toBe(
        "replacement",
      );
    } else expect(result.error.code).toBe("aborted");
    expect(classifyFallback(result.error)).toBe("do-not-fallback");
    expect(digest(await readFile(prepared.sourcePath))).toBe(
      digest(prepared.sourceBytes),
    );
    expect(controller.evidence().openHandles).toBe(0);
    expect(controller.evidence().writerAttempts).toBeLessThanOrEqual(1);
  });
});
