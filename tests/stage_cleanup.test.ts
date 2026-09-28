import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/index.js";
import { webpHandler } from "../src/admission/webp-handler.js";
import { NODE_FILE_OPS, type FileOps } from "../src/transaction/file-ops.js";
import { snapshotSource } from "../src/transaction/identity.js";
import { runSafeTransaction } from "../src/transaction/safe-transaction.js";
import { metadataWebp } from "./fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(prefix = "exifcleaner-stage-cleanup-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const CORPUS_ROOT = fileURLToPath(new URL("corpus/", import.meta.url));

interface FixtureCase {
  readonly label: string;
  readonly sourceBasename: string;
  readonly destinationBasename: string;
  readonly load: () => Promise<Buffer>;
}

const FIXTURES: readonly FixtureCase[] = [
  {
    label: "webp",
    sourceBasename: "source.webp",
    destinationBasename: "clean.webp",
    load: () => readFile(join(CORPUS_ROOT, "sample.webp")),
  },
  {
    label: "jpeg",
    sourceBasename: "source.jpg",
    destinationBasename: "clean.jpg",
    load: () =>
      readFile(
        join(CORPUS_ROOT, "upstream/libjpeg-turbo-3.2.0/testorig.jpg"),
      ),
  },
  {
    label: "png",
    sourceBasename: "source.png",
    destinationBasename: "clean.png",
    load: () => readFile(join(CORPUS_ROOT, "upstream/libpng-1.6.58/rgb-8-sRGB.png")),
  },
];

describe("zero stage residue beside a committed output", () => {
  for (const fixture of FIXTURES) {
    it(`leaves only source and destination after a successful POSIX sanitize (${fixture.label})`, async () => {
      const directory = await workspace();
      const sourcePath = join(directory, fixture.sourceBasename);
      const destinationPath = join(directory, fixture.destinationBasename);
      const sourceBytes = await fixture.load();
      await writeFile(sourcePath, sourceBytes);

      const result = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        preserveResolution: false,
      });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;

      const listing = (await readdir(directory)).sort();
      expect(listing).toEqual(
        [fixture.sourceBasename, fixture.destinationBasename].sort(),
      );
      expect(result.value.postCommitResidue).toEqual({ state: "none" });
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
    });
  }

  it("leaves exactly the three sources and three destinations after three concurrent sanitizeFile calls", async () => {
    const directory = await workspace();
    const entries: string[] = [];
    const results = await Promise.all(
      FIXTURES.map(async (fixture) => {
        const sourcePath = join(directory, fixture.sourceBasename);
        const destinationPath = join(directory, fixture.destinationBasename);
        const sourceBytes = await fixture.load();
        await writeFile(sourcePath, sourceBytes);
        entries.push(fixture.sourceBasename, fixture.destinationBasename);
        const result = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
          preserveResolution: false,
        });
        expect(result).toMatchObject({ ok: true });
        return result;
      }),
    );

    const listing = (await readdir(directory)).sort();
    expect(listing).toEqual(entries.sort());
    for (const result of results) {
      if (result.ok) {
        expect(result.value.postCommitResidue).toEqual({ state: "none" });
      }
    }
  });

  it("gets the same exact two-entry result when the parent directory name is non-ASCII", async () => {
    const root = await workspace();
    const directory = join(root, "Fotos ü 照片");
    directories.push(directory);
    await mkdir(directory);
    const fixture = FIXTURES[0]!;
    const sourcePath = join(directory, fixture.sourceBasename);
    const destinationPath = join(directory, fixture.destinationBasename);
    const sourceBytes = await fixture.load();
    await writeFile(sourcePath, sourceBytes);

    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    const listing = (await readdir(directory)).sort();
    expect(listing).toEqual(
      [fixture.sourceBasename, fixture.destinationBasename].sort(),
    );
    expect(result.value.postCommitResidue).toEqual({ state: "none" });
  });
});

