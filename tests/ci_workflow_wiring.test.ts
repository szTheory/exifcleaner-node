import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 66 (TEST-11, TEST-09, D-03, D-05, M6): CI runs the suite once on Node 26, never
// as a matrix (the required `quality` context name stays), and enforces `check:dist`
// after a fresh build. engines stays >=22.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowText = readFileSync(
  join(packageRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as { engines?: { node?: string } };

const CHECKOUT_PIN =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE_PIN =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";

// Local copy of the header regex in scripts/classify_ci_scope.cjs (sliceJobs is not exported).
const JOB_HEADER_RE = /\n {2}([a-z][a-z0-9-]+):\n/gu;

function sliceJobs(text: string): Record<string, string> {
  const jobsHeaderIndex = text.indexOf("\njobs:\n");
  const searchText =
    jobsHeaderIndex >= 0 ? text.slice(jobsHeaderIndex + 1) : text;
  const matches = [...searchText.matchAll(JOB_HEADER_RE)];
  const jobs: Record<string, string> = {};
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end =
      index + 1 < matches.length ? matches[index + 1].index : searchText.length;
    jobs[match[1]] = searchText.slice(start, end);
  });
  return jobs;
}

export function checkCiWiring(
  text: string,
  pkg: { engines?: { node?: string } },
): string[] {
  const problems: string[] = [];
  const count = (text.match(/node-version: 26\b/gu) ?? []).length;
  if (count !== 1)
    problems.push(`expected exactly one node-version: 26, found ${count}`);

  const jobs = sliceJobs(text);
  const leg = jobs["test-node26"];
  if (leg === undefined) {
    problems.push("job test-node26 is missing");
  } else {
    if (!/^ {4}runs-on: ubuntu-24\.04$/mu.test(leg))
      problems.push("test-node26 must run on ubuntu-24.04");
    if (/^ {4}needs:/mu.test(leg))
      problems.push("test-node26 must not have needs");
    if (/^ {4}if:/mu.test(leg))
      problems.push("test-node26 must not have a job-level if");
    if (/^ {4}strategy:/mu.test(leg))
      problems.push("test-node26 must not be a matrix");
    if (!leg.includes(`- uses: ${CHECKOUT_PIN}`))
      problems.push("test-node26 checkout is not the pinned SHA");
    if (!leg.includes(`- uses: ${SETUP_NODE_PIN}`))
      problems.push("test-node26 setup-node is not the pinned SHA");
    const runs = [...leg.matchAll(/^ {6}- run: (.+)$/gmu)].map((m) => m[1]);
    if (
      JSON.stringify(runs) !==
      JSON.stringify(["npm ci", "npm run build:native", "npm test"])
    )
      problems.push(`test-node26 run steps are ${JSON.stringify(runs)}`);
    if (
      leg.includes("${{") &&
      leg.replace('ref: "${{ github.sha }}"', "").includes("${{")
    )
      problems.push("test-node26 has a new expression");
  }

  const quality = jobs["quality"];
  if (
    quality === undefined ||
    !quality.includes("npm run build && npm run check:dist")
  )
    problems.push(
      "quality run line lacks `npm run build && npm run check:dist`",
    );

  if (pkg.engines?.node !== ">=22")
    problems.push(
      `engines.node is ${JSON.stringify(pkg.engines?.node)}, expected ">=22"`,
    );
  return problems;
}

describe("ci.yml and package.json Node 26 / check:dist wiring (TEST-11, D-03, D-05)", () => {
  it("has no wiring problems on the real files", () => {
    expect(checkCiWiring(workflowText, packageJson)).toEqual([]);
  });

  it("has no schedule trigger (no cron lanes)", () => {
    expect(workflowText).not.toMatch(/^ {2}schedule:/mu);
  });

  function mutate(from: string | RegExp, to: string): string {
    const mutated = workflowText.replace(from, to);
    expect(mutated).not.toBe(workflowText);
    return mutated;
  }

  it("mutation 1: a second node-version 26 leg is rejected", () => {
    const mutated = mutate(
      "          node-version: 24\n          cache: npm\n      - run: npm ci\n      - name: Prepare",
      "          node-version: 26\n          cache: npm\n      - run: npm ci\n      - name: Prepare",
    );
    expect(mutated).not.toBe(workflowText);
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });

  it("mutation 2: engines >=24 is rejected", () => {
    const mutatedPkg = { engines: { node: ">=24" } };
    expect(mutatedPkg.engines.node).not.toBe(packageJson.engines?.node);
    expect(checkCiWiring(workflowText, mutatedPkg)).not.toEqual([]);
  });

  it("mutation 3: check:dist removed from quality is rejected", () => {
    const mutated = mutate(
      "npm run build && npm run check:dist &&",
      "npm run build &&",
    );
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });

  it("mutation 4: check:dist before build is rejected", () => {
    const mutated = mutate(
      "npm run build && npm run check:dist &&",
      "npm run check:dist && npm run build &&",
    );
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });

  it("mutation 5: a SHA pin replaced by a tag in test-node26 is rejected", () => {
    const jobStart = workflowText.indexOf("\n  test-node26:\n");
    expect(jobStart).toBeGreaterThan(-1);
    const head = workflowText.slice(0, jobStart);
    const tail = workflowText.slice(jobStart);
    const mutatedTail = tail.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/checkout@v7",
    );
    expect(mutatedTail).not.toBe(tail);
    expect(checkCiWiring(head + mutatedTail, packageJson)).not.toEqual([]);
  });

  it("mutation 6: needs: classify added to test-node26 is rejected", () => {
    const mutated = mutate(
      "  test-node26:\n",
      "  test-node26:\n    needs: classify\n",
    );
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });
});
