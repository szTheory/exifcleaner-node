// Advisory PR mutation lane driver (MUT-04, D-25, D-26). Node builtins only.
//
//   lane.mjs plan   env LANE_EVENT_NAME, MUTATE_MODE, MUTATE_LIST -> lane-plan.json
//   lane.mjs smoke  stryker --dryRunOnly + onDryRunCompleted wait -> lane-smoke.json
//   lane.mjs run    stryker run --mutate <list>                    -> lane-run.json
//   lane.mjs gate   evaluateGate over the files above               -> gate-result.json
//
// Everything arrives through the environment and leaves through argument
// arrays: no shell is ever involved (T-67-17). A noop plan never spawns Stryker.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { waitForEventFile } from "./dryrun-compare.mjs";
import { evaluateGate, renderSummary } from "./lane-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REPORTS = join(ROOT, "reports", "mutation");
const STRYKER_BIN = join(HERE, "node_modules", ".bin", "stryker");
const CONFIG = "tools/mutation/stryker.config.json";
const ENTRY =
  /^(src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts)(?::\d+-\d+)?$/u;
const MODES = ["none", "tests-only", "smoke", "run", "run+smoke", "error"];

function writeJson(name, value) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, name), `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error.code === "ENOENT" ? "missing" : "unparseable" };
  }
}

/** Pure plan decision from the three environment inputs. */
export function decidePlan(env) {
  const eventName = env.LANE_EVENT_NAME ?? "";
  const mode = env.MUTATE_MODE ?? "";
  const list = env.MUTATE_LIST ?? "";
  const plan = {
    verdict: "noop",
    reason: "",
    mode,
    eventName,
    files: [],
    mutateList: list,
    install: false,
    smoke: false,
    run: false,
  };
  const done = (verdict, reason) => ({ ...plan, verdict, reason });
  if (eventName !== "pull_request")
    return done("noop", `event ${eventName} is not pull_request (D-25)`);
  if (!MODES.includes(mode))
    return done("error", `unknown mutate mode ${JSON.stringify(mode)}`);
  if (mode === "error")
    return done("error", "classifier reported error: mutate nothing");
  const entries = list === "" ? [] : list.split(",");
  const files = [];
  for (const entry of entries) {
    const m = entry.match(ENTRY);
    if (m === null)
      return done("error", `unsafe mutate entry ${JSON.stringify(entry)}`);
    if (!files.includes(m[1])) files.push(m[1]);
  }
  files.sort();
  if (mode === "tests-only") return done("noop", "tests changed, not mutated");
  if (mode === "none") {
    if (entries.length > 0)
      return done("error", "mode none with a non-empty mutate list");
    return done("noop", "no mutation-relevant changed paths");
  }
  const wantsRun = mode === "run" || mode === "run+smoke";
  if (wantsRun && entries.length === 0)
    return done("error", `mode ${mode} with an empty mutate list`);
  if (mode === "smoke" && entries.length > 0)
    return done("error", "mode smoke with a non-empty mutate list");
  return {
    ...plan,
    verdict: "proceed",
    reason: `mode ${mode}`,
    files,
    install: true,
    smoke: mode === "smoke" || mode === "run+smoke",
    run: wantsRun,
  };
}

function setOutputs(env, plan) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(
    env.GITHUB_OUTPUT,
    `install=${plan.install}\nsmoke=${plan.smoke}\nrun=${plan.run}\n`,
  );
}

function spawnStryker(args) {
  const started = Date.now();
  const child = spawnSync(STRYKER_BIN, args, { cwd: ROOT, stdio: "inherit" });
  return {
    exitCode: child.status,
    signal: child.signal ?? null,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    spawnError: child.error?.message,
  };
}

function loadProceedingPlan(flag) {
  const { value } = readJson(join(REPORTS, "lane-plan.json"));
  if (!value || value.verdict !== "proceed" || value[flag] !== true) {
    process.stdout.write(`lane: plan does not call for ${flag}; skipping\n`);
    return null;
  }
  return value;
}

async function smoke() {
  const plan = loadProceedingPlan("smoke");
  if (plan === null) return 0;
  rmSync(join(REPORTS, "events"), { recursive: true, force: true });
  const done = spawnStryker(["run", CONFIG, "--dryRunOnly"]);
  let result = done.exitCode === 0 && done.signal === null ? "pass" : "fail";
  if (result === "pass") {
    try {
      await waitForEventFile(join(REPORTS, "events"), 60000);
    } catch {
      result = "fail";
    }
  }
  writeJson("lane-smoke.json", { result, ...done });
  return result === "pass" ? 0 : 1;
}

function run(env) {
  const plan = loadProceedingPlan("run");
  if (plan === null) return 0;
  rmSync(join(REPORTS, "mutation.json"), { force: true });
  const done = spawnStryker(["run", CONFIG, "--mutate", env.MUTATE_LIST ?? ""]);
  writeJson("lane-run.json", done);
  return done.exitCode === 0 && done.signal === null ? 0 : 1;
}

function strykerVersion() {
  const pkg = readJson(
    join(HERE, "node_modules", "@stryker-mutator", "core", "package.json"),
  );
  return pkg.value?.version ?? "unknown";
}

/** PR head from LANE_HEAD_SHA; the merge SHA stands in only for non-PR events. */
function laneHeadSha(env) {
  if (env.LANE_HEAD_SHA) return env.LANE_HEAD_SHA;
  return env.LANE_EVENT_NAME === "pull_request"
    ? undefined
    : env.LANE_MERGE_SHA;
}

function gate(env) {
  const orMissing = (name) => readJson(join(REPORTS, name)).value ?? null;
  const report = readJson(join(REPORTS, "mutation.json"));
  const floors = readJson(join(ROOT, "mutation-floors.json"));
  const classes = readJson(join(HERE, "classes.json"));
  let result;
  if (floors.error || classes.error) {
    result = evaluateGate({
      plan: null,
      headSha: laneHeadSha(env),
      mergeSha: env.LANE_MERGE_SHA,
      baseSha: env.LANE_BASE_SHA,
      strykerVersion: strykerVersion(),
    });
    result.reason = `floors or classes ${floors.error ?? classes.error}`;
  } else {
    result = evaluateGate({
      plan: orMissing("lane-plan.json"),
      run: orMissing("lane-run.json"),
      smoke: orMissing("lane-smoke.json"),
      report: report.value ?? null,
      reportError: report.error,
      floors: floors.value,
      classes: classes.value,
      headSha: laneHeadSha(env),
      mergeSha: env.LANE_MERGE_SHA,
      baseSha: env.LANE_BASE_SHA,
      strykerVersion: strykerVersion(),
    });
  }
  writeJson("gate-result.json", result);
  process.stdout.write(`lane: ${result.verdict}: ${result.reason}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderSummary(result)}\n`);
  return result.verdict === "fail" || result.verdict === "error" ? 1 : 0;
}

export async function main(argv, env = process.env) {
  const [command] = argv;
  try {
    if (command === "plan") {
      const plan = decidePlan(env);
      writeJson("lane-plan.json", plan);
      setOutputs(env, plan);
      process.stdout.write(`lane: plan ${plan.verdict}: ${plan.reason}\n`);
      return plan.verdict === "error" ? 1 : 0;
    }
    if (command === "smoke") return await smoke();
    if (command === "run") return run(env);
    if (command === "gate") return gate(env);
  } catch (error) {
    process.stderr.write(`lane: ${error.message}\n`);
    return 1;
  }
  process.stderr.write("usage: lane.mjs plan|smoke|run|gate\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
