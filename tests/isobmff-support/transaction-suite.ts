// Shared HEIC/AVIF deterministic transaction qualification (62.1-11, D-26, QUA-04's fault half).
//
// D-26: the kit's format-neutral `applyFaultPlan` (`tests/qualification/kit/fault-plan.ts`) is
// reused unchanged and wraps the REGISTERED `heicHandler`/`avifHandler`; there is no HEIC/AVIF
// fault harness. The expected disposition per operation is copied from the PNG/JPEG/WebP
// transaction suites (the shared engine's documented policy), never re-derived here.
//
// Independence: this file drives the shared transaction (`src/transaction/`) and the registered
// handler it is given; it never imports `src/isobmff/` (`tests/isobmff_isolation.test.ts`).
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import { classifyFallback } from "../../src/fallback.js";
import { NODE_FILE_OPS, type FileOps } from "../../src/transaction/file-ops.js";
import { snapshotSource } from "../../src/transaction/identity.js";
import { runSafeTransaction } from "../../src/transaction/safe-transaction.js";
import type { MetadataError } from "../../src/types.js";
import {
  loadCorpusRecord,
  materializeRecord,
} from "../qualification/kit/corpus.js";
import {
  applyFaultPlan,
  type FaultPlan,
} from "../qualification/kit/fault-plan.js";
import { downloadGate, tracerRecords } from "./corpus-tracer.js";

export type IsobmffTransactionFormat = "heic" | "avif";

const STAGE_DIRECTORY_PREFIX = ".exifcleaner-stage-";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface TransactionFixture {
  readonly directory: string;
  readonly sourceName: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceBytes: Buffer;
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly sourceSnapshot: ReturnType<typeof snapshotSource>;
  readonly sourceMode: number;
  readonly admission: unknown;
  readonly plan: unknown;
}

/** One corpus id's gate: run it, skip it (no cache, local), or fail (no cache, CI). */
function corpusGate(
  format: IsobmffTransactionFormat,
  id: string,
): ReturnType<typeof downloadGate> {
  const record = tracerRecords(format).find((item) => item.id === id);
  if (record === undefined)
    throw new Error(`Unknown ${format} corpus id: ${id}`);
  return downloadGate(record);
}

/**
 * Registers the shared HEIC/AVIF transaction suite for one brand. `handler` is the REGISTERED
 * handler (`heicHandler`/`avifHandler`); `corpusIds` are provenanced manifest records of that
 * brand that the sanitize transaction admits (a download-only id runs only when
 * `EXIFCLEANER_CORPUS_CACHE_DIR` is set, and fails rather than skips under CI).
 */
