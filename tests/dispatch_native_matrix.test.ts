import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const dispatcher = require("../scripts/dispatch_native_matrix.cjs") as {
  REQUIRED_TUPLES: string[];
  selectExactRun(input: {
    runs: Array<Record<string, unknown>>;
    workflow: string;
    ref: string;
    sha: string;
    startedAt: string;
  }): Record<string, unknown>;
  validateEvidence(input: Record<string, unknown>): void;
};

describe("immutable native matrix dispatcher", () => {
  it("selects only one workflow_dispatch run with the submitted immutable ref and SHA", () => {
    const run = dispatcher.selectExactRun({
      workflow: "ci.yml",
      ref: "proof/abc-nonce",
      sha: "a".repeat(40),
      startedAt: "2026-08-26T16:00:00Z",
      runs: [
        {
          id: 1,
          path: ".github/workflows/ci.yml",
          event: "workflow_dispatch",
          head_branch: "proof/abc-nonce",
          head_sha: "a".repeat(40),
          created_at: "2026-08-26T16:00:01Z",
        },
        {
          id: 2,
          path: ".github/workflows/ci.yml",
          event: "push",
          head_branch: "proof/abc-nonce",
          head_sha: "a".repeat(40),
          created_at: "2026-08-26T16:00:02Z",
        },
      ],
    });
    expect(run.id).toBe(1);
  });

  it("rejects ambiguous, stale, or identity-mismatched runs", () => {
    const base = {
      id: 1,
      path: ".github/workflows/ci.yml",
      event: "workflow_dispatch",
      head_branch: "proof/ref",
      head_sha: "a".repeat(40),
      created_at: "2026-08-26T16:00:01Z",
    };
    for (const runs of [
      [base, { ...base, id: 2 }],
      [{ ...base, created_at: "2026-08-26T15:59:59Z" }],
      [{ ...base, head_sha: "b".repeat(40) }],
    ])
      expect(() =>
        dispatcher.selectExactRun({
          runs,
          workflow: "ci.yml",
          ref: "proof/ref",
          sha: "a".repeat(40),
          startedAt: "2026-08-26T16:00:00Z",
        }),
      ).toThrow(/exactly one|identity|created/i);
  });

  it("requires six SHA-bound tuples, one tarball, and two Node conclusions per tuple", () => {
    const tupleEvidence = Object.fromEntries(
      dispatcher.REQUIRED_TUPLES.map((tuple) => [
        tuple,
        {
          binarySha256: "a".repeat(64),
          reportSha256: "b".repeat(64),
          implementationSha: "c".repeat(40),
          runner: tuple,
          installed: [
            { node: 22, tarballSha256: "d".repeat(64), conclusion: "pass" },
            { node: 24, tarballSha256: "d".repeat(64), conclusion: "pass" },
          ],
        },
      ]),
    );
    expect(() =>
      dispatcher.validateEvidence({
        implementationSha: "c".repeat(40),
        tarballSha256: "d".repeat(64),
        tuples: tupleEvidence,
      }),
    ).not.toThrow();
    delete tupleEvidence["linux-x64"];
    expect(() =>
      dispatcher.validateEvidence({
        implementationSha: "c".repeat(40),
        tarballSha256: "d".repeat(64),
        tuples: tupleEvidence,
      }),
    ).toThrow(/six|missing/i);
  });
});
