// MUT-03 floors check (D-16): the real-tree monotonic check against the base
// revision, and a score check on the 67-01 report when it is present.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("floors tracer (MUT-03, D-16)", () => {
  it("the real-tree floors never lower the base revision's floors", () => {
    const base = script.readBaseFloors(
      script.resolveBaseRev(process.env),
      packageRoot,
    );
    // error means the base ref cannot be resolved: fail closed, never skip.
    expect(base.status).not.toBe("error");
    if (base.status === "absent") return; // introduction: nothing to lower
    expect(
      script.checkMonotonic(base.text, readFileSync(floorsPath, "utf8")),
    ).toEqual([]);
  });

  it("scores the 67-01 report against the committed floors", () => {
    const reportPath = join(
      packageRoot,
      "reports",
      "mutation",
      "mutation.json",
    );
    if (!existsSync(reportPath)) return; // reports/ is untracked output
    const groups = JSON.parse(readFileSync(floorsPath, "utf8")).groups;
    const scored = script.scoreReport(
      JSON.parse(readFileSync(reportPath, "utf8")),
      groups,
    );
    expect(script.checkScores([scored], groups)).toEqual([]);
    expect(script.headroomHints([scored], groups).length).toBe(
      Object.keys(groups).length,
    );
  });
});
