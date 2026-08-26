import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import packageManifest from "../package.json" with { type: "json" };
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const gate = join(packageRoot, "scripts", "runtime_surface_gate.mjs");
const fixtureRoots: string[] = [];
const require = createRequire(import.meta.url);
const artifacts = require("../scripts/native_artifacts.cjs");
const audit = require("../scripts/audit_native_artifact.cjs");

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exifcleaner-runtime-surface-"));
  fixtureRoots.push(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", exports: { ".": "./dist/index.js" }, files: ["dist", "LICENSE", "README.md"], ...overrides }, null, 2)}\n`,
  );
  await writeFile(join(root, "LICENSE"), "MIT\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await (await import("node:fs/promises")).mkdir(join(root, "dist"));
  await writeFile(
    join(root, "dist", "index.js"),
    "export const fixture = true;\n",
  );
  return root;
}

async function runGate(
  root: string,
  gatePath = gate,
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, [gatePath, root]);
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

function fixtureBinary(format: string, machine: string): Buffer {
  if (format === "elf") {
    const output = Buffer.alloc(20);
    output.write("\u007fELF", 0, "ascii");
    output.writeUInt16LE(machine === "x64" ? 62 : 183, 18);
    return output;
  }
  if (format === "macho") {
    const output = Buffer.alloc(8);
    output.writeUInt32BE(0xcffaedfe, 0);
    output.writeUInt32LE(machine === "x64" ? 0x01000007 : 0x0100000c, 4);
    return output;
  }
  const output = Buffer.alloc(128);
  output.write("MZ", 0, "ascii");
  output.writeUInt32LE(64, 60);
  output.write("PE\0\0", 64, "ascii");
  output.writeUInt16LE(machine === "x64" ? 0x8664 : 0xaa64, 68);
  return output;
}

function fixtureReport(tuple: string): string {
  const report = tuple.startsWith("linux")
    ? audit.auditLinux(
        "Shared library: [libc.so.6]",
        " UND napi_create_string_utf8\n UND renameat2",
      )
    : tuple.startsWith("darwin")
      ? audit.auditDarwin("\t/usr/lib/libSystem.B.dylib", " U _renamex_np")
      : audit.auditWindows("KERNEL32.dll", "    CreateFileW\n    HeapAlloc");
  return JSON.stringify({
    ...JSON.parse(report),
    evidenceScope: "test-fixture",
  });
}

async function createAssembly(): Promise<{
  root: string;
  manifest: string;
  reports: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "exifcleaner-exact-six-"));
  fixtureRoots.push(root);
  const reports = join(root, "audit-reports");
  await mkdir(reports);
  const reportRecords: Record<string, string> = {};
  for (const record of artifacts.EXACT_ARTIFACTS) {
    const target = join(root, record.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fixtureBinary(record.binaryFormat, record.machine));
    reportRecords[record.tuple] = fixtureReport(record.tuple);
    const report = reportRecords[record.tuple];
    if (report === undefined) throw new Error("fixture report was not created");
    await writeFile(join(reports, `${record.tuple}.json`), report);
  }
  const manifest = await artifacts.createManifest(root, reportRecords);
  const manifestPath = join(root, "native-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest: manifestPath, reports };
}

async function runArgs(
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, [gate, ...args]);
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