export function defineIsobmffTransactionSuite(
  format: IsobmffTransactionFormat,
  handler: RegisteredHandler,
  corpusIds: readonly string[],
): void {
  const FORMAT = format.toUpperCase();
  const extension = handler.capability.extensions[0];
  if (extension === undefined)
    throw new Error(`${format} handler declares no extension`);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function fixture(sourceBytes: Buffer): Promise<TransactionFixture> {
    const directory = await mkdtemp(
      join(tmpdir(), `exifcleaner-qtx-${format}-`),
    );
    directories.push(directory);
    const sourceName = `source${extension}`;
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, `destination${extension}`);
    await writeFile(sourcePath, sourceBytes);
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await handler.admit(source, stats.size);
    return {
      directory,
      sourceName,
      sourcePath,
      destinationPath,
      sourceBytes,
      source,
      sourceSnapshot: snapshotSource(stats),
      sourceMode: stats.mode,
      admission,
      plan: handler.buildOutputPlan(admission, false, false, false, undefined),
    };
  }

  async function corpusFixture(id: string): Promise<TransactionFixture> {
    return fixture(await materializeRecord(await loadCorpusRecord(id)));
  }

  function run(
    prepared: TransactionFixture,
    options: {
      readonly fileOps: FileOps;
      readonly handler: RegisteredHandler;
      readonly preserveTimestamps?: boolean;
      readonly beforePublish?: () => void;
    },
  ) {
    return runSafeTransaction({
      sourceHandle: prepared.source,
      sourceSnapshot: prepared.sourceSnapshot,
      sourceMode: prepared.sourceMode,
      handler: options.handler,
      admission: prepared.admission as never,
      plan: prepared.plan,
      orientation: undefined,
      options: {
        sourcePath: prepared.sourcePath,
        destinationPath: prepared.destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: options.preserveTimestamps ?? false,
        preserveResolution: false,
      },
      fileOps: options.fileOps,
      ...(options.beforePublish === undefined
        ? {}
        : { beforePublish: options.beforePublish }),
    });
  }

  /**
   * Terminal safety after one injected fault, with the disposition the PNG/JPEG/WebP suites
   * assert for the same operation: a typed transaction failure that must not fall back, the
   * source bytes unchanged, nothing under the destination name, every handle closed, and the
   * whole destination directory accounted for -- the source plus, unless the stage directory was
   * never created, exactly one private stage directory holding at most the staged output (the
   * non-win32 `owned-partial-remains` disposition, STATE.md Phase 62 concern).
   */
  async function expectTerminalSafety(
    prepared: TransactionFixture,
    error: MetadataError,
    preCreationFailure: boolean,
  ): Promise<void> {
    expect(error).toMatchObject({
      phase: "transaction",
      finalization: {
        state: preCreationFailure ? "already-missing" : "owned-partial-remains",
      },
    });
    expect(classifyFallback(error)).toBe("do-not-fallback");
    expect(digest(await readFile(prepared.sourcePath))).toBe(
      digest(prepared.sourceBytes),
    );
    await expect(access(prepared.destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const entries = (await readdir(prepared.directory)).sort();
    const stageDirectories = entries.filter((entry) =>
      entry.startsWith(STAGE_DIRECTORY_PREFIX),
    );
    expect(entries).toEqual([...stageDirectories, prepared.sourceName].sort());
    expect(stageDirectories).toHaveLength(preCreationFailure ? 0 : 1);
    for (const stageDirectory of stageDirectories) {
      const staged = await readdir(join(prepared.directory, stageDirectory));
      expect(staged.every((entry) => entry === handler.stagingFileName)).toBe(
        true,
      );
    }
    await expect(
      prepared.source.read(Buffer.alloc(1), 0, 1, 0),
    ).rejects.toMatchObject({ code: "EBADF" });
  }

  async function injectOnce(prepared: TransactionFixture, plan: FaultPlan) {
    const controller = applyFaultPlan(NODE_FILE_OPS, plan);
    const result = await run(prepared, {
      fileOps: controller.fileOps,
      handler: controller.wrapHandler(handler),
      preserveTimestamps: plan.operation === "timestamps",
      beforePublish: controller.beforePublish,
    });
    return { controller, result };
  }

  describe(`deterministic transaction qualification (${FORMAT})`, () => {
    const [firstCorpusId] = corpusIds;
    if (firstCorpusId === undefined)
      throw new Error(`${format} transaction suite needs a corpus id`);

    it(`injects stage-write once with terminal safety on ${firstCorpusId}`, async (context) => {
      const gate = corpusGate(format, firstCorpusId);
      if (gate.kind === "fail") throw new Error(gate.reason);
      if (gate.kind === "skip") return context.skip(gate.reason);
      const prepared = await corpusFixture(firstCorpusId);
      const { controller, result } = await injectOnce(prepared, {
        operation: "stage-write",
        occurrence: 1,
        error: "EIO",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ nativeWrite: "started" });
      await expectTerminalSafety(prepared, result.error, false);
      expect(controller.evidence()).toMatchObject({
        injected: 1,
        openHandles: 0,
        writerAttempts: 1,
        publicationAttempts: 0,
      });
    });
  });
}
