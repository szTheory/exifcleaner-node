#!/usr/bin/env node
"use strict";
// Fail-closed CI scope classifier (D-14 to D-19).
//
// PURPOSE: decide whether a run can skip the 6-platform native build/install
// matrix and the paired benchmarks, in favor of running only Linux quality
// and qualification checks. A run stays "linux" ONLY when every changed path
// positively matches the Linux-only-safe allowlist below; every other input,
// including a path nobody has listed yet, a git error, or an empty diff, is
// "full". There is no default-open branch anywhere in this file.
//
// WHY NO THIRD-PARTY DIFF ACTION (D-14): the March 2025 tj-actions/changed-files
// compromise showed the blast radius of trusting a third-party Action to decide
// what a workflow runs. This repo's convention (see release_workflow_gate.cjs,
// check_evidence_present.cjs) is an in-repo script plus a companion vitest file,
// using Node built-ins and `git` only. This classifier follows that convention.
//
// WHY NOT workflow-level `on.paths` / `on.paths-ignore`: GitHub never reports a
// path-filtered-out job as "success" to branch protection -- it stays pending
// forever, so every required status check would block merges on unrelated PRs.
// The classifier instead runs as a normal job (`classify`) whose `outputs.scope`
// gates downstream jobs at the job level with `if:`, which DOES report a
// definite conclusion (skipped counts as passing a required check).
//
// REUSABLE-WORKFLOW CAVEAT: when ci.yml is invoked via `workflow_call` from
// release.yml, GitHub's own docs ("Reusing workflow configurations") state the
// `github` context inside the CALLED workflow is the CALLER's context. So
// `github.event_name` inside a release run is the caller's event (a `push` of a
// v* tag, or `workflow_dispatch`), never literally `workflow_call`, and
// `github.workflow` is the caller's name ("Release"), not "CI". D-17's "a
// release must never inherit a reduced scope" is therefore enforced by THREE
// independent checks, not event_name alone: the ALWAYS_FULL_EVENTS check, a
// `workflowName !== CI_WORKFLOW_NAME` check, and a `refs/tags/` ref check.

const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const CI_WORKFLOW_NAME = "CI";

const ALWAYS_FULL_EVENTS = Object.freeze([
  "workflow_dispatch",
  "workflow_call",
]);
const FILTERED_EVENTS = Object.freeze(["pull_request", "push"]);

/**
 * Linux-only-safe: a change stays "linux" only if EVERY changed path matches
 * one of these. Per-format parser/handler code, its tests, and docs are cheap
 * and cannot touch the native matrix, the shared transaction, or packaging.
 */
const LINUX_SAFE_PATH_RULES = Object.freeze(
  [
    { id: "src-format-code", pattern: /^src\/(?:webp|metadata|png|jpeg)\/.+/u },
    {
      id: "src-format-handler",
      pattern: /^src\/admission\/[a-z0-9-]+-handler\.ts$/u,
    },
    {
      id: "dist-format-code",
      pattern: /^dist\/(?:webp|metadata|png|jpeg)\/.+/u,
    },
    {
      id: "dist-format-handler",
      pattern:
        /^dist\/admission\/[a-z0-9-]+-handler\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u,
    },
    {
      id: "format-unit-tests",
      pattern:
        /^tests\/(?:riff|icc_admission|(?:webp|png|jpeg|metadata|exif|xmp|icc)[a-z0-9_-]*)\.test\.ts$/u,
    },
    {
      id: "format-qualification-tests",
      pattern:
        /^tests\/qualification\/(?:parser|(?:webp|png|jpeg)[a-z0-9_-]*)\.test\.ts$/u,
    },
    { id: "docs", pattern: /^docs\/.+/u },
    { id: "root-markdown", pattern: /^[^/]+\.md$/u },
    { id: "planning-markdown", pattern: /^\.planning\/.+\.md$/u },
  ].map((rule) => Object.freeze(rule)),
);

/**
 * Wins over LINUX_SAFE_PATH_RULES even if a rule above is later widened to
 * accidentally cover one of these -- native, the shared transaction, the
 * public surface, packaging, release, and the classifier itself must never
 * be able to skip the matrix.
 */