async function runWebpTransaction(
  directory: string,
  fileOps: FileOps,
): Promise<{
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly result: Awaited<ReturnType<typeof runSafeTransaction>>;
}> {
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "destination.webp");
  await writeFile(sourcePath, metadataWebp());
  const source = await open(sourcePath, fsConstants.O_RDONLY);
  const stats = await source.stat();
  const admission = await webpHandler.admit(source, stats.size);
  const plan = webpHandler.buildOutputPlan(admission, false, false, false, undefined);
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
      preserveResolution: false,
    },
    fileOps,
  });
  return { sourcePath, destinationPath, result };
}

describe.runIf(process.platform !== "win32")(
  "stage removal is identity-bound, empty-only and never revokes success",
  () => {
    it("reports removal residue with the rmdir cause when removeDirectory fails, and leaves the stage entry present", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-stage-cleanup-"),
      );
      directories.push(directory);
      const fileOps: FileOps = {
        ...NODE_FILE_OPS,
        removeDirectory: async () => {
          throw Object.assign(new Error("Operation not permitted"), {
            code: "EPERM",
          });
        },
      };

      const { destinationPath, result } = await runWebpTransaction(
        directory,
        fileOps,
      );

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.postCommitResidue).toEqual({
        state: "private-empty-stage-directory-remains",
        cause: expect.objectContaining({ code: "EPERM" }),
      });
      await expect(stat(destinationPath)).resolves.toBeDefined();

      const listing = await readdir(directory);
      const stageEntries = listing.filter((entry) =>
        entry.startsWith(".exifcleaner-stage-"),
      );
      expect(stageEntries).toHaveLength(1);
      expect(listing.sort()).toEqual(
        ["destination.webp", "source.webp", stageEntries[0]!].sort(),
      );
    });

    it("never removes a stage directory that is not empty, and the foreign file survives byte-identical", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-stage-cleanup-"),
      );
      directories.push(directory);
      const foreignBytes = Buffer.from("do not delete me");
      const fileOps: FileOps = {
        ...NODE_FILE_OPS,
        removeDirectory: async (path) => {
          await writeFile(join(path, "foreign.txt"), foreignBytes);
          await NODE_FILE_OPS.removeDirectory(path);
        },
      };

      const { result } = await runWebpTransaction(directory, fileOps);

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.postCommitResidue).toMatchObject({
        state: "private-empty-stage-directory-remains",
        cause: expect.objectContaining({
          code: expect.stringMatching(/^(ENOTEMPTY|EEXIST)$/),
        }),
      });

      const listing = await readdir(directory);
      const stageEntry = listing.find((entry) =>
        entry.startsWith(".exifcleaner-stage-"),
      );
      expect(stageEntry).toBeDefined();
      const foreignPath = join(directory, stageEntry!, "foreign.txt");
      await expect(readFile(foreignPath)).resolves.toEqual(foreignBytes);
    });

    it("removes nothing when the stage identity changed by the post-commit stat, and both directories survive", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "exifcleaner-stage-cleanup-"),
      );
      directories.push(directory);
      let removeDirectoryCalls = 0;
      let swapped = false;
      const fileOps: FileOps = {
        ...NODE_FILE_OPS,
        statPath: async (path) => {
          if (
            !swapped &&
            typeof path === "string" &&
            path.includes(".exifcleaner-stage-")
          ) {
            const destinationExists = await stat(
              join(directory, "destination.webp"),
            ).then(
              () => true,
              () => false,
            );
            if (destinationExists) {
              swapped = true;
              const movedStage = join(directory, "moved-stage");
              await rename(path, movedStage);
              await mkdir(path, { mode: 0o700 });
            }
          }
          return NODE_FILE_OPS.statPath(path);
        },
        removeDirectory: async (path) => {
          removeDirectoryCalls += 1;
          await NODE_FILE_OPS.removeDirectory(path);
        },
      };

      const { result } = await runWebpTransaction(directory, fileOps);

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.postCommitResidue).toEqual({
        state: "private-empty-stage-directory-remains",
        cause: expect.objectContaining({ code: "stage-identity-changed" }),
      });
      expect(removeDirectoryCalls).toBe(0);
      expect(swapped).toBe(true);

      await expect(stat(join(directory, "moved-stage"))).resolves.toBeDefined();
      const listing = await readdir(directory);
      const replacementStage = listing.find((entry) =>
        entry.startsWith(".exifcleaner-stage-"),
      );
      expect(replacementStage).toBeDefined();
    });
  },
);
