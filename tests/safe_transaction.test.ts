import {
  constants as fsConstants,
  mkdirSync,
  linkSync,
  unlinkSync,
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
    let reopenedStageDescriptor: number | undefined;
    const restore = setNativePublicationBindingForTests({
      publishNoReplace(...args) {
        expect(args).toEqual([
          reopenedStageDescriptor,
          destinationPath,
          join(capability.path!, "output.webp"),
          capability,
        ]);
        linkSync(join(capability.path!, "output.webp"), destinationPath);
        return "published";
      },
      createPrivateStageDirectory(stageDirectoryPath) {
        capability.path = stageDirectoryPath;
        mkdirSync(stageDirectoryPath);
        return capability;
      },
      removePrivateStageFile(received, stagePath) {
        expect(received).toBe(capability);
        unlinkSync(stagePath);
        return "published";
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
          const handle = await NODE_FILE_OPS.open(path, flags, mode);
          if (
            path.endsWith("output.webp") &&
            (flags & fsConstants.O_EXCL) === 0
          ) {
            reopenedStageDescriptor = handle.fd;
          }
          return handle;
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
      expect(reopenedStageDescriptor).toBeTypeOf("number");
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
      fileOps: NODE_FILE_OPS,
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
    const stageName = (await readdir(directory)).find((entry) =>
      entry.startsWith(".exifcleaner-stage-"),
    );
    expect(stageName).toBeDefined();
    expect((await stat(join(directory, stageName!))).mode & 0o077).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "refuses publication when the verified stage directory is swapped before publication",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-transaction-"),
      );
      directories.push(directory);
      const sourcePath = join(directory, "source.webp");
      const destinationPath = join(directory, "destination.webp");
      const movedStageDirectory = join(directory, "moved-stage");
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
        fileOps: NODE_FILE_OPS,
        beforePublish: async ({
          stageDirectoryPath,
        }: {
          stageDirectoryPath: string;
        }) => {
          await rename(stageDirectoryPath, movedStageDirectory);
          await mkdir(stageDirectoryPath, { mode: 0o700 });
          await writeFile(
            join(stageDirectoryPath, "output.webp"),
            "replacement",
          );
        },
      } as never);

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
    },
  );

  it("refuses publication when the source changes after staged-output verification", async () => {
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
      fileOps: NODE_FILE_OPS,
      beforePublish: async () =>
        writeFile(sourcePath, Buffer.from("changed source")),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "source-changed",
        finalization: { state: "owned-partial-remains" },
      },
    });
    await expect(stat(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    const restore = setNativePublicationBindingForTests({
      publishNoReplace: () => "failed",
      createPrivateStageDirectory: () => capability,
      removePrivateStageFile: () => "unsupported",
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
      await expect(readFile(sourcePath)).resolves.toEqual(metadataWebp());
      await expect(stat(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      restore();
    }
  });

  it("reports post-create native setup residue instead of claiming the stage is missing", async () => {
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
    let createdStageDirectory = "";
    const restore = setNativePublicationBindingForTests({
      publishNoReplace: () => "failed",
      createPrivateStageDirectory(stageDirectoryPath) {
        createdStageDirectory = stageDirectoryPath;
        mkdirSync(stageDirectoryPath);
        return true;
      },
      removePrivateStageFile: () => "unsupported",
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
        fileOps: NODE_FILE_OPS,
        platform: "win32" as never,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "write-failed",
          nativeWrite: "not-started",
          finalization: { state: "owned-partial-remains" },
        },
      });
      expect((await stat(createdStageDirectory)).isDirectory()).toBe(true);
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
      const restore = setNativePublicationBindingForTests({
        publishNoReplace: () => {
          nativeAttempts += 1;
          return nativeOutcome;
        },
        createPrivateStageDirectory: () => undefined,
        removePrivateStageFile: () => "unsupported",
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
          fileOps: NODE_FILE_OPS,
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
        finalization: { state: "owned-partial-remains" },
      },
    });
    await expect(stat(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not use pathname observation as an authority after stage failure", async () => {
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
        finalization: { state: "owned-partial-remains" },
      },
    });
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      open: async (path, flags, mode) => {
        if ((flags & fsConstants.O_EXCL) !== 0) writerStarts += 1;
        return NODE_FILE_OPS.open(path, flags, mode);
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
