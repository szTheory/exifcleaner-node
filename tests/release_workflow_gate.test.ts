import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const gate = require("../scripts/release_workflow_gate.cjs") as {
  REQUIRED_AUTHORITIES: string[];
  validateReleaseGraph(graph: {
    jobs: Record<string, { needs?: string[]; script?: string }>;
  }): void;
};

const authorities = [
  "immutable-sha-evidence",
  "installed-linux-x64",
  "installed-linux-arm64",
  "installed-darwin-x64",
  "installed-darwin-arm64",
  "installed-win32-x64",
  "installed-win32-arm64",
];

type WorkflowJob = { needs?: string[]; script?: string };
type WorkflowGraph = { jobs: Record<string, WorkflowJob> };
const matchingPath =
  "windows-publication-matching-host-${{ matrix.tuple }}.json";
const installedPath =
  "windows-publication-installed-node22-${{ matrix.tuple }}.json";
const cancellationPath =
  "windows-cancellation-installed-node22-${{ matrix.tuple }}.json";

function validateWindowsDiagnosticWorkflow(workflow: string): void {
  const matchingUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  const installedUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  const cancellationUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-cancellation-installed-node22-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-cancellation-installed-node22-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  if (!matchingUpload || !installedUpload || !cancellationUpload)
    throw new Error("all Windows diagnostic uploads must run always");
  for (const required of [
    "WINDOWS_PUBLICATION_DIAGNOSTIC_PATH",
    "--windows-publication-diagnostic-output",
    matchingPath,
    installedPath,
    "--windows-cancellation-diagnostic-output",
    cancellationPath,
    "win32-x64",
    "win32-arm64",
    "fail-fast: false",
  ])
    if (!workflow.includes(required))
      throw new Error(`Windows diagnostic workflow lacks ${required}`);
  if (/continue-on-error:\s*true|\|\|\s*true/u.test(workflow))
    throw new Error("Windows diagnostic workflow softens a hard failure");
  for (const name of [
    "windows-publication-matching-host-*",
    "windows-publication-installed-node22-*",
    "windows-cancellation-installed-node22-*",
  ])
    if (
      workflow.includes(`pattern: ${name}`) ||
      workflow.includes(`needs: ${name}`)
    )
      throw new Error("diagnostic artifact entered an authority graph");
}

function workflowJob(
  workflow: string,
  jobName: string,
  nextJobName?: string,
): string {
  const start = workflow.indexOf(`\n  ${jobName}:`);
  const end =
    nextJobName === undefined
      ? workflow.length
      : workflow.indexOf(`\n  ${nextJobName}:`, start + 1);
  if (start < 0 || end < 0)
    throw new Error(`workflow job ${jobName} is absent`);
  return workflow.slice(start, end);
}

