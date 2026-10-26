#!/usr/bin/env node
// Survivor ledger checker (MUT-03, D-18). Node builtins plus relative imports.
//
// ledger.json maps every pre-triage trust-group Survived/NoCoverage mutant to a
// cluster with a disposition: pending | gap (a test now kills it) | equivalent
// (a next-line Stryker disable with a class) | dead (the code was deleted).
// Each claim is checked against the reports, the tests and the source so a row
// cannot name a test, deletion or disable that does not exist.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClasses, parseDisableReason } from "./disable-lint.mjs";
import { groupsFor } from "./groups.mjs";
import { anchorKey, mutantKey } from "./identity.mjs";

const show = (key) => key.replaceAll("\u0000", "|");
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

function isTrust(file, groups) {
  return groupsFor(file, groups).some((n) => groups[n].tier === "trust");
}

/** Every mutant of the report as { file, mutant, source }. */
function* mutantsOf(report) {
  for (const [file, entry] of Object.entries(report?.files ?? {}))
    for (const mutant of entry.mutants ?? [])
      yield { file, mutant, source: entry.source ?? "" };
}

function symbolInSrc(symbol, root) {
  try {
    execFileSync(
      "git",
      ["grep", "--no-index", "-q", "-w", "-F", "-e", symbol, "--", "src"],
      {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true; // exit 0: a match
  } catch (error) {
    if (error.status === 1) return false; // no match
    throw new Error(`git grep failed for ${symbol}: ${error.message}`);
  }
}

export function checkLedger({
  ledger,
  preReport = null,
  finalReport = null,
  root,
  groups,
  classes = loadClasses(),
  mode,
}) {
  const problems = [];
  const clusters = ledger?.clusters;
  if (!Array.isArray(clusters)) return ["ledger has no clusters array"];

  const ids = new Set();
  const membership = new Map(); // key -> cluster ids
  for (const c of clusters) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate cluster id`);
    ids.add(c.id);
    if (c.count !== (c.keys ?? []).length)
      problems.push(
        `${c.id}: count ${c.count} differs from ${(c.keys ?? []).length} keys`,
      );
    for (const key of c.keys ?? []) {
      if (!membership.has(key)) membership.set(key, []);
      membership.get(key).push(c.id);
    }
  }

  if (preReport !== null) {
    const survivors = new Set();
    for (const { file, mutant } of mutantsOf(preReport))
      if (UNDETECTED.has(mutant.status) && isTrust(file, groups))
        survivors.add(mutantKey(file, mutant));
    for (const key of [...survivors].sort())
      if (!membership.has(key)) problems.push(`${show(key)}: in no cluster`);
    for (const [key, owners] of membership) {
      if (owners.length > 1)
        problems.push(
          `${show(key)}: in ${owners.length} clusters (${owners.join(", ")})`,
        );
      if (!survivors.has(key))
        problems.push(
          `${show(key)}: not a trust survivor of the pre-triage report`,
        );
    }
  }

  if (mode === "final") {
    for (const c of clusters) {
      if (c.disposition === "pending")
        problems.push(`${c.id}: cluster is pending`);
      else if (c.disposition === "gap") {
        const file = c.test?.file;
        const name = c.test?.name;
        const path = typeof file === "string" ? join(root, file) : null;
        if (path === null || !existsSync(path))
          problems.push(`${c.id}: gap test file ${file} is missing`);
        else if (
          typeof name !== "string" ||
          name === "" ||
          !readFileSync(path, "utf8").includes(name)
        )
          problems.push(
            `${c.id}: gap test ${file} does not contain test name ${JSON.stringify(name)}`,
          );
      } else if (c.disposition === "dead") {
        if (typeof c.symbol !== "string" || c.symbol === "")
          problems.push(`${c.id}: dead row has no symbol`);
        else if (symbolInSrc(c.symbol, root))
          problems.push(
            `${c.id}: dead symbol ${c.symbol} still appears in src/`,
          );
      } else if (c.disposition === "equivalent") {
        if (!parseDisableReason(`${c.equivalenceClass} — x`, classes).valid)
          problems.push(
            `${c.id}: equivalenceClass ${JSON.stringify(c.equivalenceClass)} is not a known class`,
          );
      } else
        problems.push(
          `${c.id}: unknown disposition ${JSON.stringify(c.disposition)}`,
        );
    }

    if (finalReport !== null) {
      const anchorOwner = new Map(); // anchor -> cluster
      for (const c of clusters)
        if (c.disposition === "equivalent")
          for (const a of c.anchors ?? []) anchorOwner.set(a, c);
      for (const { file, mutant, source } of mutantsOf(finalReport)) {
        if (UNDETECTED.has(mutant.status) && isTrust(file, groups))
          problems.push(
            `${show(mutantKey(file, mutant))}: ${mutant.status} in a trust group in the final report`,
          );
        const commentIgnored =
          mutant.status === "Ignored" &&
          mutant.static !== true &&
          !String(mutant.statusReason ?? "").startsWith("error-message:");
        if (!commentIgnored) continue;
        const key = anchorKey(file, mutant, source);
        const owner = anchorOwner.get(key);
        if (owner === undefined)
          problems.push(
            `${show(key)}: comment-Ignored mutant matches no equivalent row`,
          );
        else {
          const parsed = parseDisableReason(mutant.statusReason, classes);
          if (!parsed.valid)
            problems.push(
              `${show(key)}: disable reason ${JSON.stringify(mutant.statusReason)} is not a valid class reason`,
            );
          else if (parsed.className !== owner.equivalenceClass)
            problems.push(
              `${owner.id}: equivalenceClass ${owner.equivalenceClass} differs from the disable comment class ${parsed.className}`,
            );
        }
      }
    }
  }
  return problems;
}

function summary(ledger, groups) {
  const lines = [];
  for (const name of Object.keys(groups)) {
    const counts = {};
    for (const c of ledger.clusters ?? [])
      if (c.group === name)
        counts[c.disposition] = (counts[c.disposition] ?? 0) + 1;
    lines.push(`${name}: ${JSON.stringify(counts)}`);
  }
  return lines;
}

/** CLI: ledger-check.mjs [--pre <mutation.json>] [--final <mutation.json>] */
export function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const prePath = arg("--pre");
  const finalPath = arg("--final");
  try {
    const ledger = JSON.parse(
      readFileSync(join(root, "tools", "mutation", "ledger.json"), "utf8"),
    );
    const groups = JSON.parse(
      readFileSync(join(root, "mutation-floors.json"), "utf8"),
    ).groups;
    const read = (p) =>
      p === null ? null : JSON.parse(readFileSync(p, "utf8"));
    const problems = checkLedger({
      ledger,
      preReport: read(prePath),
      finalReport: read(finalPath),
      root,
      groups,
      mode: finalPath === null ? "pre" : "final",
    });
    for (const line of summary(ledger, groups))
      process.stdout.write(`${line}\n`);
    for (const p of problems) process.stderr.write(`ledger: ${p}\n`);
    if (problems.length === 0) process.stdout.write("ledger: ok\n");
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`ledger: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
