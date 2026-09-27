import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(packageRoot, "scripts", "classify_ci_scope.cjs");

type ClassifyRule = { id: string; pattern: RegExp };
type ClassifyResult = { scope: "linux" | "full"; reason: string };
type ClassifyInput = {
  eventName: unknown;
  workflowName: unknown;
  ref: unknown;
  changedPaths: unknown;
};

type QualificationFormatsInput = {
  eventName: unknown;
  ref: unknown;
  changedPaths: unknown;
};

const classify = require("../scripts/classify_ci_scope.cjs") as {
  CI_WORKFLOW_NAME: string;
  ALWAYS_FULL_EVENTS: readonly string[];
  FILTERED_EVENTS: readonly string[];
  LINUX_SAFE_PATH_RULES: readonly ClassifyRule[];
  FULL_SCOPE_OVERRIDES: readonly ClassifyRule[];
  QUALIFIED_FORMATS: readonly string[];
  FORMAT_PATH_RULES: Readonly<Record<string, readonly RegExp[]>>;
  SKIP_GATED_JOBS: readonly string[];
  NOOP_MATRIX_JOBS: readonly string[];
  ALWAYS_RUN_JOBS: readonly string[];
  isLinuxSafePath(path: unknown): boolean;
  classifyCiScope(input: ClassifyInput): ClassifyResult;
  classifyQualificationFormats(
    input: QualificationFormatsInput,
  ): readonly string[];
  changedPathsForEvent(input: {
    eventName: string;
    before?: string;
    forced?: string;
    head?: string;
    cwd: string;
  }): string[] | null;
  validateCiScopeWiring(workflowText: string): void;
};

// ---------------------------------------------------------------------------
// Fixtures (D-19: dual-direction proof)
// ---------------------------------------------------------------------------

const LINUX_FIXTURE_PATHS = [
  "src/webp/riff.ts",
  "dist/webp/riff.js",
  "dist/webp/riff.js.map",
  "tests/riff.test.ts",
];

const HANDLER_LINUX_FIXTURES = [
  "src/admission/webp-handler.ts",
  "dist/admission/webp-handler.js",
  "tests/qualification/webp/parser.test.ts",
];

const PER_FORMAT_QUALIFICATION_LINUX_FIXTURES = [
  "tests/qualification/webp/parser.test.ts",
  "tests/qualification/png/parser.test.ts",
];

const DOCS_ONLY_LINUX_FIXTURES = [
  "docs/ci-budget.md",
  "README.md",
  "AGENTS.md",
  ".planning/research/STACK.md",
];

const FULL_ALONE_FIXTURES = [
  "native/publication.c",
  "binding.gyp",
  "prebuilds/linux-x64/publication.node",
  "scripts/build_native.cjs",
  "scripts/classify_ci_scope.cjs",
  "src/transaction/safe-transaction.ts",
  "src/transaction/native-publication.ts",
  "src/admission/registry.ts",
  "src/engine.ts",
  "src/fallback.ts",
  "src/index.ts",
  "src/types.ts",
  "src/result.ts",
  "src/errors.ts",
  "dist/engine.js",
  "dist/admission/registry.js",
  "package.json",
  "package-lock.json",
  ".github/workflows/ci.yml",
  ".github/dependabot.yml",
  "tests/corpus/manifest.json",
  "tests/classify_ci_scope.test.ts",
  "tests/qualification/kit/corpus.ts",
  "tests/qualification/kit/oracles.ts",
  "tests/qualification/webp/benchmark.test.ts",
  "tests/qualification/parser.test.ts",
];

const MALFORMED_PATHS = [
  "",
  "/src/webp/riff.ts",
  "src\\webp\\riff.ts",
  "../secret",
  "src/webp/../../etc/passwd",
  "src/webp/riff\u0000.ts",
];

function baseInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    eventName: "pull_request",
    workflowName: "CI",
    ref: "refs/pull/9/merge",
    changedPaths: LINUX_FIXTURE_PATHS,
    ...overrides,
  };
}