describe("runtime surface gate", () => {
  it("accepts the clean built package", async () => {
    await expect(runGate(packageRoot)).resolves.toEqual({
      exitCode: 0,
      output: expect.stringContaining("Runtime surface gate passed"),
    });
  });

  it("rejects each forbidden manifest surface with its path and reason", async () => {
    const dependency = await createFixture({
      dependencies: { telemetry: "1.0.0" },
    });
    const lifecycle = await createFixture({
      scripts: { install: "node setup.js" },
    });
    const extraExport = await createFixture({
      exports: { ".": "./dist/index.js", "./internal": "./dist/internal.js" },
    });

    await expect(runGate(dependency)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining(
        "package.json: runtime dependency section dependencies is forbidden",
      ),
    });
    await expect(runGate(lifecycle)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining(
        "package.json: lifecycle script install is forbidden",
      ),
    });
    await expect(runGate(extraExport)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining(
        "package.json: export subpath ./internal is forbidden",
      ),
    });
  });

  it("rejects an invalid package when directly invoked from a path containing spaces", async () => {
    const gateDirectory = await mkdtemp(
      join(tmpdir(), "exifcleaner runtime surface-"),
    );
    fixtureRoots.push(gateDirectory);
    const copiedGate = join(gateDirectory, "runtime surface gate.mjs");
    await copyFile(gate, copiedGate);
    const invalidPackage = await createFixture({
      dependencies: { telemetry: "1.0.0" },
    });

    const result = await runGate(invalidPackage, copiedGate);

    expect(result).toEqual({
      exitCode: 1,
      output: expect.stringContaining("Runtime surface gate failed:"),
    });
    expect(result).toMatchObject({
      output: expect.stringContaining(
        "package.json: runtime dependency section dependencies is forbidden",
      ),
    });
  });

  it.each([
    "node:http",
    "node:child_process",
    "node:http/promises",
    "node:child_process/promises",
    "http/promises",
    "child_process/promises",
  ])(
    "rejects forbidden built runtime import %s with its path and module",
    async (specifier) => {
      const root = await createFixture();
      await writeFile(
        join(root, "dist", "index.js"),
        `import ${JSON.stringify(specifier)};\nexport const fixture = true;\n`,
      );

      await expect(runGate(root)).resolves.toMatchObject({
        exitCode: 1,
        output: expect.stringContaining(
          `dist/index.js: forbidden runtime import ${JSON.stringify(specifier)}`,
        ),
      });
    },
  );

  it.each(["http2-extra", "child_processes", "node:fs/promises"])(
    "accepts allowed built runtime import %s without prefix matching",
    async (specifier) => {
      const root = await createFixture();
      await writeFile(
        join(root, "dist", "index.js"),
        `import ${JSON.stringify(specifier)};\nexport const fixture = true;\n`,
      );

      await expect(runGate(root)).resolves.toEqual({
        exitCode: 0,
        output: expect.stringContaining("Runtime surface gate passed"),
      });
    },
  );

  it("rejects runtime directory scanning and implicit build or download markers", async () => {
    const scanner = await createFixture();
    await writeFile(
      join(scanner, "dist", "index.js"),
      "import { readdir } from 'node:fs/promises';\nexport const fixture = readdir;\n",
    );
    const builder = await createFixture();
    await writeFile(
      join(builder, "dist", "index.js"),
      "export const fixture = 'npm install download';\n",
    );

    await expect(runGate(scanner)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("directory scan"),
    });
    await expect(runGate(builder)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("runtime build or download"),
    });
  });

  it("accepts deterministic exact-six fixtures only through the explicit test seam", async () => {
    const assembly = await createAssembly();

    await expect(
      runArgs([
        "--assembly-root",
        assembly.root,
        "--manifest",
        assembly.manifest,
        "--reports-dir",
        assembly.reports,
        "--evidence-scope",
        "test-fixture",
      ]),
    ).resolves.toMatchObject({
      exitCode: 0,
      output: expect.stringContaining("assembly gate passed"),
    });
    await expect(
      runArgs([
        "--assembly-root",
        assembly.root,
        "--manifest",
        assembly.manifest,
        "--reports-dir",
        assembly.reports,
        "--evidence-scope",
        "final-release",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("fixture evidence"),
    });
  });

  it("rejects stale manifests, extra native files, and packed-listing drift", async () => {
    const assembly = await createAssembly();
    const manifest = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(assembly.manifest, "utf8"),
    );
    manifest[0].sha256 = createHash("sha256").update("stale").digest("hex");
    const stale = join(assembly.root, "stale-manifest.json");
    await writeFile(stale, JSON.stringify(manifest));
    await expect(
      runArgs([
        "--assembly-root",
        assembly.root,
        "--manifest",
        stale,
        "--reports-dir",
        assembly.reports,
        "--evidence-scope",
        "test-fixture",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("hash is stale"),
    });

    await writeFile(
      join(assembly.root, "prebuilds", "linux-x64", "extra.node"),
      "fixture",
    );
    await expect(
      runArgs([
        "--assembly-root",
        assembly.root,
        "--manifest",
        assembly.manifest,
        "--reports-dir",
        assembly.reports,
        "--evidence-scope",
        "test-fixture",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("extra native"),
    });

    const listing = join(assembly.root, "packed-files.json");
    await writeFile(
      listing,
      JSON.stringify([
        "package.json",
        "dist/index.js",
        "prebuilds/linux-x64/publication.node",
      ]),
    );
    await expect(runArgs(["--packed-listing", listing])).resolves.toMatchObject(
      {
        exitCode: 1,
        output: expect.stringContaining("packed native path set"),
      },
    );
  });

  it("declares only the six literal D-50 artifacts for package packing", () => {
    expect(packageManifest.files).toEqual([
      "dist",
      "prebuilds/linux-x64/publication.node",
      "prebuilds/linux-arm64/publication.node",
      "prebuilds/darwin-x64/publication.node",
      "prebuilds/darwin-arm64/publication.node",
      "prebuilds/win32-x64/publication.node",
      "prebuilds/win32-arm64/publication.node",
      "LICENSE",
      "README.md",
    ]);
  });
});
