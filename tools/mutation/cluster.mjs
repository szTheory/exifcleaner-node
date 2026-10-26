#!/usr/bin/env node
// Survivor extraction, clustering and triage partitioning (MUT-03, D-17, D-18,
// D-22). Node builtins plus relative imports.
//
// extract   <mutation.json> <runId> <sha>   -> pre-triage-survivors.json
// cluster                                   -> ledger.json (all pending)
// partition                                 -> markdown on stdout
//
// Every output is a pure function of its input: inputs are sorted before use
// and no clock, random value or object-insertion order reaches the output.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupsFor } from "./groups.mjs";
import { anchorKey, mutantKey } from "./identity.mjs";

const UNDETECTED = new Set(["Survived", "NoCoverage"]);
const NOT_A_FUNCTION = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "with",
  "await",
  "throw",
  "new",
  "typeof",
  "void",
  "delete",
  "yield",
  "super",
]);

const DECLARATIONS = [
  // function declarations and function expressions assigned to a name
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  // classes
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  // const f = (...) => / async (...) => / x => / function
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/,
  // object-literal property holding a function
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:\(.*\)\s*(?::\s*[^=]+)?=>|function\b)/,
];
const METHOD =
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/;

function declaredName(line) {
  for (const pattern of DECLARATIONS) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  const trimmed = line.trimEnd();
  const method = METHOD.exec(line);
  if (
    method &&
    !NOT_A_FUNCTION.has(method[1]) &&
    /(?:\{|\()$/.test(trimmed) &&
    !/^\s*(?:return|const|let|var)\b/.test(line)
  )
    return method[1];
  return null;
}

const indentOf = (line) => /^\s*/.exec(line)[0].length;

// The closing line of a multi-line signature: `): T {`, `} {`, `}): T {`.
const CLOSER = /^\s*\)|^\s*\}.*\{\s*$/;

/** The declaration opening the multi-line signature that line `at` closes. */
function signatureOpener(lines, at) {
  const indent = indentOf(lines[at]);
  for (let j = at - 1; j >= 0; j--) {
    if (lines[j].trim() === "" || indentOf(lines[j]) > indent) continue;
    return declaredName(lines[j]);
  }
  return null;
}

/**
 * Name of the nearest enclosing function, method, class member, arrow-function
 * const or object-literal method of a 1-based line, or `<module>`. Scans upward
 * for the nearest declaration whose indentation is lower than the mutant line.
 */
export function enclosingFunction(source, line) {
  const lines = source.split("\n");
  const own = lines[line - 1] ?? "";
  const ownName = declaredName(own);
  if (ownName !== null) return ownName;
  if (CLOSER.test(own)) {
    const opener = signatureOpener(lines, line - 1);
    if (opener !== null) return opener;
  }
  let ceiling = indentOf(own);
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i];
    if (text.trim() === "") continue;
    const indent = indentOf(text);
    if (indent >= ceiling) continue;
    const name = declaredName(text);
    if (name !== null) return name;
    if (CLOSER.test(text)) {
      const opener = signatureOpener(lines, i);
      if (opener !== null) return opener;
    }
    ceiling = indent;
  }
  return "<module>";
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Trust-group Survived/NoCoverage mutants of a Stryker report with the fields
 * the audit needs. `groups` is the mutation-floors.json groups map.
 */
export function extractSurvivors(report, groups) {
  const survivors = [];
  for (const [file, entry] of Object.entries(report.files)) {
    const names = groupsFor(file, groups).filter(
      (n) => groups[n].tier === "trust",
    );
    if (names.length === 0) continue;
    for (const mutant of entry.mutants ?? []) {
      if (!UNDETECTED.has(mutant.status)) continue;
      survivors.push({
        group: names[0],
        key: mutantKey(file, mutant),
        anchorKey: anchorKey(file, mutant, entry.source ?? ""),
        file,
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement ?? "",
        location: mutant.location,
        status: mutant.status,
        function: enclosingFunction(
          entry.source ?? "",
          mutant.location.start.line,
        ),
      });
    }
  }
  return sortSurvivors(survivors);
}

function sortSurvivors(survivors) {
  return [...survivors].sort(
    (a, b) =>
      compare(a.file, b.file) ||
      a.location.start.line - b.location.start.line ||
      a.location.start.column - b.location.start.column ||
      compare(a.key, b.key),
  );
}

/** Pending clusters keyed by group, file, enclosing function and mutator. */
export function clusterSurvivors(survivors) {
  const byId = new Map();
  for (const s of sortSurvivors(survivors)) {
    const id = `${s.group}:${s.file}:${s.function}:${s.mutatorName}`;
    if (!byId.has(id))
      byId.set(id, {
        id,
        group: s.group,
        file: s.file,
        function: s.function,
        mutatorName: s.mutatorName,
        disposition: "pending",
        count: 0,
        keys: [],
        anchors: [],
        note: "",
      });
    const cluster = byId.get(id);
    cluster.count++;
    cluster.keys.push(s.key);
    cluster.anchors.push(s.anchorKey);
  }
  return [...byId.values()].sort((a, b) => compare(a.id, b.id));
}

/** Source line of a cluster's first mutant, read from its first key. */
function firstLineOf(cluster) {
  const lines = cluster.keys.map((k) => Number(k.split("\u0000")[3]));
  return Math.min(...lines);
}

