#!/usr/bin/env node

const { readFileSync, readdirSync, statSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const https = require("node:https");

const HELP = `Usage: node scripts/ci_monitor.cjs <command> [arguments]

Commands:
  runs [--branch <name>]                 List recent workflow runs
  watch <run-id>                         Watch a run and exit with its status
  fail-fast <run-id>                     Watch a run and exit on failure
  rerun-failed <run-id>                  Rerun only failed jobs
  log-failed <run-id>                    Print failed job logs
  test-summary <run-id>                  Summarize job and step conclusions
  check-actions [file-or-directory]      Validate immutable action pins
  grep <run-id> --pattern <regex>        Search a run's logs
  wait-for <run-id> <job> --keyword <s>  Wait for a job log keyword
`;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function runGh(args, capture = false) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is required for this command");
  }
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`gh ${args.join(" ")} exited with status ${result.status}`);
  return result.stdout;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function workflowFiles(input = ".github/workflows") {
  const target = resolve(input);
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => join(target, name));
}

function githubCommitExists(owner, repo, sha) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(
      {
        hostname: "api.github.com",
        path: `/repos/${owner}/${repo}/commits/${sha}`,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "exifcleaner-ci-monitor",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolvePromise(response.statusCode === 200));
      },
    );
    request.on("error", reject);
  });
}

async function checkActions(input) {
  const errors = [];
  const pins = new Map();
  for (const file of workflowFiles(input)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      const use = line.match(
        /^\s*-?\s*uses:\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^\s#]+)(?:\s+#\s*(.+))?\s*$/u,
      );
      if (!use) return;
      const [, owner, repo, ref, annotation] = use;
      if (!/^[0-9a-f]{40}$/u.test(ref)) {
        errors.push(
          `${file}:${index + 1}: action is not pinned to a full commit SHA`,
        );
        return;
      }
      if (!annotation)
        errors.push(
          `${file}:${index + 1}: pinned action is missing a version comment`,
        );
      pins.set(`${owner}/${repo}@${ref}`, { owner, repo, ref, annotation });
    });
  }
  for (const [key, pin] of pins) {
    const exists = await githubCommitExists(pin.owner, pin.repo, pin.ref);
    if (!exists)
      errors.push(`${key}: commit was not found through the GitHub API`);
    else
      console.log(
        `verified ${key}${pin.annotation ? ` # ${pin.annotation}` : ""}`,
      );
  }
  if (errors.length) {
    errors.forEach((error) => console.error(`ERROR ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(`Action pin check passed (${pins.size} unique actions)`);
}

function summarize(runId) {
  const json = JSON.parse(
    runGh(["run", "view", runId, "--json", "jobs"], true),
  );
  let passed = 0;
  let failed = 0;
  for (const job of json.jobs ?? []) {
    console.log(`${job.conclusion ?? job.status}\t${job.name}`);
    for (const step of job.steps ?? []) {
      if (step.conclusion === "success") passed += 1;
      else if (step.conclusion && step.conclusion !== "skipped") failed += 1;
    }
  }
  console.log(`steps: ${passed} passed, ${failed} non-passing`);
  if (failed) process.exitCode = 1;
}

async function failFast(runId) {
  const badConclusions = new Set([
    "action_required",
    "cancelled",
    "failure",
    "stale",
    "timed_out",
  ]);
  while (true) {
    const run = JSON.parse(
      runGh(
        ["run", "view", runId, "--json", "status,conclusion,jobs,url"],
        true,
      ),
    );
    const failedJob = (run.jobs ?? []).find((job) =>
      badConclusions.has(job.conclusion),
    );
    if (failedJob) {
      throw new Error(
        `Run ${runId} failed in ${failedJob.name}: ${failedJob.conclusion}\n${run.url}`,
      );
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(
          `Run ${runId} completed with ${run.conclusion}\n${run.url}`,
        );
      }
      console.log(`Run ${runId} completed successfully\n${run.url}`);
      return;
    }
    console.log(`Run ${runId}: ${run.status}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "check-actions") return checkActions(args[0]);
  if (command === "runs") {
    const ghArgs = ["run", "list", "--limit", "20"];
    const branch = option(args, "--branch");
    if (branch) ghArgs.push("--branch", branch);
    return runGh(ghArgs);
  }
  if (command === "watch") {
    if (!args[0]) throw new Error(`${command} requires a run id`);
    return runGh(["run", "watch", args[0], "--exit-status"]);
  }
  if (command === "fail-fast") {
    if (!args[0]) throw new Error("fail-fast requires a run id");
    return failFast(args[0]);
  }
  if (command === "rerun-failed") {
    if (!args[0]) throw new Error("rerun-failed requires a run id");
    return runGh(["run", "rerun", args[0], "--failed"]);
  }
  if (command === "log-failed") {
    if (!args[0]) throw new Error("log-failed requires a run id");
    return runGh(["run", "view", args[0], "--log-failed"]);
  }
  if (command === "test-summary") {
    if (!args[0]) throw new Error("test-summary requires a run id");
    return summarize(args[0]);
  }
  if (command === "grep") {
    const pattern = option(args, "--pattern");
    if (!args[0] || !pattern)
      throw new Error("grep requires a run id and --pattern");
    const logs = runGh(["run", "view", args[0], "--log"], true);
    const regex = new RegExp(pattern, "iu");
    const matches = logs.split(/\r?\n/u).filter((line) => regex.test(line));
    console.log(matches.join("\n"));
    if (!matches.length) process.exitCode = 1;
    return;
  }
  if (command === "wait-for") {
    const [runId, job] = args;
    const keyword = option(args, "--keyword");
    if (!runId || !job || !keyword)
      throw new Error("wait-for requires a run id, job, and --keyword");
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const logs = runGh(["run", "view", runId, "--job", job, "--log"], true);
        if (logs.includes(keyword)) {
          console.log(`Found ${JSON.stringify(keyword)} in job ${job}`);
          return;
        }
      } catch (error) {
        console.error(`waiting: ${error.message}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    }
    throw new Error(
      `Timed out waiting for ${JSON.stringify(keyword)} in job ${job}`,
    );
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error) => fail(error.stack ?? error.message));
