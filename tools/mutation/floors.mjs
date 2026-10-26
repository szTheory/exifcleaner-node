#!/usr/bin/env node
// Floors check for the mutation score (MUT-03, D-16). Node builtins only.
//
// Two gates. `scores` compares the recomputed per-group score of one or more
// reports against mutation-floors.json (minimum per group across reports).
// `monotonic` compares mutation-floors.json at HEAD with the same file on the
// PR base and fails if any floor drops, any group disappears or any glob is
// dropped. There is no override: floors only move up, by a manual edit. This
// script never writes any file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreGroups, formatRow } from "./score.mjs";
import { groupsFor } from "./groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Problems for every group whose minimum score across the reports is below its floor. */
export function checkScores(scoredList, floors) {
  const problems = [];
  for (const [name, group] of Object.entries(floors)) {
    const m = minScore(scoredList, name);
    if (m < group.floorTenths)
      problems.push(`${name}: measured ${m} below floor ${group.floorTenths}`);
  }
  return problems;
}

function minScore(scoredList, name) {
  let min = Infinity;
  for (const scored of scoredList) {
    const v = scored[name]?.scoreTenths ?? 0; // a missing group counts as 0
    if (v < min) min = v;
  }
  return min === Infinity ? 0 : min;
}

/** A hint per group, never a failure (D-16). */
export function headroomHints(scoredList, floors) {
  return Object.entries(floors).map(([name, group]) => {
    const m = minScore(scoredList, name);
    return `${name}: min ${m}, floor ${group.floorTenths}, headroom ${m - group.floorTenths} tenths`;
  });
}

export function resolveBaseRev(env) {
  if (env.MUTATION_BASE_REV) return env.MUTATION_BASE_REV;
  return `origin/${env.GITHUB_BASE_REF || "main"}`;
}

/** `{ status: "ok", text } | { status: "absent" } | { status: "error", error }`. */
export function readBaseFloors(baseRev, cwd = ROOT) {
  const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${baseRev}^{commit}`],
      opts,
    );
  } catch {
    return { status: "error", error: `base ${baseRev} cannot be resolved` };
  }
  try {
    execFileSync(
      "git",
      ["cat-file", "-e", `${baseRev}:mutation-floors.json`],
      opts,
    );
  } catch {
    return { status: "absent" };
  }
  try {
    const text = execFileSync(
      "git",
      ["show", `${baseRev}:mutation-floors.json`],
      opts,
    );
    return { status: "ok", text };
  } catch (error) {
    return {
      status: "error",
      error: `cannot read mutation-floors.json at ${baseRev}: ${error.message}`,
    };
  }
}

/** Problems when head lowers a floor, drops a group or drops a glob of base. */
export function checkMonotonic(baseText, headText) {
  let base;
  let head;
  try {
    base = JSON.parse(baseText).groups;
  } catch (error) {
    return [`base mutation-floors.json is not valid JSON: ${error.message}`];
  }
  try {
    head = JSON.parse(headText).groups;
  } catch (error) {
    return [`head mutation-floors.json is not valid JSON: ${error.message}`];
  }
  if (base === null || typeof base !== "object") return ["base has no groups"];
  if (head === null || typeof head !== "object") return ["head has no groups"];
  const problems = [];
  for (const [name, b] of Object.entries(base)) {
    const h = head[name];
    if (h === undefined) {
      problems.push(`${name}: removed group`);
      continue;
    }
    if (!(h.floorTenths >= b.floorTenths))
      problems.push(
        `${name}: lowered floor ${b.floorTenths} -> ${h.floorTenths}`,
      );
    const globs = new Set(h.globs ?? []);
    for (const g of b.globs ?? [])
      if (!globs.has(g)) problems.push(`${name}: glob list shrank: ${g}`);
  }
  return problems;
}

/**
 * Score only the groups the report has mutants for (a partial report is
 * legal); an absent group is then measured 0 by checkScores. A file in no
 * group or in two still throws (scoreGroups), so it exits red.
 */
export function scoreReport(report, groups) {
  const present = new Set();
  for (const f of Object.keys(report.files ?? {})) {
    const names = groupsFor(f, groups);
    if (names.length !== 1)
      throw new Error(
        `${f}: matches ${names.length} groups${names.length ? ` (${names.join(", ")})` : ""}`,
      );
    present.add(names[0]);
  }
  return scoreGroups(
    report,
    Object.fromEntries(Object.entries(groups).filter(([n]) => present.has(n))),
  );
}

function fail(message) {
  process.stderr.write(`floors: ${message}\n`);
  return 1;
}

/**
 * CLI: floors.mjs scores <mutation.json>... | floors.mjs monotonic
 * Reads mutation-floors.json from the package root (cwd-independent).
 */
export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const floorsPath = join(ROOT, "mutation-floors.json");
  if (command === "scores") {
    if (rest.length === 0) return fail("scores needs at least one report");
    let groups;
    const scoredList = [];
    try {
      groups = JSON.parse(readFileSync(floorsPath, "utf8")).groups;
      for (const path of rest)
        scoredList.push(
          scoreReport(JSON.parse(readFileSync(path, "utf8")), groups),
        );
    } catch (error) {
      return fail(error.message);
    }
    for (const scored of scoredList)
      for (const [name, entry] of Object.entries(scored))
        process.stdout.write(`${formatRow(name, entry)}\n`);
    for (const hint of headroomHints(scoredList, groups))
      process.stdout.write(`hint ${hint}\n`);
    const problems = checkScores(scoredList, groups);
    for (const p of problems) process.stderr.write(`floors: ${p}\n`);
    if (problems.length === 0) process.stdout.write("floors: ok\n");
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "monotonic") {
    const base = readBaseFloors(resolveBaseRev(env), ROOT);
    if (base.status === "error") return fail(base.error);
    if (base.status === "absent") {
      process.stdout.write("floors: mutation-floors.json introduced\n");
      return 0;
    }
    let head;
    try {
      head = readFileSync(floorsPath, "utf8");
    } catch (error) {
      return fail(error.message);
    }
    const problems = checkMonotonic(base.text, head);
    for (const p of problems) process.stderr.write(`floors: ${p}\n`);
    if (problems.length === 0) process.stdout.write("floors: monotonic ok\n");
    return problems.length === 0 ? 0 : 1;
  }
  return fail("usage: floors.mjs scores <mutation.json>... | monotonic");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