/** Group clusters of one file by function, functions in source order. */
function functionRuns(fileClusters) {
  const byFunction = new Map();
  for (const c of fileClusters) {
    if (!byFunction.has(c.function)) byFunction.set(c.function, []);
    byFunction.get(c.function).push(c);
  }
  const runs = [...byFunction.entries()].map(([name, list]) => ({
    name,
    line: Math.min(...list.map(firstLineOf)),
    clusters: [...list].sort(
      (a, b) => firstLineOf(a) - firstLineOf(b) || compare(a.id, b.id),
    ),
  }));
  runs.sort((a, b) => a.line - b.line || compare(a.name, b.name));
  return runs;
}

/**
 * Batches of at most `limit` clusters and `maxFiles` src files per group, cut
 * at file boundaries; a file over `limit` clusters is cut at function
 * boundaries in source order (a single function over `limit` is cut hard).
 * Returns [{ id, group, clusters, mutants, files }] with ids `<group>-<k>`.
 */
export function partitionBatches(clusters, limit = 25, maxFiles = 4) {
  const batches = [];
  const groups = [...new Set(clusters.map((c) => c.group))].sort(compare);
  for (const group of groups) {
    const mine = clusters.filter((c) => c.group === group);
    const files = [...new Set(mine.map((c) => c.file))].sort(compare);
    let current = { clusters: [], files: new Set() };
    const close = () => {
      if (current.clusters.length === 0) return;
      batches.push({
        id: `${group}-${batches.filter((b) => b.group === group).length + 1}`,
        group,
        clusters: current.clusters.map((c) => c.id),
        mutants: current.clusters.reduce((n, c) => n + c.count, 0),
        files: [...current.files].sort(compare),
      });
      current = { clusters: [], files: new Set() };
    };
    for (const file of files) {
      const runs = functionRuns(mine.filter((c) => c.file === file));
      const flat = runs.flatMap((r) => r.clusters);
      if (flat.length <= limit) {
        if (
          current.clusters.length + flat.length > limit ||
          (!current.files.has(file) && current.files.size + 1 > maxFiles)
        )
          close();
        current.clusters.push(...flat);
        current.files.add(file);
        continue;
      }
      close();
      for (const run of runs) {
        let rest = run.clusters;
        while (rest.length > 0) {
          const room = limit - current.clusters.length;
          if (rest.length <= room) {
            current.clusters.push(...rest);
            rest = [];
          } else if (current.clusters.length > 0 && rest.length <= limit) {
            close(); // keep the function whole in the next batch
          } else {
            current.clusters.push(...rest.slice(0, room));
            rest = rest.slice(room);
          }
          current.files.add(file);
          if (current.clusters.length >= limit) close();
        }
      }
    }
    close();
  }
  return batches;
}

function renderPartition(ledger, batches) {
  const out = [];
  const groups = [...new Set(ledger.clusters.map((c) => c.group))].sort(
    compare,
  );
  out.push("# Phase 67 triage partition", "");
  out.push(
    `Generated by tools/mutation/cluster.mjs partition from tools/mutation/ledger.json (pre-triage run ${ledger.preTriage.runId}, SHA ${ledger.preTriage.sha}, ${ledger.preTriage.survivorCount} trust survivors).`,
    "",
  );
  out.push(
    "Rule (D-22): at most 25 clusters and 4 src files per batch, cut at file boundaries and, inside a file over 25 clusters, at function boundaries in source order.",
    "",
  );
  out.push("| group | clusters | mutants | batches |", "|---|---|---|---|");
  for (const g of groups) {
    const cs = ledger.clusters.filter((c) => c.group === g);
    out.push(
      `| ${g} | ${cs.length} | ${cs.reduce((n, c) => n + c.count, 0)} | ${batches.filter((b) => b.group === g).length} |`,
    );
  }
  out.push("");
  out.push(`Triage batches: ${batches.length}`, "");
  out.push(
    `Replan required: run /gsd-plan-phase 67 --gaps against this file (${batches.length} batches, one plan each).`,
    "",
  );
  for (const b of batches) {
    out.push(`### ${b.id}`, "");
    out.push(
      `- clusters: ${b.clusters.length}`,
      `- mutants: ${b.mutants}`,
      `- src files: ${b.files.join(", ")}`,
      "- cluster ids:",
    );
    for (const id of b.clusters) out.push(`  - ${id}`);
    out.push("");
  }
  return out.join("\n");
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const survivorsPath = join(here, "pre-triage-survivors.json");
const ledgerPath = join(here, "ledger.json");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === "extract") {
      const [reportPath, runId, sha] = rest;
      if (!reportPath || !runId || !sha)
        throw new Error("usage: extract <mutation.json> <runId> <sha>");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const groups = JSON.parse(
        readFileSync(join(root, "mutation-floors.json"), "utf8"),
      ).groups;
      const survivors = extractSurvivors(report, groups);
      writeFileSync(
        survivorsPath,
        json({ runId, sha, survivorCount: survivors.length, survivors }),
      );
      process.stdout.write(`survivors: ${survivors.length}\n`);
    } else if (command === "cluster") {
      const pre = JSON.parse(readFileSync(survivorsPath, "utf8"));
      const clusters = clusterSurvivors(pre.survivors);
      writeFileSync(
        ledgerPath,
        json({
          schemaVersion: 1,
          preTriage: {
            runId: pre.runId,
            sha: pre.sha,
            survivorCount: pre.survivorCount,
          },
          clusters,
        }),
      );
      process.stdout.write(`clusters: ${clusters.length}\n`);
    } else if (command === "partition") {
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      process.stdout.write(
        `${renderPartition(ledger, partitionBatches(ledger.clusters))}\n`,
      );
    } else throw new Error(`unknown command ${JSON.stringify(command)}`);
    return 0;
  } catch (error) {
    process.stderr.write(`cluster: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
