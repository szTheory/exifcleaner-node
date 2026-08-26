import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const audit = join(packageRoot, "scripts", "audit_native_source.cjs");
const binding = join(packageRoot, "binding.gyp");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

async function fixture(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-native-audit-"));
  const path = join(directory, "fixture.c");
  fixtures.push(directory);
  await writeFile(path, source, "utf8");
  return path;
}

async function run(path?: string): Promise<{ code: number; output: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      path ? [audit, path] : [audit],
    );
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("native source capability audit", () => {
  it("keeps the descriptor-to-handle CRT dependency explicitly linked", async () => {
    const source = await readFile(
      join(packageRoot, "native", "publication.c"),
      "utf8",
    );
    const configuration = await readFile(binding, "utf8");

    expect(source).toContain("_get_osfhandle");
    expect(configuration).toContain('"ucrt.lib"');
  });

  it("accepts the production C source", async () => {
    await expect(run()).resolves.toMatchObject({
      code: 0,
      output: expect.stringContaining("Native source audit passed"),
    });
  });

  it.each([
    ["network", "socket()"],
    ["process", "fork()"],
    ["shell", 'system("x")'],
    ["downloader", "URLDownloadToFileW()"],
    ["runtime-build", "cl.exe"],
    ["dynamic-loader", "LoadLibraryW()"],
    ["replacing-publication", 'rename("a", "b")'],
    ["pathname-cleanup", 'unlink("a")'],
    ["pathname-cleanup", 'unlinkat(0, "a", 0)'],
    ["pathname-cleanup", 'remove("a")'],
    ["pathname-cleanup", 'rm("a")'],
    ["pathname-cleanup", 'rmdir("a")'],
    ["pathname-cleanup", 'RemoveFile(L"a")'],
    ["pathname-cleanup", 'DeleteFileW(L"a")'],
    ["pathname-cleanup", 'RemoveDirectoryW(L"a")'],
  ])("rejects %s capability fixtures", async (category, forbidden) => {
    const path = await fixture(
      `#include <stdio.h>\nvoid fixture(void) { ${forbidden}; }\n`,
    );
    await expect(run(path)).resolves.toMatchObject({
      code: 1,
      output: expect.stringContaining(category),
    });
  });
});