describe("linux scope", () => {
  it("returns linux for a parser-only diff", () => {
    expect(classify.classifyCiScope(baseInput())).toMatchObject({
      scope: "linux",
    });
  });

  it.each(HANDLER_LINUX_FIXTURES)(
    "returns linux for handler/qualification-test path %s",
    (path) => {
      expect(
        classify.classifyCiScope(baseInput({ changedPaths: [path] })),
      ).toMatchObject({ scope: "linux" });
    },
  );

  it.each(PER_FORMAT_QUALIFICATION_LINUX_FIXTURES)(
    "returns linux for per-format qualification path %s",
    (path) => {
      expect(
        classify.classifyCiScope(baseInput({ changedPaths: [path] })),
      ).toMatchObject({ scope: "linux" });
    },
  );

  it("returns linux for a docs-only diff", () => {
    expect(
      classify.classifyCiScope(
        baseInput({ changedPaths: DOCS_ONLY_LINUX_FIXTURES }),
      ),
    ).toMatchObject({ scope: "linux" });
  });
});

describe("full scope", () => {
  it.each(FULL_ALONE_FIXTURES)("returns full for %s alone", (path) => {
    expect(
      classify.classifyCiScope(baseInput({ changedPaths: [path] })),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for a mixed parser + native diff", () => {
    expect(
      classify.classifyCiScope(
        baseInput({
          changedPaths: ["src/webp/riff.ts", "native/publication.c"],
        }),
      ),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for an unknown new path", () => {
    expect(
      classify.classifyCiScope(
        baseInput({ changedPaths: ["src/brand-new/thing.ts"] }),
      ),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for an empty diff", () => {
    expect(
      classify.classifyCiScope(baseInput({ changedPaths: [] })),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for a null (errored) diff", () => {
    expect(
      classify.classifyCiScope(baseInput({ changedPaths: null })),
    ).toMatchObject({ scope: "full" });
  });

  it.each(MALFORMED_PATHS)("treats malformed path %j as full", (path) => {
    expect(
      classify.classifyCiScope(baseInput({ changedPaths: [path] })),
    ).toMatchObject({ scope: "full" });
    expect(classify.isLinuxSafePath(path)).toBe(false);
  });
});

describe("event overrides", () => {
  it.each(["workflow_dispatch", "workflow_call"])(
    "returns full for event %s even with a parser-only diff",
    (eventName) => {
      expect(classify.classifyCiScope(baseInput({ eventName }))).toMatchObject({
        scope: "full",
      });
    },
  );

  it("returns full when workflowName is not CI (reusable-call caller context)", () => {
    expect(
      classify.classifyCiScope(baseInput({ workflowName: "Release" })),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for a refs/tags/ ref", () => {
    expect(
      classify.classifyCiScope(baseInput({ ref: "refs/tags/v0.3.0" })),
    ).toMatchObject({ scope: "full" });
  });

  it("returns full for an unknown eventName", () => {
    expect(
      classify.classifyCiScope(baseInput({ eventName: "schedule" })),
    ).toMatchObject({ scope: "full" });
  });
});

describe("dead-rule coverage (no rule is unreachable)", () => {
  const allLinuxFixturePaths = [
    ...LINUX_FIXTURE_PATHS,
    ...HANDLER_LINUX_FIXTURES,
    ...PER_FORMAT_QUALIFICATION_LINUX_FIXTURES,
    ...DOCS_ONLY_LINUX_FIXTURES,
  ];

  it("every LINUX_SAFE_PATH_RULES entry is matched by at least one linux fixture", () => {
    for (const rule of classify.LINUX_SAFE_PATH_RULES) {
      const matched = allLinuxFixturePaths.some((path) =>
        rule.pattern.test(path),
      );
      expect(matched, `rule ${rule.id} has no matching fixture`).toBe(true);
    }
  });

  it("every FULL_SCOPE_OVERRIDES entry is matched by at least one full fixture", () => {
    for (const override of classify.FULL_SCOPE_OVERRIDES) {
      const matched = FULL_ALONE_FIXTURES.some((path) =>
        override.pattern.test(path),
      );
      expect(matched, `override ${override.id} has no matching fixture`).toBe(
        true,
      );
    }
  });
});

describe("reason is always a non-empty string", () => {
  const cases: ClassifyInput[] = [
    baseInput(),
    baseInput({ changedPaths: ["native/publication.c"] }),
    baseInput({ changedPaths: [] }),
    baseInput({ eventName: "workflow_call" }),
    baseInput({ workflowName: "Release" }),
    baseInput({ ref: "refs/tags/v0.3.0" }),
  ];

  it.each(cases)("carries a non-empty reason", (input) => {
    const result = classify.classifyCiScope(input);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-format qualification scoping (D-17, 56-12 handoff)
// ---------------------------------------------------------------------------

function formatsInput(
  overrides: Partial<QualificationFormatsInput> = {},
): QualificationFormatsInput {
  return {
    eventName: "pull_request",
    ref: "refs/pull/1/merge",
    changedPaths: ["src/png/chunks.ts"],
    ...overrides,
  };
}

describe("classifyQualificationFormats (D-17 per-format CI scoping)", () => {
  // Real-path fixtures (must_haves): each of these tests is also this
  // plan's required negative control -- if a format's own FORMAT_PATH_RULES
  // entry were ever dropped, the changed path would no longer match exactly
  // one format and this classifier would fall through to "every format"
  // instead, so each assertion below fails the moment a format's scoping
  // rule regresses.
  it("selects only png for a PNG source path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ changedPaths: ["src/png/chunks.ts"] }),
      ),
    ).toEqual(["png"]);
  });

  it("selects only png for a PNG qualification suite path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["tests/qualification/png/property.test.ts"],
        }),
      ),
    ).toEqual(["png"]);
  });

  it("selects only webp for a WebP handler path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["src/admission/webp-handler.ts"],
        }),
      ),
    ).toEqual(["webp"]);
  });

  it("selects only jpeg for a JPEG source path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ changedPaths: ["src/jpeg/parser.ts"] }),
      ),
    ).toEqual(["jpeg"]);
  });

  it("selects only jpeg for a JPEG qualification suite path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["tests/qualification/jpeg/tracer.test.ts"],
        }),
      ),
    ).toEqual(["jpeg"]);
  });

  it("selects every qualified format for a shared src/metadata path", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ changedPaths: ["src/metadata/exif.ts"] }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for a kit-shared path (matches zero formats)", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["tests/qualification/kit/oracles.ts"],
        }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for a mixed png + full-scope-only diff (matches zero formats on the second path)", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["src/png/chunks.ts", "src/engine.ts"],
        }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects jpeg and png for a mixed jpeg + png diff (each path matches exactly one different format)", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({
          changedPaths: ["src/jpeg/parser.ts", "src/png/chunks.ts"],
        }),
      ),
    ).toEqual(["jpeg", "png"]);
  });

  it("selects every format for a tag ref even with a png-only diff", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ ref: "refs/tags/v0.3.0" }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for a non-PR/push event", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ eventName: "workflow_dispatch" }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for an unknown eventName", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ eventName: "schedule" }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for an empty diff", () => {
    expect(
      classify.classifyQualificationFormats(formatsInput({ changedPaths: [] })),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it("selects every format for a null (errored) diff", () => {
    expect(
      classify.classifyQualificationFormats(
        formatsInput({ changedPaths: null }),
      ),
    ).toEqual(["jpeg", "png", "webp"]);
  });

  it.each(MALFORMED_PATHS)(
    "treats malformed path %j as every format",
    (path) => {
      expect(
        classify.classifyQualificationFormats(
          formatsInput({ changedPaths: [path] }),
        ),
      ).toEqual(["jpeg", "png", "webp"]);
    },
  );

  it("the end-to-end dry-run example from the plan verify step", () => {
    const classifyOne = (paths: readonly string[]) =>
      classify
        .classifyQualificationFormats(formatsInput({ changedPaths: paths }))
        .join(",");
    expect(
      [
        classifyOne(["src/png/chunks.ts"]),
        classifyOne(["src/admission/webp-handler.ts"]),
        classifyOne(["src/jpeg/parser.ts"]),
        classifyOne(["tests/qualification/kit/oracles.ts"]),
        classifyOne(["src/png/chunks.ts", "src/engine.ts"]),
        classifyOne(["src/jpeg/parser.ts", "src/png/chunks.ts"]),
      ].join("|"),
    ).toBe("png|webp|jpeg|jpeg,png,webp|jpeg,png,webp|jpeg,png");
  });

  describe("dead-rule coverage (no per-format rule is unreachable)", () => {
    it("every FORMAT_PATH_RULES pattern matches at least one real git-tracked path", () => {
      const trackedPaths = spawnSync("git", ["ls-files"], {
        cwd: packageRoot,
        encoding: "utf8",
      })
        .stdout.split("\n")
        .filter((path) => path.length > 0);
      for (const [format, patterns] of Object.entries(
        classify.FORMAT_PATH_RULES,
      )) {
        for (const pattern of patterns) {
          const matched = trackedPaths.some((path) => pattern.test(path));
          expect(
            matched,
            `format ${format} pattern ${pattern} has no matching tracked path`,
          ).toBe(true);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end (temp git repo)
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Classify Test",
  GIT_AUTHOR_EMAIL: "classify-test@example.com",
  GIT_COMMITTER_NAME: "Classify Test",
  GIT_COMMITTER_EMAIL: "classify-test@example.com",
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  return result.stdout;
}

function createBaseRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "classify-ci-scope-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Classify Test"]);
  git(dir, ["config", "user.email", "classify-test@example.com"]);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "base.md"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function runCli(
  dir: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; outputFileContents: string } {
  const outputFile = join(dir, "gh-output.txt");
  writeFileSync(outputFile, "");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    outputFileContents: readFileSync(outputFile, "utf8"),
  };
}

describe("CLI end-to-end", () => {
  it("pull_request mode: docs-only branch merged with --no-ff writes scope=linux", () => {
    const dir = createBaseRepo();
    try {
      git(dir, ["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(dir, "docs", "x.md"), "x\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "docs change"]);
      git(dir, ["checkout", "-q", "main"]);
      git(dir, ["merge", "--no-ff", "-m", "merge", "feature"]);

      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "pull_request",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/pull/1/merge",
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=linux\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pull_request mode: native branch merged with --no-ff writes scope=full", () => {
    const dir = createBaseRepo();
    try {
      git(dir, ["checkout", "-q", "-b", "feature"]);
      mkdirSync(join(dir, "native"), { recursive: true });
      writeFileSync(join(dir, "native", "publication.c"), "// native\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "native change"]);
      git(dir, ["checkout", "-q", "main"]);
      git(dir, ["merge", "--no-ff", "-m", "merge", "feature"]);

      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "pull_request",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/pull/1/merge",
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=full\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("push mode: docs-only head against a valid before SHA writes scope=linux", () => {
    const dir = createBaseRepo();
    try {
      const beforeSha = git(dir, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(dir, "docs", "y.md"), "y\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "docs push change"]);

      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "push",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/heads/main",
        CLASSIFY_BEFORE: beforeSha,
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=linux\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("push mode: an all-zero before SHA writes scope=full", () => {
    const dir = createBaseRepo();
    try {
      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "push",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/heads/main",
        CLASSIFY_BEFORE: "0".repeat(40),
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=full\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("push mode: CLASSIFY_FORCED=true writes scope=full", () => {
    const dir = createBaseRepo();
    try {
      const beforeSha = git(dir, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(dir, "docs", "z.md"), "z\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "docs push change"]);

      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "push",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/heads/main",
        CLASSIFY_BEFORE: beforeSha,
        CLASSIFY_FORCED: "true",
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=full\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-git cwd writes scope=full and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "classify-ci-scope-nongit-"));
    try {
      const { status, outputFileContents } = runCli(dir, {
        CLASSIFY_EVENT_NAME: "push",
        CLASSIFY_WORKFLOW: "CI",
        CLASSIFY_REF: "refs/heads/main",
        CLASSIFY_BEFORE: "1".repeat(40),
      });

      expect(status).toBe(0);
      expect(outputFileContents).toBe("scope=full\nformats=jpeg,png,webp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ci.yml scope wiring (D-15, D-18)
// ---------------------------------------------------------------------------

describe("ci.yml scope wiring (D-15, D-18)", () => {
  it("does not throw for the real ci.yml", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => classify.validateCiScopeWiring(workflow)).not.toThrow();
  });

  it("throws when identity-prebuild's != 'linux' gate is removed", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "if: ${{ !cancelled() && needs.quality.result == 'success' && needs.classify.outputs.scope != 'linux' }}",
      "if: ${{ !cancelled() && needs.quality.result == 'success' }}",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when one build-audit-native step's scope gate is removed", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "      - run: npm ci\n        if: ${{ needs.classify.outputs.scope != 'linux' }}\n",
      "      - run: npm ci\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when a step's if: gate is deleted but the gate phrase survives in a comment (WR-01)", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      '      - name: Assert matching runner and submitted SHA\n        if: ${{ needs.classify.outputs.scope != \'linux\' }}\n        shell: bash\n        run: |\n          test "$(node -p process.platform)" = "${{ matrix.os }}"\n',
      '      - name: Assert matching runner and submitted SHA\n        shell: bash\n        run: |\n          # gated by needs.classify.outputs.scope != \'linux\' elsewhere\n          test "$(node -p process.platform)" = "${{ matrix.os }}"\n',
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when installed-native's runs-on downgrade is removed", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "    if: ${{ !cancelled() && (needs.classify.outputs.scope == 'linux' || needs.assemble-exact-native.result == 'success') }}\n    runs-on: ${{ needs.classify.outputs.scope == 'linux' && 'ubuntu-24.04' || matrix.runner }}\n",
      "    if: ${{ !cancelled() && (needs.classify.outputs.scope == 'linux' || needs.assemble-exact-native.result == 'success') }}\n    runs-on: ${{ matrix.runner }}\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when an outputs.scope == 'full' form is introduced", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = `${workflow}\n# needs.classify.outputs.scope == 'full'\n`;
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when classify is dropped from phase-46-admission needs", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace("      - classify\n", "");
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when needs.classify is added to the quality job", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "\n  quality:\n    runs-on: ubuntu-24.04\n",
      "\n  quality:\n    needs: [classify]\n    runs-on: ubuntu-24.04\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when qualification-linux drops classify from needs (D-17: it must read outputs.formats)", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "    needs: [quality, classify]\n    if: ${{ !cancelled() && needs.quality.result == 'success' }}\n",
      "    needs: quality\n    if: ${{ !cancelled() && needs.quality.result == 'success' }}\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when qualification-linux is gated on needs.classify.outputs.scope (it must always run, D-17)", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "    needs: [quality, classify]\n    if: ${{ !cancelled() && needs.quality.result == 'success' }}\n",
      "    needs: [quality, classify]\n    if: ${{ !cancelled() && needs.quality.result == 'success' && needs.classify.outputs.scope == 'linux' }}\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when qualification-linux never reads needs.classify.outputs.formats", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "needs.classify.outputs.formats",
      "hardcoded-formats-not-read-from-classify",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when a workflow-level paths filter is added under on.pull_request", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "\n  pull_request:\n",
      "\n  pull_request:\n    paths:\n      - '**'\n",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when a third-party diff action is added", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = `${workflow}\n      - uses: dorny/paths-filter@v3\n`;
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when qualification-linux's CLASSIFY_RESULT env is removed (WR-03)", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      "          CLASSIFY_RESULT: ${{ needs.classify.result }}\n",
      "",
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });

  it("throws when qualification-linux's fallback stops deriving formats from QUALIFIED_FORMATS (WR-03)", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const mutated = workflow.replace(
      `FORMATS="$(node -p "require('./scripts/classify_ci_scope.cjs').QUALIFIED_FORMATS.join(',')")"`,
      `FORMATS="png,webp"`,
    );
    expect(mutated).not.toBe(workflow);
    expect(() => classify.validateCiScopeWiring(mutated)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WR-03: qualification-linux selection fails closed (56-18)
// ---------------------------------------------------------------------------

const JOB_HEADER_RE_LOCAL = /\n {2}([a-z][a-z0-9-]+):\n/gu;

/**
 * A local re-slice of ci.yml's top-level jobs, mirroring
 * scripts/classify_ci_scope.cjs's own (unexported) sliceJobs -- kept in the
 * test file rather than exporting production-only slicing machinery for a
 * single caller.
 */
function extractJob(workflowText: string, jobName: string): string {
  const jobsHeaderIndex = workflowText.indexOf("\njobs:\n");
  const searchText =
    jobsHeaderIndex >= 0
      ? workflowText.slice(jobsHeaderIndex + 1)
      : workflowText;
  const matches = [...searchText.matchAll(JOB_HEADER_RE_LOCAL)];
  const targetIndex = matches.findIndex((match) => match[1] === jobName);
  if (targetIndex < 0) throw new Error(`${jobName} job not found in ci.yml`);
  const targetMatch = matches[targetIndex];
  if (targetMatch === undefined)
    throw new Error(`${jobName} job not found in ci.yml`);
  const start = targetMatch.index + 1;
  const nextMatch = matches[targetIndex + 1];
  const end = nextMatch === undefined ? searchText.length : nextMatch.index + 1;
  return searchText.slice(start, end);
}

function extractQuotedEnvVar(jobText: string, name: string): string {
  const match = jobText.match(new RegExp(`\\n {6}${name}: "([^"]*)"\\n`, "u"));
  const value = match?.[1];
  if (value === undefined)
    throw new Error(`${name} not found in qualification-linux env block`);
  return value;
}

/**
 * Extracts and dedents the `run: |` body of the named step inside a sliced
 * job's text.
 */
function extractStepRunBody(jobText: string, stepName: string): string {
  const stepsIndex = jobText.indexOf("\n    steps:\n");
  if (stepsIndex < 0) throw new Error("steps: block not found in job");
  const chunks = jobText.slice(stepsIndex).split("\n      - ").slice(1);
  const stepChunk = chunks.find((chunk) =>
    chunk.startsWith(`name: ${stepName}`),
  );
  if (stepChunk === undefined)
    throw new Error(`step "${stepName}" not found in job`);
  const runMatch = stepChunk.match(/\n {8}run: \|\n([\s\S]*)$/u);
  const runBody = runMatch?.[1];
  if (runBody === undefined)
    throw new Error(`run: | block not found in step "${stepName}"`);
  return runBody
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

const SELECT_STEP_NAME =
  "Select and run qualification suites for touched formats (D-17)";

/**
 * Runs the real (or mutated) qualification-linux selection step body under
 * bash with a recording `npm` stub on PATH, exactly the way the hosted step
 * invokes it -- proving behaviour, not just text presence.
 */
function runQualificationSelectionStep(
  jobText: string,
  scriptBody: string,
  env: { formats: string; classifyResult: string },
): { status: number | null; recordedArgs: string[] } {
  const qualKit = extractQuotedEnvVar(jobText, "QUAL_KIT");
  const qualWebp = extractQuotedEnvVar(jobText, "QUAL_WEBP");
  const qualPng = extractQuotedEnvVar(jobText, "QUAL_PNG");
  const qualJpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG");

  const workDir = mkdtempSync(join(tmpdir(), "wr03-qualselect-"));
  const binDir = join(workDir, "bin");
  mkdirSync(binDir);
  const recordFile = join(workDir, "npm-args.txt");
  const scriptFile = join(workDir, "select.sh");

  writeFileSync(scriptFile, scriptBody, "utf8");
  writeFileSync(
    join(binDir, "npm"),
    [
      "#!/usr/bin/env bash",
      ': > "$WR03_NPM_RECORD_FILE"',
      'for arg in "$@"; do',
      '  printf \'%s\\n\' "$arg" >> "$WR03_NPM_RECORD_FILE"',
      "done",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(binDir, "npm"), 0o755);

  try {
    const result = spawnSync("bash", [scriptFile], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FORMATS: env.formats,
        CLASSIFY_RESULT: env.classifyResult,
        QUAL_KIT: qualKit,
        QUAL_WEBP: qualWebp,
        QUAL_PNG: qualPng,
        QUAL_JPEG: qualJpeg,
        WR03_NPM_RECORD_FILE: recordFile,
      },
      encoding: "utf8",
    });
    const recordedArgs = existsSync(recordFile)
      ? readFileSync(recordFile, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
      : [];
    return { status: result.status, recordedArgs };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function loadSelectionStepFromWorkflow(workflowText: string): {
  jobText: string;
  scriptBody: string;
} {
  const jobText = extractJob(workflowText, "qualification-linux");
  const scriptBody = extractStepRunBody(jobText, SELECT_STEP_NAME);
  return { jobText, scriptBody };
}

function loadSelectionStep(): { jobText: string; scriptBody: string } {
  const workflow = readFileSync(
    join(packageRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  return loadSelectionStepFromWorkflow(workflow);
}

describe.skipIf(process.platform === "win32")(
  "WR-03: qualification-linux selection fails closed",
  () => {
    it("classify failure + empty formats runs every qualified format", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "", classifyResult: "failure" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...png, ...webp, ...jpeg]) {
        expect(recordedArgs).toContain(file);
      }
    });

    it("classify failure + partial formats still runs every qualified format (a failed classify is never trusted)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "png", classifyResult: "failure" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...png, ...webp, ...jpeg]) {
        expect(recordedArgs).toContain(file);
      }
    });

    it("classify success + empty formats runs every qualified format", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "", classifyResult: "success" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...png, ...webp, ...jpeg]) {
        expect(recordedArgs).toContain(file);
      }
    });

    it("classify success + narrowed formats runs only the selected formats (narrowing still works)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "png", classifyResult: "success" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...png]) {
        expect(recordedArgs).toContain(file);
      }
      for (const file of [...webp, ...jpeg]) {
        expect(recordedArgs).not.toContain(file);
      }
    });

    it("classify success + narrowed formats (jpeg) runs only the JPEG suite", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "jpeg", classifyResult: "success" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...jpeg]) {
        expect(recordedArgs).toContain(file);
      }
      for (const file of [...png, ...webp]) {
        expect(recordedArgs).not.toContain(file);
      }
    });

    it("classify success + an unknown format still fails the step (unknown-format guard intact)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const { status } = runQualificationSelectionStep(jobText, scriptBody, {
        formats: "bogus",
        classifyResult: "success",
      });
      expect(status).not.toBe(0);
    });

    it("a mutation deleting the fallback branch drops the PNG/WebP/JPEG suites on a classify failure (behavioural negative control)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const mutatedBody = scriptBody.replace(
        /if \[ "\$CLASSIFY_RESULT" != "success" \][\s\S]*?\nfi\n/u,
        "",
      );
      expect(mutatedBody).not.toBe(scriptBody);
      const { recordedArgs } = runQualificationSelectionStep(
        jobText,
        mutatedBody,
        { formats: "", classifyResult: "failure" },
      );
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...png, ...webp, ...jpeg]) {
        expect(recordedArgs).not.toContain(file);
      }
    });

    it("a mutation removing the jpeg case arm fails an unrecognized-format-shaped run (Plan 57-07 negative control 1)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const mutatedBody = scriptBody.replace(
        '    jpeg) files="$files $QUAL_JPEG" ;;\n',
        "",
      );
      expect(mutatedBody).not.toBe(scriptBody);
      const { status } = runQualificationSelectionStep(jobText, mutatedBody, {
        formats: "jpeg",
        classifyResult: "success",
      });
      expect(status).not.toBe(0);
    });

    it("emptying QUAL_JPEG drops the jpeg tracer from the WR-03 fallback file list (Plan 57-07 negative control 2)", () => {
      const workflow = readFileSync(
        join(packageRoot, ".github", "workflows", "ci.yml"),
        "utf8",
      );
      const mutated = workflow.replace(
        /QUAL_JPEG: "[^"]*"/u,
        'QUAL_JPEG: ""',
      );
      expect(mutated).not.toBe(workflow);
      const { jobText, scriptBody } = loadSelectionStepFromWorkflow(mutated);
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        scriptBody,
        { formats: "", classifyResult: "failure" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      for (const file of [...kit, ...png, ...webp]) {
        expect(recordedArgs).toContain(file);
      }
      expect(recordedArgs).not.toContain(
        "tests/qualification/jpeg/tracer.test.ts",
      );
    });

    it("a QUALIFIED_FORMATS stand-in without jpeg makes the fallback run only png and webp (Plan 57-07 negative control 3)", () => {
      const { jobText, scriptBody } = loadSelectionStep();
      const mutatedBody = scriptBody.replace(
        `FORMATS="$(node -p "require('./scripts/classify_ci_scope.cjs').QUALIFIED_FORMATS.join(',')")"`,
        `FORMATS="png,webp"`,
      );
      expect(mutatedBody).not.toBe(scriptBody);
      const { status, recordedArgs } = runQualificationSelectionStep(
        jobText,
        mutatedBody,
        { formats: "", classifyResult: "failure" },
      );
      expect(status).toBe(0);
      const kit = extractQuotedEnvVar(jobText, "QUAL_KIT").split(" ");
      const png = extractQuotedEnvVar(jobText, "QUAL_PNG").split(" ");
      const webp = extractQuotedEnvVar(jobText, "QUAL_WEBP").split(" ");
      const jpeg = extractQuotedEnvVar(jobText, "QUAL_JPEG").split(" ");
      for (const file of [...kit, ...png, ...webp]) {
        expect(recordedArgs).toContain(file);
      }
      for (const file of jpeg) {
        expect(recordedArgs).not.toContain(file);
      }
    });
  },
);
