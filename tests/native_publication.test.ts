import { createRequire } from "node:module";
import { constants as fsConstants } from "node:fs";
import { cp, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_REOPEN_FLAGS } from "../src/transaction/file-ops.js";
import {
  loadNativePublicationBindingForTests,
  mapNativePublicationCode,
  mapNativeStageDirectoryCode,
  publishNoReplace,
  type NativePublicationArguments,
  setNativePublicationBindingForTests,
} from "../src/transaction/native-publication.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const hostArtifact = join(
  packageRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "publication.node",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("current-host native publication addon", () => {
  it("loads the canonical artifact and publishes without replacing a collision", async () => {
    const binding = require(hostArtifact) as {
      publishNoReplace(...args: NativePublicationArguments): string;
      createPrivateStageDirectory(): unknown;
      disposePrivateStageDirectory(capability: unknown): string;
    };
    expect(Object.getOwnPropertyNames(binding).sort()).toEqual([
      "createPrivateStageDirectory",
      "disposePrivateStageDirectory",
      "publishNoReplace",
    ]);

    const directory = await mkdtemp(
      join(tmpdir(), "exifcleaner-native-publication-"),
    );
    temporaryDirectories.push(directory);
    const stage = join(directory, "stage.webp");
    const destination = join(directory, "destination.webp");
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
        ? binding.publishNoReplace(stageDescriptor, destination)
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
  });

  it.runIf(process.platform === "win32")(
    "creates, verifies, and disposes an identity-bound private stage directory",
    async () => {
      const binding = require(hostArtifact) as {
        createPrivateStageDirectory(stageDirectoryPath: string): unknown;
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
});

describe("private native publication loader", () => {
  it("does not apply POSIX no-follow reopening flags to a Windows private stage", () => {
    expect(WINDOWS_REOPEN_FLAGS & fsConstants.O_NOFOLLOW).toBe(0);
    expect(WINDOWS_REOPEN_FLAGS & fsConstants.O_RDWR).toBe(
      fsConstants.O_RDWR,
    );
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
        disposePrivateStageDirectory: () => "unsupported",
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
    expect(mapNativePublicationCode("failed:rename-legacy:32")).toEqual({
      state: "publication-failed",
      diagnostic: "rename-legacy:32",
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
          "destination.webp",
          "linux",
        ),
      ).toEqual({ state: "published" });
    } finally {
      restore();
    }
  });

  it("passes the explicit Windows stage-handle ABI to the binding", () => {
    const restore = setNativePublicationBindingForTests({
      publishNoReplace(...args) {
        expect(args).toEqual([40, "C:\\safe\\destination.webp"]);
        return "published";
      },
      createPrivateStageDirectory: () => undefined,
      disposePrivateStageDirectory: () => "unsupported",
    });

    try {
      expect(
        publishNoReplace(
          40,
          undefined,
          undefined,
          "output.webp",
          "C:\\safe\\destination.webp",
          "destination.webp",
          "win32",
        ),
      ).toEqual({ state: "published" });
    } finally {
      restore();
    }
  });
});
