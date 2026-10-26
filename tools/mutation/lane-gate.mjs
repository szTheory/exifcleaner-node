// Advisory PR mutation lane verdict (MUT-04, D-26). Node builtins only.
//
// evaluateGate is pure: it takes parsed inputs and returns the typed result
// that lane.mjs writes as gate-result.json. It fails closed: anything it
// cannot prove (missing or unparseable report, interrupted run, requested
// file absent, unknown status) is `error`. There is no per-file baseline: the
// trust-tier rule is absolute zero undetected (D-26).
import { groupsFor } from "./groups.mjs";
import { collapsedDigest, mutantKey } from "./identity.mjs";
import { parseDisableReason } from "./disable-lint.mjs";

export const STATUSES = [
  "Killed",
  "Timeout",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Ignored",
];
const PLUGIN_PREFIX = "error-message:";

function base(plan, ctx) {
  return {
    headSha: ctx.headSha ?? "unknown",
    mergeSha: ctx.mergeSha ?? "unknown",
    baseSha: ctx.baseSha ?? "unknown",
    strykerVersion: ctx.strykerVersion ?? "unknown",
    mutatedFiles: [...(plan?.files ?? [])],
    perFile: {},
    undetectedKeys: [],
    verdict: "error",
    reason: "",
    smoke: "skipped",
    durationSeconds: 0,
    collapsedDigest: null,
  };
}

function finish(result, verdict, reason) {
  result.verdict = verdict;
  result.reason = reason;
  return result;
}

/** An Ignored mutant is acceptable when static, plugin-reasoned or lint-valid. */
function ignoredAccepted(mutant, classes) {
  if (mutant.static === true) return true;
  const reason = String(mutant.statusReason ?? "");
  if (reason.startsWith(PLUGIN_PREFIX)) return true;
  return parseDisableReason(reason, classes).valid;
}

/**
 * @param {object} input
 * @param {{verdict:string, reason?:string, files?:string[], smoke?:boolean, run?:boolean}} input.plan
 * @param {{exitCode:number|null, signal:string|null, durationSeconds:number}|null} input.run
 * @param {{result:string, durationSeconds?:number}|null} input.smoke
 * @param {object|null} input.report parsed mutation.json
 * @param {string} [input.reportError] why the report is missing or unparseable
 * @param {{groups:object}} input.floors parsed mutation-floors.json
 * @param {object} input.classes parsed classes.json
 */
export function evaluateGate(input) {
  const { plan, run, smoke, report, floors, classes } = input;
  const result = base(plan, input);
  try {
    if (plan === null || typeof plan !== "object")
      return finish(result, "error", "lane-plan.json missing or unreadable");
    if (plan.verdict === "noop")
      return finish(result, "noop", plan.reason || "plan is noop");
    if (plan.verdict !== "proceed")
      return finish(
        result,
        "error",
        plan.reason || `plan verdict ${JSON.stringify(plan.verdict)}`,
      );

    let duration = 0;
    if (plan.smoke === true) {
      result.smoke = smoke?.result === "pass" ? "pass" : "fail";
      duration += smoke?.durationSeconds ?? 0;
      if (result.smoke !== "pass") {
        result.durationSeconds = duration;
        return finish(result, "error", "dry-run smoke did not pass");
      }
    }
    if (plan.run !== true) {
      result.durationSeconds = duration;
      return finish(result, "pass", "smoke passed; no source files to mutate");
    }

    if (run === null || run === undefined) {
      return finish(
        result,
        "error",
        "lane-run.json missing: Stryker did not run",
      );
    }
    duration += run.durationSeconds ?? 0;
    result.durationSeconds = duration;
    if (run.signal) {
      return finish(
        result,
        "error",
        `Stryker was interrupted by signal ${run.signal}`,
      );
    }
    if (run.exitCode !== 0) {
      return finish(
        result,
        "error",
        `Stryker exited with code ${run.exitCode}`,
      );
    }
    if (report === null || report === undefined) {
      return finish(
        result,
        "error",
        `mutation.json ${input.reportError ?? "missing or unparseable"}`,
      );
    }
    const files = report.files;
    if (files === null || typeof files !== "object") {
      return finish(result, "error", "mutation.json has no files map");
    }
    if (!Array.isArray(plan.files) || plan.files.length === 0) {
      return finish(result, "error", "plan requests no files but run is set");
    }
    const absent = plan.files.filter((f) => !Object.hasOwn(files, f));
    if (absent.length > 0) {
      return finish(
        result,
        "error",
        `requested file(s) absent from the report: ${absent.join(", ")}`,
      );
    }
    result.collapsedDigest = collapsedDigest(report);

    const groups = floors?.groups ?? {};
    let trustFiles = 0;
    const failures = [];
    const infos = [];
    for (const file of [...plan.files].sort()) {
      const names = groupsFor(file, groups);
      if (names.length !== 1) {
        return finish(
          result,
          "error",
          `${file}: matches ${names.length} groups`,
        );
      }
      const tier = groups[names[0]].tier;
      if (tier === "trust") trustFiles++;
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const mutant of files[file].mutants ?? []) {
        if (!STATUSES.includes(mutant.status)) {
          return finish(
            result,
            "error",
            `${file}: unknown mutant status ${JSON.stringify(mutant.status)}`,
          );
        }
        counts[mutant.status]++;
        let bad = null;
        if (mutant.status === "Survived" || mutant.status === "NoCoverage")
          bad = mutant.status;
        else if (
          mutant.status === "Ignored" &&
          !ignoredAccepted(mutant, classes)
        )
          bad = "Ignored without a valid reason";
        if (bad !== null) {
          const key = mutantKey(file, mutant);
          result.undetectedKeys.push(key);
          const loc = mutant.location.start;
          (tier === "trust" ? failures : infos).push(
            `${file}:${loc.line}:${loc.column} ${mutant.mutatorName} ${bad}`,
          );
        }
      }
      result.perFile[file] = { group: names[0], tier, counts };
    }
    result.undetectedKeys.sort();

    if (failures.length > 0) {
      return finish(
        result,
        "fail",
        `${failures.length} undetected in trust files: ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? "; ..." : ""}`,
      );
    }
    if (trustFiles === 0) {
      return finish(
        result,
        "info",
        infos.length > 0
          ? `orchestration files only; ${infos.length} undetected (advisory)`
          : "orchestration files only; nothing undetected",
      );
    }
    return finish(
      result,
      "pass",
      infos.length > 0
        ? `trust files clean; ${infos.length} advisory undetected in orchestration files`
        : "trust files have zero undetected mutants",
    );
  } catch (error) {
    result.collapsedDigest = null;
    return finish(result, "error", `gate evaluation failed: ${error.message}`);
  }
}

/** Markdown table for GITHUB_STEP_SUMMARY, headed by the verdict. */
export function renderSummary(result) {
  const lines = [
    `### Mutation lane (advisory): ${result.verdict}`,
    "",
    result.reason,
    "",
    "| File | Group | Tier | Killed | Timeout | Survived | NoCoverage | Ignored | CompileError |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [file, e] of Object.entries(result.perFile).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const c = e.counts;
    lines.push(
      `| ${file} | ${e.group} | ${e.tier} | ${c.Killed} | ${c.Timeout} | ${c.Survived} | ${c.NoCoverage} | ${c.Ignored} | ${c.CompileError} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
