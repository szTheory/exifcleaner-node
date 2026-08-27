import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smoke = join(packageRoot, "scripts", "package_smoke.cjs");
const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const helper = require("../scripts/package_smoke.cjs") as {
  createDevelopmentTarballForTests(input: {
    packageRoot: string;
    tarball: string;
  }): Promise<void>;
  assertLiteralHostArtifact(root: string): string;
  isLoadedNativeCleanupLock(
    error: { code?: string; path?: string },
    sandbox: string,
    platform?: string,
    arch?: string,
    loadedModulePaths?: string[],
  ): boolean;
  installedPropertyFailure(
    index: number,
    result:
      | { ok: true }
      | {
          ok: false;
          error: {
            code: string;
            detail: string;
            phase: string;
            nativeWrite: string;
          };
        },
    sourcePreserved: boolean,
  ): Error;
};

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
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("installed package smoke", () => {
  it("reports a bounded typed reason when an installed property fails", async () => {
    expect(
      (
        await helper.installedPropertyFailure(
          0,
          {
            ok: false,
            error: {
              code: "publication-failed",
              detail: "Native no-replace publication could not complete.",
              phase: "execution",
              nativeWrite: "started",
            },
          },
          true,
        )
      ).message,
    ).toBe(
      "Installed property case failed: 0:publication-failed:execution:started:Native no-replace publication could not complete.",
    );
    expect(
      (await helper.installedPropertyFailure(1, { ok: true }, false)).message,
    ).toBe("Installed property source changed: 1");
  });

  it("defers only the exact loaded Windows native DLL cleanup lock", () => {
    const sandbox = join(tmpdir(), "exifcleaner-package-cleanup");
    const loadedDll = join(
      sandbox,
      "node_modules",
      "exifcleaner-node",
      "prebuilds",
      "win32-x64",
      "publication.node",
    );

    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EPERM", path: loadedDll },
        sandbox,
        "win32",
        "x64",
        [loadedDll],
      ),
    ).toBe(true);
    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EPERM", path: sandbox },
        sandbox,
        "win32",
        "x64",
        [loadedDll],
      ),
    ).toBe(true);
    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EPERM", path: `\\\\?\\${sandbox}` },
        sandbox,
        "win32",
        "x64",
        [loadedDll],
      ),
    ).toBe(true);
    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EPERM", path: join(sandbox, "source.webp") },
        sandbox,
        "win32",
        "x64",
        [loadedDll],
      ),
    ).toBe(false);
    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EPERM", path: sandbox },
        sandbox,
        "win32",
        "x64",
        [],
      ),
    ).toBe(false);
    expect(
      helper.isLoadedNativeCleanupLock(
        { code: "EACCES", path: loadedDll },
        sandbox,
        "win32",
        "x64",
        [loadedDll],
      ),
    ).toBe(false);
  });

  it("requires an explicit supplied tarball instead of packing the checkout", async () => {
    await expect(runSmoke([])).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("--tarball is required"),
    });
  });

  it("installs a current-host development tarball with scripts disabled and records bounded evidence", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "exifcleaner-package-smoke-"),
    );
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "current-host.tgz");

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
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      propertySeed: 460_046,
      propertyRuns: 25,
      corpusCases: [
        {
          id: "exifcleaner-sample",
          magicAdmission: true,
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          payloadDigests: expect.any(Array),
        },
        {
          id: "derived-two-frame-animation",
          magicAdmission: true,
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          payloadDigests: expect.any(Array),
        },
      ],
      cases: {
        sourcePreserved: true,
        published: true,
        collisionPreserved: true,
        cancellation: {
          code: "aborted",
          nativeWrite: "started",
          fallback: "do-not-fallback",
        },
        postCommitResidue: expect.any(String),
      },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/\/(?:Users|home|tmp)\//u);
  });

  it("rejects wrong tarball or manifest identity before installation", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "exifcleaner-package-identity-"),
    );
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "current-host.tgz");
    await helper.createDevelopmentTarballForTests({ packageRoot, tarball });

    for (const flag of ["--tarball-sha256", "--manifest-sha256"]) {
      const result = await runSmoke([
        "--tarball",
        tarball,
        flag,
        "0".repeat(64),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        flag === "--tarball-sha256"
          ? "Tarball digest mismatch"
          : "Corpus manifest digest mismatch",
      );
      expect(result.output).not.toContain("npm install");
    }
  });

  it("refuses final-release labeling for a current-host development tarball", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "exifcleaner-package-scope-"),
    );
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "current-host.tgz");
    await helper.createDevelopmentTarballForTests({ packageRoot, tarball });

    await expect(
      runSmoke(["--tarball", tarball, "--evidence-scope", "final-release"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("final-release"),
    });
  });

  it("fails before transaction work when the literal host tuple is absent", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "exifcleaner-package-host-"),
    );
    temporaryDirectories.push(temporary);
    const tarball = join(temporary, "not-a-tarball.tgz");
    await copyFile(join(packageRoot, "package.json"), tarball);

    await expect(
      runSmoke([
        "--tarball",
        tarball,
        "--evidence-scope",
        "development-current-host",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("Unrecognized archive format"),
    });
  });

  it("rejects missing, neighboring-only, and wrong-shape host artifacts before loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "exifcleaner-package-artifact-"));
    temporaryDirectories.push(root);
    const tuple = `${process.platform}-${process.arch}`;
    const neighbor = process.arch === "x64" ? "arm64" : "x64";
    const loader = join(root, "dist", "transaction", "native-publication.js");
    await mkdir(dirname(loader), { recursive: true });
    await writeFile(
      loader,
      `const literal = '../../prebuilds/${tuple}/publication.node';\n`,
    );
    await mkdir(join(root, "prebuilds", `${process.platform}-${neighbor}`), {
      recursive: true,
    });
    await writeFile(
      join(
        root,
        "prebuilds",
        `${process.platform}-${neighbor}`,
        "publication.node",
      ),
      "neighbor",
    );

    expect(() => helper.assertLiteralHostArtifact(root)).toThrow(
      `literal host artifact ${tuple}`,
    );

    await mkdir(join(root, "prebuilds", tuple, "publication.node"), {
      recursive: true,
    });
    expect(() => helper.assertLiteralHostArtifact(root)).toThrow(
      `literal host artifact ${tuple}`,
    );
  });

  it("declares the complete six-tuple, two-runtime, focused-oracle CI graph", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    for (const tuple of [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
    ])
      expect(workflow).toContain(`tuple: ${tuple}`);
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("node-22.json");
    expect(workflow).toContain("node-24.json");
    expect(workflow).toContain("FC_RUNS=200");
    expect(workflow).toContain("QUALIFICATION_PROPERTY_RUNS=25");
    expect(workflow).toContain("build-oracles.cjs --verify-authority");
    expect(workflow).toContain("tests/qualification/oracles.test.ts");
  });
});
