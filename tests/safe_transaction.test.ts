import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
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
} from "../src/transaction/identity.js";
import { runSafeTransaction } from "../src/transaction/safe-transaction.js";
import { metadataWebp } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("safe transaction file operations", () => {
  it("keeps the Node adapter private to the transaction layer", () => {
    expect(NODE_FILE_OPS).toBeDefined();
  });

  it("treats a post-create sync fault as terminal without starting a second writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-transaction-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "destination.webp");
    await writeFile(sourcePath, metadataWebp());
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await webpHandler.admit(source, stats.size);
    const plan = webpHandler.buildOutputPlan(admission.parsed, false, false, undefined);
    let writerStarts = 0;
    const operations: string[] = [];
    const fileOps: FileOps = {
      ...NODE_FILE_OPS,
      open: async (path, flags, mode) => {
        if ((flags & fsConstants.O_EXCL) !== 0) writerStarts += 1;
        operations.push((flags & fsConstants.O_EXCL) !== 0 ? "create" : "reopen");
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

    const result = await runSafeTransaction({ sourceHandle: source, sourceSnapshot: snapshotSource(stats), sourceMode: stats.mode, handler: webpHandler, admission, plan, orientation: undefined, options: { sourcePath, destinationPath, preserveOrientation: false, preserveColorProfile: false, preserveTimestamps: false }, fileOps });

    expect(result).toMatchObject({ ok: false, error: { code: "write-failed", nativeWrite: "started", phase: "transaction" } });
    expect(writerStarts).toBe(1);
    expect(operations).toEqual(["create", "sync", "close", "close", "remove"]);
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

    expect(identityMatches({ dev: sourceStats.dev, ino: sourceStats.ino }, aliasedStats)).toBe(true);
    expect(identitiesDistinct({ dev: sourceStats.dev, ino: sourceStats.ino }, aliasedStats)).toBe(false);
    expect(sourceSnapshotMatches(snapshot, { ...aliasedStats, ino: undefined } as never)).toBe(false);
    expect(identityMatches({ dev: sourceStats.dev, ino: undefined as never }, aliasedStats)).toBe(false);
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
});
