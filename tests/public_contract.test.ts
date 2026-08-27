import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDeclaration = join(packageRoot, "dist", "index.d.ts");

async function compileConsumer(
  source: string,
): Promise<readonly ts.Diagnostic[]> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-contract-"));
  const consumer = join(directory, "consumer.ts");
  await writeFile(
    consumer,
    source.replaceAll("PACKAGE_ROOT", packageRoot.replaceAll("\\", "\\\\")),
  );

  try {
    const program = ts.createProgram([consumer], {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
    });
    return ts.getPreEmitDiagnostics(program);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectConsumerToCompile(source: string): Promise<void> {
  const diagnostics = await compileConsumer(source);
  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\\n"),
    ),
  ).toEqual([]);
}

async function productionSources(): Promise<
  ReadonlyArray<{ path: string; source: ts.SourceFile }>
> {
  const sourceRoot = join(packageRoot, "src");
  const paths = (await readdir(sourceRoot, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(sourceRoot, path));
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
    })),
  );
}

function containsDetailRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "detail") {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "detail"
  ) {
    return true;
  }
  return node.getChildren().some(containsDetailRead);
}

describe("published ICC preservation contract", () => {
  it("states a structural-only guarantee and its explicit non-capabilities", async () => {
    const [readme, capabilities] = await Promise.all([
      readFile(join(packageRoot, "README.md"), "utf8"),
      readFile(join(packageRoot, "docs/capabilities.md"), "utf8"),
    ]);

    expect(readme).toContain("structural byte-preservation guarantee");
    expect(readme).toContain("not a claim");
    expect(readme).toContain("color correctness");
    expect(readme).toContain("transform quality");
    expect(readme).toContain("full ICC semantic conformance");
    expect(capabilities).toContain("## Explicit Non-Capabilities");
    expect(capabilities).toContain("No CMM");
    expect(capabilities).toContain("color-correctness claim");
  });

  it("keeps retry decisions typed and never branches on diagnostic detail", async () => {
    const violations: string[] = [];
    for (const { path, source } of await productionSources()) {
      const visit = (node: ts.Node): void => {
        const condition =
          ts.isIfStatement(node) ||
          ts.isWhileStatement(node) ||
          ts.isDoStatement(node) ||
          ts.isSwitchStatement(node)
            ? node.expression
            : ts.isConditionalExpression(node)
              ? node.condition
              : ts.isForStatement(node)
                ? node.condition
                : undefined;
        if (condition !== undefined && containsDetailRead(condition)) {
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          violations.push(`${path}:${position.line + 1}: detail controls flow`);
        }
        if (
          ts.isIdentifier(node) &&
          /^(?:retry|retryable|disposition)$/i.test(node.text)
        ) {
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          violations.push(
            `${path}:${position.line + 1}: ${node.text} enters production API`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});

describe("published generic transaction contract", () => {
  it("pins the single-request, exact-once fallback consumer flow", async () => {
    const readme = await readFile(join(packageRoot, "README.md"), "utf8");

    for (const rootName of [
      "getCapabilities",
      "inspectFile",
      "sanitizeFile",
      "classifyFallback",
      '"safe-to-fallback"',
      '"do-not-fallback"',
    ]) {
      expect(readme).toContain(rootName);
    }
    expect(readme).toContain("Call `sanitizeFile` once");
    expect(readme).toContain("Call `classifyFallback` once");
    expect(readme).toContain("at most one ExifTool substitute");
    expect(readme).toContain("preserve the original terminal result");
    expect(readme).toContain("only completion signal");
  });

  it("states bounded publication, finalization, attribute, and filesystem guarantees", async () => {
    const capabilities = await readFile(
      join(packageRoot, "docs/capabilities.md"),
      "utf8",
    );
    const normalizedCapabilities = capabilities.replace(/\s+/g, " ");

    for (const concept of [
      "NativeFormat",
      "FormatCapabilities",
      "WebpCapabilities",
      "magic admission",
      "private same-parent stage",
      "atomic no-replace publication",
      "postCommitResidue",
      "POSIX deterministically retains one empty",
      "Windows may also report",
      "owned-partial-removed",
      "owned-partial-remains",
      "atime and mtime only",
      "non-executable",
      "private stage path is never exposed",
      "process crash or power loss may leave private-stage residue",
      "directory durability",
      "locking",
      "unlink-if-identity-matches",
      "never uses identity-check-then-remove cleanup",
      "birth time",
      "owner/group",
      "ACLs",
      "xattrs",
      "quarantine/SELinux labels",
      "hard-link topology",
      "sparse allocation",
      "source atime",
    ]) {
      expect(normalizedCapabilities).toContain(concept);
    }
    expect(normalizedCapabilities).not.toContain(
      "directly creating the final path",
    );
    expect(normalizedCapabilities).toContain(
      "No success contract claims that only the destination is created",
    );
    expect(normalizedCapabilities).not.toContain(
      "Identity checks bound cleanup to the object created by this transaction",
    );
  });
});

describe("published format-neutral declaration contract", () => {
  const rootImport = 'from "PACKAGE_ROOT/dist/index.js"';

  it("compiles generic consumers, WebP narrowing, nonempty discovery, and refinement assignability", async () => {
    await expectConsumerToCompile(`
      import { getCapabilities } ${rootImport};
      import type {
        FormatCapabilities,
        Inspection,
        NativeFormat,
        SanitizeResult,
        WebpCapabilities,
      } ${rootImport};

      const assertNever = (value: never): never => { throw new Error(String(value)); };
      const useGeneric = (inspection: Inspection, result: SanitizeResult): NativeFormat => {
        const format: NativeFormat = inspection.format;
        const output: NativeFormat = result.format;
        return format === output ? format : output;
      };
      const useRefinement = (capability: WebpCapabilities): FormatCapabilities => capability;
      const narrow = (capability: FormatCapabilities): "image/webp" => {
        switch (capability.format) {
          case "webp": return capability.mimeTypes[0];
        }
        return assertNever(capability.format);
      };
      const advertised = getCapabilities().formats;
      const first: FormatCapabilities = advertised[0];
      void [useGeneric, useRefinement, narrow, first];
    `);
  });

  it("rejects mutation and a switch that omits an advertised format", async () => {
    const mutationDiagnostics = await compileConsumer(`
      import { getCapabilities } ${rootImport};
      getCapabilities().formats.push(getCapabilities().formats[0]);
    `);
    const exhaustiveDiagnostics = await compileConsumer(`
      import type { NativeFormat } ${rootImport};
      const assertNever = (value: never): never => { throw new Error(String(value)); };
      const incomplete = (format: NativeFormat): never => {
        switch (format) {
          default: return assertNever(format);
        }
      };
      void incomplete;
    `);

    expect(mutationDiagnostics).not.toEqual([]);
    expect(exhaustiveDiagnostics).not.toEqual([]);
  });

  it("exports exactly the approved semantic root surface and no plugin platform", async () => {
    const [declaration, packageJson] = await Promise.all([
      readFile(rootDeclaration, "utf8"),
      readFile(join(packageRoot, "package.json"), "utf8"),
    ]);
    const source = ts.createSourceFile(
      rootDeclaration,
      declaration,
      ts.ScriptTarget.Latest,
      true,
    );
    const values = new Set<string>();
    const types = new Set<string>();

    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        (statement.isTypeOnly ? types : values).add(element.name.text);
      }
    }

    expect([...values].sort()).toEqual([
      "classifyFallback",
      "err",
      "getCapabilities",
      "inspectFile",
      "ok",
      "sanitizeFile",
    ]);
    expect([...types].sort()).toEqual([
      "Capabilities",
      "FallbackDisposition",
      "FormatCapabilities",
      "InspectOptions",
      "Inspection",
      "JsonSafeCause",
      "MetadataEntry",
      "MetadataError",
      "MetadataValue",
      "MetadataWarning",
      "NativeFormat",
      "PostCommitResidue",
      "Result",
      "SanitizeOptions",
      "SanitizeResult",
      "WebpCapabilities",
    ]);
    expect(JSON.parse(packageJson).exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(declaration).not.toMatch(
      /(?:handler|registry|register|transaction|file-operations|WebpInspection|WebpSanitizeResult|Webp.*Error)/i,
    );
  });
});

describe("private automated qualification surface", () => {
  it("exposes one bounded replay command family without widening the package", async () => {
    const [packageJsonSource, qualifySource] = await Promise.all([
      readFile(join(packageRoot, "package.json"), "utf8"),
      readFile(
        join(packageRoot, "scripts", "qualification", "qualify.cjs"),
        "utf8",
      ),
    ]);
    const packageJson = JSON.parse(packageJsonSource);

    expect(packageJson.scripts.qualify).toBe(
      "node scripts/qualification/qualify.cjs",
    );
    expect(packageJson.scripts["benchmark:qualify"]).toBe(
      "node scripts/qualification/benchmark.cjs",
    );
    expect(packageJson.dependencies).toBeUndefined();
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepack",
      "postpack",
    ])
      expect(packageJson.scripts[lifecycle]).toBeUndefined();
    for (const flag of ["--case", "--oracle", "--seed", "--path", "--fault"])
      expect(qualifySource).toContain(flag);
    expect(qualifySource).toContain("Reproduce:");
    expect(qualifySource).toContain("Evidence:");
  });

  it("keeps qualification code out of production imports, exports, and package files", async () => {
    const [packageJsonSource, declaration] = await Promise.all([
      readFile(join(packageRoot, "package.json"), "utf8"),
      readFile(rootDeclaration, "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonSource);
    const violations: string[] = [];
    for (const { path, source } of await productionSources()) {
      for (const statement of source.statements)
        if (
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          /(?:qualification|benchmark|oracle|corpus)/iu.test(
            statement.moduleSpecifier.text,
          )
        )
          violations.push(path);
    }

    expect(violations).toEqual([]);
    expect(declaration).not.toMatch(/qualification|benchmark|oracle|corpus/iu);
    expect(packageJson.files).not.toContain("scripts");
    expect(packageJson.files).not.toContain("tests");
  });

  it("makes final CI admission depend on every independent authority", async () => {
    const workflow = await readFile(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const job = (id: string): string => {
      const match = workflow.match(
        new RegExp(
          `^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:|(?![\\s\\S]))`,
          "mu",
        ),
      );
      if (match?.[0] === undefined) throw new Error(`Missing CI job ${id}`);
      return match[0];
    };
    const focused = job("qualification-linux");
    const benchmarkJob = job("benchmark-linux");
    const admission = job("phase-46-admission");

    for (const authority of [
      "tracer.test.ts",
      "parser.test.ts",
      "property.test.ts",
      "transaction.test.ts",
      "oracles.test.ts",
    ])
      expect(focused).toContain(authority);
    expect(benchmarkJob).toContain("node: [22, 24]");
    expect(benchmarkJob).toContain("assemble-exact-native");
    expect(benchmarkJob).toContain("benchmark:qualify");
    expect(benchmarkJob).toContain("benchmark-report.cjs --validate-report");
    expect(benchmarkJob).toContain("github.event_name == 'pull_request'");
    expect(benchmarkJob).toContain("if: always()");
    for (const dependency of [
      "quality",
      "qualification-linux",
      "immutable-sha-evidence",
      "benchmark-linux",
    ])
      expect(admission).toContain(dependency);
    expect(admission).toContain("reports.length !== 12");
    expect(admission).toContain("benchmarkReports.length !== 2");
    expect(admission).toContain("'--phase-admission'");
    expect(admission).not.toContain("baseline median ×");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("pins v2's retained robust calibration evidence without widening runtime surface", async () => {
    const [workflow, documentation, reportSource] = await Promise.all([
      readFile(join(packageRoot, ".github", "workflows", "ci.yml"), "utf8"),
      readFile(join(packageRoot, "docs", "benchmark-admission.md"), "utf8"),
      readFile(join(packageRoot, "scripts", "qualification", "benchmark-report.cjs"), "utf8"),
    ]);
    for (const claim of [
      "exifcleaner-run-calibration-v2",
      "15 x 16",
      "15000 ms",
      "central eleven",
      "normalized MAD",
      "max(beforeMedianNs, afterMedianNs)",
      "8x100/7x110",
    ]) expect(documentation).toContain(claim);
    expect(reportSource).toContain("centralRangeRatioLimit");
    expect(reportSource).toContain("Math.max(beforeEstimate.medianNs, afterEstimate.medianNs)");
    expect(workflow).toContain("benchmark-report.cjs --validate-report");
    expect(workflow).toContain("'--phase-admission'");
  });

  it("documents every replay, promotion step, guarantee, and bounded non-guarantee", async () => {
    const [capabilitiesSource, provenanceSource] = await Promise.all([
      readFile(join(packageRoot, "docs", "capabilities.md"), "utf8"),
      readFile(join(packageRoot, "docs", "fixture-provenance.md"), "utf8"),
    ]);
    const capabilities = capabilitiesSource.replace(/\s+/gu, " ");
    const provenance = provenanceSource.replace(/\s+/gu, " ");

    for (const guarantee of [
      "fail-closed container admission",
      "reopened to prove metadata removal",
      "byte-identical retained compressed image/animation payloads",
      "same canvas, timing, and frame evidence",
      "scripts disabled",
      "all twelve installed",
      "both benchmark conclusions",
    ])
      expect(capabilities).toContain(guarantee);
    for (const nonGuarantee of [
      "do not convert structural parsing into a decoder",
      "color correctness or browser parity",
      "universal WebP conformance",
      "unknown containers",
    ])
      expect(capabilities).toContain(nonGuarantee);
    for (const replay of [
      "npm run qualify",
      "--case exifcleaner-sample --json",
      "--oracle libwebp-1.5.0-example",
      "--seed 460046 --path 0",
      "--fault stage-sync:1:EIO",
      "--fault during-bounded-copy",
      "npm run benchmark:qualify",
      "--fixture still-64k",
    ])
      expect(provenance).toContain(replay);
    for (const governance of [
      "offline and immutable",
      "quarantined outside the repository",
      "Minimize the byte sequence",
      "review privacy",
      "stable manifest ID",
      "focused regression assertion",
      "never an automatic corpus synchronization",
      "retainedPayloads",
      "permittedDifferences",
      "oracle",
      "benchmarks.fixtures",
    ])
      expect(provenance).toContain(governance);
  });
});
