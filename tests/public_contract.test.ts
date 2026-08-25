import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
