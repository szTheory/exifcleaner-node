import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const gate = join(packageRoot, "scripts", "runtime_surface_gate.mjs");
const fixtureRoots: string[] = [];

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

  it("rejects a forbidden built runtime import with its path and module", async () => {
    const root = await createFixture();
    await writeFile(
      join(root, "dist", "index.js"),
      'import "node:http";\nexport const fixture = true;\n',
    );

    await expect(runGate(root)).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining(
        'dist/index.js: forbidden runtime import "node:http"',
      ),
    });
  });
});
