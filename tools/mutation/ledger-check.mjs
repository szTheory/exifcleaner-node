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
import {
  validateDeletion,
  validateReadCStringBoundary,
  containsWholeWord,
  enclosingFunctionSpan,
} from "./deletion-proof.mjs";

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

  // A scoped dead claim is statically proven on every checker invocation,
  // including --pre (which has no final report). The immutable compact snapshot
  // supplies the original owner metadata; missing membership fails closed.
  let immutableSurvivors = null;
  try {
    const snapshot = JSON.parse(readFileSync(join(root, "tools", "mutation", "pre-triage-survivors.json"), "utf8"));
    if (Array.isArray(snapshot.survivors)) immutableSurvivors = snapshot.survivors;
  } catch { /* fixture callers may intentionally omit a snapshot */ }
  if (immutableSurvivors !== null) {
    const original = new Map();
    for (const member of immutableSurvivors) {
      if (original.has(member.key)) problems.push(`${show(member.key)}: duplicate immutable pre-triage key`);
      original.set(member.key, member);
      const owners = membership.get(member.key) ?? [];
      if (owners.length === 0 && preReport === null) problems.push(`${show(member.key)}: in no cluster`);
      for (const id of owners) {
        const owner = clusters.find((c) => c.id === id);
        if (owner && (owner.group !== member.group || owner.file !== member.file ||
            owner.function !== member.function || owner.mutatorName !== member.mutatorName))
          problems.push(`${show(member.key)}: cluster ${id} differs from immutable origin`);
      }
    }
    for (const [key, owners] of membership) {
      if (!original.has(key) && preReport === null) problems.push(`${show(key)}: not a member of the immutable pre-triage snapshot`);
      if (owners.length > 1 && preReport === null)
        problems.push(`${show(key)}: in ${owners.length} clusters (${owners.join(", ")})`);
    }
  }
  for (const c of clusters) {
    if (c.sourceOperation) {
      const finalEntry = finalReport?.files?.[c.file] ?? null;
      const proof = validateReadCStringBoundary({
        row: c,
        root,
        currentSource: mode === "final" ? finalEntry?.source ?? null : null,
        finalEntry,
        finalReport,
        readTest: (file) => readFileSync(join(root, file), "utf8"),
        survivors: immutableSurvivors,
        requireFinal: mode === "final" && finalReport !== null,
      });
      problems.push(...proof.problems);
    }
    if (c.symbolScope !== undefined && (c.disposition !== "dead" || c.symbolScope !== "function"))
      problems.push(`${c.id}: symbolScope is only valid as "function" on a dead row`);
    if (c.compilerKilled !== undefined && (c.disposition !== "gap" || c.compilerKilled !== true))
      problems.push(`${c.id}: compilerKilled is only valid as true on a gap row`);
    if (c.disposition !== "dead" || !c.deletion) continue;
    const finalEntry = finalReport?.files?.[c.file] ?? null;
    const proof = validateDeletion({
      row: c,
      root,
      currentSource: null,
      finalEntry,
      finalReport,
      readTest: (file) => readFileSync(join(root, file), "utf8"),
      survivors: immutableSurvivors,
      requireFinal: finalReport !== null,
    });
    problems.push(...proof.problems);
  }

  if (mode === "final") {
    for (const c of clusters) {
      if (c.disposition === "pending")
        problems.push(`${c.id}: cluster is pending`);
      else if (c.disposition === "gap" && c.compilerKilled === true) {
        // Plan 67-19 amendment 2: every member's mutant is a CompileError, so no test names it.
        if (c.test !== undefined)
          problems.push(`${c.id}: compiler-killed gap row must not name a test`);
      } else if (c.disposition === "gap") {
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
        else if (c.symbolScope === "function") {
          // Plan 67-19 amendment 2: the witness only has to be gone from the enclosing function.
          try {
            const span = enclosingFunctionSpan(
              readFileSync(join(root, c.file), "utf8"),
              c.function,
            );
            if (containsWholeWord(span.text, c.symbol))
              problems.push(
                `${c.id}: dead symbol ${c.symbol} still appears in function ${c.function}`,
              );
          } catch (error) {
            problems.push(`${c.id}: scoped dead proof failed: ${error.message}`);
          }
        } else if (!c.deletion && symbolInSrc(c.symbol, root))
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

/**
 * The compact pre-triage-survivors.json ({ survivors: [...] }) as a minimal
 * report, so one checker serves the compact file and a full mutation.json.
 */
export function asReport(parsed) {
  if (!Array.isArray(parsed?.survivors)) return parsed;
  const files = {};
  for (const s of parsed.survivors) {
    files[s.file] ??= { language: "typescript", source: "", mutants: [] };
    files[s.file].mutants.push({
      id: String(files[s.file].mutants.length),
      mutatorName: s.mutatorName,
      replacement: s.replacement,
      status: s.status,
      location: s.location,
    });
  }
  return { files };
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
      p === null ? null : asReport(JSON.parse(readFileSync(p, "utf8")));
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
