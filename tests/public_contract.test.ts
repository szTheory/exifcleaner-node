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

    for (const concept of [
      "NativeFormat",
      "FormatCapabilities",
      "WebpCapabilities",
      "magic admission",
      "O_EXCL",
      "owned-partial-removed",
      "already-missing",
      "replaced-and-left-untouched",
      "owned-partial-remains",
      "atime and mtime only",
      "non-executable",
      "provisional pathname is not completion",
      "process crash or power loss may leave residue",
      "directory durability",
      "locking",
      "no-replace staged publication",
      "unlink-if-identity-matches",
      "hostile concurrently writable directories",
      "birth time",
      "owner/group",
      "ACLs",
      "xattrs",
      "quarantine/SELinux labels",
      "hard-link topology",
      "sparse allocation",
      "source atime",
    ]) {
      expect(capabilities).toContain(concept);
    }
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
