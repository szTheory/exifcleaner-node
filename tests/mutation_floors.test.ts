// MUT-03 floors check (D-16): the real-tree monotonic check against the base
// revision.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface Group {
  tier: string;
  globs: string[];
  floorTenths: number;
}
interface Scored {
  [group: string]: { scoreTenths: number };
}
type BaseRead =
  | { status: "ok"; text: string }
  | { status: "absent" }
  | { status: "error"; error: string };
interface FloorsScript {
  checkScores(scored: Scored[], floors: Record<string, Group>): string[];
  headroomHints(scored: Scored[], floors: Record<string, Group>): string[];
  checkMonotonic(baseText: string, headText: string): string[];
  readBaseFloors(baseRev: string, cwd?: string): BaseRead;
  resolveBaseRev(env: Record<string, string | undefined>): string;
  scoreReport(report: unknown, groups: Record<string, Group>): Scored;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const floorsPath = join(packageRoot, "mutation-floors.json");
const script = (await import(
  pathToFileURL(join(packageRoot, "tools", "mutation", "floors.mjs")).href
)) as FloorsScript;

/** The parent environment without any GIT_* variable, so git helpers act on the temp repository
 * they are pointed at even when the suite is launched from a hook or `git bisect run` (G15-WR-03). */
const cleanGitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );

describe("floors tracer (MUT-03, D-16)", () => {
  it("the real-tree floors never lower the base revision's floors", () => {
    const base = script.readBaseFloors(
      script.resolveBaseRev(process.env),
      packageRoot,
    );
    // error means the base ref cannot be resolved: fail closed, never skip.
    if (base.status === "error") throw new Error(base.error);
    if (base.status === "absent") return; // introduction: nothing to lower
    expect(
      script.checkMonotonic(base.text, readFileSync(floorsPath, "utf8")),
    ).toEqual([]);
  });
});

const grp = (floorTenths: number, globs: string[] = ["src/a/**"]): Group => ({
  tier: "trust",
  globs,
  floorTenths,
});
const text = (groups: Record<string, Group>): string =>
  JSON.stringify({ schemaVersion: 1, groups });

describe("checkScores controls (D-16)", () => {
  it("adjacency: 905 against floor 905 passes (positive control)", () => {
    expect(
      script.checkScores([{ webp: { scoreTenths: 905 } }], { webp: grp(905) }),
    ).toEqual([]);
  });

  it("adjacency: 904 against floor 905 fails naming group, measured and floor", () => {
    expect(
      script.checkScores([{ webp: { scoreTenths: 904 } }], { webp: grp(905) }),
    ).toEqual(["webp: measured 904 below floor 905"]);
  });

  it("uses the minimum across reports", () => {
    expect(
      script.checkScores(
        [{ webp: { scoreTenths: 950 } }, { webp: { scoreTenths: 904 } }],
        { webp: grp(905) },
      ),
    ).toEqual(["webp: measured 904 below floor 905"]);
  });

  it("a group missing from the report counts as measured 0", () => {
    expect(
      script.checkScores([{ png: { scoreTenths: 999 } }], { webp: grp(1) }),
    ).toEqual(["webp: measured 0 below floor 1"]);
  });
});

describe("fail-closed controls (G09-WR-01, G09-WR-02)", () => {
  it("a floor entry with a missing or non-numeric floorTenths fails checkScores", () => {
    for (const floorTenths of [undefined, null, "905", Number.NaN]) {
      const floors = {
        webp: { tier: "trust", globs: ["src/a/**"], floorTenths },
      } as unknown as Record<string, Group>;
      expect(
        script.checkScores([{ webp: { scoreTenths: 1000 } }], floors),
        String(floorTenths),
      ).toEqual(["webp: floorTenths is not a finite number"]);
    }
  });

  it("lowering a group's tier from trust fails the monotonic gate and a null head group is a removed group", () => {
    const base = text({ webp: grp(905) });
    const lowered = text({
      webp: { tier: "orchestration", globs: ["src/a/**"], floorTenths: 905 },
    });
    expect(script.checkMonotonic(base, lowered)).toEqual([
      "webp: tier lowered trust -> orchestration",
    ]);
    expect(script.checkMonotonic(base, text({ webp: grp(905) }))).toEqual([]);
    expect(
      script.checkMonotonic(
        base,
        JSON.stringify({ schemaVersion: 1, groups: { webp: null } }),
      ),
    ).toEqual(["webp: removed group"]);
  });
});

describe("checkMonotonic controls (D-16)", () => {
  const base = text({ webp: grp(500, ["src/a/**", "src/b/**"]) });

  it("a lowered floor is red", () => {
    expect(
      script.checkMonotonic(
        base,
        text({ webp: grp(499, ["src/a/**", "src/b/**"]) }),
      ),
    ).toEqual(["webp: lowered floor 500 -> 499"]);
  });

  it("a removed group is red", () => {
    expect(script.checkMonotonic(base, text({ other: grp(500) }))).toEqual([
      "webp: removed group",
    ]);
  });

  it("a shrunk glob list is red", () => {
    expect(
      script.checkMonotonic(base, text({ webp: grp(500, ["src/a/**"]) })),
    ).toEqual(["webp: glob list shrank: src/b/**"]);
  });

  it("an unparseable head is a problem", () => {
    expect(script.checkMonotonic(base, "{nope")[0]).toMatch(
      /head mutation-floors.json is not valid JSON/,
    );
  });

  it("raising a floor and adding a glob pass (positive control)", () => {
    expect(
      script.checkMonotonic(
        base,
        text({ webp: grp(600, ["src/a/**", "src/b/**", "src/c/**"]) }),
      ),
    ).toEqual([]);
  });
});