function immutableEvidenceHeredoc(workflow: string): string {
  const job = workflowJob(workflow, "immutable-sha-evidence", "benchmark-linux");
  const heredoc = job.match(/node - <<'NODE'\n([\s\S]*?)\n\s+NODE/u)?.[1];
  if (heredoc === undefined)
    throw new Error("immutable evidence Node heredoc is absent");
  return heredoc
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

function executeProductionTupleStage(
  workflow: string,
  manifest: readonly Record<string, unknown>[],
): { tuples: string[]; mappedTuples: string[] } {
  const heredoc = immutableEvidenceHeredoc(workflow);
  const tupleStage = heredoc.split(" const candidate=")[0];
  if (tupleStage === heredoc)
    throw new Error("immutable evidence tuple stage boundary is absent");
  return runInNewContext(
    `${tupleStage}; ({tuples:[...tuples],mappedTuples:[...byTuple.keys()]})`,
    {
      require(specifier: string) {
        if (specifier === "node:fs")
          return {
            readFileSync(path: string) {
              if (path === "admitted/tarball.sha256") return `${"a".repeat(64)}  candidate.tgz\n`;
              if (path === "admitted/native-manifest.json")
                return JSON.stringify(manifest);
              if (path === "tests/corpus/manifest.json") return "{}";
              throw new Error(`unexpected tuple-stage read: ${path}`);
            },
          };
        if (specifier === "node:path" || specifier === "node:crypto")
          return require(specifier);
        if (specifier === "./scripts/qualification/benchmark-report.cjs")
          return { validateIdentityCleanupLedger() {} };
        throw new Error(`unexpected tuple-stage require: ${specifier}`);
      },
    },
  ) as { tuples: string[]; mappedTuples: string[] };
}

function validateBenchmarkWorkflow(workflow: string): void {
  const benchmarkJob = workflowJob(
    workflow,
    "benchmark-linux",
    "phase-46-admission",
  );
  const admissionJob = workflowJob(workflow, "phase-46-admission");
  const freshContract =
    "report.version!==4||report.warmups!==2||report.measurements!==100||report.elapsedP95Estimator?.retainedObservations!==100||report.collection?.retries!==0||report.collection?.discarded!==0";
  for (const required of [
    "node: [22, 24]",
    "npm run benchmark:qualify -- --baseline-tarball",
    "node scripts/qualification/benchmark-report.cjs --validate-report",
    freshContract,
  ])
    if (!benchmarkJob.includes(required))
      throw new Error(`benchmark producer job lacks ${required}`);
  for (const forbidden of [
    /BENCHMARK_(?:MEASUREMENTS|SAMPLES|RETRIES)/u,
    /--(?:measurements|samples|retries)\b/u,
    /timeout-minutes:/u,
    /continue-on-error:\s*true/u,
    /for\s+attempt\b|while\s+.*attempt|retry\s+vote|outlier/u,
  ])
    if (forbidden.test(benchmarkJob))
      throw new Error("benchmark producer contains a sample shortcut");
  for (const required of [
    "- benchmark-linux",
    "benchmark-linux-node22/benchmark-node22.json",
    "benchmark-linux-node24/benchmark-node24.json",
    "const benchmarkReports=files.map",
    freshContract,
    "--phase-admission',...files.map",
    "majors.join(',')!=='22,24'",
    "reportVersion:report.version",
    "retainedObservationCount:report.elapsedP95Estimator.retainedObservations",
  ])
    if (!admissionJob.includes(required))
      throw new Error(`benchmark aggregate lacks ${required}`);
}

function greenGraph(): WorkflowGraph {
  return {
    jobs: {
      "native-admission": {
        script: "uses ci.yml immutable SHA admitted tarball",
      },
      ...Object.fromEntries(
        authorities.map((authority) => [
          authority,
          {
            needs: ["native-admission"],
            script:
              authority === "immutable-sha-evidence"
                ? "admission.json implementationSha tarballSha256"
                : `admission.json ${authority.replace("installed-", "")} implementationSha tarballSha256`,
          },
        ]),
      ),
      publish: {
        needs: authorities,
        script: "npm publish admitted/exifcleaner-node.tgz --access public",
      },
    },
  };
}

describe("release workflow authority gate", () => {
  it("accepts a permuted exact-six manifest through the production immutable tuple stage", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const canonical = [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
    ];
    const manifest = [...canonical]
      .reverse()
      .map((tuple) => ({ tuple, sha256: "a".repeat(64), auditReportSha256: "b".repeat(64) }));

    expect(executeProductionTupleStage(workflow, manifest)).toEqual({
      tuples: canonical,
      mappedTuples: [...canonical].reverse(),
    });
  });

  it("keeps complete Windows diagnostics outside every authority path", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateWindowsDiagnosticWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace(
        "if: always() && matrix.os == 'win32'",
        "if: matrix.os == 'win32'",
      ),
      workflow.replaceAll(
        "if: always() && matrix.os == 'win32'",
        "if: matrix.os == 'win32'",
      ),
      workflow.replace(
        "WINDOWS_PUBLICATION_DIAGNOSTIC_PATH",
        "WINDOWS_PUBLICATION_LATE_PATH",
      ),
      workflow.replace(
        "--windows-publication-diagnostic-output",
        "--ignored-output",
      ),
      workflow.replaceAll("win32-x64", "win32-x86"),
      workflow.replaceAll("win32-arm64", "win32-arm"),
      workflow.replaceAll(matchingPath, "renamed-matching.json"),
      workflow.replaceAll(installedPath, "renamed-installed.json"),
      workflow.replaceAll(cancellationPath, "renamed-cancellation.json"),
      workflow.replace(
        "--windows-cancellation-diagnostic-output",
        "--ignored-cancellation-output",
      ),
      `${workflow}\n# pattern: windows-publication-matching-host-*`,
      `${workflow}\n# needs: windows-publication-installed-node22-*`,
      `${workflow}\n# pattern: windows-cancellation-installed-node22-*`,
      `${workflow}\n# needs: windows-cancellation-installed-node22-*`,
      `${workflow}\ncontinue-on-error: true`,
      `${workflow}\n# || true`,
    ];
    for (const mutation of mutations)
      expect(() => validateWindowsDiagnosticWorkflow(mutation)).toThrow();

    const nativeTest = readFileSync(
      join(packageRoot, "tests", "native_publication.test.ts"),
      "utf8",
    );
    expect(nativeTest).toMatch(
      /const observation = smokeHelper\.classifyWindowsPublicationEvidence\([\s\S]{0,160}binding\.takeLastWindowsPublicationEvidence\(\)[\s\S]{0,900}await writeFile\([\s\S]{0,900}expect\(observation\)\.toMatchObject/u,
    );
    expect(nativeTest).toContain(
      "expect(binding.takeLastWindowsPublicationEvidence()).toBeUndefined()",
    );
    const packageSmoke = readFileSync(
      join(packageRoot, "scripts", "package_smoke.cjs"),
      "utf8",
    );
    expect(packageSmoke).toMatch(
      /if \(windowsCancellationDiagnosticOutput !== undefined\)[\s\S]{0,1200}writeFileSync\([\s\S]{0,1200}if \(observation\.reason !== "accepted"\)[\s\S]{0,200}throw new Error\("Installed deterministic cancellation contract failed"\)/u,
    );
  });
  it("makes the raw identity-cleanup ledger a non-optional CI authority", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    for (const required of [
      "validateIdentityCleanupLedger",
      "identity-cleanup-ledger.json",
      "--ignore-scripts",
      "fail-fast: false",
      "implementation.sha",
      "auditReportSha256",
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
    ])
      expect(workflow).toContain(required);
    for (const forbidden of ["npm install --foreground-scripts", "retry vote"])
      expect(workflow).not.toContain(forbidden);
  });
  it("makes exact version-4 100-sample reports a hard hosted authority", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateBenchmarkWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace("report.version!==4", "report.version!==3"),
      workflow.replace("report.measurements!==100", "report.measurements!==15"),
      workflow.replace(
        "report.elapsedP95Estimator?.retainedObservations!==100",
        "report.elapsedP95Estimator?.retainedObservations!==99",
      ),
      workflow.replace(
        "report.collection?.retries!==0",
        "report.collection?.retries!==1",
      ),
      workflow.replace(
        "report.collection?.discarded!==0",
        "report.collection?.discarded!==1",
      ),
      workflow.replace("node: [22, 24]", "node: [24]"),
      workflow.replace(
        "node scripts/qualification/benchmark-report.cjs --validate-report",
        "cp replacement.json benchmark-node${{ matrix.node }}.json #",
      ),
      workflow.replace(
        "const benchmarkReports=files.map",
        "const replacementReports=files.map",
      ),
      workflow.replace("      - benchmark-linux\n", ""),
      workflow.replace(
        "  benchmark-linux:\n    name:",
        "  benchmark-linux:\n    timeout-minutes: 1\n    name:",
      ),
      workflow.replace(
        "npm run benchmark:qualify --",
        "BENCHMARK_MEASUREMENTS=99 npm run benchmark:qualify --",
      ),
      workflow.replace(
        "npm run benchmark:qualify --",
        "for attempt in 1 2; do npm run benchmark:qualify --",
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(workflow);
      expect(() => validateBenchmarkWorkflow(mutation)).toThrow();
    }
  });
  it("accepts the production graph only with all immutable installed authorities", () => {
    expect(() => gate.validateReleaseGraph(greenGraph())).not.toThrow();
  });

  it.each(authorities)("rejects missing %s authority", (authority) => {
    const graph = greenGraph();
    const publish = graph.jobs.publish!;
    publish.needs = (publish.needs ?? []).filter((name) => name !== authority);
    expect(() => gate.validateReleaseGraph(graph)).toThrow(/authority|needs/i);
  });

  it("rejects bypass, mutable identity, digest substitution, rebuild, cycles, and unknown needs", () => {
    for (const mutate of [
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.needs = [];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["immutable-sha-evidence"]!.script = "latest run";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"]!.script =
          "admission.json implementationSha otherDigest";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"]!.script += " npm run build";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["native-admission"]!.needs = ["publish"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.needs = ["not-a-job"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.script = "npm publish package-local.tgz";
      },
    ]) {
      const graph = greenGraph();
      mutate(graph);
      expect(() => gate.validateReleaseGraph(graph)).toThrow();
    }
  });
});
