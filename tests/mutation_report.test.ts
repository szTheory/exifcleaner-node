import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs tooling scripts without type declarations
import { checkGroupCoverage, globToRegExp } from "../tools/mutation/groups.mjs";
import {
  collapsedDigest,
  keyedMutants,
  mutantKey,
  // @ts-expect-error plain .mjs tooling scripts without type declarations
} from "../tools/mutation/identity.mjs";
// @ts-expect-error plain .mjs tooling scripts without type declarations
import { scoreGroups } from "../tools/mutation/score.mjs";

// Tests of the mutation measurement scripts under tools/mutation/ (MUT-03).
// They test the scripts, not src, so they are excluded from the Stryker run.

const ROOT = join(__dirname, "..");

type Status =
  | "Killed"
  | "Timeout"
  | "Survived"
  | "NoCoverage"
  | "CompileError"
  | "RuntimeError"
  | "Ignored";

interface Mutant {
  id: string;
  mutatorName: string;
  replacement: string;
  statusReason?: string;
  status: Status;
  static: boolean;
  coveredBy?: string[];
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

interface Report {
  schemaVersion: string;
  files: Record<
    string,
    { language: string; source: string; mutants: Mutant[] }
  >;
}

function mutant(
  id: number,
  status: Status,
  line: number,
  extra: Partial<Mutant> = {},
): Mutant {
  return {
    id: String(id),
    mutatorName: "StringLiteral",
    replacement: '""',
    status,
    static: false,
    location: {
      start: { line, column: 1 },
      end: { line, column: 9 },
    },
    ...extra,
  };
}

const GROUPS = {
  webp: { globs: ["src/webp/**"] },
  png: { globs: ["src/png/**"] },
};

/** Pattern 2 shape: two files, eight mutants, every status present. */
function fixture(): Report {
  return {
    schemaVersion: "1.0",
    files: {
      "src/webp/riff.ts": {
        language: "typescript",
        source: "",
        mutants: [
          mutant(1, "Killed", 10),
          mutant(2, "Killed", 20),
          mutant(3, "Survived", 30),
          mutant(4, "CompileError", 40),
        ],
      },
      "src/png/chunks.ts": {
        language: "typescript",
        source: "",
        mutants: [
          mutant(5, "Timeout", 10),
          mutant(6, "NoCoverage", 20),
          mutant(7, "RuntimeError", 30),
          mutant(8, "Ignored", 40, {
            static: true,
            statusReason: 'Static mutant (and "ignoreStatic" was enabled)',
          }),
        ],
      },
    },
  };
}

describe("mutation score tracer (MUT-03)", () => {
  it("scores the inline Pattern 2 fixture with exact counts", () => {
    const scores = scoreGroups(fixture(), GROUPS);
    // webp: detected 2 (Killed x2), undetected 1 (Survived); CompileError excluded.
    //   floor(1000 * 2 / 3) = 666 tenths; covered = 2 / (2 + 1) = 666.
    expect(scores.webp.counts).toEqual({
      Killed: 2,
      Timeout: 0,
      Survived: 1,
      NoCoverage: 0,
      CompileError: 1,
      RuntimeError: 0,
      Ignored: 0,
    });
    expect(scores.webp.scoreTenths).toBe(666);
    expect(scores.webp.coveredScoreTenths).toBe(666);
    // png: detected 1 (Timeout), undetected 1 (NoCoverage); RuntimeError and
    //   Ignored excluded. floor(1000 * 1 / 2) = 500; covered = 1 / (1 + 0) = 1000.
    expect(scores.png.counts).toEqual({
      Killed: 0,
      Timeout: 1,
      Survived: 0,
      NoCoverage: 1,
      CompileError: 0,
      RuntimeError: 1,
      Ignored: 1,
    });
    expect(scores.png.scoreTenths).toBe(500);
    expect(scores.png.coveredScoreTenths).toBe(1000);
    expect(scores.png.timeout).toBe(1);
    expect(scores.png.staticIgnored).toBe(1);
    expect(scores.png.commentIgnored).toBe(0);
    expect(scores.png.pluginIgnored).toBe(0);
  });

  it("scores the real 67-01 riff.ts report when one is present", () => {
    const path = join(ROOT, "reports", "mutation", "mutation.json");
    if (!existsSync(path)) return; // generated, git-ignored; absent on a clean checkout
    const report = JSON.parse(readFileSync(path, "utf8")) as Report;
    const floors = JSON.parse(
      readFileSync(join(ROOT, "mutation-floors.json"), "utf8"),
    ) as { groups: Record<string, { globs: string[] }> };
    const only = Object.fromEntries(
      Object.entries(floors.groups).filter(([name]) => name === "webp"),
    );
    report.files = Object.fromEntries(
      Object.entries(report.files).filter(([f]) => f.startsWith("src/webp/")),
    );
    const scores = scoreGroups(report, only);
    expect(
      scores.webp.detected + scores.webp.undetected,
    ).toBeGreaterThanOrEqual(1);
  });
});

const REAL_GROUPS = (
  JSON.parse(readFileSync(join(ROOT, "mutation-floors.json"), "utf8")) as {
    groups: Record<string, { globs: string[] }>;
  }
).groups;

function shuffle<T>(items: T[]): T[] {
  return [...items]
    .reverse()
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? 1 : -1));
}

