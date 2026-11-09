// MUT-02/MUT-03 baseline driver: selection and aggregation (D-11, D-14, D-23).
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateScores,
  capFiles,
  capsConfigText,
  mutateListForGroup,
  strykerRunArgs,
  sampleMemory,
  trackedSrc,
  // @ts-expect-error plain ESM tooling script without types
} from "../tools/mutation/baseline.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const floors = JSON.parse(
  readFileSync(join(root, "mutation-floors.json"), "utf8"),
) as { groups: Record<string, unknown> };
const files: string[] = trackedSrc(root);

describe("baseline mutate list", () => {
  it("selects src/io/copy-range.ts for the io group", () => {
    expect(mutateListForGroup("io", floors, files)).toEqual([
      "src/io/copy-range.ts",
    ]);
  });
});

const groupNames = [
  "webp",
  "png",
  "jpeg",
  "isobmff",
  "metadata",
  "engine",
  "transaction",
  "io",
  "admission-core",
];

describe("group selection covers the tracked tree", () => {
  it("every group is non-empty and the union equals git ls-files src ts, no overlap", () => {
    const gitFiles = execFileSync("git", ["ls-files", "--", "src"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const all: string[] = [];
    for (const g of groupNames) {
      const list: string[] = mutateListForGroup(g, floors, files);
      expect(list.length).toBeGreaterThan(0);
      all.push(...list);
    }
    expect(Object.keys(floors.groups).sort()).toEqual([...groupNames].sort());
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(gitFiles);
    expect(mutateListForGroup("all", floors, files)).toEqual(gitFiles);
  });

  it("an unknown group and an empty match are errors", () => {
    expect(() => mutateListForGroup("nope", floors, files)).toThrow(
      /unknown group/u,
    );
    expect(() =>
      mutateListForGroup("io", floors, ["src/webp/riff.ts"]),
    ).toThrow(/matches no files/u);
  });
});

describe("capFiles", () => {
  it("is computed from MAX_ declarations plus caps.ts", () => {
    const list: string[] = capFiles(root);
    expect(list).toEqual([...list].sort());
    for (const f of [
      "src/isobmff/caps.ts",
      "src/webp/riff.ts",
      "src/png/chunks.ts",
    ])
      expect(list).toContain(f);
    for (const f of list) {
      if (f === "src/isobmff/caps.ts") continue;
      expect(readFileSync(join(root, f), "utf8")).toMatch(/MAX_/u);
    }
  });
});

describe("sampleMemory", () => {
  it("reports unavailable off Linux", () => {
    expect(sampleMemory(1, "darwin")).toBe("unavailable");
    expect(sampleMemory(1, "win32")).toBe("unavailable");
  });
});

describe("aggregate", () => {
  const statusesFor = (flip: boolean) => [
    "Killed",
    "Killed",
    flip ? "Survived" : "Killed",
    "Survived",
  ];
  function report(statuses: string[]) {
    return {
      files: {
        "src/io/copy-range.ts": {
          mutants: statuses.map((status, i) => ({
            id: String(i),
            mutatorName: "ConditionalExpression",
            replacement: "true",
            status,
            location: {
              start: { line: i + 1, column: 1 },
              end: { line: i + 1, column: 5 },
            },
          })),
        },
      },
    };
  }
  function fixture(flipSecond: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "baseline-agg-"));
    [false, flipSecond, false].forEach((flip, i) => {
      const attempt = join(dir, `mutation-baseline-attempt-${i + 1}`);
      mkdirSync(attempt);
      writeFileSync(
        join(attempt, "mutation.json"),
        JSON.stringify(report(statusesFor(flip))),
      );
    });
    return dir;
  }
  function run(dir: string) {
    // G14-WR-01: the aggregate appends a summary block to $GITHUB_STEP_SUMMARY when it is set;
    // the child must not inherit the real CI job summary and write fixture data into it.
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(
      process.execPath,
      [join(root, "tools", "mutation", "baseline.mjs"), "aggregate", dir],
      { cwd: root, encoding: "utf8", env },
    );
  }

  it("exits 0 over identical attempts and reports per-group minima", () => {
    const dir = fixture(false);
    try {
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("min io 750");
      expect(r.stdout).toContain("flakes 0");
      const out = JSON.parse(readFileSync(join(dir, "aggregate.json"), "utf8"));
      expect(out.attempts).toBe(3);
      expect(out.minima.io).toBe(750);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write fixture data into an inherited GITHUB_STEP_SUMMARY (G14-WR-01)", () => {
    const dir = fixture(false);
    const summary = join(dir, "step-summary.md");
    writeFileSync(summary, "");
    const before = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summary;
    try {
      expect(run(dir).status).toBe(0);
      expect(readFileSync(summary, "utf8")).toBe("");
    } finally {
      if (before === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when one mutant flips between attempts", () => {
    const dir = fixture(true);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("flake ");
      expect(r.stdout).toContain("flakes 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregateScores takes the minimum across attempts", () => {
    const groups = floors.groups;
    const r = aggregateScores(
      [report(statusesFor(false)), report(statusesFor(true))],
      groups,
    );
    expect(r.minima.io).toBe(500);
  });
});

// Plan 67-46 amendment 4: the first hosted caps dispatch (run 42401057745) died before Stryker
// started because the driver passed `--ignoreStatic false`, which the Stryker CLI rejects (the flag
// can only switch the option on). The caps run therefore uses a derived config.
describe("caps run arguments", () => {
  const baseText = readFileSync(
    join(root, "tools", "mutation", "stryker.config.json"),
    "utf8",
  );

  it("never passes ignoreStatic on the command line and runs from the derived config", () => {
    const args: string[] = strykerRunArgs({
      mutate: ["src/isobmff/caps.ts", "src/webp/riff.ts"],
      caps: true,
      concurrency: 4,
    });
    expect(args).toEqual([
      "run",
      "reports/mutation/stryker.caps.config.json",
      "--mutate",
      "src/isobmff/caps.ts,src/webp/riff.ts",
      "--concurrency",
      "4",
    ]);
    expect(args.join(" ")).not.toMatch(/ignoreStatic/u);
  });

  it("keeps the base config and the same argument shape for an ordinary run", () => {
    expect(
      strykerRunArgs({ mutate: ["src/io/copy-range.ts"], caps: false }),
    ).toEqual([
      "run",
      "tools/mutation/stryker.config.json",
      "--mutate",
      "src/io/copy-range.ts",
    ]);
  });

  it("derives a config that differs from the base config only in ignoreStatic", () => {
    const base = JSON.parse(baseText) as Record<string, unknown>;
    expect(base.ignoreStatic).toBe(true);
    const derived = JSON.parse(capsConfigText(baseText)) as Record<
      string,
      unknown
    >;
    expect(derived.ignoreStatic).toBe(false);
    expect({ ...derived, ignoreStatic: true }).toEqual(base);
    expect(capsConfigText(baseText).endsWith("\n")).toBe(true);
  });
});
