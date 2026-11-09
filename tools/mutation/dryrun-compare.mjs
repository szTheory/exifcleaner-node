// Dry-run determinism comparator (MUT-02, D-11). Node builtins only.
//
// Stryker writes an onDryRunCompleted event (via the event-recorder reporter)
// holding { result: { status, tests, mutantCoverage }, timing, capabilities }.
// Three runs of the same config must produce the same normalized event, and
// the event must be non-empty, else "deterministic" would be vacuous.
//
// Normalization drops timing (every timeSpentMs, the top-level timing) and
// absolute paths (every fileName), sorts tests by id and recursively sorts
// object keys. The recorded event carries mutant ids (counters), not
// locations, so coverage is compared by id: that is only meaningful across
// runs with an identical mutate set and config, so callers pass one config
// hash per event and differing hashes are refused.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "timeSpentMs" || key === "fileName") continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

export function normalizeDryRun(event) {
  const result = event?.result ?? event ?? {};
  const tests = Array.isArray(result.tests) ? result.tests : [];
  return canonical({
    status: result.status,
    tests: [...tests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    mutantCoverage: result.mutantCoverage ?? null,
  });
}

export function digestOf(event) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeDryRun(event)))
    .digest("hex");
}

/** Test file path of a Vitest-runner test id (`<file>#<name>`). */
function fileOf(id) {
  const hash = String(id).indexOf("#");
  return hash === -1 ? String(id) : String(id).slice(0, hash);
}

/**
 * events: parsed event objects (three expected); allowlist: test file paths;
 * configHashes: optional per-event config hashes that must all be equal.
 * Returns { digests, problems }.
 */
export function compareDryRuns(events, allowlist, configHashes) {
  const problems = [];
  if (events.length < 2)
    problems.push(`need at least 2 runs, got ${events.length}`);
  if (configHashes !== undefined && new Set(configHashes).size > 1)
    problems.push(
      `config hashes differ (${[...new Set(configHashes)].join(", ")}): ids are not comparable`,
    );
  const digests = events.map(digestOf);
  if (new Set(digests).size > 1)
    problems.push(`digest mismatch: ${digests.join(" vs ")}`);
  events.forEach((event, index) => {
    const tests = normalizeDryRun(event).tests;
    const run = `run ${index + 1}`;
    if (tests.length === 0) {
      problems.push(`${run}: non-empty check failed: zero tests`);
      return;
    }
    if (tests.length < allowlist.length)
      problems.push(
        `${run}: non-empty check failed: ${tests.length} tests is fewer than the allowlist size ${allowlist.length}`,
      );
    const present = new Set(tests.map((t) => fileOf(t.id)));
    for (const file of allowlist)
      if (!present.has(file))
        problems.push(`${run}: allowlisted file ${file} contributed no test`);
  });
  return { digests, problems };
}

/** Poll until a parsed *-onDryRunCompleted.json exists (the reporter does not await its write). */
export async function waitForEventFile(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(dir)) {
      const name = readdirSync(dir).find((n) =>
        n.endsWith("-onDryRunCompleted.json"),
      );
      if (name !== undefined) {
        try {
          const path = join(dir, name);
          JSON.parse(readFileSync(path, "utf8"));
          return path;
        } catch {
          // partially written; poll again
        }
      }
    }
    if (Date.now() >= deadline)
      throw new Error(
        `no parseable onDryRunCompleted event in ${dir} after ${timeoutMs} ms`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Extract the STRYKER_TEST_ALLOWLIST string literals without importing the TS config. */
export function allowlistFromConfig(text) {
  const start = text.indexOf("STRYKER_TEST_ALLOWLIST");
  const open = text.indexOf("[", start);
  const close = text.indexOf("] as const", open);
  if (start === -1 || open === -1 || close === -1)
    throw new Error("cannot locate STRYKER_TEST_ALLOWLIST in config");
  return [...text.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * CLI: dryrun-compare.mjs <event.json> <event.json> [<event.json>...]
 *      --allowlist-from tools/mutation/vitest.stryker.config.ts
 * Prints the digests, exits 1 on any problem.
 */
export function main(argv) {
  const paths = [];
  let allowlistPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allowlist-from") allowlistPath = argv[++i];
    else paths.push(argv[i]);
  }
  try {
    if (allowlistPath === undefined)
      throw new Error("--allowlist-from is required");
    const allowlist = allowlistFromConfig(readFileSync(allowlistPath, "utf8"));
    const events = paths.map((p) => JSON.parse(readFileSync(p, "utf8")));
    const { digests, problems } = compareDryRuns(events, allowlist);
    digests.forEach((d, i) => {
      const tests = normalizeDryRun(events[i]).tests.length;
      process.stdout.write(`run ${i + 1}: ${d} tests ${tests}\n`);
    });
    for (const p of problems) process.stderr.write(`dryrun-compare: ${p}\n`);
    if (problems.length === 0)
      process.stdout.write(`identical, allowlist ${allowlist.length}\n`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`dryrun-compare: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
