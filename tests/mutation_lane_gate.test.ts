import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffAttempts,
  main as flakeMain,
  // @ts-expect-error plain .mjs tooling scripts without type declarations
} from "../tools/mutation/flake-diff.mjs";
// @ts-expect-error plain .mjs tooling scripts without type declarations
import { evaluateGate, renderSummary } from "../tools/mutation/lane-gate.mjs";
// @ts-expect-error plain .mjs tooling scripts without type declarations
import { decidePlan } from "../tools/mutation/lane.mjs";

// Tests of the advisory PR mutation lane scripts (MUT-04; D-25, D-26, D-27).
// They test tools/mutation scripts, not src, so they are excluded from the Stryker run.

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
  status: Status;
  statusReason?: string;
  static: boolean;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}
interface Report {
  files: Record<
    string,
    { language: string; source: string; mutants: Mutant[] }
  >;
}

let line = 0;
function mutant(
  status: Status,
  extra: Partial<Mutant> = {},
  at: number = ++line,
): Mutant {
  return {
    id: String(at),
    mutatorName: "StringLiteral",
    replacement: '""',
    status,
    static: false,
    location: {
      start: { line: at, column: 1 },
      end: { line: at, column: 5 },
    },
    ...extra,
  };
}
function report(files: Record<string, Mutant[]>): Report {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([f, mutants]) => [
        f,
        { language: "typescript", source: "", mutants },
      ]),
    ),
  };
}

const FLOORS = {
  groups: {
    webp: { tier: "trust", globs: ["src/webp/**"], floorTenths: 0 },
    engine: { tier: "orchestration", globs: ["src/engine.ts"], floorTenths: 0 },
  },
};
const CLASSES = JSON.parse(
  readFileSync(join(ROOT, "tools/mutation/classes.json"), "utf8"),
);
const PROCEED = (files: string[]) => ({
  verdict: "proceed",
  reason: "mode run",
  files,
  smoke: false,
  run: true,
});
const RUN_OK = { exitCode: 0, signal: null, durationSeconds: 3 };

function gate(
  files: Record<string, Mutant[]>,
  over: Record<string, unknown> = {},
) {
  return evaluateGate({
    plan: PROCEED(Object.keys(files)),
    run: RUN_OK,
    smoke: null,
    report: report(files),
    floors: FLOORS,
    classes: CLASSES,
    headSha: "h",
    baseSha: "b",
    strykerVersion: "10.1.1",
    ...over,
  });
}

