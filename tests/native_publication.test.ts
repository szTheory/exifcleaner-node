import { createRequire } from "node:module";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativePublicationBindingForTests,
  mapNativePublicationCode,
  mapNativeStageDirectoryCode,
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
      publishNoReplace(stagePath: string, destinationPath: string): string;
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

    expect(binding.publishNoReplace(stage, destination)).toBe("published");
    await expect(
      cp(destination, join(directory, "published-copy.webp")),
    ).resolves.toBeUndefined();

    const collisionStage = join(directory, "collision-stage.webp");
    await writeFile(collisionStage, "must stay staged");
    expect(binding.publishNoReplace(collisionStage, destination)).toBe(
      "collision",
    );
  });
});

describe("private native publication loader", () => {
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
});
