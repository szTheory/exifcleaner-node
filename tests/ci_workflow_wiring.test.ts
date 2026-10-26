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
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1]?.index ?? searchText.length)
        : searchText.length;
    jobs[match[1] ?? ""] = searchText.slice(start, end);
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

const UPLOAD_PIN =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1";
const MUTATION_IF =
  "if: ${{ !cancelled() && github.event_name == 'pull_request' }}";

/** Split a job body into its top-level steps (each begins at `      - `). */
function sliceSteps(job: string): string[] {
  return job
    .split(/^(?= {6}- )/mu)
    .filter((step) => step.startsWith("      - "));
}

// MUT-04 (D-25, D-26, D-16, D-01): the advisory PR mutation lane wiring, and the base revision the
// static ratchet checks read in quality and test-node26.
export function checkMutationLaneWiring(text: string): string[] {
  const problems: string[] = [];
  const jobs = sliceJobs(text);

  for (const name of ["quality", "test-node26"]) {
    const job = jobs[name];
    if (job === undefined) continue;
    if (!/^ {4}env:\n(?: {6}.*\n)*? {6}MUTATION_BASE_REV: HEAD\^1$/mu.test(job))
      problems.push(`${name} must set MUTATION_BASE_REV: HEAD^1`);
    if (!/^ {10}fetch-depth: 2$/mu.test(job))
      problems.push(`${name} checkout must use fetch-depth: 2`);
  }

  const classify = jobs["classify"] ?? "";
  for (const output of ["mutate", "mutate_mode"]) {
    if (
      !new RegExp(
        `^ {6}${output}: \\$\\{\\{ steps\\.scope\\.outputs\\.${output} \\}\\}$`,
        "mu",
      ).test(classify)
    )
      problems.push(`classify is missing the ${output} output`);
  }

  const job = jobs["mutation-pr"];
  if (job === undefined) return [...problems, "job mutation-pr is missing"];
  if (!/^ {4}needs: classify$/mu.test(job))
    problems.push("mutation-pr must have needs: classify");
  const jobIfs = [...job.matchAll(/^ {4}if: .*$/gmu)].map((m) => m[0].trim());
  if (jobIfs.length !== 1 || jobIfs[0] !== MUTATION_IF)
    problems.push(
      `mutation-pr job-level if must be exactly ${MUTATION_IF}, found ${JSON.stringify(jobIfs)}`,
    );
  if (!/^ {4}runs-on: ubuntu-24\.04$/mu.test(job))
    problems.push("mutation-pr must run on ubuntu-24.04");
  if (!/^ {4}timeout-minutes: 15$/mu.test(job))
    problems.push("mutation-pr must set timeout-minutes: 15");
  if (!/^ {6}MUTATION_BASE_REV: HEAD\^1$/mu.test(job))
    problems.push("mutation-pr must set MUTATION_BASE_REV: HEAD^1");
  if (!job.includes(`- uses: ${CHECKOUT_PIN}`))
    problems.push("mutation-pr checkout is not the pinned SHA");
  if (!job.includes(`- uses: ${SETUP_NODE_PIN}`))
    problems.push("mutation-pr setup-node is not the pinned SHA");
  if (!/^ {10}node-version: 24$/mu.test(job))
    problems.push("mutation-pr must use node-version: 24");
  if (!/^ {10}fetch-depth: 2$/mu.test(job))
    problems.push("mutation-pr checkout must use fetch-depth: 2");
  if (!job.includes("MUTATE_LIST: ${{ needs.classify.outputs.mutate }}"))
    problems.push("mutation-pr plan step does not read classify mutate");
  if (!job.includes("MUTATE_MODE: ${{ needs.classify.outputs.mutate_mode }}"))
    problems.push("mutation-pr plan step does not read classify mutate_mode");
  const interpolatedRuns = job
    .split("\n")
    .filter((line) => /^ +(- )?run: .*\$\{\{/u.test(line));
  if (interpolatedRuns.length > 0)
    problems.push(
      `mutation-pr has an expression inside a run line: ${interpolatedRuns.join(" | ")}`,
    );
  if (/actions\/cache@/u.test(job))
    problems.push("mutation-pr must not use actions/cache");
  if (/continue-on-error/u.test(job))
    problems.push("mutation-pr must not use continue-on-error");

  const steps = sliceSteps(job);
  const gateStep = steps.find((step) => step.includes("lane.mjs gate"));
  if (
    gateStep === undefined ||
    !/^(?: {6}- | {8})if: always\(\)$/mu.test(gateStep)
  )
    problems.push("mutation-pr gate step must carry if: always()");
  const uploadStep = steps.find((step) => step.includes("upload-artifact"));
  if (uploadStep === undefined) {
    problems.push("mutation-pr has no upload step");
  } else {
    if (!uploadStep.includes(`uses: ${UPLOAD_PIN}`))
      problems.push("mutation-pr upload-artifact is not the pinned SHA");
    if (!/^ {6}- if: always\(\)$/mu.test(uploadStep))
      problems.push("mutation-pr upload step must carry if: always()");
    if (
      !uploadStep.includes(
        "name: mutation-pr-attempt-${{ github.run_attempt }}",
      )
    )
      problems.push("mutation-pr artifact name must be per run attempt");
    if (!uploadStep.includes("path: reports/mutation/"))
      problems.push("mutation-pr must upload reports/mutation/");
  }
  return problems;
}

describe("ci.yml and package.json Node 26 / check:dist wiring (TEST-11, D-03, D-05)", () => {
  it("has no wiring problems on the real files", () => {
    expect(checkCiWiring(workflowText, packageJson)).toEqual([]);
  });

  it("has no mutation lane wiring problems on the real file", () => {
    expect(checkMutationLaneWiring(workflowText)).toEqual([]);
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
    expect(mutated).not.toBe(workflowText);
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });

  it("mutation 2: engines >=24 is rejected", () => {
    const mutated = { engines: { node: ">=24" } };
    expect(mutated.engines.node).not.toBe(packageJson.engines?.node);
    expect(checkCiWiring(workflowText, mutated)).not.toEqual([]);
  });

  it("mutation 3: check:dist removed from quality is rejected", () => {
    const mutated = mutate(
      "npm run build && npm run check:dist &&",
      "npm run build &&",
    );
    expect(mutated).not.toBe(workflowText);
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });

  it("mutation 4: check:dist before build is rejected", () => {
    const mutated = mutate(
      "npm run build && npm run check:dist &&",
      "npm run check:dist && npm run build &&",
    );
    expect(mutated).not.toBe(workflowText);
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
    expect(mutated).not.toBe(workflowText);
    expect(checkCiWiring(mutated, packageJson)).not.toEqual([]);
  });
});
