// D-15/61-10, flipped by 62.1-07: proves `dist/isobmff/` is committed (`check:dist` already gates
// that) and that, now that `heicHandler`/`avifHandler` are registered (62.1-07's atomic
// registration commit, D-03), the engine is REACHABLE from `dist/index.js` -- the one file
// `package.json`'s `exports` map actually publishes -- only as runtime code behind the registry:
// no value or type the engine modules export is re-exported from the public entry point. The
// only public additions are the two capability types, which live in `src/types.ts`.
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
import { fileURLToPath, pathToFileURL } from "node:url";
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
  "plan",
  "rebuild",
  "writer",
  "verify",
  "refusals",
] as const;

/**
 * 62-12 / 62.1-07: the three handler modules (`isobmff-handler.ts`, the shared engine-bound
 * factory, and `heic-handler.ts`/`avif-handler.ts`, the two per-brand modules built on it) are
 * committed under `dist/admission/` (`check:dist` already gates that) and, since 62.1-07
 * registered both handlers, are IN the public entry point's runtime import closure.
 */
const ISOBMFF_HANDLER_DIST_MODULES = [
  "isobmff-handler",
  "heic-handler",
  "avif-handler",
] as const;

describe("dist/isobmff is committed (BMF-02..BMF-06)", () => {
  it.each(ISOBMFF_DIST_MODULES)("dist/isobmff/%s.js exists", async (module) => {
    await expect(
      access(join(DIST_ROOT, "isobmff", `${module}.js`)),
    ).resolves.toBeUndefined();
  });
});

describe.each(ISOBMFF_HANDLER_DIST_MODULES)(
  "dist/admission/%s.js is reachable from the public entry point (registered in 62.1-07)",
  (module) => {
    it(`the transitive import closure of dist/index.js contains dist/admission/${module}.js`, async () => {
      const closure = await transitiveImportClosure(DIST_INDEX);
      const handlerPaths = closure.filter((path) =>
        path.replaceAll("\\", "/").endsWith(`/dist/admission/${module}.js`),
      );
      expect(handlerPaths).toHaveLength(1);
    });
  },
);

/** Every name a `dist/isobmff/*.d.ts` module exports (values and types), read from its text. */
async function isobmffExportedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const declaration =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu;
  for (const module of ISOBMFF_DIST_MODULES) {
    const source = await readFile(
      join(DIST_ROOT, "isobmff", `${module}.d.ts`),
      "utf8",
    );
    for (const match of source.matchAll(declaration)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

describe("no isobmff engine symbol is exported from the public entry point (D-15, 62.1-07)", () => {
  it("the engine modules export a non-empty set of names (the check below is not vacuous)", async () => {
    const names = await isobmffExportedNames();
    expect(names.has("classifyIsobmffBrand")).toBe(true);
    expect(names.has("HEIF_REFUSALS")).toBe(true);
    expect(names.has("HeifRefusal")).toBe(true);
  });

  it("dist/index.js exports no runtime value any engine module exports", async () => {
    const names = await isobmffExportedNames();
    const publicValues = Object.keys(
      (await import(pathToFileURL(DIST_INDEX).href)) as Record<string, unknown>,
    );
    expect(publicValues.length).toBeGreaterThan(0);
    expect(publicValues.filter((name) => names.has(name))).toEqual([]);
  });

  it("dist/index.d.ts names no engine export and imports nothing from ./isobmff/", async () => {
    const names = await isobmffExportedNames();
    const declaration = await readFile(join(DIST_ROOT, "index.d.ts"), "utf8");
    expect(declaration.toLowerCase()).not.toContain("isobmff");
    const identifiers = new Set(declaration.match(/[A-Za-z_$][\w$]*/gu) ?? []);
    expect([...names].filter((name) => identifiers.has(name))).toEqual([]);
    expect(identifiers.has("HeicCapabilities")).toBe(true);
    expect(identifiers.has("AvifCapabilities")).toBe(true);
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
