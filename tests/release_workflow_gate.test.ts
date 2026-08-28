import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function validateWindowsDiagnosticWorkflow(workflow: string): void {
  const matchingPath =
    "windows-publication-matching-host-${{ matrix.tuple }}.json";
  const installedPath =
    "windows-publication-installed-node22-${{ matrix.tuple }}.json";
  const matchingUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  const installedUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  if (!matchingUpload || !installedUpload)
    throw new Error("both Windows diagnostic uploads must run always");
  for (const required of [
    "WINDOWS_PUBLICATION_DIAGNOSTIC_PATH",
    "--windows-publication-diagnostic-output",
    matchingPath,
    installedPath,
    "win32-x64",
    "win32-arm64",
    "fail-fast: false",
  ])
    if (!workflow.includes(required))
      throw new Error(`Windows diagnostic workflow lacks ${required}`);
  if (/continue-on-error:\s*true/u.test(workflow))
    throw new Error("Windows diagnostic workflow softens a hard failure");
  for (const name of [
    "windows-publication-matching-host-*",
    "windows-publication-installed-node22-*",
  ])
    if (workflow.includes(`pattern: ${name}`) || workflow.includes(`needs: ${name}`))
      throw new Error("diagnostic artifact entered an authority graph");
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
  it("keeps complete Windows diagnostics outside every authority path", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateWindowsDiagnosticWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace("if: always() && matrix.os == 'win32'", "if: matrix.os == 'win32'"),
      workflow.replaceAll(
        "if: always() && matrix.os == 'win32'",
        "if: matrix.os == 'win32'",
      ),
      workflow.replace("WINDOWS_PUBLICATION_DIAGNOSTIC_PATH", "WINDOWS_PUBLICATION_LATE_PATH"),
      workflow.replace("--windows-publication-diagnostic-output", "--ignored-output"),
      workflow.replace("win32-x64", "win32-x86"),
      workflow.replace("win32-arm64", "win32-arm"),
      workflow.replace(matchingPath, "renamed-matching.json"),
      workflow.replace(installedPath, "renamed-installed.json"),
      `${workflow}\n# pattern: windows-publication-matching-host-*`,
      `${workflow}\n# needs: windows-publication-installed-node22-*`,
      `${workflow}\ncontinue-on-error: true`,
    ];
    for (const mutation of mutations)
      expect(() => validateWindowsDiagnosticWorkflow(mutation)).toThrow();

    const nativeTest = readFileSync(
      join(packageRoot, "tests", "native_publication.test.ts"),
      "utf8",
    );
    expect(nativeTest.indexOf("takeLastWindowsPublicationEvidence()"))
      .toBeLessThan(nativeTest.indexOf("status: \"accepted\""));
    expect(nativeTest).toContain(
      "expect(binding.takeLastWindowsPublicationEvidence()).toBeUndefined()",
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
