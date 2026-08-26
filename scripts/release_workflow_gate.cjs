#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const REQUIRED_AUTHORITIES = Object.freeze([
  "immutable-sha-evidence",
  "installed-linux-x64",
  "installed-linux-arm64",
  "installed-darwin-x64",
  "installed-darwin-arm64",
  "installed-win32-x64",
  "installed-win32-arm64",
]);

function closure(jobs, start, seen = new Set(), visiting = new Set()) {
  if (visiting.has(start))
    throw new Error(`Release graph contains cycle at ${start}`);
  if (seen.has(start)) return seen;
  const job = jobs[start];
  if (!job) throw new Error(`Release graph references unknown need ${start}`);
  seen.add(start);
  visiting.add(start);
  for (const dependency of job.needs ?? [])
    closure(jobs, dependency, seen, visiting);
  visiting.delete(start);
  return seen;
}

function validateReleaseGraph({ jobs }) {
  if (!jobs || typeof jobs !== "object")
    throw new Error("Release jobs are missing");
  for (const [name, job] of Object.entries(jobs)) closure(jobs, name);
  const publishJobs = Object.entries(jobs).filter(([, job]) =>
    /\bnpm\s+publish\b|registry publication/iu.test(job.script ?? ""),
  );
  if (publishJobs.length === 0)
    throw new Error("Release graph has no publish or dry-run path");
  for (const [name, job] of publishJobs) {
    const authorities = closure(jobs, name);
    for (const authority of REQUIRED_AUTHORITIES)
      if (!authorities.has(authority))
        throw new Error(
          `Publish job ${name} lacks required authority ${authority}`,
        );
    if (!/\bnpm\s+publish\s+admitted\//u.test(job.script ?? ""))
      throw new Error(
        `Publish job ${name} does not publish the admitted tarball`,
      );
    if (/\bnpm\s+(?:run\s+)?build\b|npm\s+pack\b/iu.test(job.script ?? ""))
      throw new Error(`Publish job ${name} rebuilds or repacks after assembly`);
  }
  const immutable = jobs["immutable-sha-evidence"]?.script ?? "";
  if (
    !/admission\.json.*implementationSha.*tarballSha256|implementationSha.*tarballSha256.*admission\.json/u.test(
      immutable,
    ) ||
    /latest|mutable/iu.test(immutable)
  )
    throw new Error(
      "Immutable authority does not verify the admitted implementation SHA and tarball digest",
    );
  for (const authority of REQUIRED_AUTHORITIES.slice(1)) {
    const script = jobs[authority]?.script ?? "";
    const tuple = authority.slice("installed-".length);
    if (
      !script.includes("admission.json") ||
      !script.includes(tuple) ||
      !script.includes("implementationSha") ||
      !script.includes("tarballSha256")
    )
      throw new Error(
        `${authority} does not verify tuple, SHA, and tarball digest`,
      );
    if (/\bnpm\s+(?:run\s+)?build\b|npm\s+pack\b/iu.test(script))
      throw new Error(`${authority} rebuilds after assembly`);
  }
}

function parseWorkflow(path) {
  const text = readFileSync(path, "utf8");
  const jobs = {};
  let current;
  let collectingNeeds = false;
  for (const line of text.split(/\r?\n/u)) {
    const job = line.match(/^  ([a-z0-9-]+):\s*$/u);
    if (job) {
      current = job[1];
      jobs[current] = { needs: [], script: "" };
      collectingNeeds = false;
      continue;
    }
    if (!current) continue;
    const needs = line.match(/^    needs:\s*(.*)$/u);
    if (needs) {
      collectingNeeds = !needs[1].includes("]");
      const values = needs[1].replace(/[\[\]]/gu, "");
      jobs[current].needs.push(
        ...values
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else if (collectingNeeds) {
      collectingNeeds = !line.includes("]");
      jobs[current].needs.push(
        ...line
          .replace(/[\[\]]/gu, "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    }
    if (/^\s*(?:-\s+)?(?:run|uses):/u.test(line) || /^\s+run:/u.test(line))
      jobs[current].script += `${line}\n`;
  }
  return { jobs };
}

function main() {
  const path = process.argv[2] ?? ".github/workflows/release.yml";
  validateReleaseGraph(parseWorkflow(resolve(path)));
  console.log("Release workflow gate passed");
}

module.exports = { REQUIRED_AUTHORITIES, parseWorkflow, validateReleaseGraph };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}
