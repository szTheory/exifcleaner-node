// Recomputed mutation score per group (MUT-03, D-15). Node builtins only.
//
// Never trusts Stryker's own totals: the score is recomputed from raw mutant
// statuses. score = floor(1000 * D / (D + U)) tenths of a percent with
// D = Killed + Timeout, U = Survived + NoCoverage; CompileError, RuntimeError
// and Ignored are excluded.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupsFor } from "./groups.mjs";
import { keyedMutants } from "./identity.mjs";

const STATUSES = [
  "Killed",
  "Timeout",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Ignored",
];
const PLUGIN_PREFIX = "error-message:";

function emptyEntry() {
  return {
    counts: Object.fromEntries(STATUSES.map((s) => [s, 0])),
    detected: 0,
    undetected: 0,
    scoreTenths: 0,
    coveredScoreTenths: 0,
    timeout: 0,
    staticIgnored: 0,
    commentIgnored: 0,
    pluginIgnored: 0,
    files: [],
  };
}

export function scoreGroups(report, groups) {
  const keyed = keyedMutants(report); // throws on empty / duplicate
  const result = {};
  for (const name of Object.keys(groups)) result[name] = emptyEntry();
  const fileSeen = new Set();
  for (const { file, mutant } of keyed.values()) {
    const names = groupsFor(file, groups);
    if (names.length !== 1)
      throw new Error(
        `${file}: matches ${names.length} groups${names.length ? ` (${names.join(", ")})` : ""}`,
      );
    const entry = result[names[0]];
    if (!STATUSES.includes(mutant.status))
      throw new Error(`unknown mutant status ${JSON.stringify(mutant.status)}`);
    entry.counts[mutant.status]++;
    if (!fileSeen.has(file)) {
      fileSeen.add(file);
      entry.files.push(file);
    }
    if (mutant.status === "Timeout") entry.timeout++;
    if (mutant.status === "Ignored") {
      if (mutant.static === true) entry.staticIgnored++;
      else if (String(mutant.statusReason ?? "").startsWith(PLUGIN_PREFIX))
        entry.pluginIgnored++;
      else entry.commentIgnored++;
    }
  }
  for (const [name, entry] of Object.entries(result)) {
    const c = entry.counts;
    entry.detected = c.Killed + c.Timeout;
    entry.undetected = c.Survived + c.NoCoverage;
    const scorable = entry.detected + entry.undetected;
    if (scorable === 0) throw new Error(`group ${name} has no scorable mutant`);
    entry.scoreTenths = Math.floor((1000 * entry.detected) / scorable);
    const covered = entry.detected + c.Survived;
    entry.coveredScoreTenths =
      covered === 0 ? 0 : Math.floor((1000 * entry.detected) / covered);
    entry.files.sort();
  }
  return result;
}

export function formatRow(name, e) {
  return [
    name.padEnd(15),
    `score ${(e.scoreTenths / 10).toFixed(1)}%`,
    `covered ${(e.coveredScoreTenths / 10).toFixed(1)}%`,
    `K${e.counts.Killed} T${e.counts.Timeout} S${e.counts.Survived} N${e.counts.NoCoverage}`,
    `CE${e.counts.CompileError} RE${e.counts.RuntimeError} I${e.counts.Ignored}`,
    `static${e.staticIgnored} comment${e.commentIgnored} plugin${e.pluginIgnored}`,
  ].join("  ");
}

/**
 * CLI: score.mjs <mutation.json> [mutation-floors.json] [--only-present]
 * --only-present drops groups with no mutant (a partial or PR-scoped report)
 * instead of failing on them.
 */
export function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const onlyPresent = argv.includes("--only-present");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const reportPath =
    args[0] ?? join(root, "reports", "mutation", "mutation.json");
  const floorsPath = args[1] ?? join(root, "mutation-floors.json");
  let report;
  let groups;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
    groups = JSON.parse(readFileSync(floorsPath, "utf8")).groups;
  } catch (error) {
    process.stderr.write(`score: ${error.message}\n`);
    return 1;
  }
  try {
    if (onlyPresent) {
      const present = new Set();
      for (const f of Object.keys(report.files ?? {}))
        for (const n of groupsFor(f, groups)) present.add(n);
      groups = Object.fromEntries(
        Object.entries(groups).filter(([n]) => present.has(n)),
      );
    }
    const scores = scoreGroups(report, groups);
    for (const [name, entry] of Object.entries(scores))
      process.stdout.write(`${formatRow(name, entry)}\n`);
    process.stdout.write(`${JSON.stringify(scores)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`score: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