describe("floors main() exit codes in a temp git repo (D-16)", () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const root of temporaryRoots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: cleanGitEnv(),
    }).trim();

  /** A repo holding a copy of the scripts and the given floors at HEAD. */
  function repo(headFloors: string, originFloors: string | null | "none") {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "mut-floors-")));
    temporaryRoots.push(cwd);
    mkdirSync(join(cwd, "tools"), { recursive: true });
    cpSync(
      join(packageRoot, "tools", "mutation"),
      join(cwd, "tools", "mutation"),
      {
        recursive: true,
        filter: (src) => !src.includes("node_modules"),
      },
    );
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.email", "t@example.com");
    git(cwd, "config", "user.name", "t");
    git(cwd, "config", "commit.gpgsign", "false");
    if (originFloors !== "none") {
      if (originFloors !== null)
        writeFileSync(join(cwd, "mutation-floors.json"), originFloors);
      else writeFileSync(join(cwd, "placeholder"), "x");
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", "base");
      git(
        cwd,
        "update-ref",
        "refs/remotes/origin/main",
        git(cwd, "rev-parse", "HEAD"),
      );
    }
    writeFileSync(join(cwd, "mutation-floors.json"), headFloors);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "--allow-empty", "-m", "head");
    return cwd;
  }

  const run = (cwd: string, ...args: string[]) => {
    const env = cleanGitEnv();
    delete env.MUTATION_BASE_REV;
    delete env.GITHUB_BASE_REF;
    return spawnSync(
      process.execPath,
      [join(cwd, "tools", "mutation", "floors.mjs"), ...args],
      { cwd, env, encoding: "utf8" },
    );
  };

  const mutant = (line: number) => ({
    id: String(line),
    mutatorName: "BooleanLiteral",
    replacement: "false",
    status: "Killed",
    location: {
      start: { line, column: 0 },
      end: { line, column: 4 },
    },
  });
  const report = (files: string[]) =>
    JSON.stringify({
      files: Object.fromEntries(
        files.map((f) => [
          f,
          { language: "typescript", source: "true\n", mutants: [mutant(1)] },
        ]),
      ),
    });
  const floors = (n: number) => text({ g: grp(n, ["src/a/**"]) });

  it("no origin ref: monotonic exits 1 (unreadable base is red)", () => {
    const cwd = repo(floors(5), "none");
    const result = run(cwd, "monotonic");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/base origin\/main cannot be resolved/);
  });

  it("origin ref without the floors file: exits 0 and prints introduced", () => {
    const cwd = repo(floors(5), null);
    const result = run(cwd, "monotonic");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/introduced/);
  });

  it("origin commit resolves but its tree object is gone: exits 1 with an unreadable-base message, never introduced (G09-WR-04, D-27)", () => {
    // Head floors differ from the base floors so the base root tree is a
    // distinct object (an identical tree would be shared with HEAD).
    const cwd = repo(floors(6), floors(5));
    const baseTree = git(cwd, "rev-parse", "origin/main^{tree}");
    const headTree = git(cwd, "rev-parse", "HEAD^{tree}");
    expect(baseTree).not.toBe(headTree);
    const objectFile = join(
      cwd,
      ".git",
      "objects",
      baseTree.slice(0, 2),
      baseTree.slice(2),
    );
    expect(existsSync(objectFile)).toBe(true);
    rmSync(objectFile, { force: true });
    expect(existsSync(objectFile)).toBe(false);
    // The commit object itself still resolves (the precondition of the bug).
    expect(git(cwd, "cat-file", "-t", "origin/main")).toBe("commit");
    const result = run(cwd, "monotonic");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toMatch(/introduced/);
    expect(result.stderr).toMatch(
      /floors: cannot read mutation-floors\.json tree at origin\/main: /,
    );
  });

  it("origin with a higher floor than head: exits 1", () => {
    const cwd = repo(floors(5), floors(6));
    const result = run(cwd, "monotonic");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/g: lowered floor 6 -> 5/);
  }, 30_000);

  it("origin with an equal floor: exits 0 (positive control)", () => {
    const cwd = repo(floors(6), floors(6));
    expect(run(cwd, "monotonic").status).toBe(0);
  });

  it("scores on a report with a file outside every group exits 1", () => {
    const cwd = repo(floors(0), "none");
    const path = join(cwd, "r.json");
    writeFileSync(path, report(["src/a/x.ts", "src/zzz/y.ts"]));
    const result = run(cwd, "scores", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/src\/zzz\/y\.ts: matches 0 groups/);
  });

  it("scores on a report below a floor exits 1 naming the group", () => {
    const cwd = repo(floors(1001), "none");
    const path = join(cwd, "r.json");
    writeFileSync(path, report(["src/a/x.ts"]));
    const result = run(cwd, "scores", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/g: measured 1000 below floor 1001/);
  });

  it("scores above the floors exits 0 and never rewrites the floors file (positive control)", () => {
    const cwd = repo(floors(1000), "none");
    const path = join(cwd, "r.json");
    writeFileSync(path, report(["src/a/x.ts"]));
    const sha = () =>
      createHash("sha256")
        .update(readFileSync(join(cwd, "mutation-floors.json")))
        .digest("hex");
    const before = sha();
    const result = run(cwd, "scores", path);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/hint g: min 1000, floor 1000, headroom 0/);
    expect(sha()).toBe(before);
  });
});
