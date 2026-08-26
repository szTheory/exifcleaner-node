import {
  constants as fsConstants,
  mkdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webpHandler } from "../src/admission/webp-handler.js";
import { NODE_FILE_OPS, type FileOps } from "../src/transaction/file-ops.js";
import {
  identitiesDistinct,
  identityMatches,
  snapshotSource,
  sourceSnapshotMatches,
  timestampsMatchAtMillisecondPrecision,
} from "../src/transaction/identity.js";
import { runSafeTransaction } from "../src/transaction/safe-transaction.js";
import { setNativePublicationBindingForTests } from "../src/transaction/native-publication.js";
import { metadataWebp } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("safe transaction file operations", () => {
  it("keeps the Node adapter private to the transaction layer", () => {
    expect(NODE_FILE_OPS).toBeDefined();
  });

  it("uses the verified Windows capability for creation, publication, and disposal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    const capability: { path?: string } = {};
    let reopenFlags: number | undefined;
    const restore = setNativePublicationBindingForTests({
      publishNoReplace(stagePath, finalPath) {
        renameSync(stagePath, finalPath);
        return "published";
      },
      createPrivateStageDirectory(stageDirectoryPath) {
        capability.path = stageDirectoryPath;
        mkdirSync(stageDirectoryPath);
        return capability;
      },
      disposePrivateStageDirectory(received) {
        expect(received).toBe(capability);
        rmdirSync(capability.path!);
        return "published";
      },
    });

    try {
      const fileOps: FileOps = {
        ...NODE_FILE_OPS,
        open: async (path, flags, mode) => {
          if ((flags & fsConstants.O_EXCL) === 0) reopenFlags = flags;
          return NODE_FILE_OPS.open(path, flags, mode);
        },
      };
      const result = await runSafeTransaction({
        sourceHandle: source,
        sourceSnapshot: snapshotSource(stats),
        sourceMode: stats.mode,
        handler: webpHandler,
        admission,
        plan,
        orientation: undefined,
        options: {
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
        },
        fileOps,
        platform: "win32",
      });

      expect(result).toMatchObject({
        ok: true,
        value: { postCommitResidue: { state: "none" } },
      });
      expect(reopenFlags! & fsConstants.O_RDWR).toBe(fsConstants.O_RDWR);
      await expect(readFile(destinationPath)).resolves.toBeInstanceOf(Buffer);
      await expect(stat(capability.path!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });

  it("keeps all work in a verified private stage until the native collision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    const competitor = Buffer.from("competitor owns this destination");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    let pathnameRemovals = 0;
    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps: {
        ...NODE_FILE_OPS,
        remove: async () => {
          pathnameRemovals += 1;
          throw new Error("private stages must not use pathname cleanup");
        },
      },
      beforePublish: async () => writeFile(destinationPath, competitor),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "destination-exists",
        phase: "transaction",
        nativeWrite: "started",
        finalization: { state: "owned-partial-remains" },
      },
    });
    expect(await readFile(destinationPath)).toEqual(competitor);
    expect(pathnameRemovals).toBe(0);
    const stageName = (await readdir(directory)).find((entry) =>
      entry.startsWith(".exifcleaner-stage-"),
    );
    expect(stageName).toBeDefined();
    expect((await stat(join(directory, stageName!))).mode & 0o077).toBe(0);
  });

  it("uses only the opened Windows stage capability after directory identity capture fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    const capability = {} as never;
    let dispositionAttempts = 0;
    let pathnameRemovals = 0;
    const restore = setNativePublicationBindingForTests({
      publishNoReplace: () => "failed",
      createPrivateStageDirectory: () => capability,
      disposePrivateStageDirectory: (received) => {
        expect(received).toBe(capability);
        dispositionAttempts += 1;
        return "published";
      },
    });

    try {
      const result = await runSafeTransaction({
        sourceHandle: source,
        sourceSnapshot: snapshotSource(stats),
        sourceMode: stats.mode,
        handler: webpHandler,
        admission,
        plan,
        orientation: undefined,
        options: {
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
        },
        fileOps: {
          ...NODE_FILE_OPS,
          statHandle: async () => {
            throw new Error("injected directory identity failure");
          },
          remove: async () => {
            pathnameRemovals += 1;
          },
        },
        platform: "win32" as never,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "write-failed",
          nativeWrite: "not-started",
          finalization: { state: "owned-partial-removed" },
        },
      });
      expect(dispositionAttempts).toBe(1);
      expect(pathnameRemovals).toBe(0);
      await expect(readFile(sourcePath)).resolves.toEqual(metadataWebp());
      await expect(stat(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });

  it("retains file and directory replacements on every file-present finalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    const replacementDirectory = join(directory, "replacement-stage");
    const replacementFile = Buffer.from("replacement stage file");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    let pathnameRemovals = 0;
    let observedStageDirectory = "";
    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps: {
        ...NODE_FILE_OPS,
        sync: async () => {
          throw new Error("injected file-present failure");
        },
        remove: async () => {
          pathnameRemovals += 1;
        },
      },
      platform: "linux" as never,
      beforeStageFinalization: async ({
        stageDirectoryPath,
        stagePath,
      }: {
        readonly stageDirectoryPath: string;
        readonly stagePath: string;
      }) => {
        observedStageDirectory = stageDirectoryPath;
        await rename(stageDirectoryPath, replacementDirectory);
        await mkdir(stageDirectoryPath, { mode: 0o700 });
        await writeFile(stagePath, replacementFile);
      },
    } as never);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "write-failed",
        finalization: { state: "owned-partial-remains" },
      },
    });
    expect(pathnameRemovals).toBe(0);
    await expect(
      readFile(join(observedStageDirectory, "output.webp")),
    ).resolves.toEqual(replacementFile);
    await expect(readFile(sourcePath)).resolves.toEqual(metadataWebp());
    await expect(stat(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["unsupported", "failed"] as const)(
    "treats native publication %s as one terminal attempt without destination cleanup",
    async (nativeOutcome) => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-transaction-"),
      );
      directories.push(directory);
      const sourcePath = join(directory, "source.webp");
      const destinationPath = join(directory, "destination.webp");
      await writeFile(sourcePath, metadataWebp());
      const source = await open(sourcePath, fsConstants.O_RDONLY);
      const stats = await source.stat();
      const admission = await webpHandler.admit(source, stats.size);
      const plan = webpHandler.buildOutputPlan(
        admission.parsed,
        false,
        false,
        undefined,
      );
      let nativeAttempts = 0;
      let pathnameRemovals = 0;
      const restore = setNativePublicationBindingForTests({
        publishNoReplace: () => {
          nativeAttempts += 1;
          return nativeOutcome;
        },
        createPrivateStageDirectory: () => undefined,
        disposePrivateStageDirectory: () => "unsupported",
      });
      try {
        const result = await runSafeTransaction({
          sourceHandle: source,
          sourceSnapshot: snapshotSource(stats),
          sourceMode: stats.mode,
          handler: webpHandler,
          admission,
          plan,
          orientation: undefined,
          options: {
            sourcePath,
            destinationPath,
            preserveOrientation: false,
            preserveColorProfile: false,
            preserveTimestamps: false,
          },
          fileOps: {
            ...NODE_FILE_OPS,
            remove: async () => {
              pathnameRemovals += 1;
              throw new Error(
                "publication failures must retain the private stage",
              );
            },
          },
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "write-failed",
            phase: "transaction",
            nativeWrite: "started",
            finalization: { state: "owned-partial-remains" },
          },
        });
        expect(nativeAttempts).toBe(1);
        expect(pathnameRemovals).toBe(0);
        await expect(stat(destinationPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        restore();
      }
    },
  );

  it("treats a post-create sync fault as terminal without starting a second writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    let writerStarts = 0;
    const operations: string[] = [];
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      open: async (path, flags, mode) => {
        if ((flags & fsConstants.O_EXCL) !== 0) writerStarts += 1;
        operations.push(
          (flags & fsConstants.O_EXCL) !== 0 ? "create" : "reopen",
        );
        return NODE_FILE_OPS.open(path, flags, mode);
      },
      sync: async () => {
        operations.push("sync");
        throw new Error("injected sync failure");
      },
      close: async (handle) => {
        operations.push("close");
        await NODE_FILE_OPS.close(handle);
      },
      remove: async (path) => {
        operations.push("remove");
        await NODE_FILE_OPS.remove(path);
      },
    };

    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "write-failed",
        nativeWrite: "started",
        phase: "transaction",
        finalization: { state: "owned-partial-remains" },
      },
    });
    expect(writerStarts).toBe(1);
    expect(operations).not.toContain("remove");
  });

  it("reports an already missing owned destination without recreating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    let cleanupAttempts = 0;
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      sync: async () => {
        throw new Error("injected sync failure");
      },
      lstatPath: async () => {
        cleanupAttempts += 1;
        await unlink(destinationPath);
        const error = Object.assign(new Error("missing"), { code: "ENOENT" });
        throw error;
      },
    };

    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "write-failed",
        finalization: { state: "owned-partial-remains" },
      },
    });
    await expect(stat(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cleanupAttempts).toBe(0);
  });

  it("does not use pathname observation as an authority after stage failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    const replacement = Buffer.from("replacement bytes");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    let cleanupAttempts = 0;
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      sync: async () => {
        throw new Error("injected sync failure");
      },
      lstatPath: async (path) => {
        cleanupAttempts += 1;
        await unlink(destinationPath);
        await writeFile(destinationPath, replacement);
        return NODE_FILE_OPS.lstatPath(path);
      },
    };

    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "write-failed",
        finalization: { state: "owned-partial-remains" },
      },
    });
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cleanupAttempts).toBe(0);
  });

  it("reports a bounded residue cause when owned cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      sync: async () => {
        throw new Error("injected sync failure");
      },
    };

    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler: webpHandler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      },
      fileOps,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "write-failed",
        finalization: {
          state: "owned-partial-remains",
          cause: {
            message:
              "Private staged file remains after terminal publication failure.",
          },
        },
      },
    });
    await expect(stat(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels after creation through exactly one cleanup path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(
      admission.parsed,
      false,
      false,
      undefined,
    );
    const controller = new AbortController();
    let writerStarts = 0;
    let cleanupAttempts = 0;
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      open: async (path, flags, mode) => {
        if ((flags & fsConstants.O_EXCL) !== 0) writerStarts += 1;
        return NODE_FILE_OPS.open(path, flags, mode);
      },
      remove: async (path) => {
        cleanupAttempts += 1;
        await NODE_FILE_OPS.remove(path);
      },
    };
    const handler = {
      ...webpHandler,
      writeOutput: async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    };

    const result = await runSafeTransaction({
      sourceHandle: source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      handler,
      admission,
      plan,
      orientation: undefined,
      options: {
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        signal: controller.signal,
      },
      fileOps,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "aborted",
        phase: "transaction",
        nativeWrite: "started",
        finalization: { state: "owned-partial-remains" },
      },
    });
    expect(writerStarts).toBe(1);
    expect(cleanupAttempts).toBe(0);
  });

  it("fails closed when an identity or source snapshot cannot be proven", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const aliasPath = join(directory, "source-alias.webp");
    await writeFile(sourcePath, metadataWebp());
    await symlink(sourcePath, aliasPath);
    const sourceStats = await stat(sourcePath);
    const aliasedStats = await stat(aliasPath);
    const snapshot = snapshotSource(sourceStats);

    expect(
      identityMatches(
        { dev: sourceStats.dev, ino: sourceStats.ino },
        aliasedStats,
      ),
    ).toBe(true);
    expect(
      identitiesDistinct(
        { dev: sourceStats.dev, ino: sourceStats.ino },
        aliasedStats,
      ),
    ).toBe(false);
    expect(
      sourceSnapshotMatches(snapshot, {
        ...aliasedStats,
        ino: undefined,
      } as never),
    ).toBe(false);
    expect(
      identityMatches(
        { dev: sourceStats.dev, ino: undefined as never },
        aliasedStats,
      ),
    ).toBe(false);
  });

  it("captures independent requested timestamps before any package reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    await writeFile(sourcePath, metadataWebp());
    const sourceStats = await stat(sourcePath);
    const snapshot = snapshotSource(sourceStats);
    const expectedAtime = snapshot.atime.getTime();
    const expectedMtime = snapshot.mtime.getTime();

    sourceStats.atime.setTime(expectedAtime + 1_000);
    sourceStats.mtime.setTime(expectedMtime + 1_000);

    expect(snapshot.atime.getTime()).toBe(expectedAtime);
    expect(snapshot.mtime.getTime()).toBe(expectedMtime);
  });

  it("compares filesystem timestamps at actual millisecond precision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    await writeFile(sourcePath, metadataWebp());
    const stats = await stat(sourcePath);
    const snapshot = snapshotSource(stats);

    expect(
      timestampsMatchAtMillisecondPrecision(snapshot, {
        ...stats,
        atimeMs: snapshot.atime.getTime() - 0.001,
        mtimeMs: snapshot.mtime.getTime() + 0.001,
      } as never),
    ).toBe(true);
    expect(
      timestampsMatchAtMillisecondPrecision(snapshot, {
        ...stats,
        atimeMs: snapshot.atime.getTime() + 1,
      } as never),
    ).toBe(false);
  });
});
