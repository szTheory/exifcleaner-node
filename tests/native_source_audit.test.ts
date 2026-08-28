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

async function productionFixture(
  mutate: (source: string) => string,
): Promise<string> {
  return fixture(
    mutate(
      await readFile(join(packageRoot, "native", "publication.c"), "utf8"),
    ),
  );
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
  it("bridges descriptors through Node's initialized libuv without a CRT import", async () => {
    const source = await readFile(
      join(packageRoot, "native", "publication.c"),
      "utf8",
    );
    const configuration = await readFile(binding, "utf8");

    expect(source).toContain("uv_get_osfhandle");
    expect(source).toContain("CreateHardLinkW");
    expect(source).toContain("GetFileInformationByHandleEx");
    expect(source).toContain("FileIdInfo");
    expect(source).not.toMatch(/FileRenameInfo|ReOpenFile/);
    expect(source).not.toMatch(/\b_get_osfhandle\b/);
    expect(configuration).not.toContain('"ucrt.lib"');
  });

  it("accepts the production C source", async () => {
    await expect(run()).resolves.toMatchObject({
      code: 0,
      output: expect.stringContaining("Native source audit passed"),
    });
  });

  it.each([
    [
      "descriptor bridge",
      (source: string) =>
        source.replace(
          "uv_get_osfhandle(stage_descriptor)",
          "invalid_descriptor(stage_descriptor)",
        ),
    ],
    [
      "borrowed-descriptor FileIdInfo",
      (source: string) =>
        source.replace(
          "GetFileInformationByHandleEx(stage_handle, FileIdInfo, &expected, sizeof(expected))",
          "FALSE",
        ),
    ],
    [
      "observed FileIdInfo",
      (source: string) =>
        source.replace(
          "GetFileInformationByHandleEx(stage_file, FileIdInfo, &observed, sizeof(observed))",
          "FALSE",
        ),
    ],
    [
      "complete identity comparison",
      (source: string) =>
        source.replace("!file_identity_matches(&observed, expected)", "FALSE"),
    ],
    [
      "delete-authorized rights",
      (source: string) =>
        source.replace(
          "DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE",
          "FILE_READ_ATTRIBUTES",
        ),
    ],
    [
      "all sharing",
      (source: string) =>
        source.replace(
          "stage_file = CreateFileW(stage_path,\n      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,\n      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE",
          "stage_file = CreateFileW(stage_path,\n      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,\n      FILE_SHARE_READ",
        ),
    ],
    [
      "reparse refusal",
      (source: string) =>
        source.replace(
          "stage_file = CreateFileW(stage_path,\n      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,\n      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,\n      FILE_FLAG_OPEN_REPARSE_POINT",
          "stage_file = CreateFileW(stage_path,\n      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,\n      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,\n      0",
        ),
    ],
    [
      "retained cleanup consume",
      (source: string) =>
        source.replaceAll(
          "SetFileInformationByHandle(capability->cleanup_handle",
          "SetFileInformationByHandle(INVALID_HANDLE_VALUE",
        ),
    ],
    [
      "full-width native comparison",
      (source: string) =>
        source.replace(
          "left->VolumeSerialNumber != right->VolumeSerialNumber",
          "FALSE",
        ),
    ],
    [
      "no uint32 identity authority",
      (source: string) =>
        source.replace(
          "FILE_ID_INFO expected;",
          "uint32_t serial;\n  FILE_ID_INFO expected;",
        ),
    ],
    [
      "no cleanup JavaScript identity object",
      (source: string) =>
        source.replace(
          "FILE_ID_INFO expected;",
          "napi_value identity;\n  FILE_ID_INFO expected;",
        ),
    ],
    [
      "no post-capture reopen",
      (source: string) =>
        source.replace(
          "return capability;\n}\n\nstatic publication_result consume_private_stage_cleanup",
          "return capability;\n  ReOpenFile(stage_file, 0, 0, 0);\n}\n\nstatic publication_result consume_private_stage_cleanup",
        ),
    ],
  ])("rejects a missing or unsafe %s", async (_name, mutate) => {
    const path = await productionFixture(mutate);
    await expect(run(path)).resolves.toMatchObject({ code: 1 });
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
