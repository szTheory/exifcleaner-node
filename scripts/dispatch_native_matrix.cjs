#!/usr/bin/env node
"use strict";

const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const REQUIRED_TUPLES = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);
const SHA = /^[a-f0-9]{40}$/iu;
const DIGEST = /^[a-f0-9]{64}$/iu;

function exact(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function selectExactRun({ runs, workflow, ref, sha, startedAt }) {
  const after = Date.parse(startedAt);
  if (!Number.isFinite(after))
    throw new Error("dispatch start time is invalid");
  const matches = runs.filter(
    (run) =>
      run.path === `.github/workflows/${workflow}` &&
      run.event === "workflow_dispatch" &&
      run.head_branch === ref &&
      run.head_sha === sha &&
      Date.parse(run.created_at) >= after,
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one matching immutable workflow run; found ${matches.length}`,
    );
  return matches[0];
}

function validateEvidence({ implementationSha, tarballSha256, tuples }) {
  exact(implementationSha, "implementation SHA", SHA);
  exact(tarballSha256, "tarball SHA-256", DIGEST);
  if (!tuples || typeof tuples !== "object")
    throw new Error("tuple evidence is missing");
  const names = Object.keys(tuples).sort();
  if (names.join(",") !== [...REQUIRED_TUPLES].sort().join(","))
    throw new Error("Evidence must contain exactly six required tuples");
  for (const tuple of REQUIRED_TUPLES) {
    const evidence = tuples[tuple];
    exact(evidence?.binarySha256, `${tuple} binary SHA-256`, DIGEST);
    exact(evidence?.reportSha256, `${tuple} report SHA-256`, DIGEST);
    if (evidence.implementationSha !== implementationSha)
      throw new Error(`${tuple} implementation SHA does not match`);
    if (!Array.isArray(evidence.installed) || evidence.installed.length !== 2)
      throw new Error(
        `${tuple} must contain Node 22 and Node 24 installed conclusions`,
      );
    const versions = evidence.installed
      .map((item) => item?.node)
      .sort((a, b) => a - b);
    if (versions.join(",") !== "22,24")
      throw new Error(`${tuple} Node conclusions are incomplete`);
    for (const item of evidence.installed) {
      if (item.conclusion !== "pass")
        throw new Error(`${tuple} installed smoke did not pass`);
      if (item.tarballSha256 !== tarballSha256)
        throw new Error(`${tuple} installed tarball digest does not match`);
    }
  }
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options });
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1])
      throw new Error(
        "Usage: --workflow ci.yml --sha <40-hex> --watch --validation <file>",
      );
    values[args[index].slice(2)] = args[index + 1];
  }
  if (args.includes("--watch")) values.watch = true;
  return values;
}

function runMain() {
  const raw = process.argv.slice(2);
  const watchIndex = raw.indexOf("--watch");
  if (watchIndex !== -1) raw.splice(watchIndex, 1);
  const values = parseArgs(raw);
  const sha = exact(values.sha, "implementation SHA", SHA).toLowerCase();
  if (!values.workflow || !values.validation || !values.watch)
    throw new Error(
      "--workflow, --sha, --watch, and --validation are required",
    );
  if (
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw new Error("Refusing dispatch from a dirty implementation checkout");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== sha)
    throw new Error("Submitted SHA must equal the clean implementation HEAD");
  const ref = `proof/45-16-${sha}-${randomBytes(16).toString("hex")}`;
  execFileSync("git", ["push", "origin", `${sha}:refs/heads/${ref}`], {
    stdio: "inherit",
  });
  const startedAt = new Date().toISOString();
  gh(["workflow", "run", values.workflow, "--ref", ref]);
  let run;
  for (let attempt = 0; attempt < 30 && !run; attempt += 1) {
    const runs = JSON.parse(
      gh([
        "run",
        "list",
        "--workflow",
        values.workflow,
        "--branch",
        ref,
        "--event",
        "workflow_dispatch",
        "--json",
        "databaseId,path,event,headBranch,headSha,createdAt,url,status,conclusion",
        "--limit",
        "20",
      ]),
    ).map((item) => ({
      ...item,
      id: item.databaseId,
      head_branch: item.headBranch,
      head_sha: item.headSha,
      created_at: item.createdAt,
    }));
    try {
      run = selectExactRun({
        runs,
        workflow: values.workflow,
        ref,
        sha,
        startedAt,
      });
    } catch (error) {
      if (!String(error.message).includes("found 0")) throw error;
      execFileSync("sleep", ["2"]);
    }
  }
  if (!run) throw new Error("Matching dispatched run was not created");
  gh(["run", "watch", String(run.id), "--exit-status"], { stdio: "inherit" });
  const summary = JSON.parse(
    gh([
      "run",
      "view",
      String(run.id),
      "--json",
      "status,conclusion,url,headSha,headBranch,event,path",
    ]),
  );
  if (
    summary.status !== "completed" ||
    summary.conclusion !== "success" ||
    summary.headSha !== sha ||
    summary.headBranch !== ref ||
    summary.event !== "workflow_dispatch" ||
    summary.path !== `.github/workflows/${values.workflow}`
  )
    throw new Error(
      "Watched run does not retain its exact immutable identity and success conclusion",
    );
  const artifact = JSON.parse(
    gh(["api", `repos/{owner}/{repo}/actions/runs/${run.id}/artifacts`]),
  ).artifacts.find((item) => item.name === "final-native-admission");
  if (!artifact)
    throw new Error("Exact run did not upload final native admission evidence");
  const temp = resolve(`.native-admission-${run.id}`);
  gh(
    [
      "run",
      "download",
      String(run.id),
      "--name",
      "final-native-admission",
      "--dir",
      temp,
    ],
    { stdio: "inherit" },
  );
  const evidence = JSON.parse(
    readFileSync(resolve(temp, "admission.json"), "utf8"),
  );
  validateEvidence(evidence);
  if (evidence.implementationSha !== sha)
    throw new Error("Evidence SHA does not match submitted immutable SHA");
  writeFileSync(
    resolve(values.validation),
    `${readFileSync(resolve(values.validation), "utf8").trimEnd()}\n\n## Final immutable hosted admission\n\n- Primary implementation identity: \`${sha}\`\n- Workflow: \`${values.workflow}\`; event: \`workflow_dispatch\`; ref: \`${ref}\`\n- Exact watched run: [${run.id}](${summary.url})\n- Dispatch started: \`${startedAt}\`\n- Admitted tarball SHA-256: \`${evidence.tarballSha256}\`\n- Tuple evidence and Node 22/24 installed conclusions: \`${JSON.stringify(evidence.tuples)}\`\n`,
    "utf8",
  );
}

module.exports = { REQUIRED_TUPLES, selectExactRun, validateEvidence };
if (require.main === module) {
  try {
    runMain();
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}
