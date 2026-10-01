// D-15/61-10: proves `dist/isobmff/` is committed (`check:dist` already gates that) but
// UNREACHABLE from the public package surface. The engine built across this phase must never
// become reachable from `dist/index.js` -- the one file `package.json`'s `exports` map actually
// publishes -- until Phase 62 deliberately wires a real handler in.
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");
const DIST_INDEX = join(DIST_ROOT, "index.js");

/**
 * Mirrors `scripts/runtime_surface_gate.mjs`'s `importSpecifiers` static/dynamic import regexes
 * (the same pattern `tests/isobmff_isolation.test.ts` also mirrors for its own narrower purpose).
 */
const STATIC_IMPORT =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Walks the transitive import closure of `entryFile`, following only relative specifiers
 * (resolved against the IMPORTING file's own directory, not the entry file's) and ignoring
 * `node:` builtins and bare package specifiers (this package has zero runtime dependencies, so
 * any bare specifier reaching here would already be a separate, unrelated defect). Returns every
 * resolved absolute file path reached, including the entry file itself.
 */
export async function transitiveImportClosure(
  entryFile: string,
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [resolve(entryFile)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    let source: string;
    try {
      source = await readFile(current, "utf8");
    } catch {
      continue; // unresolved specifier (e.g. a .d.ts-only path) -- not a runtime edge
    }
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue; // ignore node: builtins and bare specifiers
      const resolved = resolve(dirname(current), specifier);
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return [...visited];
}

const ISOBMFF_DIST_MODULES = [
  "errors",
  "caps",
  "boxes",
  "iloc",
  "ipma",
  "brand",
  "items",
  "parse",
  "admission",
] as const;

describe("dist/isobmff is committed (BMF-02..BMF-06)", () => {
  it.each(ISOBMFF_DIST_MODULES)("dist/isobmff/%s.js exists", async (module) => {
    await expect(
      access(join(DIST_ROOT, "isobmff", `${module}.js`)),
    ).resolves.toBeUndefined();
  });
});

describe("dist/isobmff is unreachable from the public surface (D-15)", () => {
  it("the transitive import closure of dist/index.js contains no path under dist/isobmff/", async () => {
    const closure = await transitiveImportClosure(DIST_INDEX);
    expect(closure.length).toBeGreaterThan(0);
    const isobmffPaths = closure.filter((path) =>
      path.replaceAll("\\", "/").includes("/dist/isobmff/"),
    );
    expect(isobmffPaths).toEqual([]);
  });
});

describe("transitiveImportClosure negative controls (D-15: the walker actually detects a reachable isobmff path)", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function freshDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-surface-"));
    directories.push(directory);
    return directory;
  }

  it("a synthetic index.js with a STATIC import of ./isobmff/x.js is found", async () => {
    const root = await freshDirectory();
    await mkdir(join(root, "isobmff"), { recursive: true });
    await writeFile(
      join(root, "index.js"),
      'export {} from "./isobmff/x.js";\n',
      "utf8",
    );
    await writeFile(
      join(root, "isobmff", "x.js"),
      "export const x = 1;\n",
      "utf8",
    );

    const closure = await transitiveImportClosure(join(root, "index.js"));
    expect(closure).toContain(resolve(root, "isobmff", "x.js"));
  });

  it("a synthetic index.js with a DYNAMIC import of ./isobmff/y.js is found", async () => {
    const root = await freshDirectory();
    await mkdir(join(root, "isobmff"), { recursive: true });
    await writeFile(
      join(root, "index.js"),
      'export async function load() {\n  await import("./isobmff/y.js");\n}\n',
      "utf8",
    );
    await writeFile(
      join(root, "isobmff", "y.js"),
      "export const y = 1;\n",
      "utf8",
    );

    const closure = await transitiveImportClosure(join(root, "index.js"));
    expect(closure).toContain(resolve(root, "isobmff", "y.js"));
  });
});

describe("src/index.ts and src/types.ts contain no isobmff reference (D-15)", () => {
  it.each(["index.ts", "types.ts"] as const)(
    "src/%s has no isobmff substring",
    async (file) => {
      const source = await readFile(join(PACKAGE_ROOT, "src", file), "utf8");
      expect(source.toLowerCase()).not.toContain("isobmff");
    },
  );
});
