import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const scriptPath =
  require.resolve("../../../scripts/qualification/build-oracles.cjs");
const buildOracles = require(scriptPath) as {
  readonly loadAndValidateAuthority: () => unknown;
  readonly prepareOracleDir: (
    dir: string,
    options: { readonly build: (workspace: string) => FakeTools },
  ) => FakeTools;
  readonly createOracleToolsLoader: (options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly build?: (workspace: string) => FakeTools;
    readonly probe?: () => void;
  }) => { readonly tools: () => { readonly source: string } };
};

interface FakeExecutable {
  readonly path: string;
  readonly sha256: string;
}

interface FakeTools {
  readonly authority: unknown;
  readonly [name: string]: unknown;
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * A minimal, injectable `build` function for `prepareOracleDir`/`prepareOracleTools`:
 * writes three small placeholder executables into `workspace` and returns a tools
 * record whose `authority` field equals the real `authoritySummary` of the committed
 * tools manifest (via `loadAndValidateAuthority()`, which runs on any host). Never
 * invokes the real linux/x64-only build, so the tracer and its negative controls run
 * on any host.
 */
export function fakeBuild(workspace: string): FakeTools {
  mkdirSync(workspace, { recursive: true });
  const authority = buildOracles.loadAndValidateAuthority();
  const tools: Record<string, unknown> = { authority };
  for (const name of ["toolA", "toolB", "toolC"]) {
    const filePath = join(workspace, name);
    writeFileSync(filePath, `#!/bin/sh\necho ${name}\n`);
    const record: FakeExecutable = {
      path: filePath,
      sha256: digest(readFileSync(filePath)),
    };
    tools[name] = record;
  }
  return tools as FakeTools;
}

describe("build-oracles.cjs prepare/cache/assert (KIT-09)", () => {
  it("prepares into a directory, loads it read-only through a cache loader, and asserts one build (tracer)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-dir-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });

      const loader = buildOracles.createOracleToolsLoader({
        env: { CI: "true", EXIFCLEANER_ORACLE_DIR: dir },
        probe: () => {},
      });
      const tools = loader.tools();
      expect(tools.source).toBe("cache");

      const result = spawnSync(process.execPath, [
        scriptPath,
        "--assert-built-once",
        dir,
      ]);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