function shuffled(report: Report): Report {
  const files = Object.entries(report.files)
    .reverse()
    .map(([name, f]) => [name, { ...f, mutants: shuffle(f.mutants) }] as const);
  return { ...report, files: Object.fromEntries(files) };
}

describe("globToRegExp (D-14)", () => {
  it("handles ** depth, alternation and anchoring", () => {
    const iso = globToRegExp("src/isobmff/**");
    expect(iso.test("src/isobmff/a.ts")).toBe(true);
    expect(iso.test("src/isobmff/x/y.ts")).toBe(true);
    expect(iso.test("src/isobmffx.ts")).toBe(false);
    const handlers = globToRegExp(
      "src/admission/{isobmff,heic,avif}-handler.ts",
    );
    for (const n of ["isobmff", "heic", "avif"])
      expect(handlers.test(`src/admission/${n}-handler.ts`)).toBe(true);
    expect(handlers.test("src/admission/png-handler.ts")).toBe(false);
    const top = globToRegExp("src/{engine,index}.ts");
    expect(top.test("src/engine.ts")).toBe(true);
    expect(top.test("src/engine/x.ts")).toBe(false);
    expect(top.test("src/engineXts")).toBe(false);
  });
});

describe("group coverage over src (D-14)", () => {
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", "src/*.ts", "src/**/*.ts"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter((p) => p !== "");

  it("puts every tracked src file in exactly one group", () => {
    expect(tracked.length).toBeGreaterThanOrEqual(45);
    expect(checkGroupCoverage(tracked, REAL_GROUPS)).toEqual([]);
  });

  it("control: a file in no group is red", () => {
    expect(
      checkGroupCoverage([...tracked, "src/new/x.ts"], REAL_GROUPS),
    ).toEqual(["src/new/x.ts: matches 0 groups"]);
  });

  it("control: an overlapping glob is red", () => {
    const overlapping = {
      ...REAL_GROUPS,
      png: {
        ...REAL_GROUPS.png!,
        globs: [...REAL_GROUPS.png!.globs, "src/webp/**"],
      },
    };
    const problems = checkGroupCoverage(tracked, overlapping);
    expect(problems).toContain(
      "src/webp/riff.ts: matches 2 groups (webp, png)",
    );
  });
});

