// Shared HEIC/AVIF deterministic transaction qualification (62.1-11, D-26, QUA-04's fault half).
//
// D-26: the kit's format-neutral `applyFaultPlan` (`tests/qualification/kit/fault-plan.ts`) is
// reused unchanged and wraps the REGISTERED `heicHandler`/`avifHandler`; there is no HEIC/AVIF
// fault harness. The expected disposition per operation is copied from the PNG/JPEG/WebP
// transaction suites (the shared engine's documented policy), never re-derived here; a measured
// probe on 2026-10-03 found HEIC's disposition identical to PNG's for all 14 operations.
//
// Independence: this file drives the shared transaction (`src/transaction/`) and the registered
// handler it is given; it never imports `src/isobmff/` (`tests/isobmff_isolation.test.ts`). Every
// structural fact about a fixture or an output comes from the independent inventory walker.
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync, renameSync } from "node:fs";
import {
  access,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import { classifyFallback } from "../../src/fallback.js";
import { COPY_BLOCK_BYTES } from "../../src/io/copy-range.js";
import { NODE_FILE_OPS, type FileOps } from "../../src/transaction/file-ops.js";
import { snapshotSource } from "../../src/transaction/identity.js";
import { setNativePublicationBindingForTests } from "../../src/transaction/native-publication.js";
import { runSafeTransaction } from "../../src/transaction/safe-transaction.js";
import type { MetadataError } from "../../src/types.js";
import { exifWithArtist } from "../fixtures.js";
import {
  loadCorpusRecord,
  materializeRecord,
} from "../qualification/kit/corpus.js";
import {
  LOGICAL_OPERATIONS,
  applyFaultPlan,
  type FaultPlan,
  type LogicalOperation,
} from "../qualification/kit/fault-plan.js";
import { heifFile } from "./builder.js";
import {
  assertIso01,
  downloadGate,
  survivingPayloadDigests,
  tracerRecords,
} from "./corpus-tracer.js";
import { inventoryIsobmff } from "./inventory.js";

export type IsobmffTransactionFormat = "heic" | "avif";

const STAGE_DIRECTORY_PREFIX = ".exifcleaner-stage-";

/** D-26: the generated fixture's surviving payload spans MORE than three copy blocks. */
export const LARGE_MDAT_MINIMUM_BYTES = 3 * COPY_BLOCK_BYTES;
const LARGE_PRIMARY_PAYLOAD_BYTES = 3 * COPY_BLOCK_BYTES + 8 * 1024;

/**
 * Operations whose occurrence-1 fault happens before publication and so must end in a terminal
 * failure (the PNG/JPEG/WebP `terminalFaults` set). `stage-disposition` and
 * `stage-directory-remove` act only after the destination is committed; they are covered by the
 * post-commit residue tests below, exactly as the PNG suite covers them.
 */
const TERMINAL_FAULTS: readonly LogicalOperation[] = LOGICAL_OPERATIONS.filter(
  (operation) =>
    operation !== "stage-disposition" && operation !== "stage-directory-remove",
);

/**
 * The stage-write occurrences counted per bounded copy block of the large surviving payload:
 * occurrence 2 faults the first payload block (after every header byte is staged), occurrence 3
 * after one whole 64 KiB block is copied, occurrence 4 after two.
 */
const MID_COPY_OCCURRENCES = [2, 3, 4] as const;

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface TransactionFixture {
  readonly directory: string;
  readonly sourceName: string;
  readonly destinationName: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceBytes: Buffer;
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly sourceSnapshot: ReturnType<typeof snapshotSource>;
  readonly sourceMode: number;
  readonly admission: unknown;
  readonly plan: unknown;
}

interface RunOptions {
  readonly fileOps: FileOps;
  readonly handler: RegisteredHandler;
  readonly preserveTimestamps?: boolean;
  readonly beforePublish?: () => void;
  readonly platform?: NodeJS.Platform;
}

/**
 * A builder HEIF of `format`'s own brand with one surviving primary item whose payload spans
 * more than three `COPY_BLOCK_BYTES` blocks (a non-constant byte pattern, so a misplaced block is
 * observable) and one removable Exif item.
 */
export function largeMdatFixture(format: IsobmffTransactionFormat): Buffer {
  const payload = Buffer.alloc(LARGE_PRIMARY_PAYLOAD_BYTES);
  for (let index = 0; index < payload.length; index += 1)
    payload[index] = (index * 31 + (index >>> 8)) & 0xff;
  return heifFile({
    majorBrand: format,
    compatibleBrands: ["mif1", format],
    primary: {
      itemId: 1,
      itemType: format === "heic" ? "hvc1" : "av01",
      width: 64,
      height: 64,
      payload,
    },
    exif: {
      itemId: 2,
      payload: Buffer.concat([
        Buffer.alloc(4),
        exifWithArtist("private workflow"),
      ]),
    },
  });
}

/** The single top-level `mdat`'s payload length, read by the independent inventory walker. */
export function mdatPayloadBytes(bytes: Buffer): number {
  const mdats = inventoryIsobmff(bytes).topLevel.filter(
    (box) => box.type === "mdat",
  );
  if (mdats.length !== 1)
    throw new Error(`Expected exactly one mdat, found ${mdats.length}`);
  const [mdat] = mdats;
  const largeSize = bytes.readUInt32BE(mdat!.offset) === 1;
  return mdat!.size - (largeSize ? 16 : 8);
}

/** Output file offset of the primary item's first extent (independent inventory). */
function primaryPayloadOffset(output: Buffer): number {
  const inventory = inventoryIsobmff(output);
  const primary = inventory.items.find(
    (item) => item.id === inventory.primaryItemId,
  );
  const extent = primary?.extents[0];
  if (primary === undefined || extent === undefined)
    throw new Error("Output primary item has no extent");
  if (primary.constructionMethod !== 0)
    throw new Error("Output primary item is not file-relative");
  return primary.baseOffset + extent.offset;
}

/** One corpus id's gate: run it, skip it (no cache, local), or fail (no cache, CI). */
function corpusGate(
  format: IsobmffTransactionFormat,
  id: string,
): ReturnType<typeof downloadGate> {
  const record = tracerRecords(format).find((item) => item.id === id);
  if (record === undefined)
    throw new Error(`Unknown ${format} corpus id: ${id}`);
  if (record.outcome.status !== "success")
    throw new Error(`${id} is not an admitted ${format} record`);
  return downloadGate(record);
}

/**
 * The identity proof for a committed output: the independent ISO-01 check (every metadata item
 * removed, no residue window, surviving entry order kept) plus byte-identical surviving payloads.
 */
function expectIdentityProof(source: Buffer, output: Buffer): void {
  expect(() => assertIso01(source, output)).not.toThrow();
  expect(survivingPayloadDigests(output)).toEqual(
    survivingPayloadDigests(source),
  );
}
/**
 * Registers the shared HEIC/AVIF transaction suite for one brand. `handler` is the REGISTERED
 * handler (`heicHandler`/`avifHandler`); `corpusIds` are provenanced, admitted manifest records
 * of that brand (a download-only id runs only when `EXIFCLEANER_CORPUS_CACHE_DIR` is set, and
 * fails rather than skips under CI).
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
  const [firstCorpusId] = corpusIds;
  if (firstCorpusId === undefined)
    throw new Error(`${format} transaction suite needs a corpus id`);
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
    const destinationName = `destination${extension}`;
    const sourcePath = join(directory, sourceName);
    const destinationPath = join(directory, destinationName);
    await writeFile(sourcePath, sourceBytes);
    const source = await open(sourcePath, fsConstants.O_RDONLY);
    const stats = await source.stat();
    const admission = await handler.admit(source, stats.size);
    return {
      directory,
      sourceName,
      destinationName,
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

  async function corpusBytes(id: string): Promise<Buffer> {
    return materializeRecord(await loadCorpusRecord(id));
  }

  function run(prepared: TransactionFixture, options: RunOptions) {
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
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  }

  async function stageDirectoriesOf(
    prepared: TransactionFixture,
  ): Promise<string[]> {
    return (await readdir(prepared.directory)).filter((entry) =>
      entry.startsWith(STAGE_DIRECTORY_PREFIX),
    );
  }

  /**
   * Terminal safety after one fault, with the disposition the PNG/JPEG/WebP suites assert for the
   * same operation: a typed transaction failure that must not fall back, the source bytes
   * unchanged, nothing under the destination name, the source handle closed, and the whole
   * destination directory accounted for -- the source plus, unless the stage directory was never
   * created, exactly one private stage directory holding at most the staged output (the non-win32
   * `owned-partial-remains` disposition, STATE.md Phase 62 concern).
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
    const stageDirectories = await stageDirectoriesOf(prepared);
    expect((await readdir(prepared.directory)).sort()).toEqual(
      [...stageDirectories, prepared.sourceName].sort(),
    );
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

  /** The no-fault control: same wrapping, no plan; returns the committed output bytes. */
  async function controlRun(sourceBytes: Buffer): Promise<Buffer> {
    const prepared = await fixture(sourceBytes);
    const controller = applyFaultPlan(NODE_FILE_OPS);
    const result = await run(prepared, {
      fileOps: controller.fileOps,
      handler: controller.wrapHandler(handler),
      beforePublish: controller.beforePublish,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { postCommitResidue: { state: "none" } },
    });
    expect(controller.evidence()).toMatchObject({
      injected: 0,
      openHandles: 0,
      writerAttempts: 1,
    });
    expect((await readdir(prepared.directory)).sort()).toEqual(
      [prepared.destinationName, prepared.sourceName].sort(),
    );
    expect(await readFile(prepared.sourcePath)).toEqual(sourceBytes);
    const output = await readFile(prepared.destinationPath);
    expectIdentityProof(sourceBytes, output);
    return output;
  }

  /** Registers `body` for one corpus id behind its download gate (fail in CI, skip locally). */
  function corpusIt(
    title: string,
    id: string,
    body: (bytes: Buffer) => Promise<void>,
  ): void {
    const gate = corpusGate(format, id);
    if (gate.kind === "fail") {
      it(`${id}: ${title} (download-only record needs the fetch cache in CI)`, () => {
        throw new Error(gate.reason);
      });
      return;
    }
    if (gate.kind === "skip") {
      console.warn(`skipping ${gate.reason}`);
      it.skip(`${id}: ${title} (download-only, no local fetch cache)`, () => {});
      return;
    }
    it(`${id}: ${title}`, async () => body(await corpusBytes(id)));
  }

  /**
   * `handler` wrapped by `controller`, with one extra `stage-write` hit before every bounded write
   * that lands at or after `payloadStart` (each `COPY_BLOCK_BYTES` block of the surviving
   * payload). The kit's own hit at `writeOutput` entry stays occurrence 1, so occurrence N >= 2 is
   * the (N-1)th payload block. `written` records every byte that reached the stage file.
   */
  function blockCountingHandler(
    controller: ReturnType<typeof applyFaultPlan>,
    payloadStart: number,
  ): { readonly handler: RegisteredHandler; readonly written: () => number } {
    const wrapped = controller.wrapHandler(handler);
    let written = 0;
    return {
      written: () => written,
      handler: {
        ...wrapped,
        writeOutput: async (source, destination, plan, signal) => {
          const counted = {
            write: async (...args: Parameters<typeof destination.write>) => {
              const position = (args as readonly unknown[])[3];
              if (typeof position === "number" && position >= payloadStart)
                controller.hit("stage-write");
              const result = await destination.write(...args);
              written += result.bytesWritten;
              return result;
            },
          } as unknown as typeof destination;
          return wrapped.writeOutput(source, counted, plan, signal);
        },
      },
    };
  }

  describe(`deterministic transaction qualification (${FORMAT})`, () => {
    corpusIt(
      "injects stage-write once with terminal safety",
      firstCorpusId,
      async (bytes) => {
        const prepared = await fixture(bytes);
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
      },
    );

    for (const id of corpusIds) {
      corpusIt(
        "the no-fault control succeeds and passes the identity proof",
        id,
        async (bytes) => {
          await controlRun(bytes);
        },
      );

      for (const operation of TERMINAL_FAULTS) {
        corpusIt(
          `injects ${operation} once with terminal safety and complete handle accounting`,
          id,
          async (bytes) => {
            const prepared = await fixture(bytes);
            const { controller, result } = await injectOnce(prepared, {
              operation,
              occurrence: 1,
              error: "EIO",
            });

            expect(result.ok).toBe(false);
            if (result.ok) return;
            const preCreationFailure = operation === "stage-directory-create";
            expect(result.error).toMatchObject({
              nativeWrite:
                operation === "stage-directory-create" ||
                operation === "stage-directory-verify" ||
                operation === "stage-open"
                  ? "not-started"
                  : "started",
            });
            await expectTerminalSafety(
              prepared,
              result.error,
              preCreationFailure,
            );
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
            expect(
              controller.evidence().occurrences["stage-directory-remove"] ?? 0,
            ).toBe(0);
          },
        );
      }

      corpusIt(
        "records a stage-directory-remove fault as truthful post-commit residue",
        id,
        async (bytes) => {
          const prepared = await fixture(bytes);
          const { controller, result } = await injectOnce(prepared, {
            operation: "stage-directory-remove",
            occurrence: 1,
            error: "EIO",
          });

          expect(result).toMatchObject({
            ok: true,
            value: {
              postCommitResidue: {
                state: "private-empty-stage-directory-remains",
                cause: { code: "EIO" },
              },
            },
          });
          expect(controller.evidence()).toMatchObject({
            injected: 1,
            openHandles: 0,
            writerAttempts: 1,
          });
          expect(await readFile(prepared.sourcePath)).toEqual(bytes);
          expectIdentityProof(bytes, await readFile(prepared.destinationPath));
          const stageDirectories = await stageDirectoriesOf(prepared);
          expect(stageDirectories).toHaveLength(1);
          expect(
            await readdir(join(prepared.directory, stageDirectories[0]!)),
          ).toEqual([]);
          expect((await readdir(prepared.directory)).sort()).toEqual(
            [
              ...stageDirectories,
              prepared.destinationName,
              prepared.sourceName,
            ].sort(),
          );
        },
      );

      corpusIt(
        "an output-verification failure yields verification-failed with nothing published",
        id,
        async (bytes) => {
          const prepared = await fixture(bytes);
          const controller = applyFaultPlan(NODE_FILE_OPS);
          const wrapped = controller.wrapHandler(handler);
          let end = 0;
          const result = await run(prepared, {
            fileOps: controller.fileOps,
            beforePublish: controller.beforePublish,
            handler: {
              ...wrapped,
              // The writer completes, then the last staged byte (inside a surviving payload) is
              // flipped, so the REAL verifier -- not a synthetic throw -- sees a wrong output.
              writeOutput: async (source, destination, plan, signal) => {
                const tracked = {
                  write: async (
                    ...args: Parameters<typeof destination.write>
                  ) => {
                    const result = await destination.write(...args);
                    const position = (args as readonly unknown[])[3];
                    if (typeof position === "number")
                      end = Math.max(end, position + result.bytesWritten);
                    return result;
                  },
                } as unknown as typeof destination;
                await wrapped.writeOutput(source, tracked, plan, signal);
                const last = Buffer.alloc(1);
                await destination.read(last, 0, 1, end - 1);
                last[0] = last[0]! ^ 0xff;
                await destination.write(last, 0, 1, end - 1);
              },
            },
          });

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toMatchObject({
            code: "verification-failed",
            nativeWrite: "started",
          });
          await expectTerminalSafety(prepared, result.error, false);
          expect(controller.evidence()).toMatchObject({
            injected: 0,
            openHandles: 0,
            writerAttempts: 1,
            publicationAttempts: 0,
          });
          expect(controller.evidence().occurrences["output-verification"]).toBe(
            1,
          );
        },
      );
    }

    corpusIt(
      "records a single capability-disposition fault as truthful post-commit residue",
      firstCorpusId,
      async (bytes) => {
        const prepared = await fixture(bytes);
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
            renameSync(
              join(capability.path!, handler.stagingFileName),
              destinationPath,
            );
            return "published";
          },
          removePrivateStageFile() {
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
            handler: controller.wrapHandler(handler),
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
          expectIdentityProof(bytes, await readFile(prepared.destinationPath));
          expect(await readFile(prepared.sourcePath)).toEqual(bytes);
        } finally {
          restore();
        }
      },
    );

    describe("a stage-write fault after partial copying of a large mdat", () => {
      it(`the generated fixture's mdat payload exceeds three ${COPY_BLOCK_BYTES}-byte copy blocks and its no-fault control passes the identity proof`, async () => {
        const bytes = largeMdatFixture(format);
        expect(mdatPayloadBytes(bytes)).toBeGreaterThan(
          LARGE_MDAT_MINIMUM_BYTES,
        );
        await controlRun(bytes);
      });

      it.each(MID_COPY_OCCURRENCES)(
        "fails safe when stage-write occurrence %i lands mid-copy",
        async (occurrence) => {
          const bytes = largeMdatFixture(format);
          expect(mdatPayloadBytes(bytes)).toBeGreaterThanOrEqual(
            LARGE_MDAT_MINIMUM_BYTES,
          );
          const payloadStart = primaryPayloadOffset(await controlRun(bytes));
          const prepared = await fixture(bytes);
          const controller = applyFaultPlan(NODE_FILE_OPS, {
            operation: "stage-write",
            occurrence,
            error: "EIO",
          });
          const counting = blockCountingHandler(controller, payloadStart);
          const result = await run(prepared, {
            fileOps: controller.fileOps,
            handler: counting.handler,
            beforePublish: controller.beforePublish,
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
          expect(controller.evidence().occurrences["stage-write"]).toBe(
            occurrence,
          );
          // Partial copying is proven, not assumed: everything before the surviving payload plus
          // (occurrence - 2) whole copy blocks reached the stage file before the fault, and the
          // private stage file holds exactly those bytes.
          const expectedWritten =
            payloadStart + (occurrence - 2) * COPY_BLOCK_BYTES;
          expect(counting.written()).toBe(expectedWritten);
          const [stageDirectory] = await stageDirectoriesOf(prepared);
          const stagedPath = join(
            prepared.directory,
            stageDirectory!,
            handler.stagingFileName,
          );
          expect((await stat(stagedPath)).size).toBe(expectedWritten);
        },
      );
    });
  });
}
