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

const DOWNLOAD_PIN =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";

// MUT-02/MUT-03 (D-23): the dispatch-only authoritative baseline workflow.
export function checkMutationBaselineWiring(text: string): string[] {
  const problems: string[] = [];
  const onBlock = /^on:\n((?: {2}.*\n|\n)*)/mu.exec(text)?.[1] ?? "";
  if (!/^ {2}workflow_dispatch:$/mu.test(onBlock))
    problems.push("trigger must be workflow_dispatch");
  for (const trigger of ["schedule", "push", "pull_request"]) {
    if (new RegExp(`^ {2}${trigger}:`, "mu").test(onBlock))
      problems.push(`must not have a ${trigger} trigger`);
  }
  if (/^\s*- cron:/mu.test(text)) problems.push("must not contain a cron");
  for (const input of ["mode", "group", "attempts", "concurrency"]) {
    const block = new RegExp(`^ {6}${input}:\\n((?: {8}.*\\n)+)`, "mu").exec(
      text,
    )?.[1];
    if (block === undefined) problems.push(`input ${input} is missing`);
    else if (!/^ {8}type: choice$/mu.test(block))
      problems.push(`input ${input} must be type: choice`);
  }
  if (/^ +type: (string|boolean|number)$/mu.test(text))
    problems.push("free-text inputs are forbidden: only choice inputs");
  if (!/^permissions:\n {2}contents: read$/mu.test(text))
    problems.push("permissions must be contents: read");
  if (!/^ {2}cancel-in-progress: false$/mu.test(text))
    problems.push("concurrency must set cancel-in-progress: false");
  for (const line of text.split("\n")) {
    const m = /\buses: (\S+@\S+)(.*)$/u.exec(line);
    if (m === null) continue;
    if (!/@[0-9a-f]{40}$/u.test(m[1] ?? "") || !/^ # v\d/u.test(m[2] ?? ""))
      problems.push(`unpinned action: ${line.trim()}`);
  }
  const interpolatedRuns = text
    .split("\n")
    .filter((line) => /^ +(- )?run: .*\$\{\{/u.test(line));
  if (interpolatedRuns.length > 0)
    problems.push(
      `expression inside a run line: ${interpolatedRuns.join(" | ")}`,
    );

  const jobs = sliceJobs(text);
  const job = jobs["baseline"];
  if (job === undefined) return [...problems, "job baseline is missing"];
  if (!/^ {4}runs-on: ubuntu-24\.04$/mu.test(job))
    problems.push("baseline must run on ubuntu-24.04");
  if (!/^ {4}timeout-minutes: 340$/mu.test(job))
    problems.push("baseline must set timeout-minutes: 340");
  if (!/^ {6}fail-fast: false$/mu.test(job))
    problems.push("baseline must set fail-fast: false");
  if (!job.includes("test -f prebuilds/linux-x64/publication.node"))
    problems.push("baseline must check prebuilds/linux-x64/publication.node");
  for (const needle of [
    "npm run build:native",
    "npm ci --prefix tools/mutation",
    "node tools/mutation/check-isolation.mjs",
    "node tools/mutation/baseline.mjs dryruns 3",
    "node tools/mutation/baseline.mjs full",
  ])
    if (!job.includes(needle)) problems.push(`baseline is missing: ${needle}`);
  if (!job.includes(`uses: ${CHECKOUT_PIN}`))
    problems.push("baseline checkout is not the pinned SHA");
  if (!job.includes(`uses: ${SETUP_NODE_PIN}`))
    problems.push("baseline setup-node is not the pinned SHA");
  if (!/^ {10}node-version: 24$/mu.test(job))
    problems.push("baseline must use node-version: 24");
  const upload = sliceSteps(job).find((step) =>
    step.includes("upload-artifact"),
  );
  if (upload === undefined) problems.push("baseline has no upload step");
  else {
    if (!/^ {6}- if: always\(\)$/mu.test(upload))
      problems.push("baseline upload step must carry if: always()");
    if (
      !upload.includes("name: mutation-baseline-attempt-${{ matrix.attempt }}")
    )
      problems.push("baseline artifact name must be per attempt");
  }
  const aggregate = jobs["aggregate"];
  if (aggregate === undefined) problems.push("job aggregate is missing");
  else {
    if (!/^ {4}needs: baseline$/mu.test(aggregate))
      problems.push("aggregate must have needs: baseline");
    if (!aggregate.includes("inputs.attempts == '3'"))
      problems.push("aggregate must run only when attempts is 3");
    if (!aggregate.includes(`uses: ${DOWNLOAD_PIN}`))
      problems.push("aggregate download-artifact is not the pinned SHA");
    if (!aggregate.includes("node tools/mutation/baseline.mjs aggregate"))
      problems.push("aggregate must run baseline.mjs aggregate");
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

  // Mutations 7-15 operate on text confined to one job so a hit elsewhere cannot mask a miss.
  function mutateJob(job: string, from: string | RegExp, to: string): string {
    const start = workflowText.indexOf(`\n  ${job}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = workflowText
      .slice(start + 1)
      .search(/\n {2}[a-z][a-z0-9-]+:\n/u);
    const end = next < 0 ? workflowText.length : start + 1 + next;
    const body = workflowText.slice(start, end);
    const mutatedBody = body.replace(from, to);
    expect(mutatedBody).not.toBe(body);
    return workflowText.slice(0, start) + mutatedBody + workflowText.slice(end);
  }

  function expectProblem(text: string, fragment: string): void {
    const problems = checkMutationLaneWiring(text);
    expect(problems.some((p) => p.includes(fragment))).toBe(true);
  }

  it("mutation 7: needs: classify removed from mutation-pr is rejected", () => {
    expectProblem(
      mutateJob("mutation-pr", "    needs: classify\n", ""),
      "mutation-pr must have needs: classify",
    );
  });

  it("mutation 8: any other job-level if on mutation-pr is rejected", () => {
    const cond =
      "if: ${{ !cancelled() && github.event_name == 'pull_request' }}";
    const variants = [
      "if: needs.classify.outputs.scope != 'linux'",
      "if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.classify.outputs.scope != 'linux' }}",
      "if: ${{ !cancelled() }}",
      "",
    ];
    for (const variant of variants) {
      const text = mutateJob(
        "mutation-pr",
        `    ${cond}\n`,
        variant === "" ? "" : `    ${variant}\n`,
      );
      expectProblem(text, "mutation-pr job-level if must be exactly");
    }
  });

  it("mutation 9: a checkout tag instead of the SHA pin in mutation-pr is rejected", () => {
    expectProblem(
      mutateJob("mutation-pr", CHECKOUT_PIN, "actions/checkout@v7"),
      "mutation-pr checkout is not the pinned SHA",
    );
  });

  it("mutation 10: an expression inside a run line of mutation-pr is rejected", () => {
    expectProblem(
      mutateJob(
        "mutation-pr",
        "run: node tools/mutation/lane.mjs run",
        "run: node tools/mutation/lane.mjs run ${{ needs.classify.outputs.mutate }}",
      ),
      "mutation-pr has an expression inside a run line",
    );
  });

  it("mutation 11: actions/cache in mutation-pr is rejected", () => {
    expectProblem(
      mutateJob(
        "mutation-pr",
        "      - id: plan\n",
        "      - uses: actions/cache@v4\n      - id: plan\n",
      ),
      "mutation-pr must not use actions/cache",
    );
  });

  it("mutation 12: continue-on-error in mutation-pr is rejected", () => {
    expectProblem(
      mutateJob(
        "mutation-pr",
        "    timeout-minutes: 15\n",
        "    timeout-minutes: 15\n    continue-on-error: true\n",
      ),
      "mutation-pr must not use continue-on-error",
    );
  });

  it("mutation 13: timeout-minutes removed from mutation-pr is rejected", () => {
    expectProblem(
      mutateJob("mutation-pr", "    timeout-minutes: 15\n", ""),
      "mutation-pr must set timeout-minutes: 15",
    );
  });

  it("mutation 14: MUTATION_BASE_REV pointed at HEAD, or no fetch-depth 2, is rejected", () => {
    expectProblem(
      mutateJob(
        "quality",
        "MUTATION_BASE_REV: HEAD^1",
        "MUTATION_BASE_REV: HEAD",
      ),
      "quality must set MUTATION_BASE_REV: HEAD^1",
    );
    expectProblem(
      mutateJob("quality", "          fetch-depth: 2\n", ""),
      "quality checkout must use fetch-depth: 2",
    );
    expectProblem(
      mutateJob("test-node26", "          fetch-depth: 2\n", ""),
      "test-node26 checkout must use fetch-depth: 2",
    );
    expectProblem(
      mutateJob(
        "mutation-pr",
        "MUTATION_BASE_REV: HEAD^1",
        "MUTATION_BASE_REV: HEAD",
      ),
      "mutation-pr must set MUTATION_BASE_REV: HEAD^1",
    );
  });

  it("mutation 15: the classify mutate_mode output removed is rejected", () => {
    expectProblem(
      mutateJob(
        "classify",
        "      mutate_mode: ${{ steps.scope.outputs.mutate_mode }}\n",
        "",
      ),
      "classify is missing the mutate_mode output",
    );
  });

  it("mutation-pr is not in any classifier job list (advisory until v4.13)", () => {
    const text = readFileSync(
      join(packageRoot, "scripts", "classify_ci_scope.cjs"),
      "utf8",
    );
    const lists =
      text.match(
        /(ALWAYS_RUN_JOBS|SKIP_GATED_JOBS|NOOP_MATRIX_JOBS)[^;]*;/gu,
      ) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const list of lists) expect(list).not.toContain("mutation-pr");
  });
});

describe("mutation-baseline.yml wiring (D-23)", () => {
  const baselineText = readFileSync(
    join(packageRoot, ".github", "workflows", "mutation-baseline.yml"),
    "utf8",
  );

  function expectBaselineProblem(text: string, fragment: string): void {
    expect(text).not.toBe(baselineText);
    const problems = checkMutationBaselineWiring(text);
    expect(problems.some((p) => p.includes(fragment))).toBe(true);
  }

  it("has no wiring problems on the real file", () => {
    expect(checkMutationBaselineWiring(baselineText)).toEqual([]);
  });

  it("control: a schedule trigger is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "on:\n  workflow_dispatch:",
        'on:\n  schedule:\n    - cron: "0 3 * * 1"\n  workflow_dispatch:',
      ),
      "must not have a schedule trigger",
    );
  });

  it("control: a push trigger is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "on:\n  workflow_dispatch:",
        "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
      ),
      "must not have a push trigger",
    );
  });

  it("control: a missing prebuilds check is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "test -f prebuilds/linux-x64/publication.node",
        "true",
      ),
      "prebuilds/linux-x64/publication.node",
    );
  });

  it("control: timeout-minutes 360 is rejected", () => {
    expectBaselineProblem(
      baselineText.replace("timeout-minutes: 340", "timeout-minutes: 360"),
      "timeout-minutes: 340",
    );
  });

  it("control: a free-text string input is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "      group:\n        description: Group to mutate (all or one D-14 group)\n        type: choice",
        "      group:\n        description: Group to mutate (all or one D-14 group)\n        type: string",
      ),
      "must be type: choice",
    );
  });

  it("control: an unpinned action is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(CHECKOUT_PIN, "actions/checkout@v7"),
      "unpinned action",
    );
  });

  it("control: an expression inside a run line is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "run: node tools/mutation/baseline.mjs full",
        "run: node tools/mutation/baseline.mjs full ${{ inputs.group }}",
      ),
      "expression inside a run line",
    );
  });

  it("control: an upload step without if: always() is rejected", () => {
    expectBaselineProblem(
      baselineText.replace(
        "      - if: always()\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: mutation-baseline-attempt",
        "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: mutation-baseline-attempt",
      ),
      "must carry if: always()",
    );
  });
});
