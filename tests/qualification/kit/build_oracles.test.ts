import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const scriptPath =
  require.resolve("../../../scripts/qualification/build-oracles.cjs");

interface PreparedTools extends FakeTools {
  readonly source: string;
  readonly dispose: () => void;
}

const buildOracles = require(scriptPath) as {
  readonly loadAndValidateAuthority: () => unknown;
  readonly prepareOracleTools: (options?: {
    readonly build?: (workspace: string) => FakeTools;
  }) => { readonly dispose: () => void };
  readonly prepareOracleDir: (
    dir: string,
    options: { readonly build: (workspace: string) => FakeTools },
  ) => FakeTools;
  readonly loadPreparedOracleTools: (
    dir: string,
    options?: { readonly probe?: () => void },
  ) => PreparedTools;
  readonly assertBuiltOnce: (dir: string) => void;
  readonly createOracleToolsLoader: (options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly build?: (workspace: string) => FakeTools;
    readonly probe?: () => void;
  }) => { readonly tools: () => PreparedTools };
  readonly assertHeifFeatures: (logs: {
    readonly aomConfigureLog: string;
    readonly heifConfigureLog: string;
  }) => void;
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

// A prepareOracleDir call measured ~2s on hosted runners; a test that
// prepares twice sat at the 5s default and timed out in CI (PR #30).
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
}, 30_000);

