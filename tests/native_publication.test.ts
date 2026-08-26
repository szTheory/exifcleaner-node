import { createRequire } from "node:module";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
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

    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-native-publication-"));
    temporaryDirectories.push(directory);
    const stage = join(directory, "stage.webp");
    const destination = join(directory, "destination.webp");
    await writeFile(stage, "verified stage");

    expect(binding.publishNoReplace(stage, destination)).toBe("published");
    await expect(cp(destination, join(directory, "published-copy.webp"))).resolves.toBeUndefined();

    const collisionStage = join(directory, "collision-stage.webp");
    await writeFile(collisionStage, "must stay staged");
    expect(binding.publishNoReplace(collisionStage, destination)).toBe("collision");
  });
});
