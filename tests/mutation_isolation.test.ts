// MUT-01 isolation guard for tools/mutation/ (the StrykerJS package), with
// negative controls. The script under test is the single source of the rules
// (also run in CI as `node tools/mutation/check-isolation.mjs`).
//
// Each negative control builds a throwaway tree (or git repo) and breaks exactly
// one rule, then asserts a NON-EMPTY problem list naming that rule, so a guard
// that silently returns [] cannot pass.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface IsolationScript {
  checkStaticIsolation(root: string): string[];
  checkInstalledIsolation(root: string): string[];
  checkManifestCoupling(baseRev: string, cwd: string): string[];
  resolveBaseRev(env: Record<string, string | undefined>): string;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = (await import(
  pathToFileURL(join(packageRoot, "tools", "mutation", "check-isolation.mjs"))
    .href
)) as IsolationScript;

const PACKAGES = ["core", "api", "vitest-runner", "typescript-checker"];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mut-iso-")));
  temporaryRoots.push(root);
  return root;
}

function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

interface TreeOptions {
  pins?: Record<string, string>;
  npmrc?: string | null;
  rootPackage?: Record<string, unknown>;
  rootLock?: string;
  lockVersion?: string;
}

/** A minimal valid tree; options break one rule at a time. */
function buildTree(options: TreeOptions = {}): string {
  const root = tempDir();
  const pins =
    options.pins ??
    Object.fromEntries(
      PACKAGES.map((p) => [`@stryker-mutator/${p}`, "10.1.1"]),
    );
  put(
    root,
    "tools/mutation/package.json",
    JSON.stringify({ name: "t", devDependencies: pins }),
  );
  put(
    root,
    "tools/mutation/package-lock.json",
    JSON.stringify({
      packages: Object.fromEntries(
        PACKAGES.map((p) => [
          `node_modules/@stryker-mutator/${p}`,
          { version: options.lockVersion ?? "10.1.1" },
        ]),
      ),
    }),
  );
  if (options.npmrc !== null)
    put(
      root,
      "tools/mutation/.npmrc",
      options.npmrc ?? "legacy-peer-deps=true\nfund=false\n",
    );
  put(
    root,
    "package.json",
    JSON.stringify(
      options.rootPackage ?? { name: "lib", scripts: { test: "vitest run" } },
    ),
  );
  put(root, "package-lock.json", options.rootLock ?? "{}");
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repo with a fake origin/main at the first commit and a branch commit. */
function buildRepo(branchFiles: string[]): string {
  const cwd = tempDir();
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.com");
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "commit.gpgsign", "false");
  put(cwd, "package.json", "{}");
  put(cwd, "package-lock.json", "{}");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(
    cwd,
    "update-ref",
    "refs/remotes/origin/main",
    git(cwd, "rev-parse", "HEAD"),
  );
  git(cwd, "switch", "-q", "-c", "work");
  for (const file of branchFiles) put(cwd, file, `${file} changed\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "work");
  return cwd;
}

describe("checkStaticIsolation (MUT-01)", () => {
  it("accepts the real tree", () => {
    expect(script.checkStaticIsolation(packageRoot)).toEqual([]);
  });

  it("accepts a well-formed temp tree (positive control for the fixtures)", () => {
    expect(script.checkStaticIsolation(buildTree())).toEqual([]);
  });

  it("flags unequal pins", () => {
    const pins = Object.fromEntries(
      PACKAGES.map((p, i) => [
        `@stryker-mutator/${p}`,
        i === 0 ? "10.1.0" : "10.1.1",
      ]),
    );
    const problems = script.checkStaticIsolation(buildTree({ pins }));
    expect(problems.join("\n")).toMatch(/not identical/);
  });

  it("flags a caret pin", () => {
    const pins = Object.fromEntries(
      PACKAGES.map((p) => [`@stryker-mutator/${p}`, "^10.1.1"]),
    );
    expect(script.checkStaticIsolation(buildTree({ pins })).join("\n")).toMatch(
      /not an exact/,
    );
  });

  it("flags a missing package", () => {
    const pins = Object.fromEntries(
      PACKAGES.slice(1).map((p) => [`@stryker-mutator/${p}`, "10.1.1"]),
    );
    expect(script.checkStaticIsolation(buildTree({ pins })).join("\n")).toMatch(
      /@stryker-mutator\/core missing/,
    );
  });

  it("flags a lockfile version that differs from the pin", () => {
    expect(
      script
        .checkStaticIsolation(buildTree({ lockVersion: "10.0.0" }))
        .join("\n"),
    ).toMatch(/lockfile version 10\.0\.0 differs/);
  });

  it("flags a missing legacy-peer-deps line", () => {
    expect(
      script
        .checkStaticIsolation(buildTree({ npmrc: "fund=false\n" }))
        .join("\n"),
    ).toMatch(/legacy-peer-deps=true/);
    expect(
      script.checkStaticIsolation(buildTree({ npmrc: null })).join("\n"),
    ).toMatch(/\.npmrc is missing/);
  });

  it("flags @stryker-mutator in a root manifest", () => {
    const inPackage = buildTree({
      rootPackage: {
        name: "lib",
        devDependencies: { "@stryker-mutator/core": "10.1.1" },
      },
    });
    expect(script.checkStaticIsolation(inPackage).join("\n")).toMatch(
      /root package\.json mentions/,
    );
    const inLock = buildTree({
      rootLock: '{"packages":{"node_modules/@stryker-mutator/core":{}}}',
    });
    expect(script.checkStaticIsolation(inLock).join("\n")).toMatch(
      /root package-lock\.json mentions/,
    );
  });

  it("flags a root stryker script and a root dependencies key", () => {
    const script1 = buildTree({
      rootPackage: { name: "lib", scripts: { mutate: "stryker run" } },
    });
    expect(script.checkStaticIsolation(script1).join("\n")).toMatch(
      /root script "mutate"/,
    );
    const deps = buildTree({
      rootPackage: { name: "lib", dependencies: { x: "1.0.0" } },
    });
    expect(script.checkStaticIsolation(deps).join("\n")).toMatch(
      /non-empty dependencies/,
    );
  });
});

describe("checkInstalledIsolation (MUT-01)", () => {
  function installedTree(): string {
    const root = buildTree();
    put(root, "node_modules/vitest/package.json", "{}");
    return root;
  }

  it("accepts a tree whose only vitest is the root copy", () => {
    expect(script.checkInstalledIsolation(installedTree())).toEqual([]);
  });

  it("flags a nested vitest", () => {
    const root = installedTree();
    put(root, "tools/mutation/node_modules/vitest/package.json", "{}");
    expect(script.checkInstalledIsolation(root).join("\n")).toMatch(
      /nested vitest/,
    );
  });

  it.skipIf(
    !existsSync(join(packageRoot, "tools", "mutation", "node_modules")),
  )(
    "accepts the real install (skipped when tools/mutation is not installed; CI runs main() after npm ci --prefix tools/mutation)",
    () => {
      expect(script.checkInstalledIsolation(packageRoot)).toEqual([]);
    },
  );
});

describe("resolveBaseRev", () => {
  it("defaults to origin/main, honours GITHUB_BASE_REF, and MUTATION_BASE_REV wins", () => {
    expect(script.resolveBaseRev({})).toBe("origin/main");
    expect(script.resolveBaseRev({ GITHUB_BASE_REF: "dev" })).toBe(
      "origin/dev",
    );
    expect(
      script.resolveBaseRev({
        MUTATION_BASE_REV: "HEAD^1",
        GITHUB_BASE_REF: "dev",
      }),
    ).toBe("HEAD^1");
  });
});

describe("checkManifestCoupling (MUT-01)", () => {
  it("flags tooling and the root manifest changing in one range", () => {
    const repo = buildRepo(["tools/mutation/x", "package.json"]);
    expect(
      script.checkManifestCoupling("origin/main", repo).join("\n"),
    ).toMatch(/package\.json changed in the same range/);
    const lock = buildRepo(["tools/mutation/x", "package-lock.json"]);
    expect(
      script.checkManifestCoupling("origin/main", lock).join("\n"),
    ).toMatch(/package-lock\.json changed/);
  });

  it("accepts a tooling-only range and a root-manifest-only range", () => {
    expect(
      script.checkManifestCoupling(
        "origin/main",
        buildRepo(["tools/mutation/x"]),
      ),
    ).toEqual([]);
    expect(
      script.checkManifestCoupling("origin/main", buildRepo(["package.json"])),
    ).toEqual([]);
  });

  it("fails closed when the base ref does not resolve", () => {
    const repo = buildRepo(["tools/mutation/x"]);
    expect(
      script.checkManifestCoupling("origin/does-not-exist", repo).join("\n"),
    ).toMatch(/fail closed/);
  });

  const baseRev = script.resolveBaseRev(process.env);
  let baseResolves = true;
  try {
    git(packageRoot, "rev-parse", "--verify", "--quiet", `${baseRev}^{commit}`);
  } catch {
    baseResolves = false;
  }
  it.skipIf(!baseResolves)(
    "the real branch range keeps tooling and root manifests apart (skipped when the base ref is not fetched; CI sets MUTATION_BASE_REV and runs main())",
    () => {
      expect(script.checkManifestCoupling(baseRev, packageRoot)).toEqual([]);
    },
  );
});