describe("identity and score edge controls (D-13, D-15)", () => {
  it("ordering: a shuffled report gives identical keys, digest and scores", () => {
    const a = fixture();
    const b = shuffled(a);
    expect([...keyedMutants(b).keys()].sort()).toEqual(
      [...keyedMutants(a).keys()].sort(),
    );
    expect(collapsedDigest(b)).toBe(collapsedDigest(a));
    expect(scoreGroups(b, GROUPS)).toEqual(scoreGroups(a, GROUPS));
  });

  it("ordering: the digest changes when a status changes class", () => {
    const a = fixture();
    const b = fixture();
    b.files["src/webp/riff.ts"]!.mutants[2]!.status = "Killed";
    expect(collapsedDigest(b)).not.toBe(collapsedDigest(a));
  });

  it("empty: empty inputs and groups without a scorable mutant error", () => {
    expect(() => keyedMutants({})).toThrow("report has no files map");
    expect(() => keyedMutants({ files: {} })).toThrow("zero mutants");
    expect(() =>
      keyedMutants({
        files: { "src/webp/riff.ts": { language: "typescript", mutants: [] } },
      }),
    ).toThrow("zero mutants");
    expect(() => scoreGroups({}, GROUPS)).toThrow();
    const onlyCompile: Report = {
      schemaVersion: "1.0",
      files: {
        "src/webp/riff.ts": {
          language: "typescript",
          source: "",
          mutants: [mutant(1, "CompileError", 1), mutant(2, "Ignored", 2)],
        },
        "src/png/chunks.ts": {
          language: "typescript",
          source: "",
          mutants: [mutant(3, "Killed", 1)],
        },
      },
    };
    expect(() => scoreGroups(onlyCompile, GROUPS)).toThrow(
      "group webp has no scorable mutant",
    );
  });

  it("empty: a file outside every group is an error, never ignored", () => {
    const r = fixture();
    r.files["src/other/x.ts"] = {
      language: "typescript",
      source: "",
      mutants: [mutant(9, "Killed", 1)],
    };
    expect(() => scoreGroups(r, GROUPS)).toThrow(
      "src/other/x.ts: matches 0 groups",
    );
  });

  it("adjacency: touching ranges get distinct keys, identical tuples are rejected", () => {
    const first = mutant(1, "Killed", 5);
    const second = mutant(2, "Killed", 5, {
      location: { start: { line: 5, column: 9 }, end: { line: 5, column: 12 } },
    });
    expect(mutantKey("src/webp/riff.ts", first)).not.toBe(
      mutantKey("src/webp/riff.ts", second),
    );
    const ok: Report = {
      schemaVersion: "1.0",
      files: {
        "src/webp/riff.ts": {
          language: "typescript",
          source: "",
          mutants: [first, second],
        },
      },
    };
    expect(keyedMutants(ok).size).toBe(2);
    const dup: Report = {
      schemaVersion: "1.0",
      files: {
        "src/webp/riff.ts": {
          language: "typescript",
          source: "",
          mutants: [first, { ...first, id: "99" }],
        },
      },
    };
    expect(() => keyedMutants(dup)).toThrow("duplicate mutant key");
  });

  it("the key ignores the Stryker id", () => {
    expect(mutantKey("f", mutant(1, "Killed", 3))).toBe(
      mutantKey("f", mutant(777, "Survived", 3)),
    );
  });

  it("a forged top-level score does not change the computed score", () => {
    const forged = {
      ...fixture(),
      mutationScore: 100,
      metrics: { score: 100 },
    };
    expect(scoreGroups(forged, GROUPS)).toEqual(scoreGroups(fixture(), GROUPS));
    expect(scoreGroups(forged, GROUPS).webp.scoreTenths).toBe(666);
  });

  it("counts comment-ignored and plugin-ignored separately from static", () => {
    const r = fixture();
    r.files["src/webp/riff.ts"]!.mutants.push(
      mutant(20, "Ignored", 50, { statusReason: "Ignored using a comment" }),
      mutant(21, "Ignored", 60, {
        statusReason: "error-message: throw argument",
      }),
    );
    const w = scoreGroups(r, GROUPS).webp;
    expect(w.commentIgnored).toBe(1);
    expect(w.pluginIgnored).toBe(1);
    expect(w.staticIgnored).toBe(0);
    expect(w.scoreTenths).toBe(666);
  });
});
