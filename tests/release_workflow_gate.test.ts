import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
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

function greenGraph() {
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
  it("accepts the production graph only with all immutable installed authorities", () => {
    expect(() => gate.validateReleaseGraph(greenGraph())).not.toThrow();
  });

  it.each(authorities)("rejects missing %s authority", (authority) => {
    const graph = greenGraph();
    graph.jobs.publish.needs = graph.jobs.publish.needs?.filter(
      (name) => name !== authority,
    );
    expect(() => gate.validateReleaseGraph(graph)).toThrow(/authority|needs/i);
  });

  it("rejects bypass, mutable identity, digest substitution, rebuild, cycles, and unknown needs", () => {
    for (const mutate of [
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish.needs = [];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["immutable-sha-evidence"].script = "latest run";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"].script =
          "admission.json implementationSha otherDigest";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"].script += " npm run build";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["native-admission"].needs = ["publish"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish.needs = ["not-a-job"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish.script = "npm publish package-local.tgz";
      },
    ]) {
      const graph = greenGraph();
      mutate(graph);
      expect(() => gate.validateReleaseGraph(graph)).toThrow();
    }
  });
});
