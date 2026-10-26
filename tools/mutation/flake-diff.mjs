// Flake diff over N >= 2 mutation.json reports from the same SHA (MUT-04, D-27).
// Node builtins only.
//
// A flake is a mutant (keyed by D-13: file, mutator, replacement, location)
// whose collapsed outcome differs between attempts, or that exists in some
// attempts only. Killed <-> Timeout is the same collapsed outcome (detected):
// listed as a swap, information only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collapseStatus, collapsedDigest, keyedMutants } from "./identity.mjs";

const display = (key) => key.split("\u0000").join("|");

/** @returns {{keyCount:number, digests:string[], flakes:object[], swaps:object[], problems:string[]}} */
export function diffAttempts(reports) {
  const out = { keyCount: 0, digests: [], flakes: [], swaps: [], problems: [] };
  if (!Array.isArray(reports) || reports.length < 2) {
    out.problems.push("need at least two reports to compare");
    return out;
  }
  const keyed = [];
  for (const [i, report] of reports.entries()) {
    try {
      keyed.push(keyedMutants(report));
      out.digests.push(collapsedDigest(report));
    } catch (error) {
      out.problems.push(`report ${i + 1}: ${error.message}`);
    }
  }
  if (out.problems.length > 0) return out;
  const union = new Set(keyed.flatMap((m) => [...m.keys()]));
  out.keyCount = union.size;
  for (const key of [...union].sort()) {
    const statuses = keyed.map((m) => m.get(key)?.mutant.status ?? "absent");
    const collapsed = statuses.map((s) =>
      s === "absent" ? "absent" : collapseStatus(s),
    );
    const entry = { key: display(key), statuses };
    if (new Set(collapsed).size > 1) out.flakes.push(entry);
    else if (new Set(statuses).size > 1) out.swaps.push(entry);
  }
  return out;
}

/** CLI: flake-diff.mjs <mutation.json> <mutation.json> [...]; exit 1 on a flake or problem. */
export function main(argv) {
  let result;
  try {
    result = diffAttempts(argv.map((p) => JSON.parse(readFileSync(p, "utf8"))));
  } catch (error) {
    process.stderr.write(`flake-diff: ${error.message}\n`);
    return 1;
  }
  result.digests.forEach((d, i) =>
    process.stdout.write(`attempt ${i + 1}: ${d}\n`),
  );
  process.stdout.write(`keys ${result.keyCount}\n`);
  for (const p of result.problems) process.stderr.write(`flake-diff: ${p}\n`);
  for (const f of result.flakes)
    process.stderr.write(`flake ${f.key} ${f.statuses.join(" ")}\n`);
  for (const s of result.swaps)
    process.stdout.write(`swap ${s.key} ${s.statuses.join(" ")}\n`);
  process.stdout.write(
    `flakes ${result.flakes.length} swaps ${result.swaps.length}\n`,
  );
  return result.flakes.length === 0 && result.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
