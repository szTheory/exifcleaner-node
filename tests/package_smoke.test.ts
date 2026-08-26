import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smoke = join(packageRoot, "scripts", "package_smoke.cjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runSmoke(
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, [smoke, ...args]);
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("installed package smoke", () => {
  it("requires an explicit supplied tarball instead of packing the checkout", async () => {
    await expect(runSmoke([])).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("--tarball is required"),
    });
  });

  it("installs a current-host development tarball with scripts disabled and records bounded evidence", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "exifcleaner-package-smoke-"));
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "current-host.tgz");

    const helper = await import("../scripts/package_smoke.cjs");
    await helper.createDevelopmentTarballForTests({ packageRoot, tarball });

    const result = await runSmoke([
      "--tarball",
      tarball,
      "--evidence-scope",
      "development-current-host",
    ]);
    expect(result.exitCode, result.output).toBe(0);
    const evidence = JSON.parse(result.output) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      evidenceScope: "development-current-host",
      hostTuple: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      install: { command: "npm install --ignore-scripts" },
      tarball: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      cases: {
        sourcePreserved: true,
        published: true,
        collisionPreserved: true,
        postCommitResidue: expect.any(String),
      },
    });
  });

  it("refuses final-release labeling for a current-host development tarball", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "exifcleaner-package-scope-"));
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "current-host.tgz");
    const helper = await import("../scripts/package_smoke.cjs");
    await helper.createDevelopmentTarballForTests({ packageRoot, tarball });

    await expect(
      runSmoke(["--tarball", tarball, "--evidence-scope", "final-release"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("final-release"),
    });
  });

  it("fails before transaction work when the literal host tuple is absent", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "exifcleaner-package-host-"));
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "not-a-tarball.tgz");
    await copyFile(join(packageRoot, "package.json"), tarball);

    await expect(
      runSmoke(["--tarball", tarball, "--evidence-scope", "development-current-host"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("npm install --ignore-scripts"),
    });
  });
});
