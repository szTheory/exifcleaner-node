#!/usr/bin/env node
// Authoritative baseline driver (MUT-02 D-11, MUT-03 D-14, D-23). Builtins plus
// relative imports only. Everything arrives through the environment and leaves
// through argument arrays: no shell is ever involved.
//
//   baseline.mjs dryruns <n>     n consecutive --dryRunOnly runs, compared
//   baseline.mjs full            one mutation run, writes baseline-meta.json
//   baseline.mjs aggregate <dir> flake diff and per-group minima over attempts
//
// Floors come only from CI artifacts whose baseline-meta.json platform is linux.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  allowlistFromConfig,
  compareDryRuns,
  waitForEventFile,
} from "./dryrun-compare.mjs";
import { diffAttempts } from "./flake-diff.mjs";
import { headroomHints, scoreReport } from "./floors.mjs";
import { groupsFor } from "./groups.mjs";
import { formatRow } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REPORTS = join(ROOT, "reports", "mutation");
const STRYKER_BIN = join(HERE, "node_modules", ".bin", "stryker");
const CONFIG = "tools/mutation/stryker.config.json";
const SAMPLE_MS = 5000;

const tracked = (root = ROOT, pathspec = "src") =>
  execFileSync("git", ["ls-files", "--", pathspec], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

/** Tracked src/**\/*.ts files. */
export function trackedSrc(root = ROOT) {
  return tracked(root).filter((p) => p.endsWith(".ts"));
}

/**
 * Files to mutate for a group. `all` is every tracked src ts file; otherwise
 * the files matching the group's globs. `floors` is the parsed
 * mutation-floors.json or its `groups` object. Empty is an error.
 */
export function mutateListForGroup(group, floors, trackedFiles) {
  const groups = floors.groups ?? floors;
  let list;
  if (group === "all") list = [...trackedFiles];
  else {
    if (!Object.hasOwn(groups, group))
      throw new Error(`unknown group ${group}`);
    list = trackedFiles.filter((f) => groupsFor(f, groups).includes(group));
  }
  list.sort();
  if (list.length === 0) throw new Error(`group ${group} matches no files`);
  return list;
}

/** Files declaring a MAX_ constant plus src/isobmff/caps.ts (D-14 caps run). */
export function capFiles(root = ROOT) {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "-E", "^(export )?const MAX_[A-Z0-9_]+", "--", "src"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    if (error.status !== 1) throw error; // 1 means no match
  }
  const files = new Set(out.split("\n").filter((f) => f.endsWith(".ts")));
  files.add("src/isobmff/caps.ts");
  const list = [...files].sort();
  if (list.length === 0) throw new Error("no cap files found");
  return list;
}

function readProc(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Summed VmRSS (bytes) of rootPid and its descendants, from /proc. */
function treeRss(rootPid) {
  const parents = new Map();
  const rss = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    const status = readProc(`/proc/${name}/status`);
    if (status === null) continue;
    const ppid = /^PPid:\s+(\d+)/mu.exec(status);
    const vm = /^VmRSS:\s+(\d+)\s+kB/mu.exec(status);
    parents.set(Number(name), ppid ? Number(ppid[1]) : 0);
    rss.set(Number(name), vm ? Number(vm[1]) * 1024 : 0);
  }
  let total = 0;
  for (const [pid, bytes] of rss) {
    for (
      let p = pid, hops = 0;
      p > 1 && hops < 64;
      p = parents.get(p), hops++
    ) {
      if (p === rootPid) {
        total += bytes;
        break;
      }
      if (!parents.has(p)) break;
    }
  }
  return total;
}

/**
 * One memory sample. `unavailable` off Linux; otherwise
 * { usedBytes: MemTotal - MemAvailable, treeRssBytes } for the pid tree.
 */
export function sampleMemory(rootPid, platform = process.platform) {
  if (platform !== "linux") return "unavailable";
  const info = readProc("/proc/meminfo");
  if (info === null) return "unavailable";
  const total = /^MemTotal:\s+(\d+)\s+kB/mu.exec(info);
  const avail = /^MemAvailable:\s+(\d+)\s+kB/mu.exec(info);
  if (!total || !avail) return "unavailable";
  return {
    usedBytes: (Number(total[1]) - Number(avail[1])) * 1024,
    treeRssBytes: rootPid === undefined ? 0 : treeRss(rootPid),
  };
}

