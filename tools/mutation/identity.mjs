// Stable mutant identity (MUT-03, D-13). Node builtins only.
//
// Stryker ids are counters that depend on the mutate set, so nothing here uses
// them. A mutant is identified by where it is and what it does.
import { createHash } from "node:crypto";

export function mutantKey(file, mutant) {
  const { start, end } = mutant.location;
  return [
    file,
    mutant.mutatorName,
    mutant.replacement ?? "",
    start.line,
    start.column,
    end.line,
    end.column,
  ].join("\u0000");
}

/** Map key -> { file, mutant }. Throws on a duplicate key or zero mutants. */
export function keyedMutants(report) {
  const files = report?.files;
  if (files === null || typeof files !== "object")
    throw new Error("report has no files map");
  const keyed = new Map();
  for (const file of Object.keys(files).sort()) {
    for (const mutant of files[file].mutants ?? []) {
      const key = mutantKey(file, mutant);
      if (keyed.has(key))
        throw new Error(`duplicate mutant key ${JSON.stringify(key)}`);
      keyed.set(key, { file, mutant });
    }
  }
  if (keyed.size === 0) throw new Error("report holds zero mutants");
  return keyed;
}

export function collapseStatus(status) {
  switch (status) {
    case "Killed":
    case "Timeout":
      return "detected";
    case "Survived":
    case "NoCoverage":
      return "undetected";
    case "Ignored":
      return "ignored";
    case "CompileError":
    case "RuntimeError":
      return "invalid";
    default:
      throw new Error(`unknown mutant status ${JSON.stringify(status)}`);
  }
}

/** sha256 of the sorted `key<TAB>collapsed` lines; order-independent. */
export function collapsedDigest(report) {
  const lines = [];
  for (const [key, { mutant }] of keyedMutants(report))
    lines.push(`${key}\t${collapseStatus(mutant.status)}`);
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
