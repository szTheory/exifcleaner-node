// Lint for manual Stryker disable comments in src/ (MUT-03, D-16, D-19). Node builtins only.
//
// Stryker silently fills in "Ignored using a comment" when a disable has no
// reason, so the only accepted form is
//   // Stryker disable next-line <Mutator[,Mutator]>: <class> — <specifics>
// with every mutator in the closed list, a class from classes.json and
// non-empty specifics. Anything else mentioning `Stryker disable|restore` is a
// problem.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupsFor } from "./groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadClasses() {
  return JSON.parse(readFileSync(join(HERE, "classes.json"), "utf8"));
}

// The one valid form, anchored at the start of the line.
export const DISABLE_FORM =
  /^\s*\/\/ Stryker disable next-line ([A-Za-z]+(?:, ?[A-Za-z]+)*): ([a-z][a-z-]*) — (\S.*)$/;

const DIRECTIVE =
  /^\s*\/\/ Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.*))?$/;

/** `{ valid, className }` for a Stryker statusReason or directive reason. */
export function parseDisableReason(reason, classes = loadClasses()) {
  const m = /^([a-z][a-z-]*) — (\S.*)$/.exec(String(reason ?? "").trim());
  if (!m || !Object.hasOwn(classes.equivalenceClasses, m[1]))
    return { valid: false, className: undefined };
  return { valid: true, className: m[1] };
}

function problemFor(line, classes) {
  if (DISABLE_FORM.test(line)) {
    const m = DISABLE_FORM.exec(line);
    const names = m[1].split(",").map((n) => n.trim());
    for (const n of names) {
      if (n === "all") return "mutator list must not contain all";
      if (!classes.mutators.includes(n)) return `unknown mutator ${n}`;
    }
    if (!Object.hasOwn(classes.equivalenceClasses, m[2]))
      return `unknown class ${m[2]}`;
    return null;
  }
  const d = DIRECTIVE.exec(line);
  if (!d) return "unrecognized Stryker comment (use the next-line form)";
  if (d[1] === "restore") return "Stryker restore is not allowed";
  if (d[2] !== "next-line")
    return "only next-line disables are allowed (no file or block scope)";
  const names = d[3].split(",").map((n) => n.trim());
  if (names.includes("all")) return "mutator list must not contain all";
  const unknown = names.find((n) => !classes.mutators.includes(n));
  if (unknown !== undefined) return `unknown mutator ${unknown}`;
  if (d[4] === undefined || d[4].trim() === "")
    return "missing reason: expected `: <class> — <specifics>`";
  const reason = d[4].trim();
  if (!reason.includes(" — "))
    return "reason must be `<class> — <specifics>` (em dash with spaces)";
  const [cls, ...rest] = reason.split(" — ");
  if (!Object.hasOwn(classes.equivalenceClasses, cls.trim()))
    return `unknown class ${cls.trim()}`;
  if (rest.join(" — ").trim() === "") return "specifics must not be empty";
  return "malformed Stryker disable comment";
}

/** Sorted `{ file, line, problem }` for every bad Stryker comment line. */
export function lintDisableComments(
  sourceText,
  fileName = "<source>",
  classes = loadClasses(),
) {
  return analyze(sourceText, fileName, classes).problems;
}

function analyze(sourceText, fileName, classes) {
  const problems = [];
  let valid = 0;
  sourceText.split("\n").forEach((text, i) => {
    if (!/Stryker (disable|restore)/.test(text)) return;
    const problem = problemFor(text, classes);
    if (problem === null) valid += 1;
    else problems.push({ file: fileName, line: i + 1, problem });
  });
  return { problems, valid };
}

function trackedSrcFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--", "src"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((p) => p.endsWith(".ts"))
    .sort();
}

/** Scan git-tracked src/**\/*.ts: `{ problems: ["path:line: problem"], scanned, perFile }`. */
export function scanSrcDisables(root, classes = loadClasses()) {
  const files = trackedSrcFiles(root);
  const problems = [];
  const valid = {};
  for (const file of files) {
    const result = analyze(
      readFileSync(join(root, file), "utf8"),
      file,
      classes,
    );
    for (const p of result.problems)
      problems.push(`${file}:${p.line}: ${p.problem}`);
    valid[file] = result.valid;
  }
  return { problems, scanned: files.length, valid };
}

export function main() {
  const root = join(HERE, "..", "..");
  const floors = JSON.parse(
    readFileSync(join(root, "mutation-floors.json"), "utf8"),
  ).groups;
  const { problems, scanned, valid } = scanSrcDisables(root);
  const perGroup = Object.fromEntries(Object.keys(floors).map((g) => [g, 0]));
  for (const [file, n] of Object.entries(valid))
    for (const g of groupsFor(file, floors)) perGroup[g] += n;
  for (const [g, n] of Object.entries(perGroup))
    process.stdout.write(`${g}  disables: ${n}\n`);
  process.stdout.write(`scanned ${scanned} src files\n`);
  for (const p of problems) process.stderr.write(`${p}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();