describe("build-oracles.cjs negative controls and edges (KIT-09 D-07)", () => {
  it("rejects a second prepare into the same directory (already claimed) while a second directory is independent", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-claim-"));
    const otherDir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-claim2-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });
      expect(() =>
        buildOracles.prepareOracleDir(dir, { build: fakeBuild }),
      ).toThrow(/already claimed/);
      expect(() =>
        buildOracles.prepareOracleDir(otherDir, { build: fakeBuild }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("fails assertBuiltOnce and the CLI on a directory with no builds.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-nolog-"));
    try {
      expect(() => buildOracles.assertBuiltOnce(dir)).toThrow(/no build log/);
      const result = spawnSync(process.execPath, [
        scriptPath,
        "--assert-built-once",
        dir,
      ]);
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails assertBuiltOnce on an empty builds.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-emptylog-"));
    try {
      writeFileSync(join(dir, "builds.log"), "");
      expect(() => buildOracles.assertBuiltOnce(dir)).toThrow(/built 0 times/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails assertBuiltOnce on a builds.log with two lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-twolines-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });
      appendFileSync(join(dir, "builds.log"), "stray build\n");
      expect(() => buildOracles.assertBuiltOnce(dir)).toThrow(/built 2 times/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails assertBuiltOnce when complete.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-nocomplete-"));
    try {
      writeFileSync(join(dir, "builds.log"), "one line\n");
      expect(() => buildOracles.assertBuiltOnce(dir)).toThrow(
        /is not complete/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses loadPreparedOracleTools on an interrupted prepare (build.claim and builds.log but no complete.json)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-interrupted-"));
    try {
      writeFileSync(join(dir, "build.claim"), "x\n");
      writeFileSync(join(dir, "builds.log"), "x\n");
      expect(() => buildOracles.loadPreparedOracleTools(dir)).toThrow(
        /is not complete/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a thrown build so a retry into the same dir works, while an already-claimed dir still refuses (WR-01)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-rollback-"));
    try {
      const throwingBuild = (): FakeTools => {
        throw new Error("transient toolchain crash");
      };
      expect(() =>
        buildOracles.prepareOracleDir(dir, { build: throwingBuild }),
      ).toThrow(/transient toolchain crash/);

      // The failed build must not leave a permanent claim: a retry into the
      // same directory builds successfully rather than failing with the
      // misleading "already claimed" error.
      expect(existsSync(join(dir, "build.claim"))).toBe(false);
      expect(existsSync(join(dir, "builds.log"))).toBe(false);
      expect(existsSync(join(dir, "complete.json"))).toBe(false);
      expect(() =>
        buildOracles.prepareOracleDir(dir, { build: fakeBuild }),
      ).not.toThrow();

      // The concurrent-second-build detection property is still intact: a
      // genuinely already-claimed (successfully completed) dir refuses a
      // second prepare.
      expect(() =>
        buildOracles.prepareOracleDir(dir, { build: fakeBuild }),
      ).toThrow(/already claimed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second prepare into a dir with an in-progress claim (no complete.json yet), independent of the rollback path (WR-01)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-inprogress-"));
    try {
      writeFileSync(join(dir, "build.claim"), "x\n");
      writeFileSync(join(dir, "builds.log"), "x\n");
      expect(() =>
        buildOracles.prepareOracleDir(dir, { build: fakeBuild }),
      ).toThrow(/already claimed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createOracleToolsLoader with CI set does not throw on construction, but throws EXIFCLEANER_ORACLE_DIR is required in CI on the first tools() call", () => {
    let loader: ReturnType<typeof buildOracles.createOracleToolsLoader>;
    expect(() => {
      loader = buildOracles.createOracleToolsLoader({ env: { CI: "true" } });
    }).not.toThrow();
    expect(() => loader.tools()).toThrow(
      /EXIFCLEANER_ORACLE_DIR is required in CI/,
    );
  });

  it("refuses a tampered cached executable with a sha256 mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-tamper-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });
      const toolAPath = join(dir, "workspace", "toolA");
      const bytes = readFileSync(toolAPath);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      writeFileSync(toolAPath, bytes);
      expect(() => buildOracles.loadPreparedOracleTools(dir)).toThrow(
        /cached oracle sha256 mismatch: toolA/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a complete.json tampered to point record.path outside dir, even with a matching sha256 (WR-02)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-escape-"));
    const outsideDir = mkdtempSync(
      join(tmpdir(), "exifcleaner-oracle-outside-"),
    );
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });

      // Plant a file outside `dir` with the same bytes (and therefore the
      // same sha256) as the real toolA, then repoint complete.json's
      // record.path at it.
      const realToolAPath = join(dir, "workspace", "toolA");
      const bytes = readFileSync(realToolAPath);
      const outsideToolAPath = join(outsideDir, "toolA");
      writeFileSync(outsideToolAPath, bytes);

      const completePath = join(dir, "complete.json");
      const complete = JSON.parse(readFileSync(completePath, "utf8"));
      complete.executables.toolA.path = outsideToolAPath;
      writeFileSync(completePath, JSON.stringify(complete, null, 2));

      expect(() => buildOracles.loadPreparedOracleTools(dir)).toThrow(
        /resolves outside/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("a cache-backed tools().dispose() leaves the directory listing unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-dispose-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });
      const before = readdirSync(dir).sort();
      const tools = buildOracles.loadPreparedOracleTools(dir, {
        probe: () => {},
      });
      tools.dispose();
      const after = readdirSync(dir).sort();
      expect(after).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two independent loaders on one prepared directory both return source cache, emit two cache-hit lines, and leave builds.log and the directory listing unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-twoload-"));
    try {
      buildOracles.prepareOracleDir(dir, { build: fakeBuild });
      const listing = () =>
        readdirSync(dir)
          .sort()
          .map((name) => ({
            name,
            mtimeMs: statSync(join(dir, name)).mtimeMs,
          }));
      const before = listing();
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const loaderA = buildOracles.createOracleToolsLoader({
          env: { EXIFCLEANER_ORACLE_DIR: dir },
          probe: () => {},
        });
        const loaderB = buildOracles.createOracleToolsLoader({
          env: { EXIFCLEANER_ORACLE_DIR: dir },
          probe: () => {},
        });
        expect(loaderA.tools().source).toBe("cache");
        expect(loaderB.tools().source).toBe("cache");
        const cacheHitCalls = stderrSpy.mock.calls.filter(
          ([chunk]) =>
            typeof chunk === "string" && chunk.includes("oracle cache hit"),
        );
        expect(cacheHitCalls.length).toBe(2);
      } finally {
        stderrSpy.mockRestore();
      }
      const buildsLogLines = readFileSync(join(dir, "builds.log"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(buildsLogLines.length).toBe(1);
      expect(listing()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepareOracleTools appends to builds.log when EXIFCLEANER_ORACLE_DIR is set, using an injected build so no real build runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "exifcleaner-oracle-stray-"));
    const original = process.env.EXIFCLEANER_ORACLE_DIR;
    try {
      process.env.EXIFCLEANER_ORACLE_DIR = dir;
      const tools = buildOracles.prepareOracleTools({ build: fakeBuild });
      tools.dispose();
    } finally {
      if (original === undefined) delete process.env.EXIFCLEANER_ORACLE_DIR;
      else process.env.EXIFCLEANER_ORACLE_DIR = original;
      const lines = readFileSync(join(dir, "builds.log"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines.length).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest copy with an inadmissible SPDX value on a new (HEIF) authority (D-20/D-21)", () => {
    const manifestPath = require.resolve("../../corpus/tools/manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    try {
      const manifest = JSON.parse(original);
      const heifIndex = manifest.authorities.findIndex(
        (item: { id: string }) => item.id === "libheif-1.23.5",
      );
      expect(heifIndex).toBeGreaterThanOrEqual(0);
      manifest.authorities[heifIndex].license.spdx = "GPL-2.0-only";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      expect(() => buildOracles.loadAndValidateAuthority()).toThrow(
        /license\.spdx is not admitted/,
      );
    } finally {
      writeFileSync(manifestPath, original, "utf8");
    }
    // Unmutated reload confirms the restore above actually took effect.
    const restored = buildOracles.loadAndValidateAuthority() as {
      authorities: ReadonlyArray<{ id: string }>;
    };
    expect(restored.authorities.map((item) => item.id)).toContain(
      "libheif-1.23.5",
    );
  });

  it("rejects a manifest copy with a new authority's id replaced (expected-id check, D-20/D-21)", () => {
    const manifestPath = require.resolve("../../corpus/tools/manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    try {
      const manifest = JSON.parse(original);
      const aomIndex = manifest.authorities.findIndex(
        (item: { id: string }) => item.id === "libaom-3.15.1",
      );
      expect(aomIndex).toBeGreaterThanOrEqual(0);
      // Keep the array at exactly eight entries (a length change hits the
      // earlier "exactly eight tool authorities are required" check first);
      // renaming the id in place isolates the order/ID-list check itself.
      manifest.authorities[aomIndex].id = "libaom-9.9.9";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      expect(() => buildOracles.loadAndValidateAuthority()).toThrow(
        /authority order and IDs are not exact/,
      );
    } finally {
      writeFileSync(manifestPath, original, "utf8");
    }
  });

  describe("assertHeifFeatures (D-21 configure-log drift gate)", () => {
    const GOOD_AOM_LOG = "--- aom_configure: Detected CPU: generic\n";
    const GOOD_HEIF_LOG =
      "libde265 HEVC decoder                : + built-in\n" +
      "AOM AV1 decoder                      : + built-in\n";

    it("passes on a log holding all three required lines", () => {
      expect(() =>
        buildOracles.assertHeifFeatures({
          aomConfigureLog: GOOD_AOM_LOG,
          heifConfigureLog: GOOD_HEIF_LOG,
        }),
      ).not.toThrow();
    });

    it("throws naming the aom CPU feature when its line is missing", () => {
      expect(() =>
        buildOracles.assertHeifFeatures({
          aomConfigureLog: "--- aom_configure: Detected CPU: x86_64\n",
          heifConfigureLog: GOOD_HEIF_LOG,
        }),
      ).toThrow(/libheif feature drift: aom target CPU is generic/);
    });

    it("throws naming the libde265 built-in feature when its line is missing", () => {
      expect(() =>
        buildOracles.assertHeifFeatures({
          aomConfigureLog: GOOD_AOM_LOG,
          heifConfigureLog:
            "AOM AV1 decoder                      : + built-in\n",
        }),
      ).toThrow(/libheif feature drift: libde265 HEVC decoder built in/);
    });

    it("throws naming the AOM built-in feature when its line is missing", () => {
      expect(() =>
        buildOracles.assertHeifFeatures({
          aomConfigureLog: GOOD_AOM_LOG,
          heifConfigureLog:
            "libde265 HEVC decoder                : + built-in\n",
        }),
      ).toThrow(/libheif feature drift: AOM AV1 decoder built in/);
    });
  });

  it("source scan: every oracles.ts module under tests/qualification/*/ calls loadOrPrepareOracleTools(), and none calls prepareOracleTools() directly", () => {
    // Discovers sibling qualification subdirectories on disk rather than naming
    // any of them literally, so this stays reusable by a future format's own
    // oracles.ts without this kit file ever carrying its name as a token.
    const qualificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const oraclesFiles = readdirSync(qualificationRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(qualificationRoot, entry.name, "oracles.ts"))
      .filter((filePath) => existsSync(filePath));
    expect(oraclesFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of oraclesFiles) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("prepareOracleTools()")).toBe(false);
      expect(text.includes("loadOrPrepareOracleTools()")).toBe(true);
    }
  });
}, 30_000);
