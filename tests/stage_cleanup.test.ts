import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/index.js";

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
