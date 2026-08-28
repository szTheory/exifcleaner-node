import { createRequire } from "node:module";
import { constants as fsConstants, readFileSync } from "node:fs";
import { cp, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFile } from "../src/index.js";
import { WINDOWS_REOPEN_FLAGS } from "../src/transaction/file-ops.js";
import {
  loadNativePublicationBindingForTests,
  mapNativePublicationCode,
  mapNativeStageDirectoryCode,
  publishNoReplace,
  type NativePublicationArguments,
  type NativeStageDirectoryCapability,
  setNativePublicationBindingForTests,
} from "../src/transaction/native-publication.js";
import { vp8, vp8x, webp } from "./fixtures.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const hostArtifact = join(
  packageRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "publication.node",
);
const nativePublicationSource = join(packageRoot, "native", "publication.c");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("current-host native publication addon", () => {
  it("requires FileIdInfo proof before one CreateHardLinkW publication", () => {
    const source = readFileSync(nativePublicationSource, "utf8");

    expect(source).toContain("CreateHardLinkW(destination, stage_path, NULL)");
    expect(source).toContain(
      "GetFileInformationByHandleEx(parent_handle, FileIdInfo",
    );
    expect(source).toContain(
      "GetFileInformationByHandleEx(stage_directory, FileIdInfo",
    );
    expect(source).toContain(
      "GetFileInformationByHandleEx(stage_handle, FileIdInfo",
    );
    expect(source.indexOf("FileIdInfo")).toBeLessThan(
      source.indexOf("CreateHardLinkW(destination, stage_path, NULL)"),
    );
    expect(source).toContain(
      "if (split == 2 && path[1] == L':') parent_length = split + 1;",
    );
    expect(source).toContain("dispose_verified_stage_directory(directory)");
    expect(source).toContain("napi_get_boolean(env, TRUE, &value)");
    expect(source).not.toMatch(
      /FileRenameInfo(?:Ex)?|ReplaceIfExists|ReOpenFile/u,
    );
  });

  it("loads the canonical artifact and publishes without replacing a collision", async () => {
    const binding = require(hostArtifact) as {
      publishNoReplace(...args: NativePublicationArguments): string;
      createPrivateStageDirectory(stageDirectoryPath: string): unknown;
      removePrivateStageFile(capability: unknown, stagePath: string): string;
      disposePrivateStageDirectory(capability: unknown): string;
    };
    expect(Object.getOwnPropertyNames(binding).sort()).toEqual([
      "createPrivateStageDirectory",
      "disposePrivateStageDirectory",
      "publishNoReplace",
      "removePrivateStageFile",
      "takeLastWindowsPublicationEvidence",
    ]);

    const directory = await mkdtemp(
      join(tmpdir(), "exifcleaner-native-publication-"),
    );
    temporaryDirectories.push(directory);
    const stageDirectoryPath = join(directory, "stage");
    const stage =
      process.platform === "win32"
        ? join(stageDirectoryPath, "stage.webp")
        : join(directory, "stage.webp");
    const destination = join(directory, "destination.webp");
    const stageDirectoryCapability =
      process.platform === "win32"
        ? binding.createPrivateStageDirectory(stageDirectoryPath)
        : undefined;
    if (process.platform === "win32")
      expect(stageDirectoryCapability).toBeDefined();
    await writeFile(stage, "verified stage");

    const stageDirectory = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    const destinationDirectory = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    const stageHandle = await open(stage, fsConstants.O_RDWR);
    const publish = (
      stageDescriptor: number,
      stageEntry: string,
      destinationEntry: string,
    ) =>
      process.platform === "win32"
        ? binding.publishNoReplace(
            ...([
              stageDescriptor,
              destination,
              stage,
              stageDirectoryCapability!,
            ] as unknown as NativePublicationArguments),
          )
        : binding.publishNoReplace(
            stageDirectory.fd,
            stageEntry,
            destinationDirectory.fd,
            destinationEntry,
          );

    expect(publish(stageHandle.fd, "stage.webp", "destination.webp")).toBe(
      "published",
    );
    await expect(
      cp(destination, join(directory, "published-copy.webp")),
    ).resolves.toBeUndefined();

    const collisionStage = join(directory, "collision-stage.webp");
    await writeFile(collisionStage, "must stay staged");
    const collisionHandle = await open(collisionStage, fsConstants.O_RDWR);
    expect(
      publish(collisionHandle.fd, "collision-stage.webp", "destination.webp"),
    ).toBe("collision");
    await collisionHandle.close();
    await stageHandle.close();
    await stageDirectory.close();
    await destinationDirectory.close();
    if (process.platform === "win32") {
      expect(
        binding.removePrivateStageFile(stageDirectoryCapability!, stage),
      ).toBe("published");
      expect(
        binding.disposePrivateStageDirectory(stageDirectoryCapability!),
      ).toBe("published");
    }
  });

  it.runIf(process.platform === "win32")(
    "creates, verifies, and disposes an identity-bound private stage directory",
    async () => {
      const binding = require(hostArtifact) as {
        createPrivateStageDirectory(stageDirectoryPath: string): unknown;
        removePrivateStageFile(capability: unknown, stagePath: string): string;
        disposePrivateStageDirectory(capability: unknown): string;
      };
      const parent = await mkdtemp(
        join(tmpdir(), "exifcleaner-native-stage-directory-"),
      );
      temporaryDirectories.push(parent);
      const stageDirectory = join(parent, "stage");

      const capability = binding.createPrivateStageDirectory(stageDirectory);

      expect(capability).toBeDefined();
      expect(binding.disposePrivateStageDirectory(capability)).toBe(
        "published",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "publishes a file reopened inside an identity-bound private stage directory",
    async () => {
      const binding = require(hostArtifact) as {
        publishNoReplace(
          stageDescriptor: number,
          destinationPath: string,
          stagePath: string,
          capability: unknown,
        ): string;
        createPrivateStageDirectory(stageDirectoryPath: string): unknown;
        removePrivateStageFile(capability: unknown, stagePath: string): string;
        disposePrivateStageDirectory(capability: unknown): string;
      };
      const parent = await mkdtemp(
        join(tmpdir(), "exifcleaner-native-private-publication-"),
      );
      temporaryDirectories.push(parent);
      const stageDirectory = join(parent, "stage");
      const stagePath = join(stageDirectory, "output.webp");
      const destination = join(parent, "destination.webp");
      const capability = binding.createPrivateStageDirectory(stageDirectory);

      expect(capability).toBeDefined();
      await writeFile(stagePath, "verified private stage");
      const stage = await open(stagePath, WINDOWS_REOPEN_FLAGS);
      try {
        expect(
          binding.publishNoReplace(
            stage.fd,
            destination,
            stagePath,
            capability,
          ),
        ).toBe("published");
        await expect(
          cp(destination, join(parent, "published-copy.webp")),
        ).resolves.toBeUndefined();
      } finally {
        await stage.close();
        expect(binding.removePrivateStageFile(capability, stagePath)).toBe(
          "published",
        );
        expect(binding.disposePrivateStageDirectory(capability)).toBe(
          "published",
        );
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "publishes an ordinary sanitized WebP through the private stage transaction",
    async () => {
      const parent = await mkdtemp(
        join(tmpdir(), "exifcleaner-native-private-transaction-"),
      );
      temporaryDirectories.push(parent);
      const source = join(parent, "source.webp");
      const destination = join(parent, "destination.webp");
      await writeFile(
        source,
        webp([
          { fourCc: "VP8X", data: vp8x(0x08) },
          { fourCc: "VP8 ", data: vp8() },
          {
            fourCc: "EXIF",
            data: Buffer.from("II*\0\b\0\0\0\0\0\0\0", "binary"),
          },
        ]),
      );

      await expect(
        sanitizeFile({
          sourcePath: source,
          destinationPath: destination,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        cp(destination, join(parent, "published-copy.webp")),
      ).resolves.toBeUndefined();
      await expect(readdir(parent)).resolves.not.toContainEqual(
        expect.stringMatching(/^\.exifcleaner-stage-/u),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "publishes a current-directory relative destination through the native capability",
    async () => {
      const parent = await mkdtemp(
        join(tmpdir(), "exifcleaner-native-relative-transaction-"),
      );
      temporaryDirectories.push(parent);
      const source = join(parent, "source.webp");
      const previousDirectory = process.cwd();
      await writeFile(
        source,
        webp([
          { fourCc: "VP8X", data: vp8x(0x08) },
          { fourCc: "VP8 ", data: vp8() },
          {
            fourCc: "EXIF",
            data: Buffer.from("II*\0\b\0\0\0\0\0\0\0", "binary"),
          },
        ]),
      );
      process.chdir(parent);
      try {
        await expect(
          sanitizeFile({
            sourcePath: source,
            destinationPath: "output.webp",
            preserveOrientation: false,
            preserveColorProfile: false,
            preserveTimestamps: false,
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          cp(join(parent, "output.webp"), join(parent, "copy.webp")),
        ).resolves.toBeUndefined();
        await expect(readdir(parent)).resolves.not.toContainEqual(
          expect.stringMatching(/^\.exifcleaner-stage-/u),
        );
      } finally {
        process.chdir(previousDirectory);
      }
    },
  );
});

describe("private native publication loader", () => {
  it("does not apply POSIX no-follow reopening flags to a Windows private stage", () => {
    expect(WINDOWS_REOPEN_FLAGS & fsConstants.O_NOFOLLOW).toBe(0);
    expect(WINDOWS_REOPEN_FLAGS & fsConstants.O_NONBLOCK).toBe(0);
    expect(WINDOWS_REOPEN_FLAGS & fsConstants.O_RDWR).toBe(fsConstants.O_RDWR);
  });

  it.each([
    ["linux", "x64", "../../prebuilds/linux-x64/publication.node"],
    ["linux", "arm64", "../../prebuilds/linux-arm64/publication.node"],
    ["darwin", "x64", "../../prebuilds/darwin-x64/publication.node"],
    ["darwin", "arm64", "../../prebuilds/darwin-arm64/publication.node"],
    ["win32", "x64", "../../prebuilds/win32-x64/publication.node"],
    ["win32", "arm64", "../../prebuilds/win32-arm64/publication.node"],
  ])(
    "selects only the literal %s-%s addon path",
    (platform, architecture, path) => {
      const binding = {
        publishNoReplace: () => "published",
        createPrivateStageDirectory: () => undefined,
        removePrivateStageFile: () => "unsupported",
        capturePrivateStageCleanup: () => undefined,
        consumePrivateStageCleanup: () => "unsupported",
        stageFileIdentity: () => undefined,
        disposePrivateStageDirectory: () => "unsupported",
        takeLastWindowsPublicationEvidence: () => undefined,
      };
      expect(
        loadNativePublicationBindingForTests(
          platform,
          architecture,
          (specifier) => {
            expect(specifier).toBe(path);
            return binding;
          },
        ),
      ).toBe(binding);
    },
  );

  it("rejects unsupported tuples and malformed exports before destination work", () => {
    expect(() =>
      loadNativePublicationBindingForTests("freebsd", "x64", () => ({})),
    ).toThrow("Unsupported native publication tuple");
    expect(() =>
      loadNativePublicationBindingForTests("darwin", "arm64", () => ({
        publishNoReplace: () => "published",
      })),
    ).toThrow("expected exports");
  });

  it("maps publication and private-directory outcomes as disjoint bounded results", () => {
    expect(mapNativePublicationCode("published")).toEqual({
      state: "published",
    });
    expect(mapNativePublicationCode("collision")).toEqual({
      state: "destination-exists",
    });
    expect(mapNativePublicationCode("unsupported")).toEqual({
      state: "publication-unsupported",
    });
    expect(mapNativePublicationCode("anything-else")).toEqual({
      state: "publication-failed",
    });
    expect(mapNativePublicationCode("failed:link:32")).toEqual({
      state: "publication-failed",
      diagnostic: "link:32",
    });
    expect(mapNativeStageDirectoryCode("published")).toEqual({
      state: "disposed",
    });
    expect(mapNativeStageDirectoryCode("unsupported")).toEqual({
      state: "disposition-unsupported",
    });
    expect(mapNativeStageDirectoryCode("anything-else")).toEqual({
      state: "disposition-failed",
    });
  });

  it("uses an injected binding only through the private test seam", () => {
    const restore = setNativePublicationBindingForTests({
      publishNoReplace: () => "collision",
      createPrivateStageDirectory: () => undefined,
      removePrivateStageFile: () => "unsupported",
      disposePrivateStageDirectory: () => "unsupported",
    });
    expect(restore).toBeTypeOf("function");
    restore();
  });

  it("passes the explicit POSIX directory-capability ABI to the binding", () => {
    const restore = setNativePublicationBindingForTests({
      publishNoReplace(...args) {
        expect(args).toEqual([41, "output.webp", 42, "destination.webp"]);
        return "published";
      },
      createPrivateStageDirectory: () => undefined,
      removePrivateStageFile: () => "unsupported",
      disposePrivateStageDirectory: () => "unsupported",
    });

    try {
      expect(
        publishNoReplace(
          40,
          41,
          42,
          "output.webp",
          "/safe/destination.webp",
          "/safe/stage/output.webp",
          undefined,
          "destination.webp",
          "linux",
        ),
      ).toEqual({ state: "published" });
    } finally {
      restore();
    }
  });

  it("passes the drive-root Windows publication ABI to the binding", () => {
    const restore = setNativePublicationBindingForTests({
      publishNoReplace(...args) {
        expect(args).toEqual([
          40,
          "C:\\destination.webp",
          "C:\\.exifcleaner-stage-test\\output.webp",
          {},
        ]);
        return "published";
      },
      createPrivateStageDirectory: () => undefined,
      removePrivateStageFile: () => "unsupported",
      disposePrivateStageDirectory: () => "unsupported",
    });

    try {
      expect(
        publishNoReplace(
          40,
          undefined,
          undefined,
          "output.webp",
          "C:\\destination.webp",
          "C:\\.exifcleaner-stage-test\\output.webp",
          {} as NativeStageDirectoryCapability,
          "destination.webp",
          "win32",
        ),
      ).toEqual({ state: "published" });
    } finally {
      restore();
    }
  });
});