function countMutants(report) {
  let n = 0;
  for (const file of Object.values(report.files ?? {}))
    n += (file.mutants ?? []).length;
  return n;
}

function strykerVersion() {
  const text = readProc(
    join(HERE, "node_modules", "@stryker-mutator", "core", "package.json"),
  );
  return text === null ? "unknown" : (JSON.parse(text).version ?? "unknown");
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readFloors() {
  return JSON.parse(readFileSync(join(ROOT, "mutation-floors.json"), "utf8"));
}

function appendSummary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  writeFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`, { flag: "a" });
}

/** Run Stryker with an argument array; resolves { exitCode, signal, peaks }. */
function runStryker(args) {
  return new Promise((resolve) => {
    const child = spawn(STRYKER_BIN, args, { cwd: ROOT, stdio: "inherit" });
    let peakUsed = "unavailable";
    let peakTree = "unavailable";
    const sample = () => {
      const s = sampleMemory(child.pid);
      if (s === "unavailable") return;
      peakUsed = Math.max(
        peakUsed === "unavailable" ? 0 : peakUsed,
        s.usedBytes,
      );
      peakTree = Math.max(
        peakTree === "unavailable" ? 0 : peakTree,
        s.treeRssBytes,
      );
    };
    sample();
    const timer = setInterval(sample, SAMPLE_MS);
    child.on("close", (exitCode, signal) => {
      clearInterval(timer);
      sample();
      resolve({ exitCode, signal, peakUsed, peakTree });
    });
    child.on("error", () => {
      clearInterval(timer);
      resolve({ exitCode: 1, signal: null, peakUsed, peakTree });
    });
  });
}

async function full(env) {
  const group = env.BASELINE_GROUP || "all";
  const caps = env.BASELINE_CAPS === "true";
  const attempt = Number(env.BASELINE_ATTEMPT || "1");
  const mutate = caps
    ? capFiles()
    : mutateListForGroup(group, readFloors(), trackedSrc());
  const args = ["run", CONFIG, "--mutate", mutate.join(",")];
  if (caps) args.push("--ignoreStatic", "false");
  let concurrency = 4;
  if (env.BASELINE_CONCURRENCY) {
    concurrency = Number(env.BASELINE_CONCURRENCY);
    args.push("--concurrency", String(concurrency));
  }
  rmSync(join(REPORTS, "mutation.json"), { force: true });
  const started = Date.now();
  const done = await runStryker(args);
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(REPORTS, "mutation.json"), "utf8"));
  } catch {
    report = null;
  }
  const meta = {
    sha: gitSha(),
    strykerVersion: strykerVersion(),
    node: process.version,
    platform: process.platform,
    concurrency,
    group: caps ? "caps" : group,
    ignoreStatic: !caps,
    attempt,
    wallSeconds,
    exitCode: done.exitCode ?? -1,
    mutantCount: report === null ? 0 : countMutants(report),
    peakUsedMemoryBytes: done.peakUsed,
    peakTreeRssBytes: done.peakTree,
  };
  writeJson(join(REPORTS, "baseline-meta.json"), meta);
  if (done.exitCode !== 0 || report === null) {
    process.stderr.write(
      `baseline: stryker exit ${done.exitCode}, report ${report === null ? "missing" : "present"}\n`,
    );
    return 1;
  }
  const lines = [];
  const scored = scoreReport(report, readFloors().groups);
  for (const [name, entry] of Object.entries(scored))
    lines.push(formatRow(name, entry));
  process.stdout.write(`${lines.join("\n")}\n`);
  appendSummary(
    env,
    `### Baseline ${meta.group} attempt ${attempt}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\nwall ${wallSeconds}s, mutants ${meta.mutantCount}, platform ${meta.platform}`,
  );
  return 0;
}

