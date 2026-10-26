// MUT-03 survivor ledger checker (D-13, D-18) with fixtures. Every red case
// asserts a specific problem; the passing cases prove the fixtures are valid.
import { spawnSync } from "node:child_process";
import {
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

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  statusReason?: string;
  static?: boolean;
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
interface Cluster {
  id: string;
  group: string;
  file: string;
  mutatorName: string;
  function: string;
  disposition: string;
  count: number;
  keys: string[];
  anchors: string[];
  test?: { file: string; name: string };
  symbol?: string;
  equivalenceClass?: string;
  note: string;
}
interface Identity {
  mutantKey(file: string, mutant: Mutant): string;
  anchorKey(file: string, mutant: Mutant, source: string): string;
}
interface Checker {
  checkLedger(input: {
    ledger: { schemaVersion: number; preTriage: null; clusters: Cluster[] };
    preReport?: Report | null;
    finalReport?: Report | null;
    root: string;
    groups: Record<string, { tier: string; globs: string[] }>;
    mode: "pre" | "final";
  }): string[];
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const load = async <T>(name: string) =>
  (await import(
    pathToFileURL(join(packageRoot, "tools", "mutation", name)).href
  )) as T;
const identity = await load<Identity>("identity.mjs");
const { checkLedger } = await load<Checker>("ledger-check.mjs");

const groups = {
  g: { tier: "trust", globs: ["src/a/**"] },
  o: { tier: "orchestration", globs: ["src/o/**"] },
};
const SOURCE = "const a = true;\nconst b = true;\n";
const mutant = (
  id: string,
  line: number,
  column: number,
  status: string,
  extra: Partial<Mutant> = {},
): Mutant => ({
  id,
  mutatorName: "BooleanLiteral",
  replacement: "false",
  status,
  location: {
    start: { line, column },
    end: { line, column: column + 4 },
  },
  ...extra,
});
const reportOf = (
  mutants: Mutant[],
  file = "src/a/x.ts",
  source = SOURCE,
): Report => ({
  files: { [file]: { language: "typescript", source, mutants } },
});
const keyOf = (m: Mutant, file = "src/a/x.ts") => identity.mutantKey(file, m);
const cluster = (id: string, over: Partial<Cluster> = {}): Cluster => ({
  id,
  group: "g",
  file: "src/a/x.ts",
  mutatorName: "BooleanLiteral",
  function: "f",
  disposition: "pending",
  count: 0,
  keys: [],
  anchors: [],
  note: "n",
  ...over,
});
const ledgerOf = (clusters: Cluster[]) => ({
  schemaVersion: 1,
  preTriage: null,
  clusters,
});

// Three trust survivors (a first, b second line, a killed control).
const m1 = mutant("1", 1, 11, "Survived");
const m2 = mutant("2", 2, 11, "NoCoverage");
const m3 = mutant("3", 1, 11, "Survived", {
  mutatorName: "ConditionalExpression",
  replacement: "true",
});
const m4 = mutant("4", 2, 11, "Killed", { mutatorName: "EqualityOperator" });
const pre = reportOf([m1, m2, m3, m4]);

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function tempRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mut-ledger-")));
  temporaryRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const covering: [Cluster, Cluster] = [
  cluster("c1", { count: 2, keys: [keyOf(m1), keyOf(m2)] }),
  cluster("c2", { count: 1, keys: [keyOf(m3)] }),
];
const noRoot = "/nonexistent-root";

describe("anchorKey (D-13, D-18)", () => {
  it("survives a line shift that changes mutantKey", () => {
    const shifted = "// inserted\n" + SOURCE;
    const before = m2;
    const after = mutant("2", 3, 11, "NoCoverage");
    expect(identity.anchorKey("f", after, shifted)).toBe(
      identity.anchorKey("f", before, SOURCE),
    );
    expect(identity.mutantKey("f", after)).not.toBe(
      identity.mutantKey("f", before),
    );
  });

  it("differs for the second identical occurrence in the same file", () => {
    const twice = "x(true);\nx(true);\n";
    const first = mutant("1", 1, 3, "Survived");
    const second = mutant("2", 2, 3, "Survived");
    expect(identity.anchorKey("f", first, twice)).not.toBe(
      identity.anchorKey("f", second, twice),
    );
  });

  it("reads the mutated span with 1-based columns", () => {
    expect(identity.anchorKey("f", m1, SOURCE)).toContain("\u0000true\u0000");
  });
});

describe("pre-triage mapping (D-18)", () => {
  it("fails naming the uncovered key when 2 of 3 survivors are mapped", () => {
    const problems = checkLedger({
      ledger: ledgerOf([covering[0]]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toEqual([
      `${keyOf(m3).replaceAll("\u0000", "|")}: in no cluster`,
    ]);
  });

  it("fails a key that sits in two clusters", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        covering[0],
        covering[1],
        cluster("c3", { count: 1, keys: [keyOf(m1)] }),
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/: in 2 clusters \(c1, c3\)$/);
  });

  it("fails a cluster whose count differs from its key list", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        cluster("c1", { count: 3, keys: covering[0].keys }),
        covering[1],
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toEqual(["c1: count 3 differs from 2 keys"]);
  });

  it("fails a key that is not a survivor of the pre-triage report", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        ...covering,
        cluster("c4", { count: 1, keys: [keyOf(m4)] }),
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /not a trust survivor of the pre-triage report/,
    );
  });

  it("an empty ledger with a non-empty report is red", () => {
    const problems = checkLedger({
      ledger: ledgerOf([]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(3);
  });

  it("ignores orchestration-group survivors (positive control)", () => {
    const orchestration = reportOf(
      [mutant("9", 1, 11, "Survived")],
      "src/o/y.ts",
    );
    expect(
      checkLedger({
        ledger: ledgerOf([]),
        preReport: orchestration,
        root: noRoot,
        groups,
        mode: "pre",
      }),
    ).toEqual([]);
  });

  it("passes when every survivor is in exactly one cluster (positive control)", () => {
    expect(
      checkLedger({
        ledger: ledgerOf(covering),
        preReport: pre,
        root: noRoot,
        groups,
        mode: "pre",
      }),
    ).toEqual([]);
  });
});

describe("final mode (D-18)", () => {
  const clean = reportOf([mutant("1", 1, 11, "Killed")]);
  const final = (
    clusters: Cluster[],
    root = noRoot,
    finalReport: Report | null = clean,
  ) =>
    checkLedger({
      ledger: ledgerOf(clusters),
      finalReport,
      root,
      groups,
      mode: "final",
    });

  it("a pending cluster fails", () => {
    expect(final([cluster("c1")])).toEqual(["c1: cluster is pending"]);
  });

  it("a gap row whose test file is missing fails", () => {
    const root = tempRoot({});
    const problems = final(
      [
        cluster("c1", {
          disposition: "gap",
          test: { file: "tests/k.test.ts", name: "kills it" },
        }),
      ],
      root,
    );
    expect(problems).toEqual(["c1: gap test file tests/k.test.ts is missing"]);
  });

  it("a gap row whose file lacks the test name fails", () => {
    const root = tempRoot({ "tests/k.test.ts": 'it("other", () => {});\n' });
    const problems = final(
      [
        cluster("c1", {
          disposition: "gap",
          test: { file: "tests/k.test.ts", name: "kills it" },
        }),
      ],
      root,
    );
    expect(problems).toEqual([
      'c1: gap test tests/k.test.ts does not contain test name "kills it"',
    ]);
  });

  it("a dead row whose symbol is still a word in src fails", () => {
    const root = tempRoot({
      "src/a/x.ts": "export function legacyHelper() {}\n",
    });
    const problems = final(
      [cluster("c1", { disposition: "dead", symbol: "legacyHelper" })],
      root,
    );
    expect(problems).toEqual([
      "c1: dead symbol legacyHelper still appears in src/",
    ]);
  });

  it("a comment-Ignored mutant with no equivalent row fails", () => {
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const problems = final([], noRoot, reportOf([ignored]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /comment-Ignored mutant matches no equivalent row/,
    );
  });

  it("an equivalent row whose class differs from the disable comment fails", () => {
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const anchor = identity.anchorKey("src/a/x.ts", ignored, SOURCE);
    const problems = final(
      [
        cluster("c1", {
          disposition: "equivalent",
          equivalenceClass: "platform-constant",
          count: 0,
          anchors: [anchor],
        }),
      ],
      noRoot,
      reportOf([ignored]),
    );
    expect(problems).toEqual([
      "c1: equivalenceClass platform-constant differs from the disable comment class equivalent-arithmetic",
    ]);
  });

  it("a Survived trust mutant in the final report fails", () => {
    const problems = final(
      [],
      noRoot,
      reportOf([mutant("1", 1, 11, "Survived")]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /: Survived in a trust group in the final report$/,
    );
  });

  it("a NoCoverage trust mutant in the final report fails", () => {
    const problems = final(
      [],
      noRoot,
      reportOf([mutant("1", 1, 11, "NoCoverage")]),
    );
    expect(problems[0]).toMatch(/: NoCoverage in a trust group/);
  });

  it("an orchestration-group Survived mutant does not fail (positive control)", () => {
    expect(
      final(
        [],
        noRoot,
        reportOf([mutant("1", 1, 11, "Survived")], "src/o/y.ts"),
      ),
    ).toEqual([]);
  });

  it("a complete fixture passes (positive control)", () => {
    const root = tempRoot({
      "tests/k.test.ts": 'it("kills it", () => {});\n',
      "src/a/x.ts": "export const live = 1;\n",
    });
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const anchor = identity.anchorKey("src/a/x.ts", ignored, SOURCE);
    const report = reportOf([ignored, mutant("6", 2, 11, "Killed")]);
    expect(
      final(
        [
          cluster("c1", {
            disposition: "gap",
            test: { file: "tests/k.test.ts", name: "kills it" },
          }),
          cluster("c2", { disposition: "dead", symbol: "legacyHelper" }),
          cluster("c3", {
            disposition: "equivalent",
            equivalenceClass: "equivalent-arithmetic",
            anchors: [anchor],
          }),
        ],
        root,
        report,
      ),
    ).toEqual([]);
  });
});

describe("committed ledger", () => {
  const ledgerPath = join(packageRoot, "tools", "mutation", "ledger.json");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(packageRoot, "tools", "mutation", "ledger-check.mjs"), ...args],
      { cwd: packageRoot, encoding: "utf8" },
    );

  it("starts empty and passes in pre mode without a report", () => {
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual({
      schemaVersion: 1,
      preTriage: null,
      clusters: [],
    });
    expect(run().status).toBe(0);
  });

  it("is red against a non-empty pre-report (empty ledger, non-empty report)", () => {
    const dir = tempRoot({
      "pre.json": JSON.stringify(
        reportOf([mutant("1", 1, 11, "Survived")], "src/webp/x.ts"),
      ),
    });
    const result = run("--pre", join(dir, "pre.json"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/in no cluster/);
  });
});