describe("lane tracer on the real report", () => {
  const realPath = join(ROOT, "reports", "mutation", "mutation.json");
  it("judges the tracer's mutation.json with a typed, non-empty verdict", () => {
    if (!existsSync(realPath)) return; // reports/ is gitignored; CI has none
    const real = JSON.parse(readFileSync(realPath, "utf8")) as Report;
    const files = Object.keys(real.files);
    const floors = JSON.parse(
      readFileSync(join(ROOT, "mutation-floors.json"), "utf8"),
    );
    const result = evaluateGate({
      plan: PROCEED(files),
      run: RUN_OK,
      smoke: null,
      report: real,
      floors,
      classes: CLASSES,
    });
    expect(["pass", "fail"]).toContain(result.verdict);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.collapsedDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("evaluateGate verdicts (D-26)", () => {
  it("undetected: a Survived webp mutant fails and its key is listed", () => {
    const r = gate({
      "src/webp/riff.ts": [mutant("Killed"), mutant("Survived")],
    });
    expect(r.verdict).toBe("fail");
    expect(r.undetectedKeys).toHaveLength(1);
    expect(r.undetectedKeys[0]).toContain("src/webp/riff.ts");
    expect(r.reason).not.toBe("");
  });

  it("a NoCoverage webp mutant fails", () => {
    const r = gate({ "src/webp/riff.ts": [mutant("NoCoverage")] });
    expect(r.verdict).toBe("fail");
  });

  it("missing reason: Ignored using a comment (Stryker default) fails", () => {
    const r = gate({
      "src/webp/riff.ts": [
        mutant("Ignored", { statusReason: "Ignored using a comment" }),
      ],
    });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toContain("Ignored without a valid reason");
  });

  it("an Ignored mutant with a lint-valid class reason passes", () => {
    const r = gate({
      "src/webp/riff.ts": [
        mutant("Killed"),
        mutant("Ignored", {
          statusReason: "unobservable-message — message text only",
        }),
      ],
    });
    expect(r.verdict).toBe("pass");
  });

  it("error-message: and static Ignored mutants pass", () => {
    const r = gate({
      "src/webp/riff.ts": [
        mutant("Killed"),
        mutant("Ignored", { statusReason: "error-message: x (D-20)" }),
        mutant("Ignored", { static: true, statusReason: "Ignored static" }),
      ],
    });
    expect(r.verdict).toBe("pass");
  });

  it("only Killed, Timeout and CompileError mutants pass", () => {
    const r = gate({
      "src/webp/riff.ts": [
        mutant("Killed"),
        mutant("Timeout"),
        mutant("CompileError"),
      ],
    });
    expect(r.verdict).toBe("pass");
    expect(r.undetectedKeys).toEqual([]);
    expect(r.collapsedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.perFile["src/webp/riff.ts"].counts.Timeout).toBe(1);
  });

  it("a Survived mutant only in orchestration is info", () => {
    const r = gate({ "src/engine.ts": [mutant("Killed"), mutant("Survived")] });
    expect(r.verdict).toBe("info");
    expect(r.undetectedKeys).toHaveLength(1);
  });

  it("noop plan yields noop, error plan yields error", () => {
    const noop = gate({}, { plan: { verdict: "noop", reason: "nothing" } });
    expect(noop.verdict).toBe("noop");
    const err = gate({}, { plan: { verdict: "error", reason: "bad" } });
    expect(err.verdict).toBe("error");
  });

  it("missing mutation.json is verdict error", () => {
    const r = gate(
      { "src/webp/riff.ts": [mutant("Killed")] },
      { report: null, reportError: "missing" },
    );
    expect(r.verdict).toBe("error");
    expect(r.reason).toContain("missing");
  });

  it("a non-zero Stryker exit or a signal is verdict error, never pass", () => {
    const files = { "src/webp/riff.ts": [mutant("Killed")] };
    expect(
      gate(files, { run: { exitCode: 1, signal: null, durationSeconds: 1 } })
        .verdict,
    ).toBe("error");
    expect(
      gate(files, {
        run: { exitCode: null, signal: "SIGTERM", durationSeconds: 1 },
      }).verdict,
    ).toBe("error");
    expect(gate(files, { run: null }).verdict).toBe("error");
  });

  it("a requested file absent from the report is verdict error", () => {
    const r = gate(
      { "src/webp/riff.ts": [mutant("Killed")] },
      { plan: PROCEED(["src/webp/riff.ts", "src/webp/other.ts"]) },
    );
    expect(r.verdict).toBe("error");
    expect(r.reason).toContain("src/webp/other.ts");
  });

  it("a failed smoke is verdict error; a passed smoke-only plan passes", () => {
    const plan = { verdict: "proceed", files: [], smoke: true, run: false };
    expect(
      gate({}, { plan, smoke: { result: "fail", durationSeconds: 2 } }).verdict,
    ).toBe("error");
    expect(gate({}, { plan, smoke: null }).verdict).toBe("error");
    const ok = gate(
      {},
      { plan, smoke: { result: "pass", durationSeconds: 2 } },
    );
    expect(ok.verdict).toBe("pass");
    expect(ok.smoke).toBe("pass");
  });

  it("a file in no group is verdict error (fail closed)", () => {
    const r = gate({ "src/other/x.ts": [mutant("Killed")] });
    expect(r.verdict).toBe("error");
  });

  it("an unknown mutant status is verdict error", () => {
    const r = gate({
      "src/webp/riff.ts": [mutant("Weird" as unknown as Status)],
    });
    expect(r.verdict).toBe("error");
  });

  it("is order-independent: permuted files and mutants give one digest", () => {
    const a = mutant("Killed", {}, 1);
    const b = mutant("Survived", {}, 2);
    const c = mutant("Killed", {}, 3);
    const one = gate({ "src/webp/riff.ts": [a, b], "src/webp/x.ts": [c] });
    const two = gate({ "src/webp/x.ts": [c], "src/webp/riff.ts": [b, a] });
    expect(two.collapsedDigest).toBe(one.collapsedDigest);
    expect(two.undetectedKeys).toEqual(one.undetectedKeys);
  });

  it("renders a markdown table headed by the verdict", () => {
    const md = renderSummary(
      gate({ "src/webp/riff.ts": [mutant("Killed"), mutant("Survived")] }),
    );
    expect(md).toContain("### Mutation lane (advisory): fail");
    expect(md).toContain("| src/webp/riff.ts | webp | trust | 1 | 0 | 1 |");
  });
});

describe("decidePlan (D-25)", () => {
  const plan = (mode: string, list: string, event = "pull_request") =>
    decidePlan({
      LANE_EVENT_NAME: event,
      MUTATE_MODE: mode,
      MUTATE_LIST: list,
    });

  it("a push event is noop with the D-25 reason", () => {
    const p = plan("run", "src/webp/riff.ts", "push");
    expect(p.verdict).toBe("noop");
    expect(p.reason).toBe("event push is not pull_request (D-25)");
    expect(p.run).toBe(false);
  });
  it("tests-only is noop 'tests changed, not mutated'", () => {
    const p = plan("tests-only", "");
    expect(p.verdict).toBe("noop");
    expect(p.reason).toBe("tests changed, not mutated");
  });
  it("none with an empty list is noop; with a list it is error", () => {
    expect(plan("none", "").verdict).toBe("noop");
    expect(plan("none", "src/a.ts").verdict).toBe("error");
  });
  it("error and unknown modes are error", () => {
    expect(plan("error", "").verdict).toBe("error");
    expect(plan("bogus", "").verdict).toBe("error");
  });
  it("run with an empty list is error (inconsistent classifier output)", () => {
    expect(plan("run", "").verdict).toBe("error");
    expect(plan("run+smoke", "").verdict).toBe("error");
  });
  it("smoke, run and run+smoke set install plus the matching legs", () => {
    const s = plan("smoke", "");
    expect([s.verdict, s.install, s.smoke, s.run]).toEqual([
      "proceed",
      true,
      true,
      false,
    ]);
    const r = plan("run", "src/webp/riff.ts:88-100,src/engine.ts");
    expect([r.install, r.smoke, r.run]).toEqual([true, false, true]);
    expect(r.files).toEqual(["src/engine.ts", "src/webp/riff.ts"]);
    const b = plan("run+smoke", "src/a.ts");
    expect([b.install, b.smoke, b.run]).toEqual([true, true, true]);
  });
  it("an unsafe entry is error", () => {
    expect(plan("run", "src/a.ts;rm -rf /").verdict).toBe("error");
    expect(plan("run", "../x.ts").verdict).toBe("error");
  });
});

describe("lane.mjs as a child process", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function sandbox(): string {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lane-gate-")));
    dirs.push(cwd);
    mkdirSync(join(cwd, "tools", "mutation"), { recursive: true });
    for (const name of readdirSync(join(ROOT, "tools", "mutation"))) {
      if (/\.(mjs|json)$/.test(name) && name !== "package-lock.json")
        cpSync(
          join(ROOT, "tools", "mutation", name),
          join(cwd, "tools", "mutation", name),
        );
    }
    writeFileSync(join(cwd, "mutation-floors.json"), JSON.stringify(FLOORS));
    return cwd;
  }
  function lane(cwd: string, sub: string, env: Record<string, string>) {
    const out = join(cwd, "github-output");
    const summary = join(cwd, "step-summary");
    const done = spawnSync(
      process.execPath,
      [join(cwd, "tools", "mutation", "lane.mjs"), sub],
      {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: summary,
          ...env,
        },
      },
    );
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    const gateFile = join(cwd, "reports", "mutation", "gate-result.json");
    return {
      status: done.status,
      stderr: done.stderr,
      output: read(out),
      summary: read(summary),
      result: existsSync(gateFile)
        ? JSON.parse(readFileSync(gateFile, "utf8"))
        : null,
    };
  }
  function put(cwd: string, name: string, value: unknown) {
    mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
    writeFileSync(
      join(cwd, "reports", "mutation", name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  it("empty list noop: plan exits 0 and writes false flags with no Stryker binary", () => {
    const cwd = sandbox();
    const planned = lane(cwd, "plan", {
      LANE_EVENT_NAME: "pull_request",
      MUTATE_MODE: "none",
      MUTATE_LIST: "",
    });
    expect(planned.status).toBe(0);
    expect(planned.output).toBe("install=false\nsmoke=false\nrun=false\n");
    const run = lane(cwd, "run", { MUTATE_LIST: "" });
    expect(run.status).toBe(0);
    expect(existsSync(join(cwd, "reports", "mutation", "lane-run.json"))).toBe(
      false,
    );
    const g = lane(cwd, "gate", { LANE_HEAD_SHA: "h", LANE_BASE_SHA: "b" });
    expect(g.status).toBe(0);
    expect(g.result.verdict).toBe("noop");
    expect(g.summary).toContain("noop");
  });

  it("plan error exits 1 and the gate is verdict error", () => {
    const cwd = sandbox();
    const planned = lane(cwd, "plan", {
      LANE_EVENT_NAME: "pull_request",
      MUTATE_MODE: "run",
      MUTATE_LIST: "",
    });
    expect(planned.status).toBe(1);
    const g = lane(cwd, "gate", {});
    expect(g.status).toBe(1);
    expect(g.result.verdict).toBe("error");
  });

  it("missing mutation.json after a run plan: gate exits 1 with verdict error", () => {
    const cwd = sandbox();
    lane(cwd, "plan", {
      LANE_EVENT_NAME: "pull_request",
      MUTATE_MODE: "run",
      MUTATE_LIST: "src/webp/riff.ts",
    });
    put(cwd, "lane-run.json", RUN_OK);
    const g = lane(cwd, "gate", {});
    expect(g.status).toBe(1);
    expect(g.result.verdict).toBe("error");
    expect(g.result.reason).toContain("mutation.json");
  });

  it("unparseable mutation.json: gate exits 1 with verdict error", () => {
    const cwd = sandbox();
    lane(cwd, "plan", {
      LANE_EVENT_NAME: "pull_request",
      MUTATE_MODE: "run",
      MUTATE_LIST: "src/webp/riff.ts",
    });
    put(cwd, "lane-run.json", RUN_OK);
    put(cwd, "mutation.json", "{not json");
    const g = lane(cwd, "gate", {});
    expect(g.status).toBe(1);
    expect(g.result.verdict).toBe("error");
    expect(g.result.reason).toContain("unparseable");
  });

  it("interrupted run (lane-run.json with a signal): gate exits 1 with verdict error", () => {
    const cwd = sandbox();
    lane(cwd, "plan", {
      LANE_EVENT_NAME: "pull_request",
      MUTATE_MODE: "run",
      MUTATE_LIST: "src/webp/riff.ts",
    });
    put(cwd, "lane-run.json", {
      exitCode: null,
      signal: "SIGKILL",
      durationSeconds: 2,
    });
    put(
      cwd,
      "mutation.json",
      report({ "src/webp/riff.ts": [mutant("Killed")] }),
    );
    const g = lane(cwd, "gate", {});
    expect(g.status).toBe(1);
    expect(g.result.verdict).toBe("error");
  });

  it("exit codes: fail is 1, pass is 0, info is 0; gate-result.json is complete", () => {
    const need = [
      "headSha",
      "baseSha",
      "strykerVersion",
      "mutatedFiles",
      "perFile",
      "undetectedKeys",
      "verdict",
      "reason",
      "smoke",
      "durationSeconds",
      "collapsedDigest",
    ];
    const cases: [Record<string, Mutant[]>, string, number][] = [
      [{ "src/webp/riff.ts": [mutant("Survived")] }, "fail", 1],
      [{ "src/webp/riff.ts": [mutant("Killed")] }, "pass", 0],
      [{ "src/engine.ts": [mutant("Survived")] }, "info", 0],
    ];
    for (const [files, verdict, status] of cases) {
      const cwd = sandbox();
      lane(cwd, "plan", {
        LANE_EVENT_NAME: "pull_request",
        MUTATE_MODE: "run",
        MUTATE_LIST: Object.keys(files).join(","),
      });
      put(cwd, "lane-run.json", RUN_OK);
      put(cwd, "mutation.json", report(files));
      const g = lane(cwd, "gate", {
        LANE_HEAD_SHA: "abc",
        LANE_BASE_SHA: "def",
        LANE_MERGE_SHA: "mrg",
      });
      expect(g.status).toBe(status);
      expect(g.result.verdict).toBe(verdict);
      for (const k of need) expect(g.result).toHaveProperty(k);
      expect(g.result.headSha).toBe("abc");
      expect(g.result.baseSha).toBe("def");
      expect(g.result.mergeSha).toBe("mrg");
      expect(g.summary).toContain(`advisory): ${verdict}`);
    }
  });
});

describe("diffAttempts (D-27)", () => {
  const withStatuses = (...statuses: Status[]): Report =>
    report({
      "src/webp/riff.ts": statuses.map((s, i) => mutant(s, {}, i + 1)),
    });

  it("three identical reports: no flakes, equal digests, exit 0", () => {
    const r = withStatuses("Killed", "Survived");
    const d = diffAttempts([r, r, r]);
    expect(d.flakes).toEqual([]);
    expect(d.problems).toEqual([]);
    expect(new Set(d.digests).size).toBe(1);
    expect(d.digests).toHaveLength(3);
    expect(d.keyCount).toBe(2);
  });

  it("one-mutant-diff control: Killed, Killed, Survived is exactly one flake", () => {
    const d = diffAttempts([
      withStatuses("Killed", "Killed"),
      withStatuses("Killed", "Killed"),
      withStatuses("Killed", "Survived"),
    ]);
    expect(d.flakes).toHaveLength(1);
    expect(d.flakes[0].statuses).toEqual(["Killed", "Killed", "Survived"]);
    expect(d.flakes[0].key).toContain("src/webp/riff.ts");
    expect(new Set(d.digests).size).toBe(2);
  });

  it("exit 1 on the one-mutant-diff files, exit 0 on a swap-only pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-diff-"));
    try {
      const write = (name: string, r: Report) => {
        const p = join(dir, name);
        writeFileSync(p, JSON.stringify(r));
        return p;
      };
      const a = write("a.json", withStatuses("Killed", "Killed"));
      const b = write("b.json", withStatuses("Killed", "Survived"));
      const c = write("c.json", withStatuses("Killed", "Timeout"));
      expect(flakeMain([a, a, b])).toBe(1);
      expect(flakeMain([a, c])).toBe(0);
      expect(flakeMain([a])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Killed <-> Timeout is a listed swap, not a flake", () => {
    const d = diffAttempts([
      withStatuses("Killed", "Killed"),
      withStatuses("Timeout", "Killed"),
    ]);
    expect(d.flakes).toEqual([]);
    expect(d.swaps).toHaveLength(1);
    expect(d.problems).toEqual([]);
  });

  it("a mutant absent from one report is a flake (key-set difference)", () => {
    const d = diffAttempts([
      withStatuses("Killed", "Killed"),
      withStatuses("Killed", "Killed"),
      withStatuses("Killed"),
    ]);
    expect(d.flakes).toHaveLength(1);
    expect(d.flakes[0].statuses).toEqual(["Killed", "Killed", "absent"]);
  });

  it("one report only, or an empty report, is a problem", () => {
    expect(diffAttempts([withStatuses("Killed")]).problems).not.toEqual([]);
    const empty = report({ "src/webp/riff.ts": [] });
    expect(diffAttempts([withStatuses("Killed"), empty]).problems).not.toEqual(
      [],
    );
  });

  it("permuted files and mutants give an identical result", () => {
    const a = mutant("Killed", {}, 1);
    const b = mutant("Survived", {}, 2);
    const c = mutant("Killed", {}, 3);
    const flaky = mutant("Killed", {}, 2);
    const first = report({ "src/webp/riff.ts": [a, b], "src/webp/x.ts": [c] });
    const second = report({
      "src/webp/x.ts": [c],
      "src/webp/riff.ts": [a, flaky],
    });
    const permuted = report({
      "src/webp/x.ts": [c],
      "src/webp/riff.ts": [flaky, a],
    });
    const one = diffAttempts([first, second]);
    const two = diffAttempts([first, permuted]);
    expect(two).toEqual(one);
    expect(one.flakes).toHaveLength(1);
  });
});