const FULL_SCOPE_OVERRIDES = Object.freeze(
  [
    { id: "native", pattern: /^native\// },
    { id: "binding-gyp", pattern: /^binding\.gyp$/ },
    { id: "prebuilds", pattern: /^prebuilds\// },
    { id: "scripts", pattern: /^scripts\// },
    { id: "shared-transaction", pattern: /^(?:src|dist)\/transaction\// },
    {
      id: "engine-and-public-surface",
      pattern: /^(?:src|dist)\/(?:engine|fallback|index|types|result|errors)\./,
    },
    { id: "registry", pattern: /^(?:src|dist)\/admission\/registry\./ },
    { id: "packaging", pattern: /^package(?:-lock)?\.json$/ },
    { id: "workflows-and-config", pattern: /^\.github\// },
    { id: "corpus", pattern: /^tests\/corpus\// },
    { id: "classifier-tests", pattern: /^tests\/classify_ci_scope\.test\.ts$/ },
  ].map((rule) => Object.freeze(rule)),
);

/** A path git could plausibly emit but that must never be trusted for a rule match. */
function isMalformedPath(path) {
  if (typeof path !== "string" || path.length === 0) return true;
  if (path.startsWith("/")) return true;
  if (path.includes("\\")) return true;
  if (path.includes("\u0000")) return true;
  if (path.split("/").includes("..")) return true;
  return false;
}

/** true only when `path` positively matches a linux-safe rule and no override. */
function isLinuxSafePath(path) {
  if (isMalformedPath(path)) return false;
  for (const override of FULL_SCOPE_OVERRIDES) {
    if (override.pattern.test(path)) return false;
  }
  for (const rule of LINUX_SAFE_PATH_RULES) {
    if (rule.pattern.test(path)) return true;
  }
  return false;
}

/**
 * Pure decision function. No I/O. Order matters (D-16, D-17): every branch's
 * fallthrough is "full" -- there is no default-open path anywhere below.
 */
function classifyCiScope({ eventName, workflowName, ref, changedPaths }) {
  if (ALWAYS_FULL_EVENTS.includes(eventName))
    return Object.freeze({
      scope: "full",
      reason: `event ${String(eventName)} is always full`,
    });
  if (!FILTERED_EVENTS.includes(eventName))
    return Object.freeze({
      scope: "full",
      reason: `event ${String(eventName)} is not a filtered event`,
    });
  if (workflowName !== CI_WORKFLOW_NAME)
    return Object.freeze({
      scope: "full",
      reason: `workflow ${String(workflowName)} is not ${CI_WORKFLOW_NAME} (reusable-call caller context, D-17)`,
    });
  if (typeof ref === "string" && ref.startsWith("refs/tags/"))
    return Object.freeze({ scope: "full", reason: `ref ${ref} is a tag ref` });
  if (!Array.isArray(changedPaths) || changedPaths.length === 0)
    return Object.freeze({
      scope: "full",
      reason:
        "changedPaths is empty, unavailable, or the diff could not be computed",
    });
  for (const path of changedPaths) {
    if (!isLinuxSafePath(path))
      return Object.freeze({
        scope: "full",
        reason: `path is not linux-safe: ${String(path)}`,
      });
  }
  return Object.freeze({
    scope: "linux",
    reason: "every changed path matched the linux-safe allowlist",
  });
}

function diffNamesBetween(base, head, cwd) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head],
    { cwd, encoding: "utf8" },
  );
  return output.split("\u0000").filter((entry) => entry.length > 0);
}

/**
 * I/O layer: resolves the changed-path list for a filtered event via `git`
 * only. Any thrown error, or any condition D-17 calls out as untrustworthy
 * (missing/zero/unfetchable before SHA, a forced push, a non-merge HEAD for
 * pull_request), returns null so the caller falls back to "full".
 */
function changedPathsForEvent({ eventName, before, forced, head, cwd }) {
  try {
    if (eventName === "pull_request") {
      const parentsLine = execFileSync(
        "git",
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        { cwd, encoding: "utf8" },
      ).trim();
      const tokens = parentsLine.split(/\s+/u);
      if (tokens.length !== 3) return null;
      return diffNamesBetween("HEAD^1", "HEAD", cwd);
    }
    if (eventName === "push") {
      if (typeof before !== "string" || !/^[0-9a-f]{40}$/u.test(before))
        return null;
      if (/^0+$/u.test(before)) return null;
      if (forced === "true") return null;
      try {
        execFileSync("git", ["cat-file", "-e", `${before}^{commit}`], { cwd });
      } catch {
        try {
          execFileSync(
            "git",
            ["fetch", "--no-tags", "--depth=1", "origin", before],
            {
              cwd,
            },
          );
        } catch {
          return null;
        }
      }
      return diffNamesBetween(before, head ?? "HEAD", cwd);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ci.yml wiring validator (D-15, D-18). Jobs that skip entirely on a linux
 * scope, vs. jobs that report a required matrix context via a no-op leg
 * (Task 2 option-a) instead of skipping.
 */
const SKIP_GATED_JOBS = Object.freeze([
  "identity-prebuild",
  "assemble-exact-native",
  "immutable-sha-evidence",
]);
const NOOP_MATRIX_JOBS = Object.freeze([
  "build-audit-native",
  "installed-native",
  "benchmark-linux",
]);
const ALWAYS_RUN_JOBS = Object.freeze(["quality", "qualification-linux"]);

const JOB_HEADER_RE = /\n {2}([a-z][a-z0-9-]+):\n/gu;

function sliceJobs(workflowText) {
  // Only look inside the top-level `jobs:` block: the `on:` block's `push:`
  // entry is also 2-space indented with no underscore, so an unscoped regex
  // would misread it as a job.
  const jobsHeaderIndex = workflowText.indexOf("\njobs:\n");
  const searchText =
    jobsHeaderIndex >= 0
      ? workflowText.slice(jobsHeaderIndex + 1)
      : workflowText;
  const jobs = {};
  const matches = [...searchText.matchAll(JOB_HEADER_RE)];
  for (const [index, match] of matches.entries()) {
    const name = match[1];
    const start = match.index + 1; // skip the leading newline
    const end =
      index + 1 < matches.length
        ? matches[index + 1].index + 1
        : searchText.length;
    jobs[name] = searchText.slice(start, end);
  }
  return jobs;
}

function jobLevelIf(jobText) {
  const match = jobText.match(/\n {4}if: (.+)\n/u);
  return match ? match[1] : null;
}

function needsListIncludesClassify(jobText) {
  const inline = jobText.match(/\n {4}needs:\s*\[([^\]]*)\]/u);
  if (inline)
    return inline[1]
      .split(",")
      .map((entry) => entry.trim())
      .includes("classify");
  const multiline = jobText.match(/\n {4}needs:\n((?: {6}- .+\n)+)/u);
  if (multiline)
    return multiline[1]
      .split("\n")
      .some((line) => line.trim() === "- classify");
  return false;
}

function assertEveryStepGated(jobText, jobName) {
  const stepsIndex = jobText.indexOf("\n    steps:\n");
  if (stepsIndex < 0)
    throw new Error(`ci.yml wiring: ${jobName} has no steps: block`);
  const chunks = jobText.slice(stepsIndex).split("\n      - ").slice(1);
  for (const chunk of chunks) {
    if (chunk.includes("Record scope-skipped leg")) continue;
    const ifLine = chunk.match(/\n {8}if: (.+?)(?:\n|$)/u);
    if (
      ifLine === null ||
      !ifLine[1].includes("needs.classify.outputs.scope != 'linux'")
    )
      throw new Error(
        `ci.yml wiring: ${jobName} has a step not gated by needs.classify.outputs.scope != 'linux'`,
      );
  }
}

/**
 * Throws with a message naming the job and the violated rule when ci.yml's
 * classify wiring is weakened. Never throws on the real, correctly-wired
 * ci.yml.
 */
function validateCiScopeWiring(workflowText) {
  if (/dorny\//u.test(workflowText) || /tj-actions\//u.test(workflowText))
    throw new Error(
      "ci.yml wiring: must not reference a third-party diff action (D-14)",
    );
  if (workflowText.includes("outputs.scope == 'full'"))
    throw new Error(
      "ci.yml wiring: must not use a fail-open outputs.scope == 'full' gate form (D-16)",
    );

  const onBlockMatch = workflowText.match(/\non:\n([\s\S]*?)\njobs:\n/u);
  const onBlock = onBlockMatch ? onBlockMatch[1] : "";
  if (/\bpaths(?:-ignore)?:/u.test(onBlock))
    throw new Error(
      "ci.yml wiring: must not add workflow-level on.paths / on.paths-ignore (D-14)",
    );

  const jobs = sliceJobs(workflowText);

  const classifyJob = jobs.classify;
  if (classifyJob === undefined)
    throw new Error("ci.yml wiring: classify job is absent");
  if (!classifyJob.includes("steps.scope.outputs.scope"))
    throw new Error(
      "ci.yml wiring: classify job does not expose steps.scope.outputs.scope",
    );
  if (!classifyJob.includes("scripts/classify_ci_scope.cjs"))
    throw new Error(
      "ci.yml wiring: classify job does not run scripts/classify_ci_scope.cjs",
    );

  for (const jobName of ALWAYS_RUN_JOBS) {
    const job = jobs[jobName];
    if (job === undefined)
      throw new Error(`ci.yml wiring: ${jobName} job is absent`);
    if (job.includes("needs.classify") || needsListIncludesClassify(job))
      throw new Error(
        `ci.yml wiring: ${jobName} must never reference needs.classify`,
      );
  }

  for (const jobName of SKIP_GATED_JOBS) {
    const job = jobs[jobName];
    if (job === undefined)
      throw new Error(`ci.yml wiring: ${jobName} job is absent`);
    if (!needsListIncludesClassify(job))
      throw new Error(
        `ci.yml wiring: ${jobName} does not list classify in needs`,
      );
    const ifExpr = jobLevelIf(job);
    if (ifExpr === null || !ifExpr.includes("!cancelled()"))
      throw new Error(
        `ci.yml wiring: ${jobName} job-level if: is missing !cancelled()`,
      );
    if (!ifExpr.includes("needs.classify.outputs.scope != 'linux'"))
      throw new Error(
        `ci.yml wiring: ${jobName} job-level if: is missing needs.classify.outputs.scope != 'linux'`,
      );
  }

  for (const jobName of NOOP_MATRIX_JOBS) {
    const job = jobs[jobName];
    if (job === undefined)
      throw new Error(`ci.yml wiring: ${jobName} job is absent`);
    if (!needsListIncludesClassify(job))
      throw new Error(
        `ci.yml wiring: ${jobName} does not list classify in needs`,
      );
    const ifExpr = jobLevelIf(job);
    if (ifExpr === null || !ifExpr.includes("== 'linux' ||"))
      throw new Error(
        `ci.yml wiring: ${jobName} job-level if: is missing the == 'linux' || no-op condition`,
      );
    if (jobName !== "benchmark-linux") {
      if (
        !job.includes(
          "needs.classify.outputs.scope == 'linux' && 'ubuntu-24.04'",
        )
      )
        throw new Error(
          `ci.yml wiring: ${jobName} is missing the runs-on downgrade to ubuntu-24.04`,
        );
    }
    assertEveryStepGated(job, jobName);
  }

  const admissionJob = jobs["phase-46-admission"];
  if (admissionJob === undefined)
    throw new Error("ci.yml wiring: phase-46-admission job is absent");
  if (!needsListIncludesClassify(admissionJob))
    throw new Error(
      "ci.yml wiring: phase-46-admission does not list classify in needs",
    );
  const admissionIf = jobLevelIf(admissionJob);
  if (
    admissionIf === null ||
    !admissionIf.includes("needs.classify.outputs.scope != 'linux'")
  )
    throw new Error(
      "ci.yml wiring: phase-46-admission job-level if: is missing needs.classify.outputs.scope != 'linux'",
    );
}

function main() {
  const eventName = process.env.CLASSIFY_EVENT_NAME ?? "";
  const workflowName = process.env.CLASSIFY_WORKFLOW ?? "";
  const ref = process.env.CLASSIFY_REF ?? "";
  const before = process.env.CLASSIFY_BEFORE;
  const forced = process.env.CLASSIFY_FORCED;
  const head = process.env.CLASSIFY_HEAD ?? "HEAD";
  const cwd = process.cwd();

  const changedPaths = FILTERED_EVENTS.includes(eventName)
    ? changedPathsForEvent({ eventName, before, forced, head, cwd })
    : null;

  const result = classifyCiScope({
    eventName,
    workflowName,
    ref,
    changedPaths,
  });
  const pathCount = Array.isArray(changedPaths) ? changedPaths.length : 0;
  process.stdout.write(
    `scope=${result.scope} reason=${result.reason} paths=${pathCount}\n`,
  );

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    try {
      appendFileSync(outputPath, `scope=${result.scope}\n`);
    } catch (error) {
      process.stderr.write(
        `failed to write GITHUB_OUTPUT: ${String(error.message ?? error)}\n`,
      );
      return 1;
    }
  }
  return 0;
}

module.exports = {
  CI_WORKFLOW_NAME,
  ALWAYS_FULL_EVENTS,
  FILTERED_EVENTS,
  LINUX_SAFE_PATH_RULES,
  FULL_SCOPE_OVERRIDES,
  isLinuxSafePath,
  classifyCiScope,
  changedPathsForEvent,
  validateCiScopeWiring,
  SKIP_GATED_JOBS,
  NOOP_MATRIX_JOBS,
  ALWAYS_RUN_JOBS,
};

if (require.main === module) process.exit(main());