async function dryruns(n) {
  if (!Number.isInteger(n) || n < 2) {
    process.stderr.write("baseline: dryruns needs an integer >= 2\n");
    return 1;
  }
  const events = [];
  const copies = join(REPORTS, "dryrun-copies");
  rmSync(copies, { recursive: true, force: true });
  for (let i = 1; i <= n; i++) {
    rmSync(join(REPORTS, "events"), { recursive: true, force: true });
    const r = spawnSync(STRYKER_BIN, ["run", CONFIG, "--dryRunOnly"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      process.stderr.write(`baseline: dry run ${i} exited ${r.status}\n`);
      return 1;
    }
    const file = await waitForEventFile(join(REPORTS, "events"), 60000);
    const dest = join(copies, `run-${i}`);
    cpSync(join(REPORTS, "events"), dest, { recursive: true });
    events.push(
      JSON.parse(readFileSync(join(dest, file.split("/").pop()), "utf8")),
    );
  }
  const allowlist = allowlistFromConfig(
    readFileSync(join(HERE, "vitest.stryker.config.ts"), "utf8"),
  );
  const { digests, problems } = compareDryRuns(events, allowlist);
  digests.forEach((d, i) => process.stdout.write(`run ${i + 1}: ${d}\n`));
  for (const p of problems) process.stderr.write(`baseline: ${p}\n`);
  if (problems.length === 0)
    process.stdout.write(`dry runs identical (${n})\n`);
  return problems.length === 0 ? 0 : 1;
}

/** Per-group minimum scores across attempts, plus hints. Pure. */
export function aggregateScores(reports, groups) {
  const scoredList = reports.map((r) => scoreReport(r, groups));
  const minima = {};
  for (const name of Object.keys(groups)) {
    const values = scoredList
      .map((s) => s[name]?.scoreTenths)
      .filter((v) => v !== undefined);
    if (values.length > 0) minima[name] = Math.min(...values);
  }
  return { minima, hints: headroomHints(scoredList, groups) };
}

function aggregate(dir, env) {
  if (!dir || !existsSync(dir)) {
    process.stderr.write("baseline: aggregate needs an existing directory\n");
    return 1;
  }
  const reports = [];
  const metas = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name, "mutation.json");
    if (!existsSync(path)) continue;
    reports.push(JSON.parse(readFileSync(path, "utf8")));
    const metaPath = join(dir, name, "baseline-meta.json");
    if (existsSync(metaPath))
      metas.push(JSON.parse(readFileSync(metaPath, "utf8")));
  }
  const diff = diffAttempts(reports);
  const groups = readFloors().groups;
  let scores = { minima: {}, hints: [] };
  if (diff.problems.length === 0) scores = aggregateScores(reports, groups);
  const result = {
    attempts: reports.length,
    keyCount: diff.keyCount,
    digests: diff.digests,
    flakes: diff.flakes,
    swaps: diff.swaps,
    problems: diff.problems,
    minima: scores.minima,
    hints: scores.hints,
    metas,
  };
  writeJson(join(dir, "aggregate.json"), result);
  for (const p of diff.problems) process.stderr.write(`baseline: ${p}\n`);
  for (const f of diff.flakes)
    process.stderr.write(`flake ${f.key} ${f.statuses.join(" ")}\n`);
  for (const [name, v] of Object.entries(scores.minima))
    process.stdout.write(`min ${name} ${v}\n`);
  for (const h of scores.hints) process.stdout.write(`hint ${h}\n`);
  process.stdout.write(
    `attempts ${reports.length} keys ${diff.keyCount} flakes ${diff.flakes.length} swaps ${diff.swaps.length}\n`,
  );
  appendSummary(
    env,
    `### Baseline aggregate\n\nattempts ${reports.length}, flakes ${diff.flakes.length}, swaps ${diff.swaps.length}\n\n\`\`\`\n${scores.hints.join("\n")}\n\`\`\``,
  );
  return diff.flakes.length === 0 && diff.problems.length === 0 ? 0 : 1;
}

export async function main(argv, env = process.env) {
  const [command, arg] = argv;
  try {
    if (command === "full") return await full(env);
    if (command === "dryruns") return await dryruns(Number(arg));
    if (command === "aggregate") return aggregate(arg, env);
  } catch (error) {
    process.stderr.write(`baseline: ${error.message}\n`);
    return 1;
  }
  process.stderr.write(
    "usage: baseline.mjs dryruns <n>|full|aggregate <dir>\n",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
